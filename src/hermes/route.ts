/**
 * The `hermes-agent` model route: the local Hermes Agent over ACP
 * (`hermes-acp`), one model per persona. Hermes keeps each persona (a
 * profile) in a home of its own, `<root>/profiles/<name>`, with its own
 * model, memory, SOUL and skills; the root home is the `default` persona.
 * Picking a persona runs its turns in a process pinned to that home
 * (HERMES_HOME), on the model the persona is configured with, so DSH lists
 * the personas from their folders instead of probing a session. Hermes asks
 * before dangerous commands and file edits; those become DSH approval dialogs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { parse } from 'yaml'
import type { AcpProfile, RouteModel } from '../acp/route.ts'

export const HERMES_PROVIDER = 'hermes-agent'
/** Failure code for a persona whose model provider is signed out; outside DSH's retryable set. */
export const HERMES_AUTH = 'HERMES_AUTH'
/** The root home's persona, as Hermes itself names it (`hermes -p default`). */
export const DEFAULT_PERSONA = 'default'

/** Profile names Hermes creates: lowercase letters, digits, `-` and `_`. */
const PERSONA = /^[a-z0-9][a-z0-9_-]{0,63}$/

const EXE = process.platform === 'win32' ? 'hermes-acp.exe' : 'hermes-acp'

/**
 * Hermes' root home: HERMES_HOME (its root when it names a profile), else
 * %LOCALAPPDATA%\hermes on Windows and ~/.hermes elsewhere.
 */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const pinned = env.HERMES_HOME?.trim()
  if (pinned) return basename(dirname(pinned)) === 'profiles' ? dirname(dirname(pinned)) : pinned
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'hermes')
  return join(home, '.hermes')
}

/**
 * The ACP server's executable, or undefined when Hermes is not installed:
 * the installer's bin folder, ~/.local/bin (missing from the PATH of an app
 * started from the Dock), then PATH.
 */
export function findHermes(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync, root = hermesRoot(env), home = homedir()): string | undefined {
  const dirs = [join(root, 'bin'), join(home, '.local', 'bin'), ...(env.PATH ?? env.Path ?? '').split(delimiter).filter((part) => part !== '')]
  return dirs.map((dir) => join(dir, EXE)).find((file) => exists(file))
}

/** A persona's home: the root for `default`, else its profile folder. */
export function personaHome(root: string, persona: string): string {
  return persona === DEFAULT_PERSONA ? root : join(root, 'profiles', persona)
}

const readYaml = (file: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = parse(readFileSync(file, 'utf8'))
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** `model: {default: x}` or the older `model: x`. */
function configuredModel(config: Record<string, unknown> | undefined): string | undefined {
  const model = config?.model
  const id = typeof model === 'string' ? model : (model as { default?: unknown } | undefined)?.default
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

/** The persona in a home (named with its model, described by its profile.yaml), or undefined when the folder is not a Hermes home. */
function persona(id: string, home: string): RouteModel | undefined {
  const config = readYaml(join(home, 'config.yaml'))
  if (config === undefined) return undefined
  const model = configuredModel(config)
  const description = readYaml(join(home, 'profile.yaml'))?.description
  return {
    id,
    name: model === undefined ? id : `${id} · ${model}`,
    ...(typeof description === 'string' && description.trim() !== '' ? { description: description.trim().replace(/\s+/g, ' ') } : {}),
  }
}

/** Every persona: `default` first, then the profiles by name. */
export function listPersonas(root = hermesRoot()): RouteModel[] {
  let names: string[] = []
  try {
    names = readdirSync(join(root, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PERSONA.test(entry.name) && entry.name !== DEFAULT_PERSONA)
      .map((entry) => entry.name)
      .sort()
  } catch {
    // No profiles yet: the root home alone.
  }
  return [DEFAULT_PERSONA, ...names].map((id) => persona(id, personaHome(root, id))).filter((entry): entry is RouteModel => entry !== undefined)
}

export const INSTALL_HINT = 'Hermes or this persona was not found: install Hermes (iex (irm https://hermes-agent.nousresearch.com/install.ps1), or curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash), or check the persona with hermes profile list'

export function hermesProfile(find: () => string | undefined = findHermes, root: () => string = hermesRoot): AcpProfile {
  return {
    provider: HERMES_PROVIDER,
    name: 'Hermes',
    process: (model) => {
      const command = find()
      const home = personaHome(root(), model)
      if (command === undefined || !PERSONA.test(model) || !existsSync(join(home, 'config.yaml'))) return undefined
      // Pinned to the persona's home, also for `default`, so a sticky `hermes profile use` does not move it.
      return { key: model, command, args: [], env: { ...process.env, HERMES_HOME: home } }
    },
    missing: INSTALL_HINT,
    signIn: 'This Hermes persona\'s model provider is not signed in, so this turn was not sent. Run hermes -p <persona> auth (or hermes -p <persona> model) in a terminal, then send again.',
    authCode: HERMES_AUTH,
    models: async () => listPersonas(root()),
    // Each persona answers on its own configured model.
    agentModel: () => undefined,
  }
}
