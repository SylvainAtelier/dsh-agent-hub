/**
 * The language of server-side text a user or a model reads (notifications, session titles,
 * default prompts, errors): the UI language DSH is set to (Settings → General), stored by
 * `@deepseek-ai/dsh-client-locale` as its entry's `preference`. Without one, the browser picks
 * from the system's languages, so the OS locale stands in for it here. Only Chinese and English
 * have text; any other language reads English, as DSH's own fallback does.
 */

/** The host locale plugin, whose profile entry carries the UI language. */
const LOCALE_PLUGIN = '@deepseek-ai/dsh-client-locale'

/** What {@link hostLocale} reads: the Loader's entries, each with its raw config. */
interface LocaleHost {
  get(name: string): unknown
}
interface LoaderEntries {
  entries(): Iterable<{ options: { name?: string; config?: { preference?: unknown } | null } }>
}

const system = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return ''
  }
}

let source: () => string | undefined = () => undefined

/** The UI language DSH stores, read live from the Loader; undefined while unset or unreadable. */
export function hostLocale(ctx: LocaleHost): () => string | undefined {
  return () => {
    try {
      const loader = ctx.get('loader') as LoaderEntries | undefined
      for (const entry of loader?.entries() ?? []) {
        if (entry.options.name !== LOCALE_PLUGIN) continue
        const preference = entry.options.config?.preference
        if (typeof preference === 'string' && preference !== '') return preference
      }
    } catch {}
    return undefined
  }
}

/** Read the UI language from `read` (undefined: the OS locale decides); returns the disposer restoring the last source. */
export function setLocaleSource(read: () => string | undefined): () => void {
  const previous = source
  source = read
  return () => { if (source === read) source = previous }
}

/** The active language id: DSH's UI language, else the OS locale. */
export function locale(): string {
  let id: string | undefined
  try {
    id = source()
  } catch {}
  return id ?? system()
}

/** Whether server-side text is written in English: anything but Chinese. */
export function english(): boolean {
  return !/^zh(?![a-z])/i.test(locale())
}

/** The text for the active language. */
export function localized<T>(text: { zh: T; en: T }): T {
  return english() ? text.en : text.zh
}
