/**
 * File name → syntax support. Lezer grammars where CodeMirror has them
 * (incremental, error tolerant), legacy stream modes for the rest. Unknown
 * files open as plain text.
 */

import { StreamLanguage, type LanguageSupport, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { css } from '@codemirror/lang-css'
import { sass } from '@codemirror/lang-sass'
import { less } from '@codemirror/lang-less'
import { html } from '@codemirror/lang-html'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { kotlin, csharp, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { r } from '@codemirror/legacy-modes/mode/r'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'

export interface Language {
  name: string
  load: () => Extension
}

const stream = (parser: StreamParser<unknown>): (() => Extension) => () => StreamLanguage.define(parser)
const lang = (support: () => LanguageSupport): (() => Extension) => support

const BY_EXTENSION: Record<string, Language> = {}
const add = (name: string, load: () => Extension, extensions: string[]): void => {
  for (const ext of extensions) BY_EXTENSION[ext] = { name, load }
}

add('TypeScript', lang(() => javascript({ typescript: true })), ['ts', 'mts', 'cts'])
add('TSX', lang(() => javascript({ typescript: true, jsx: true })), ['tsx'])
add('JavaScript', lang(() => javascript()), ['js', 'mjs', 'cjs'])
add('JSX', lang(() => javascript({ jsx: true })), ['jsx'])
add('Python', lang(python), ['py', 'pyi', 'pyw'])
add('CSS', lang(css), ['css'])
add('SCSS', lang(() => sass()), ['scss'])
add('Sass', lang(() => sass({ indented: true })), ['sass'])
add('Less', lang(less), ['less'])
add('HTML', lang(() => html()), ['html', 'htm', 'xhtml', 'vue', 'svelte', 'astro'])
add('JSON', lang(json), ['json', 'jsonc', 'json5', 'webmanifest', 'code-workspace', 'babelrc', 'eslintrc'])
add('Markdown', lang(() => markdown()), ['md', 'markdown', 'mdx'])
add('Rust', lang(rust), ['rs'])
add('Go', lang(go), ['go'])
add('Java', lang(java), ['java'])
add('C++', lang(cpp), ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino'])
add('PHP', lang(() => php()), ['php'])
add('SQL', lang(() => sql()), ['sql'])
add('XML', lang(() => xml()), ['xml', 'svg', 'xsd', 'xsl', 'plist', 'csproj', 'vbproj', 'props', 'targets', 'xaml', 'resx'])
add('YAML', lang(yaml), ['yaml', 'yml'])
add('Shell', stream(shell), ['sh', 'bash', 'zsh', 'fish', 'ksh', 'bashrc', 'zshrc', 'profile'])
add('TOML', stream(toml), ['toml'])
add('PowerShell', stream(powerShell), ['ps1', 'psm1', 'psd1'])
add('Lua', stream(lua), ['lua'])
add('Ruby', stream(ruby), ['rb', 'rake', 'gemspec'])
add('Swift', stream(swift), ['swift'])
add('Kotlin', stream(kotlin), ['kt', 'kts'])
add('C#', stream(csharp), ['cs', 'csx'])
add('Scala', stream(scala), ['scala', 'sc'])
add('Dart', stream(dart), ['dart'])
add('Objective-C', stream(objectiveC), ['m', 'mm'])
add('Diff', stream(diff), ['diff', 'patch'])
add('Properties', stream(properties), ['properties', 'ini', 'cfg', 'conf', 'env', 'editorconfig', 'gitconfig', 'npmrc'])
add('Protobuf', stream(protobuf), ['proto'])
add('CMake', stream(cmake), ['cmake'])
add('Groovy', stream(groovy), ['groovy', 'gradle'])
add('R', stream(r), ['r'])
add('Perl', stream(perl), ['pl', 'pm'])

const BY_NAME: Record<string, Language> = {
  dockerfile: { name: 'Dockerfile', load: stream(dockerFile) },
  containerfile: { name: 'Dockerfile', load: stream(dockerFile) },
  makefile: { name: 'Makefile', load: stream(shell) },
  'cmakelists.txt': { name: 'CMake', load: stream(cmake) },
  'nginx.conf': { name: 'Nginx', load: stream(nginx) },
  '.gitignore': { name: 'Ignore', load: stream(properties) },
  '.dockerignore': { name: 'Ignore', load: stream(properties) },
  '.prettierignore': { name: 'Ignore', load: stream(properties) },
  '.env': BY_EXTENSION.env!,
  gemfile: BY_EXTENSION.rb!,
  rakefile: BY_EXTENSION.rb!,
  'tsconfig.json': BY_EXTENSION.jsonc!,
}

export const PLAIN: Language = { name: 'Plain Text', load: () => [] }

export function languageOf(fileName: string): Language {
  const name = fileName.toLowerCase()
  const exact = BY_NAME[name]
  if (exact !== undefined) return exact
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return BY_NAME.dockerfile!
  if (name.startsWith('.env.')) return BY_EXTENSION.env!
  const dot = name.lastIndexOf('.')
  if (dot === -1) return PLAIN
  return BY_EXTENSION[name.slice(dot + 1)] ?? PLAIN
}
