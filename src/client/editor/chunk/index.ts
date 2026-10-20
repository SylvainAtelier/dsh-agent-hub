/**
 * The editor chunk (lib/client.editor.js): CodeMirror and the code tab's
 * body, fetched on the first code tab through the host module loader's
 * `require.async`, so DSH's startup does not pay for it.
 */

export { CodeEditor } from './Editor.tsx'
