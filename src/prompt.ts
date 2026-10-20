/**
 * Global instructions: one Markdown text, set in 设置 → Agent Hub, that every
 * conversation with every model receives.
 *
 * - DSH models: a section of its own at the end of the system prompt, added on
 *   DSH's `system-prompt/assemble` waterfall (bots included, after their persona).
 * - Claude Agent: Claude Code never reads DSH's system prompt, so the text is
 *   appended to Claude Code's own, after a bot's persona (claude/adapter.ts).
 *   A changed text resumes the session into a fresh process on its next turn.
 */

import { localized } from './locale.ts'

/** The plugin's global settings (`Config.prompt`). */
export interface PromptSettings {
  /** Markdown; blank injects nothing. */
  instructions?: string
  /** Teach the models to deliver visual results as canvases (canvas/index.ts); on unless false. */
  canvas?: boolean
  /** With canvases on: have the models draw structural diagrams with the Archify skill, when they have it; off unless true. */
  archify?: boolean
  /** Built-in rule ids of the find scans refused for every model (guard.ts). */
  blockedScans: readonly string[]
  /** Custom commands refused for every model, as typed (guard.ts). */
  blockedCommands: readonly string[]
}

/** The system prompt section the instructions occupy. */
export const INSTRUCTIONS_SECTION = 'agent-hub:global-instructions'

const HEADING = '# Global instructions\n\nThe user set these instructions for every conversation. Follow them unless the user says otherwise in the conversation.'

/** How a model delivers a visual result: a self-contained HTML file in `dir`, linked in its reply. */
function canvasText(dir: string): string {
  return `# Canvases

When the user wants a standalone analytical or visual result (charts, comparison tables, timelines, dashboards, data or architecture explorations: anything better seen than read), build it as a canvas rather than a Markdown table or a wall of text. Do not use one for ordinary answers, code changes, drafts, or when the user asked for a deliverable in a specific tool.

A canvas is one self-contained HTML file: all CSS, JavaScript and data inline, with no build step and no external scripts, fonts, images or network requests, so it opens anywhere and can be shared as it is. Make it interactive wherever that helps the reader (sorting, filtering, search, tooltips, tabs, toggles, drill-down), in plain JavaScript with hand-drawn SVG or canvas charts. Follow \`prefers-color-scheme\` for light and dark, keep it responsive, and give it a meaningful \`<title>\`.

Write it to \`${dir}/<short-kebab-name>.html\` (create the folder if needed; to revise an earlier canvas, rewrite that file instead of adding a copy). Then link it in your reply with its absolute path, as a Markdown link with forward slashes, such as [Title](${dir}/<short-kebab-name>.html) (a backslash in a Markdown link is an escape and breaks the path): clicking it opens the canvas beside the chat. If you have a \`present\` tool, also present the file. All canvases are browsed together in the ${localized({ zh: '画布', en: 'Canvases' })} panel.`
}

/** Structural diagrams through the Archify skill (github.com/tt-a1i/archify), still delivered as canvases in `dir`. */
function archifyText(dir: string): string {
  return `For a diagram of a system's architecture, a workflow, a sequence of calls, a data flow, a state lifecycle, a database schema (ERD), classes, a tree, a timeline or a waterfall of timings, use the \`archify\` skill if you have it, in its native diagram mode: give its \`finalize\` command \`${dir}/<short-kebab-name>.html\` as the output path (\`meta.output\` stays the relative path its contract requires) and its own working folder as \`--out-dir\`, so only the page and its \`.delivery.json\` land in the canvases folder, then link the page as above. Without the skill, and for every other result, write the canvas yourself; do not use Archify's explainer pages or change your rules file for its explainer modes.`
}

/** The text to inject (the user's instructions, then the canvas guide), or undefined when there is nothing to inject. */
export function instructionsText(settings: Pick<PromptSettings, 'instructions' | 'canvas' | 'archify'> | undefined, canvasDir?: string): string | undefined {
  const body = settings?.instructions?.trim() ?? ''
  // Forward slashes even on Windows: Markdown eats a backslash before punctuation (`\.dsh` → `.dsh`).
  const dir = canvasDir === undefined || settings?.canvas === false ? undefined : canvasDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const canvas = dir === undefined ? '' : canvasText(dir)
  const archify = dir !== undefined && settings?.archify === true ? archifyText(dir) : ''
  const parts = [body === '' ? '' : `${HEADING}\n\n${body}`, canvas, archify].filter((part) => part !== '')
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

interface Section {
  name: string
  text: string
  interpolate?: boolean
}

/** The assembly with the instructions as its last section (any earlier copy replaced). */
export function withInstructions<T extends { sections: ReadonlyArray<Section> }>(assembly: T, text: string | undefined): T {
  return withSection(assembly, INSTRUCTIONS_SECTION, text)
}

/** The assembly with one named section last (any earlier copy replaced); undefined text adds nothing. */
export function withSection<T extends { sections: ReadonlyArray<Section> }>(assembly: T, name: string, text: string | undefined): T {
  if (text === undefined) return assembly
  // Not interpolated: the user's Markdown may contain template-like braces.
  const section: Section = { name, text, interpolate: false }
  return { ...assembly, sections: [...assembly.sections.filter((item) => item.name !== name), section] }
}

/** What Claude Code's system prompt is appended with: a bot's persona, then the instructions. */
export function appendedPrompt(persona: string | undefined, instructions: string | undefined): string | undefined {
  const parts = [persona, instructions].filter((part): part is string => part !== undefined && part.trim() !== '')
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
