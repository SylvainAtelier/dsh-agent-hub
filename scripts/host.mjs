// esbuild options of the host half, shared by build.mjs and the bundle test.
// The host half is ESM, where `require` does not exist; a bundled CommonJS
// dependency (yaml, for one) that requires a Node builtin would throw
// `Dynamic require of "process" is not supported` while the module loads,
// and DSH could not enable the plugin. The banner gives the bundle a real one.
export const HOST = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __agentHubCreateRequire } from 'node:module';\nconst require = __agentHubCreateRequire(import.meta.url);" },
  // The Agent SDK stays a runtime dependency: it spawns the user's own
  // Claude Code CLI and resolves its own files next to its module. zod (the
  // team bridge's tool schemas) is a dependency of both, so it stays one too.
  external: ['@deepseek-ai/*', '@anthropic-ai/claude-agent-sdk', 'zod', '@vscode/ripgrep'],
}
