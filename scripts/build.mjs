// Host half: an ESM module the DSH loader imports (runtime @deepseek-ai/*
// packages are provided by the host). Client half: a CommonJS factory wrapped
// in the host's module loader, which supplies react/react-dom via `require`.
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { HOST } from './host.mjs'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

await build({ ...HOST, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' })

// Standalone, import-safe CN task. Merely installing the plugin never runs it.
await mkdir('lib/bin', { recursive: true })
await copyFile('scripts/qoder-daily-credit.mjs', 'lib/bin/qoder-daily-credit.mjs')

const browser = {
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  // xterm's stylesheet ships as text and is injected with the terminal screen.
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
}

// Registered under the id the host module loader resolves; `require` is the loader's.
const wrap = (id, code) => `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${code}
    return module.exports;
  }
});
`

const client = await build({ ...browser, entryPoints: ['src/client/index.tsx'] })
await writeFile('lib/client.js', wrap(pkg.name, client.outputFiles[0].text))

// The clipboard and translation window is a page the native helper (dsh-type --palette) shows in
// a system web view: one self-contained file, read from disk only when the window is first built.
const palette = await build({ ...browser, format: 'iife', entryPoints: ['src/client/palette/page.ts'] })
const paletteScript = palette.outputFiles[0].text.replaceAll('</script', '<\\/script')
if (['win32', 'darwin'].includes(process.platform) && !existsSync(`lib/bin/${process.platform}-${process.arch}/dsh-type${process.platform === 'win32' ? '.exe' : ''}`)) {
  console.warn('Native helper missing: the clipboard window and Cardputer typing stay off until `pnpm build:native` is run')
}
await writeFile('lib/palette.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clipboard</title></head><body><script>${paletteScript}</script></body></html>`)

// Selection discussions load their panel and Markdown parser only on first open.
const discussion = await build({ ...browser, entryPoints: ['src/client/discussion/Panel.tsx'] })
await writeFile('lib/client.discussion.js', wrap(`${pkg.name}/client.discussion.js`, discussion.outputFiles[0].text))

// The terminal screen (xterm, ~350 KB) is a package-local chunk the panel loads on
// first open through `require.async('./client.terminal.js')`, not at startup.
const terminal = await build({ ...browser, entryPoints: ['src/client/git/screen.tsx'] })
await writeFile('lib/client.terminal.js', wrap(`${pkg.name}/client.terminal.js`, terminal.outputFiles[0].text))

// The code editor (CodeMirror and its languages) is another such chunk, loaded on the first code tab.
const editor = await build({ ...browser, entryPoints: ['src/client/editor/chunk/index.ts'] })
await writeFile('lib/client.editor.js', wrap(`${pkg.name}/client.editor.js`, editor.outputFiles[0].text))

// Each bundled IDE font is its own lazy chunk. Selecting one never downloads or decodes the other four.
const fonts = [
  ['fira-code', 'src/client/font/chunk.ts'],
  ['roboto-mono', 'src/client/font/roboto-mono.ts'],
  ['jetbrains-mono', 'src/client/font/jetbrains-mono.ts'],
  ['source-code-pro', 'src/client/font/source-code-pro.ts'],
  ['ibm-plex-mono', 'src/client/font/ibm-plex-mono.ts'],
]
for (const [id, entry] of fonts) {
  const font = await build({ ...browser, entryPoints: [entry], loader: { ...browser.loader, '.woff2': 'base64' } })
  const file = `client.font.${id}.js`
  await writeFile(`lib/${file}`, wrap(`${pkg.name}/${file}`, font.outputFiles[0].text))
}

const licenses = [
  ['node_modules/@fontsource-variable/fira-code/LICENSE', 'FiraCode-OFL.txt'],
  ['node_modules/@fontsource-variable/roboto-mono/LICENSE', 'RobotoMono-OFL.txt'],
  ['node_modules/@fontsource-variable/jetbrains-mono/LICENSE', 'JetBrainsMono-OFL.txt'],
  ['node_modules/@fontsource-variable/source-code-pro/LICENSE', 'SourceCodePro-OFL.txt'],
  ['node_modules/@fontsource/ibm-plex-mono/LICENSE', 'IBMPlexMono-OFL.txt'],
]
for (const [source, target] of licenses) await copyFile(source, `lib/${target}`)
