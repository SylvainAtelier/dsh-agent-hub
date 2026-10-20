//! `dsh-type --palette`: the clipboard history and translation window.
//!
//! One process, three kinds of work kept apart:
//!   * a thread that sleeps until the system announces a clipboard change, and stores it;
//!   * the event loop: global hotkey, the window and its web page, one message at a time;
//!   * a short-lived thread for each typing request, so the window never waits on it.
//!
//! The page is created on the first use (or when the host asks for it to be warmed up), hidden
//! and throttled between uses, and dropped after half an hour unused: what stays resident
//! is the watcher and the hotkey. Lines on stdin come from the host, lines on stdout go to it.
//!
//!   -> {"op":"config","hotkey":"Ctrl+Alt+V","keep":500,"ignore":["keepass"],"bots":[{"id":"x","name":"X"}],"bot":"x","theme":"dark","warm":true}
//!   -> {"op":"tr","rid":3,"text":"…","done":false,"error":null}
//!   <- {"event":"ready"} {"event":"hotkey","ok":true,"accel":"Ctrl+Alt+V"}
//!   <- {"event":"translate","rid":3,"text":"…","to":"en","bot":"x"} {"event":"cancel","rid":3}
//!
//! Copied images are kept too, for a few hours (db::IMAGE_TTL_MS), and the page loads them from the
//! `clip` scheme (`clip://localhost/<id>`, `http://clip.localhost/<id>` on Windows) as it shows them.
//!
//! While the window is open it owns the Alt/⌥ digits that pick languages (see `os::grab`), ahead
//! of other programs' hotkeys.
//!
//! The window wears DSH's light or dark theme once the host knows it, the system's until then. It
//! opens on the screen of the window that had the focus (the one under the pointer when there is
//! none), in its middle or where it was last dragged to (kept as a share of the screen, so it
//! means the same on any screen). Its size is one for every screen, in the screen's own units
//! (DIPs), and the person may change it by its edges.
//!
//! Finished translations are kept too (db::MAX_TRANSLATIONS), and listed beside the translator.

mod db;
mod image;
mod keys;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

#[cfg(target_os = "macos")]
use mac as os;
#[cfg(windows)]
use win as os;

use crate::Way;
use db::{Catch, Db};
use global_hotkey::{hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::dpi::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::monitor::MonitorHandle;
use tao::window::{Theme, Window, WindowBuilder};
use wry::{WebContext, WebView, WebViewBuilder};

pub use db::MAX_BYTES;

/// One copy as the watcher found it: a text, or an image as a whole PNG with its size.
pub enum Clip {
    Text(String),
    Image(Vec<u8>, u32, u32),
}

/// Where typed text should go: the program that was in front when the window opened.
#[derive(Clone)]
pub struct Target {
    pub id: isize,
    pub app: String,
}

/// A window unused this long is dropped; the next hotkey builds it again (a fraction of a second).
const RELEASE_AFTER: Duration = Duration::from_secs(30 * 60);
/// Focus often flickers while a window opens: a loss this soon after showing does not close it.
const SETTLE: Duration = Duration::from_millis(400);
/// The window's size in the screen's own units (DIPs), the same on every screen: the first one,
/// and the bounds the person may resize it within. A screen too small for it gets a share of itself.
const SIZE: (f64, f64) = (820.0, 560.0);
const MIN_SIZE: (f64, f64) = (560.0, 380.0);
const MAX_SIZE: (f64, f64) = (1280.0, 900.0);
const SCREEN_SHARE: (f64, f64) = (0.94, 0.88);
/// A dragged or resized window's place and size are stored once it has stood still this long.
const REMEMBER_AFTER: Duration = Duration::from_millis(500);

enum Ev {
    Hotkey,
    Host(Value),
    Clip,
    Page(Value),
    Typed(Result<(), String>, String),
    /// An image put on the clipboard and pasted, or not.
    Pasted(Result<(), String>),
    /// Alt/⌥ with a digit, taken from the system while the window is open.
    Lang(u8),
    Quit,
}

#[derive(Default)]
struct Settings {
    keep: AtomicUsize,
    ignore: Mutex<Vec<String>>,
}

struct Shell {
    // The page goes first: it must be dropped before the window it draws in.
    view: WebView,
    window: Window,
}

struct App {
    proxy: EventLoopProxy<Ev>,
    db: Arc<Mutex<Db>>,
    settings: Arc<Settings>,
    page: PathBuf,
    data: PathBuf,
    context: Option<WebContext>,
    shell: Option<Shell>,
    ready: bool,
    visible: bool,
    shown_at: Instant,
    hidden_at: Option<Instant>,
    /// The screen the window was last laid out for.
    placed: Option<(i32, i32, u32, u32, u64)>,
    /// The size given to the window, in DIPs: a resize to anything else is the person's.
    dip: Option<(f64, f64)>,
    /// The person moves or resizes the window (since it was last placed): theirs, to remember.
    dragging: bool,
    /// When the window's place and size are due to be stored.
    remember_at: Option<Instant>,
    /// DSH's theme; none until the host says, and the system's applies.
    theme: Option<Theme>,
    target: Option<Target>,
    sent: u64,
    /// The pins as last told to the host, so only a change is told again; none before the first,
    /// which is told even when empty: until then the host cannot tell "no pins" from "not known".
    shared: Option<Vec<(String, i64)>>,
    manager: Option<GlobalHotKeyManager>,
    hotkey: Option<(HotKey, String)>,
    bots: Value,
    bot: String,
    /// The Alt/⌥ digits that pick the languages, one bit per digit.
    keys: u16,
    /// A message for the next opening, its tone, and whether it is about the typing permission.
    notice: Option<(String, &'static str, bool)>,
    /// Translations asked for and not finished, by request: the text, the language and the bot.
    asked: HashMap<i64, (String, String, String)>,
    /// The page has the translation history (it lives as long as the page).
    history_sent: bool,
}

pub fn emit(value: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn log(message: impl AsRef<str>) {
    emit(json!({ "event": "log", "message": message.as_ref() }));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn argument(name: &str) -> Option<PathBuf> {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == name {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

pub fn run() {
    let (Some(db_path), Some(page), Some(data)) = (argument("--db"), argument("--page"), argument("--data")) else {
        eprintln!("--palette needs --db, --page and --data");
        std::process::exit(2);
    };
    let db = match Db::open(&db_path) {
        Ok(db) => Arc::new(Mutex::new(db)),
        Err(error) => {
            emit(json!({ "event": "fatal", "message": format!("cannot open the clipboard history: {error}") }));
            std::process::exit(1);
        }
    };
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // No Dock icon, no menu bar: the palette is a tool window.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();

    // The host closing our stdin (it exited, or restarted us) ends the process.
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            let stdin = io::stdin();
            let mut reader = stdin.lock();
            while let Ok(Some(frame)) = crate::read_frame(&mut reader) {
                if let Ok(line) = frame {
                    if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                        if proxy.send_event(Ev::Host(value)).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = proxy.send_event(Ev::Quit);
        });
    }
    {
        let proxy = proxy.clone();
        GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
            if event.state == HotKeyState::Pressed {
                let _ = proxy.send_event(Ev::Hotkey);
            }
        }));
    }

    let settings = Arc::new(Settings::default());
    settings.keep.store(500, Ordering::Relaxed);
    let mut app = App {
        proxy: proxy.clone(),
        db: db.clone(),
        settings: settings.clone(),
        page,
        data,
        context: None,
        shell: None,
        ready: false,
        visible: false,
        shown_at: Instant::now(),
        hidden_at: None,
        placed: None,
        dip: None,
        dragging: false,
        remember_at: None,
        theme: None,
        target: None,
        sent: 0,
        shared: None,
        manager: GlobalHotKeyManager::new().ok(),
        hotkey: None,
        bots: json!([]),
        bot: String::new(),
        keys: 0b111_1000,
        notice: None,
        asked: HashMap::new(),
        history_sent: false,
    };
    if app.manager.is_none() {
        log("the system refused global hotkeys");
    }

    event_loop.run(move |event, target, flow| {
        *flow = match (&app.shell, app.hidden_at, app.remember_at) {
            (_, _, Some(at)) => ControlFlow::WaitUntil(at),
            (Some(_), Some(at), None) if !app.visible => ControlFlow::WaitUntil(at + RELEASE_AFTER),
            _ => ControlFlow::Wait,
        };
        match event {
            Event::NewEvents(StartCause::Init) => {
                start_watcher(&app);
                emit(json!({ "event": "ready" }));
                app.share_pins(None);
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if app.remember_at.is_some_and(|at| at <= Instant::now()) {
                    app.remember_place();
                }
                app.release_if_idle();
            }
            // Only the person's moves are remembered: the ones `place` makes come while not dragging.
            Event::WindowEvent { event: WindowEvent::Moved(_), .. } => {
                if app.dragging {
                    app.remember_at = Some(Instant::now() + REMEMBER_AFTER);
                }
            }
            Event::WindowEvent { event: WindowEvent::Focused(false), .. } => {
                if app.visible && app.shown_at.elapsed() > SETTLE {
                    app.hide(false);
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => app.hide(true),
            // A resize that is not to the size given is the person's, by the window's edges.
            Event::WindowEvent { event: WindowEvent::Resized(size), .. } => app.resized(size),
            // Moving to a screen of another density: the same size in DIPs there.
            Event::WindowEvent { event: WindowEvent::ScaleFactorChanged { scale_factor, new_inner_size }, .. } => {
                if let Some((width, height)) = app.dip {
                    *new_inner_size = PhysicalSize::new((width * scale_factor).round() as u32, (height * scale_factor).round() as u32);
                }
            }
            Event::UserEvent(event) => match event {
                Ev::Quit => {
                    app.shell = None;
                    *flow = ControlFlow::Exit;
                }
                Ev::Hotkey => {
                    if app.visible {
                        app.hide(true);
                    } else {
                        // A copy the watcher missed or could not read yet shows up as the window opens.
                        os::check_now();
                        app.show(target, true);
                    }
                }
                Ev::Host(value) => app.host(value, target),
                Ev::Clip => {
                    if app.visible && app.ready {
                        app.push_changes();
                    }
                }
                Ev::Page(value) => app.page_message(value, target),
                Ev::Lang(n) => {
                    os::mask_alt();
                    app.send(&json!({ "t": "lang", "n": n }));
                }
                Ev::Pasted(result) => {
                    if let Err(error) = result {
                        app.notice = Some((format!("{error} · it is on the clipboard"), "bad", permission_missing()));
                        app.show(target, false);
                    }
                }
                Ev::Typed(result, text) => {
                    if let Err(error) = result {
                        // Never lose the text: it goes to the clipboard and the window comes back.
                        let _ = os::set_clipboard(&text);
                        app.notice = Some((format!("{error} · copied to the clipboard"), "bad", permission_missing()));
                        app.show(target, false);
                    }
                }
            },
            _ => {}
        }
    });
}

fn start_watcher(app: &App) {
    let settings = app.settings.clone();
    let skip: Arc<dyn Fn(&str) -> bool + Send + Sync> = Arc::new(move |name: &str| {
        let name = name.to_lowercase();
        !name.is_empty() && settings.ignore.lock().map(|list| list.iter().any(|item| *item == name)).unwrap_or(false)
    });
    let db = app.db.clone();
    let settings = app.settings.clone();
    let proxy = app.proxy.clone();
    let sink: Arc<dyn Fn(Clip, String) + Send + Sync> = Arc::new(move |clip, name| {
        let keep = settings.keep.load(Ordering::Relaxed);
        let stored = db
            .lock()
            .map(|mut db| match &clip {
                Clip::Text(text) => db.record(text, &name, now_ms(), keep),
                Clip::Image(data, width, height) => db.record_image(data, *width, *height, &name, now_ms()),
            })
            .unwrap_or(Ok(None));
        match stored {
            Ok(Some(_)) => {
                let _ = proxy.send_event(Ev::Clip);
            }
            Ok(None) => {}
            Err(error) => log(format!("cannot store a copy: {error}")),
        }
    });
    os::watch(skip, sink);
}

impl App {
    fn host(&mut self, value: Value, target: &EventLoopWindowTarget<Ev>) {
        match value.get("op").and_then(Value::as_str) {
            Some("config") => {
                if let Some(keep) = value.get("keep").and_then(Value::as_u64) {
                    self.settings.keep.store(keep.clamp(10, 10_000) as usize, Ordering::Relaxed);
                    if let Ok(mut db) = self.db.lock() {
                        let _ = db.trim(keep as usize);
                    }
                }
                if let Some(list) = value.get("ignore").and_then(Value::as_array) {
                    let list = list.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
                    if let Ok(mut ignore) = self.settings.ignore.lock() {
                        *ignore = list;
                    }
                }
                if let Some(bots) = value.get("bots") {
                    self.bots = bots.clone();
                }
                if let Some(bot) = value.get("bot").and_then(Value::as_str) {
                    self.bot = bot.to_string();
                }
                if let Some(theme) = value.get("theme").and_then(Value::as_str) {
                    let theme = match theme {
                        "dark" => Some(Theme::Dark),
                        "light" => Some(Theme::Light),
                        _ => None,
                    };
                    if theme != self.theme {
                        self.theme = theme;
                        self.apply_theme();
                    }
                }
                if let Some(keys) = value.get("keys").and_then(Value::as_array) {
                    self.keys = keys.iter().filter_map(Value::as_u64).filter(|digit| (1..=9).contains(digit)).fold(0, |mask, digit| mask | 1 << digit);
                }
                if let Some(accel) = value.get("hotkey").and_then(Value::as_str) {
                    self.set_hotkey(accel);
                }
                if value.get("warm").and_then(Value::as_bool) == Some(true) && self.shell.is_none() {
                    self.build(target);
                    self.park();
                }
            }
            // Settings sync sets the pinned texts; the answer (with the same `rid`) is the pins as they now are.
            Some("pins") => {
                let items: Vec<(String, i64)> = value
                    .get("items")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(|item| Some((item.get("text")?.as_str()?.to_string(), item.get("at").and_then(Value::as_i64).unwrap_or(0)))).collect())
                    .unwrap_or_default();
                let stored = self.db.lock().map_err(|e| e.to_string()).and_then(|mut db| db.set_pins(&items, now_ms()));
                if let Err(error) = stored {
                    log(format!("cannot set the pins: {error}"));
                }
                self.share_pins(Some(value.get("rid").and_then(Value::as_i64).unwrap_or(0)));
                if self.visible && self.ready {
                    self.push_changes();
                }
            }
            Some("tr") => {
                let mut message = value.clone();
                message["t"] = json!("tr");
                self.send(&message);
                self.keep_translation(&value);
            }
            _ => {}
        }
    }

    /// A finished translation joins the history, and the page's list when it has one.
    fn keep_translation(&mut self, answer: &Value) {
        let Some(rid) = answer.get("rid").and_then(Value::as_i64) else { return };
        let failed = answer.get("error").is_some_and(|error| !error.is_null());
        if !failed && answer.get("done").and_then(Value::as_bool) != Some(true) {
            return;
        }
        let Some((src, lang, bot)) = self.asked.remove(&rid) else { return };
        let out = answer.get("text").and_then(Value::as_str).unwrap_or_default();
        if failed {
            return;
        }
        let kept = self.db.lock().map_err(|e| e.to_string()).and_then(|mut db| db.record_translation(&src, out, &lang, &bot, now_ms()));
        match kept {
            Ok(Some(row)) if self.history_sent => self.send(&json!({ "t": "history", "row": row })),
            Ok(_) => {}
            Err(error) => log(format!("cannot keep a translation: {error}")),
        }
    }

    /// Registers the new combination first and only then lets go of the old one.
    fn set_hotkey(&mut self, accel: &str) {
        let accel = accel.trim();
        let Some(manager) = &self.manager else {
            return emit(json!({ "event": "hotkey", "ok": false, "accel": accel, "error": "the system refused global hotkeys" }));
        };
        if accel.is_empty() {
            if let Some((old, _)) = self.hotkey.take() {
                let _ = manager.unregister(old);
            }
            return emit(json!({ "event": "hotkey", "ok": true, "accel": "" }));
        }
        if self.hotkey.as_ref().is_some_and(|(_, text)| text == accel) {
            return emit(json!({ "event": "hotkey", "ok": true, "accel": accel }));
        }
        let outcome = keys::parse(accel).and_then(|new| {
            if self.hotkey.as_ref().is_some_and(|(old, _)| *old == new) {
                return Ok(new);
            }
            manager.register(new).map(|()| new).map_err(|error| match error {
                global_hotkey::Error::AlreadyRegistered(_) => "another program already uses this shortcut".to_string(),
                other => other.to_string(),
            })
        });
        match outcome {
            Ok(new) => {
                if let Some((old, _)) = self.hotkey.take() {
                    if old != new {
                        let _ = manager.unregister(old);
                    }
                }
                self.hotkey = Some((new, accel.to_string()));
                emit(json!({ "event": "hotkey", "ok": true, "accel": accel }));
            }
            Err(error) => {
                let active = self.hotkey.as_ref().map(|(_, text)| text.clone()).unwrap_or_default();
                emit(json!({ "event": "hotkey", "ok": false, "accel": accel, "active": active, "error": error }));
            }
        }
    }

    fn build(&mut self, target: &EventLoopWindowTarget<Ev>) {
        if self.shell.is_some() {
            return;
        }
        let html = match std::fs::read_to_string(&self.page) {
            Ok(html) => html,
            Err(error) => return log(format!("cannot read the palette page: {error}")),
        };
        let builder = WindowBuilder::new()
            .with_title("Clipboard")
            .with_decorations(false)
            .with_resizable(true)
            .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
            .with_always_on_top(true)
            // Opens on the Space in view, never takes the person back to the one it was last on.
            .with_visible_on_all_workspaces(true)
            .with_visible(false)
            .with_inner_size(LogicalSize::new(SIZE.0, SIZE.1));
        #[cfg(windows)]
        let builder = {
            use tao::platform::windows::WindowBuilderExtWindows;
            builder.with_skip_taskbar(true).with_undecorated_shadow(true)
        };
        let window = match builder.build(target) {
            Ok(window) => window,
            Err(error) => return log(format!("cannot create the window: {error}")),
        };
        os::style(hwnd(&window));
        window.set_theme(self.theme);
        let background = background(self.theme.unwrap_or_else(|| window.theme()));
        let context = self.context.get_or_insert_with(|| WebContext::new(Some(self.data.clone())));
        let proxy = self.proxy.clone();
        let images = self.db.clone();
        let view = WebViewBuilder::new_with_web_context(context)
            .with_html(html)
            // Off the window's thread: an image can be megabytes.
            .with_asynchronous_custom_protocol("clip".into(), move |_, request, responder| {
                let db = images.clone();
                std::thread::spawn(move || {
                    let id = request.uri().path().trim_start_matches('/').parse::<i64>().ok();
                    let data = id.and_then(|id| db.lock().ok()?.image(id));
                    let response = match data {
                        // An id is never reused for another image: the page may keep what it loaded.
                        Some(data) => wry::http::Response::builder()
                            .header("Content-Type", "image/png")
                            .header("Cache-Control", "max-age=86400, immutable")
                            .body(std::borrow::Cow::Owned(data)),
                        None => wry::http::Response::builder().status(404).body(std::borrow::Cow::Borrowed(&[][..])),
                    };
                    if let Ok(response) = response {
                        responder.respond(response);
                    }
                });
            })
            .with_background_color(background)
            .with_devtools(false)
            .with_hotkeys_zoom(false)
            .with_ipc_handler(move |request| {
                if let Ok(value) = serde_json::from_str::<Value>(request.body()) {
                    let _ = proxy.send_event(Ev::Page(value));
                }
            });
        #[cfg(windows)]
        let view = {
            use wry::WebViewBuilderExtWindows;
            view.with_browser_accelerator_keys(false)
        };
        match view.build(&window) {
            Ok(view) => {
                self.ready = false;
                self.history_sent = false;
                // A new page counts its requests from the start again.
                self.asked.clear();
                self.shell = Some(Shell { view, window });
            }
            Err(error) => log(format!("cannot create the web view: {error}")),
        }
    }

    /// The browser engine's own way to rest: scripts, timers and rendering stop and its memory is
/// given back; `resume` undoes it. A failure only means the page rests less deeply.
#[cfg(windows)]
fn rest(view: &WebView, suspend: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use webview2_com::TrySuspendCompletedHandler;
    use windows::core::Interface;
    use wry::WebViewExtWindows;
    unsafe {
        let Ok(core) = view.controller().CoreWebView2() else { return };
        let Ok(core) = core.cast::<ICoreWebView2_3>() else { return };
        if suspend {
            let handler = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
            let _ = core.TrySuspend(&handler);
        } else {
            let _ = core.Resume();
        }
    }
}

/// Hidden and as light as the system allows until the next use.
    fn park(&mut self) {
        if let Some(shell) = &self.shell {
            shell.window.set_visible(false);
            let _ = shell.view.set_visible(false);
            #[cfg(windows)]
            {
                use wry::WebViewExtWindows;
                let _ = shell.view.set_memory_usage_level(wry::MemoryUsageLevel::Low);
               Self::rest(&shell.view, true);
            }
        }
        self.hidden_at = Some(Instant::now());
    }

    fn release_if_idle(&mut self) {
        if !self.visible && self.hidden_at.is_some_and(|at| at.elapsed() >= RELEASE_AFTER) {
            self.shell = None;
            self.context = None;
            self.ready = false;
            self.sent = 0;
            self.hidden_at = None;
            self.placed = None;
        }
    }

    fn show(&mut self, target: &EventLoopWindowTarget<Ev>, capture: bool) {
        // Before anything is drawn: which program was the user in?
        if capture {
            self.target = os::capture();
            self.notice = None;
        }
        self.build(target);
        self.place(target);
        let Some(shell) = &self.shell else { return };
        let window = &shell.window;
        #[cfg(windows)]
        {
            use wry::WebViewExtWindows;
            Self::rest(&shell.view, false);
            let _ = shell.view.set_memory_usage_level(wry::MemoryUsageLevel::Normal);
        }
        let _ = shell.view.set_visible(true);
        window.set_visible(true);
        window.set_focus();
        os::raise(hwnd(window));
        let _ = shell.view.focus();
        let proxy = self.proxy.clone();
        os::grab(hwnd(window), self.keys, Some(Box::new(move |n| {
            let _ = proxy.send_event(Ev::Lang(n));
        })));
        self.visible = true;
        self.hidden_at = None;
        self.shown_at = Instant::now();
        if self.ready {
            self.open();
        }
    }

    /// The theme into the open window: its frame, what shows before the page draws, and the page.
    fn apply_theme(&self) {
        let Some(shell) = &self.shell else { return };
        shell.window.set_theme(self.theme);
        let _ = shell.view.set_background_color(background(self.theme.unwrap_or_else(|| shell.window.theme())));
        if self.visible && self.ready {
            self.send(&json!({ "t": "theme", "theme": self.theme_name() }));
        }
    }

    /// The theme as the page names it; "" leaves the page to the system's.
    fn theme_name(&self) -> &'static str {
        match self.theme {
            Some(Theme::Dark) => "dark",
            Some(Theme::Light) => "light",
            _ => "",
        }
    }

    /// Where the window's middle goes on a screen, as shares of its width and height: where it was
    /// last dragged to, or the middle.
    fn saved_place(&self) -> (f64, f64) {
        let saved = self.db.lock().ok().and_then(|db| db.meta("place")).unwrap_or_default();
        let mut shares = saved.split(',').map(|part| part.trim().parse::<f64>().ok().filter(|share| (0.0..=1.0).contains(share)));
        match (shares.next().flatten(), shares.next().flatten()) {
            (Some(x), Some(y)) => (x, y),
            _ => (0.5, 0.5),
        }
    }

    /// Stores where the person left the window, as shares of the screen it is on, and its size.
    /// The next opening lays it out again from them, on whichever screen is being worked on then.
    fn remember_place(&mut self) {
        self.remember_at = None;
        let Some(shell) = &self.shell else { return };
        let window = &shell.window;
        let (Ok(at), Some(monitor)) = (window.outer_position(), window.current_monitor()) else { return };
        // All in the pixels of the screen the window is on.
        let (size, p, s) = (window.outer_size(), monitor.position(), monitor.size());
        let share = |at: i32, side: u32, origin: i32, screen: u32| (((at - origin) as f64 + side as f64 / 2.0) / screen.max(1) as f64).clamp(0.0, 1.0);
        let (x, y) = (share(at.x, size.width, p.x, s.width), share(at.y, size.height, p.y, s.height));
        let inner = window.inner_size().to_logical::<f64>(window.scale_factor());
        if let Ok(db) = self.db.lock() {
            db.set_meta("place", &format!("{x:.4},{y:.4}"));
            db.set_meta("size", &format!("{:.0},{:.0}", inner.width, inner.height));
        }
        self.dip = Some((inner.width, inner.height));
        self.placed = None;
    }

    /// The size the person last gave the window, in DIPs, within the bounds; the first one until then.
    fn saved_size(&self) -> (f64, f64) {
        let saved = self.db.lock().ok().and_then(|db| db.meta("size")).unwrap_or_default();
        let mut sides = saved.split(',').map(|part| part.trim().parse::<f64>().ok().filter(|side| side.is_finite()));
        match (sides.next().flatten(), sides.next().flatten()) {
            (Some(width), Some(height)) => (width.clamp(MIN_SIZE.0, MAX_SIZE.0), height.clamp(MIN_SIZE.1, MAX_SIZE.1)),
            _ => SIZE,
        }
    }

    fn resized(&mut self, size: PhysicalSize<u32>) {
        let (Some(shell), Some((width, height))) = (&self.shell, self.dip) else { return };
        let now = size.to_logical::<f64>(shell.window.scale_factor());
        // Our own resizes land on the size given (the system may round it by a pixel).
        if (now.width - width).abs() > 2.0 || (now.height - height).abs() > 2.0 {
            // Resizing by the left or top edge moves the window too: those moves are the person's.
            self.dragging = true;
            self.remember_at = Some(Instant::now() + REMEMBER_AFTER);
        }
    }

    /// Back to the middle of the screen being worked on, forgetting where it was dragged to.
    fn recenter(&mut self, target: &EventLoopWindowTarget<Ev>) {
        if let Ok(db) = self.db.lock() {
            db.set_meta("place", "");
        }
        self.remember_at = None;
        self.placed = None;
        self.place(target);
    }

    /// Sizes and places the window for the screen being worked on: the one with the window that had
    /// the focus, else the one under the pointer. Its middle goes where it was last dragged to (the
    /// screen's middle until then), all of it on that screen. Done while hidden, and only when the
    /// screen differs or the place was changed.
    ///
    /// Everything is worked out in the units the system places windows in: points on macOS, pixels
    /// on Windows. On macOS tao gives each screen in the pixels of its own density but turns the
    /// pixels it is given into points by the density of the screen the window is on now: pixels of
    /// two screens of different densities never mix there, and points are handed to it instead.
    fn place(&mut self, target: &EventLoopWindowTarget<Ev>) {
        let Some(shell) = &self.shell else { return };
        let window = &shell.window;
        // Pixels per unit on a screen of this density.
        let unit = |scale: f64| if cfg!(target_os = "macos") { scale } else { 1.0 };
        // A screen's left, top, width and height, in units.
        let bounds = |monitor: &MonitorHandle| {
            let (p, s, unit) = (monitor.position(), monitor.size(), unit(monitor.scale_factor()));
            (p.x as f64 / unit, p.y as f64 / unit, s.width as f64 / unit, s.height as f64 / unit)
        };
        let screen_at = |(x, y): (f64, f64)| {
            target.available_monitors().find(|monitor| {
                let (left, top, width, height) = bounds(monitor);
                x >= left && x < left + width && y >= top && y < top + height
            })
        };
        let monitor = self
            .target
            .as_ref()
            .and_then(os::front_point)
            .and_then(screen_at)
            .or_else(|| {
                // In the pixels of the main screen.
                let cursor = window.cursor_position().ok()?;
                let unit = unit(window.primary_monitor()?.scale_factor());
                screen_at((cursor.x / unit, cursor.y / unit))
            })
            .or_else(|| window.current_monitor())
            .or_else(|| window.primary_monitor());
        let Some(monitor) = monitor else { return };
        let scale = monitor.scale_factor();
        let (left, top, width, height) = bounds(&monitor);
        let key = (left as i32, top as i32, width as u32, height as u32, scale.to_bits());
        if self.placed == Some(key) {
            return;
        }
        // The size in DIPs: the saved one, smaller on a screen it would not fit on.
        let (screen_w, screen_h) = (width * unit(scale) / scale, height * unit(scale) / scale);
        let (cap_w, cap_h) = ((screen_w * SCREEN_SHARE.0).min(MAX_SIZE.0), (screen_h * SCREEN_SHARE.1).min(MAX_SIZE.1));
        let (want_w, want_h) = self.saved_size();
        let dip = (want_w.min(cap_w), want_h.min(cap_h));
        self.dip = Some(dip);
        // The moves made here are not the person's.
        self.dragging = false;
        let (x, y) = self.saved_place();
        // Pixels per DIP over pixels per unit: units per DIP.
        let per_dip = scale / unit(scale);
        let (side_w, side_h) = (dip.0 * per_dip, dip.1 * per_dip);
        let at = |outer_w: f64, outer_h: f64| -> Position {
            let axis = |origin: f64, screen: f64, side: f64, share: f64| origin + (screen * share - side / 2.0).clamp(0.0, (screen - side).max(0.0));
            let (x, y) = (axis(left, width, outer_w, x), axis(top, height, outer_h, y));
            if cfg!(target_os = "macos") {
                LogicalPosition::new(x, y).into()
            } else {
                PhysicalPosition::new(x.round() as i32, y.round() as i32).into()
            }
        };
        let size: Size = if cfg!(target_os = "macos") {
            LogicalSize::new(side_w, side_h).into()
        } else {
            PhysicalSize::new(side_w.round() as u32, side_h.round() as u32).into()
        };
        // Onto the screen first (its density applies, see ScaleFactorChanged), then the size, then
        // the place again for the outer size it now has: a frame the system adds is counted. On
        // macOS the window has no frame, and the changes land later, in order.
        window.set_outer_position(at(side_w, side_h));
        // The bound first: the old screen's may be smaller than the size given now.
        window.set_max_inner_size(Some(LogicalSize::new(cap_w.max(MIN_SIZE.0), cap_h.max(MIN_SIZE.1))));
        window.set_inner_size(size);
        #[cfg(windows)]
        {
            let outer = window.outer_size();
            window.set_outer_position(at(outer.width as f64, outer.height as f64));
        }
        self.placed = Some(key);
    }

    /// What the page lacks since it last heard from us: changed rows, or the whole list.
    fn changes(&mut self) -> Value {
        let Ok(mut db) = self.db.lock() else { return Value::Null };
        let _ = db.expire(now_ms());
        let sync = db.since(self.sent);
        self.sent = db.version;
        match sync {
            Catch::Nothing => Value::Null,
            Catch::Patch { rows, gone } => json!({ "rows": rows, "gone": gone }),
            Catch::Full(items) => json!({ "items": items }),
        }
    }

    /// Tells the page it is on screen again, with what changed meanwhile.
    fn open(&mut self) {
        let sync = self.changes();
        // Once per page: later translations are sent as they finish.
        let history = if self.history_sent { Value::Null } else { self.db.lock().map(|db| db.translations()).unwrap_or(Value::Null) };
        self.history_sent = true;
        let prefs = self.prefs();
        let notice = self.notice.take();
        self.send(&json!({
            "t": "open",
            "sync": sync,
            "history": history,
            "prefs": prefs,
            "bots": self.bots,
            "bot": self.bot,
            "keys": (1..=9).filter(|digit| self.keys & 1 << digit != 0).collect::<Vec<u8>>(),
            "app": self.target.as_ref().map(|t| t.app.clone()).unwrap_or_default(),
            "theme": self.theme_name(),
            "notice": notice.map(|(message, tone, perm)| json!({ "message": message, "tone": tone, "perm": perm })),
        }));
    }

    fn prefs(&self) -> Value {
        let db = self.db.lock();
        let get = |key: &str| db.as_ref().ok().and_then(|db| db.meta(key)).unwrap_or_default();
        json!({ "bot": get("bot"), "to": get("to"), "mode": get("mode") })
    }

    /// Tells the host the pinned texts when they differ from what it knows, or answers its `rid`.
    fn share_pins(&mut self, rid: Option<i64>) {
        let pins = match self.db.lock() {
            Ok(db) => db.pins(),
            Err(_) => return,
        };
        if rid.is_none() && self.shared.as_ref() == Some(&pins) {
            return;
        }
        let items: Vec<Value> = pins.iter().map(|(text, at)| json!({ "text": text, "at": at })).collect();
        self.shared = Some(pins);
        let mut event = json!({ "event": "pins", "items": items });
        if let Some(rid) = rid {
            event["rid"] = json!(rid);
        }
        emit(event);
    }

    fn push_changes(&mut self) {
        let sync = self.changes();
        if !sync.is_null() {
            self.send(&json!({ "t": "sync", "sync": sync }));
        }
    }

    fn hide(&mut self, restore: bool) {
        if !self.visible {
            return;
        }
        self.visible = false;
        // The keys the window took go back to the system and the other programs.
        os::grab(0, 0, None);
        self.park();
        self.send(&json!({ "t": "close" }));
        if restore {
            if let Some(target) = self.target.clone() {
                std::thread::spawn(move || {
                    os::restore(&target);
                });
            }
        }
    }

    fn send(&self, message: &Value) {
        if let Some(shell) = &self.shell {
            // The page's receiver takes the JSON text as is.
            let _ = shell.view.evaluate_script(&format!("window.__r({message})"));
        }
    }

    fn type_into(&mut self, text: String) {
        // A trailing line break would be typed as Return and send what was just typed (a chat, a shell).
        let text = match text.trim_end_matches(['\r', '\n']) {
            "" => text,
            trimmed => trimmed.to_string(),
        };
        // Every inner line break would be typed as Return too: several lines go in as one paste.
        if text.contains(['\r', '\n']) {
            if let Err(error) = os::set_clipboard(&text) {
                return self.send(&json!({ "t": "toast", "message": error, "tone": "bad" }));
            }
            return self.paste_clipboard();
        }
        let Some(target) = self.target.clone() else {
            return self.fail(text, "there is no program to type into");
        };
        self.hide(false);
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = (|| {
                if text.chars().count() > crate::MAX_CHARS {
                    return Err(format!("too long to type (over {} characters)", crate::MAX_CHARS));
                }
                // The Enter that asked for this must not reach the target once it is in front.
                os::wait_enter_released();
                if !os::restore(&target) {
                    return Err(format!("cannot return to {}", target.app));
                }
                if !os::wait_modifiers() {
                    return Err("a modifier key is held down".to_string());
                }
                crate::platform::type_text(&text, Way::Unicode).map(|_| ())
            })();
            let _ = proxy.send_event(Ev::Typed(result, text));
        });
    }

    /// An image cannot be typed: it goes on the clipboard and is pasted into the program in front.
    fn paste_image(&mut self, id: i64) {
        let data = self.db.lock().ok().and_then(|mut db| {
            let data = db.image(id);
            let _ = db.used(id, now_ms());
            data
        });
        let Some(data) = data else { return };
        if let Err(error) = os::set_image(&data) {
            return self.send(&json!({ "t": "toast", "message": error, "tone": "bad" }));
        }
        self.paste_clipboard();
    }

    /// ⌘V / Ctrl+V of what was just put on the clipboard into the program in front.
    fn paste_clipboard(&mut self) {
        let Some(target) = self.target.clone() else {
            return self.send(&json!({ "t": "toast", "message": "there is no program to paste into · it is on the clipboard", "tone": "bad" }));
        };
        self.hide(false);
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = (|| {
                os::wait_enter_released();
                if !os::restore(&target) {
                    return Err(format!("cannot return to {}", target.app));
                }
                if !os::wait_modifiers() {
                    return Err("a modifier key is held down".to_string());
                }
                crate::platform::paste()
            })();
            let _ = proxy.send_event(Ev::Pasted(result));
        });
    }

    fn fail(&mut self, text: String, message: &str) {
        let _ = os::set_clipboard(&text);
        self.send(&json!({ "t": "toast", "message": format!("{message} · copied to the clipboard"), "tone": "bad" }));
    }

    fn page_message(&mut self, value: Value, target: &EventLoopWindowTarget<Ev>) {
        let kind = value.get("t").and_then(Value::as_str).unwrap_or("");
        let id = value.get("id").and_then(Value::as_i64);
        match kind {
            "ready" => {
                self.ready = true;
                if self.visible {
                    self.open();
                }
            }
            "hide" => self.hide(true),
            // A press on the header's empty parts: the system moves the window until it is let go.
            "drag" => {
                if let Some(shell) = &self.shell {
                    self.dragging = true;
                    let _ = shell.window.drag_window();
                }
            }
            "center" => self.recenter(target),
            // The top edge on Windows, where the page lies over the window's own: resized by the system.
            "resize" => {
                #[cfg(windows)]
                if let Some(shell) = &self.shell {
                    let _ = shell.window.drag_resize_window(tao::window::ResizeDirection::North);
                }
            }
            "trDel" => {
                if let Some(id) = id {
                    if let Ok(mut db) = self.db.lock() {
                        let _ = db.delete_translation(id);
                    }
                }
            }
            "pin" => {
                if let (Some(id), Some(on)) = (id, value.get("on").and_then(Value::as_bool)) {
                    if let Ok(mut db) = self.db.lock() {
                        let _ = db.pin(id, on, now_ms());
                    }
                    // The page placed it already; this hands it the pin time that orders it.
                    self.push_changes();
                    self.share_pins(None);
                }
            }
            // The page shows the new text already; the answer names the row that holds it.
            "edit" => {
                if let (Some(id), Some(text)) = (id, value.get("text").and_then(Value::as_str)) {
                    let edited = self.db.lock().map_err(|e| e.to_string()).and_then(|mut db| db.edit(id, text));
                    match edited {
                        Ok(row) => {
                            self.push_changes();
                            self.share_pins(None);
                            self.send(&json!({ "t": "edited", "id": id, "row": row }));
                        }
                        Err(error) => {
                            self.push_changes();
                            self.send(&json!({ "t": "edited", "id": id, "error": error }));
                        }
                    }
                }
            }
            "del" => {
                if let Some(id) = id {
                    if let Ok(mut db) = self.db.lock() {
                        let _ = db.delete(id);
                    }
                    self.share_pins(None);
                }
            }
            "full" => {
                if let Some(id) = id {
                    let text = self.db.lock().ok().and_then(|db| db.full(id));
                    self.send(&json!({ "t": "full", "id": id, "text": text }));
                }
            }
            // Type a stored text into the program in front before the window opened.
            "type" => {
                if let Some(id) = id.filter(|id| *id < 0) {
                    return self.paste_image(id);
                }
                if let Some(id) = id {
                    let text = self.db.lock().ok().and_then(|mut db| {
                        let text = db.full(id);
                        let _ = db.used(id, now_ms());
                        text
                    });
                    if let Some(text) = text {
                        self.type_into(text);
                    }
                }
            }
            "typeText" => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    self.type_into(text.to_string());
                }
            }
            "use" => {
                if let Some(id) = id.filter(|id| *id < 0) {
                    let data = self.db.lock().ok().and_then(|mut db| {
                        let data = db.image(id);
                        let _ = db.used(id, now_ms());
                        data
                    });
                    if let Some(data) = data {
                        match os::set_image(&data) {
                            Ok(()) => self.hide(true),
                            Err(error) => self.send(&json!({ "t": "toast", "message": error, "tone": "bad" })),
                        }
                    }
                    return;
                }
                if let Some(id) = id {
                    let text = self.db.lock().ok().and_then(|mut db| {
                        let text = db.full(id);
                        let _ = db.used(id, now_ms());
                        text
                    });
                    if let Some(text) = text {
                        if let Err(error) = os::set_clipboard(&text) {
                            return self.send(&json!({ "t": "toast", "message": error, "tone": "bad" }));
                        }
                        self.hide(true);
                    }
                }
            }
            "copyText" => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    match os::set_clipboard(text) {
                        Ok(()) => self.hide(true),
                        Err(error) => self.send(&json!({ "t": "toast", "message": error, "tone": "bad" })),
                    }
                }
            }
            "openPerm" => {
                if let Err(error) = crate::platform::open_permission() {
                    self.send(&json!({ "t": "toast", "message": error, "tone": "bad" }));
                }
            }
            "pref" => {
                if let (Some(key), Some(v)) = (value.get("k").and_then(Value::as_str), value.get("v").and_then(Value::as_str)) {
                    if matches!(key, "bot" | "to" | "mode") {
                        if let Ok(db) = self.db.lock() {
                            db.set_meta(key, v);
                        }
                    }
                }
            }
            "tr" => {
                if let (Some(rid), Some(text)) = (value.get("rid").and_then(Value::as_i64), value.get("text").and_then(Value::as_str)) {
                    let field = |name: &str| value.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
                    // A request the host dropped unanswered (the window closed) is not waited for long.
                    self.asked.retain(|asked, _| *asked > rid - 32);
                    self.asked.insert(rid, (text.to_string(), field("to"), field("bot")));
                }
                let mut event = value.clone();
                event["event"] = json!("translate");
                if let Some(object) = event.as_object_mut() {
                    object.remove("t");
                }
                emit(event);
            }
            "trCancel" => {
                if let Some(rid) = value.get("rid") {
                    if let Some(rid) = rid.as_i64() {
                        self.asked.remove(&rid);
                    }
                    emit(json!({ "event": "cancel", "rid": rid }));
                }
            }
            _ => {}
        }
    }
}

/// What shows behind the page before it draws: its own background colour in that theme.
fn background(theme: Theme) -> (u8, u8, u8, u8) {
    if theme == Theme::Dark {
        (30, 30, 32, 255)
    } else {
        (252, 252, 253, 255)
    }
}

#[cfg(target_os = "macos")]
fn permission_missing() -> bool {
    crate::macos::permission_problem().is_some()
}

#[cfg(windows)]
fn permission_missing() -> bool {
    false
}

#[cfg(windows)]
fn hwnd(window: &Window) -> isize {
    use tao::platform::windows::WindowExtWindows;
    window.hwnd() as isize
}

#[cfg(not(windows))]
fn hwnd(_: &Window) -> isize {
    0
}
