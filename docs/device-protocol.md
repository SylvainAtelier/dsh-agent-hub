# Cardputer device protocol (v1)

## Status and validation boundary

The plugin host and Node simulator are implemented and exercised on Windows. The native helper passes Windows tests and macOS ARM64/Intel Rust type checks. macOS linking, TCC permission attribution, Chinese IME compatibility, ESP32 TLS-PSK support, device UI, microphone capture, reconnect behavior and actual keyboard input still require hardware testing. This repository does **not** contain flashable Cardputer firmware. Do not treat the simulator as firmware.

## Transport and discovery

- DNS-SD service: `_dsh._tcp.local`; SRV port and TXT host identity (see `src/device/mdns.ts`). Manual IP/port is a valid fallback.
- TLS 1.2, suites `PSK-AES128-GCM-SHA256:PSK-CHACHA20-POLY1305`. Each paired device has a unique 32-byte PSK and `cp-...` identity.
- One RFC 6455 WebSocket at `/device`; client frames masked, no extensions. TLS identity authenticates the device. No HTTP bearer token or browser cookie is used.
- The listener opens only while a device is paired or a two-minute pairing window is active. It listens on all interfaces; restrict firewall access to trusted local networks. Do not expose/forward this port to the public internet.
- 32 concurrent TCP connections, 5-second TLS and HTTP upgrade deadlines; 8 KiB HTTP headers; 256 KiB messages, 1024 fragments per message. Slow readers exceeding 1 MiB queued writes are disconnected.
- Client `hello` every 30 seconds; host disconnects after 75 seconds without application traffic. Firmware should reconnect with exponential backoff and jitter, and stop retrying automatically after a revoked PSK is rejected.

## Pairing

Select Add device in DSH, then select the computer on the device. The public pairing identity is `pair`; its TLS PSK is `SHA256(UTF8("dsh-device-pair"))`. **This public outer PSK provides no identity authentication.** Authentication comes from the exchange and a human comparing both displays, not entering a six-digit password.

1. Device generates X25519 key pair and random 16-byte nonce `Nd`; sends `{t:"pair",name,pk:base64(PKd)}`.
2. Host generates its X25519 key pair and random 16-byte nonce `Nh`; sends `{t:"pair-commit",pk:base64(PKh),c:base64(HMAC-SHA256(Nh,PKh||PKd)),host,hostId}`.
3. Device sends `{t:"pair-nonce",n:base64(Nd)}`.
4. Host sends `{t:"pair-reveal",n:base64(Nh)}`. Device verifies the commitment before displaying the code.
5. Both calculate the first big-endian uint32 of `SHA256("dsh-code"||PKd||PKh||Nd||Nh)` modulo 1,000,000, padded to six digits. Both screens must be checked by a human. This is a custom protocol, not Bluetooth interoperability or an independently audited security protocol.
6. Device sends `{t:"pair-ok"}` only after confirmation; host also requires confirmation from DSH. PSK = `HKDF-SHA256(X25519(shared),salt=Nd||Nh,info="dsh-device-psk",length=32)`.
7. Host atomically persists the key before sending `{t:"paired",id}` and closing the pairing socket. Device stores the identity and PSK securely, then reconnects with them. Max 16 paired devices. Failed/cancelled pairing must not retain keys.

Key/nonce/commitment fields are base64-encoded raw bytes, never DER. X25519 low-order keys must be rejected. See `src/device/pairing.ts` and the reproducible Node client in `src/device/client.ts` for exact encoding.

## State and commands

All application frames are UTF-8 JSON, except raw audio chunks. Unknown states should render as RUNNING. Unknown fields may be ignored.

Host snapshot example:

```json
{"t":"view","rev":5,"focus":"s1","agents":[{"id":"s1","agent":"Claude","ws":"api","state":"TOOL","task":"run tests","since":1770000000,"tool":"bash","model":"opus"}],"approve":true}
```

States: IDLE, RUNNING, THINKING, TOOL, SUBAGENT, WAIT_APPROVAL, WAIT_INPUT, DONE, ERROR. Up to eight rows, ordered by waiting, running, then recent. Host folds at most 256 sessions; irrelevant log events do not allocate tracks. Normal snapshots are coalesced for 250 ms and identical states are not resent. Approval changes flush immediately. `rev` is monotonic for this host instance, not a durable sequence or a delta protocol. A reconnect always receives a whole snapshot.

Commands:

```json
{"t":"hello","fw":"0.1.0","bat":82,"rssi":-58}
{"t":"cmd","id":"unique-1","op":"select","sid":"s1"}
{"t":"cmd","id":"unique-2","op":"send","sid":"s1","text":"continue testing"}
{"t":"cmd","id":"unique-3","op":"resume","sid":"s1"}
{"t":"cmd","id":"unique-4","op":"stop","sid":"s1"}
{"t":"cmd","id":"unique-5","op":"approve","ask":"ask-id"}
{"t":"cmd","id":"unique-6","op":"deny","ask":"ask-id"}
{"t":"cmd","id":"unique-7","op":"type","text":"dictation"}
```

Each command receives `{t:"ack",id,ok:true}` or `{t:"ack",id,ok:false,error}`. IDs are nonempty strings up to 80 characters. At most eight expensive commands are in flight per connection, with four independent reserved slots for stop/approval/navigation. Last 64 completed outcomes are retained for retry deduplication **within the same connection**; this is not exactly-once delivery across reconnects. Never automatically retry typing after an uncertain disconnect. A missing session ID uses the focus shown in the latest snapshot.

When waiting, snapshot `ask` is `{id,sid,tool,text,cwd,risk}`. The first answer from DSH or device wins. Risk-recognized operations and approval texts exceeding the device preview limit (256 characters) can only be denied on the device. Risk detection is conservative heuristics, **not** a general shell security parser or a replacement for host policy. Device firmware must require Enter held for 0.8 seconds before approving, make Back navigation-only, and consume the first key exclusively to wake a dark display. These physical safeguards cannot be verified by the host protocol.

## Voice and typing

```json
{"t":"voice","id":"voice-1","target":"agent","sid":"s1"}
```

Send binary PCM chunks (16 kHz, signed 16-bit little-endian, mono), then `{t:"voice-end",id:"voice-1"}`. At most one recording/recognition per device and two concurrent recognitions across the host; maximum two minutes / 3.84 MB / 8192 chunks. Recordings shorter than 300 ms or containing a partial sample are refused. Disconnect aborts recognition; the HTTP request also has a 30-second deadline. Workspace filename hints are capped at 3000 names, 128 directories, depth three, and eight cached workspaces for one minute.

Recognition returns `{t:"heard",id,text,target,sid?,app?}` and **does not execute the text**. Device displays the transcription and destination, permits correction/target switching, then sends an explicit `send` or `type` command. `target:"type"` obtains the current front app for preview. Focus may change between preview and confirmation: user must check the foreground app before confirming. Native helpers additionally stop when foreground app/window changes during injection, but no OS API makes this atomic.

`dsh-type` starts on demand, processes bounded JSON lines over stdio, and exits after five idle minutes. It is isolated from the DSH process, limits requests to 4000 Unicode characters and eight pending calls, rejects stuck requests after 15 seconds by terminating the helper, and never retries partial typing. Windows uses SendInput; macOS uses CoreGraphics and requires Accessibility permission. Both native implementations use Unicode events and **refuse paste** rather than risk clipboard data loss. `auto` currently means Unicode, not an IME-aware clipboard fallback. No clipboard content is read or modified.

The MiniMax multipart `model=asr-1.0`, `file`, optional `language` header and JSON `text` response follow the [official ASR API reference](https://platform.minimax.cn/docs/api-reference/speech-to-text). Keys and service availability still require a real account smoke test; automated tests do not upload audio or spend quota.

## Build and test

```sh
node scripts/build.mjs
node scripts/build-native.mjs
node --test --experimental-test-module-mocks test/device*.test.ts
```

Build native helpers on their target OS with Rust installed. An optional first argument selects `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`, `x86_64-apple-darwin`, or `aarch64-apple-darwin`. Binaries are copied into `lib/bin/<platform>-<arch>/` and included in the plugin package. A complete release must assemble and validate all desired OS/architecture artifacts; running the Windows build alone does not produce macOS binaries. macOS release signing/notarization and TCC verification remain release prerequisites.

Run the interactive Node simulator with `node scripts/device-sim.ts <host> <port>`. It keeps paired credentials in a specified local JSON file; do not commit that file. Hardware firmware must implement this protocol separately.
