/**
 * 设置 → Agent Hub → 导出 / 导入: the profile's overrides as one JSON file
 * that applies on any machine. Only what the profile sets is exported, so an
 * option left at its default follows the importing machine's default. The one
 * machine-bound value, the local repositories a connector is linked to, is
 * written as the repository's folder name next to its path: importing links
 * the repository registered here under the same path, else the one with the
 * same name. Text is written with LF line ends. Sign-ins and tokens live in
 * DSH's credential store and are never part of the file.
 */

import { identitiesValid } from '../../git/identity.ts'
import { SCAN_RULES } from '../../guard.ts'
import { FONTS, regionsOf, SCALE_REGIONS, type ScaleRegion } from '../../appearance.ts'
import type { ConnectorEntry } from '../../connectors/types.ts'
import { samePath, type RepoGroup } from '../../repos/types.ts'
import { FIELDS, connectorsValid, profilesValid, type Doc, type FieldSpec, type Op } from './form.ts'

export const EXPORT_FORMAT = 'dsh-agent-hub/config'
export const EXPORT_VERSION = 1

/** A linked repository, portable: matched by path on the same machine, by folder name elsewhere. */
export interface PortableRepo {
  name: string
  path: string
}

export interface PortableConnector extends Omit<ConnectorEntry, 'repos'> {
  repos?: PortableRepo[]
}

export type ConfigDoc = Doc

export interface ConfigExport {
  format: typeof EXPORT_FORMAT
  version: number
  exportedAt: string
  config: ConfigDoc
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
const lf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** Forward slashes, no trailing separator: the same spelling whichever system wrote it. */
const portablePath = (path: string): string => {
  const slashed = path.replace(/\\/g, '/')
  return slashed.length > 1 && !/^[a-z]:\/$/i.test(slashed) ? slashed.replace(/\/+$/, '') : slashed
}
const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Every string in a value with LF line ends, so a file written on Windows reads the same elsewhere. */
function normalizeText(value: unknown): unknown {
  if (typeof value === 'string') return lf(value)
  if (Array.isArray(value)) return value.map(normalizeText)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeText(item)]))
  return value
}

/** The profile's overrides of known options, ready to be written to a file. */
export function exportConfig(user: ConfigDoc | undefined, repos: readonly RepoGroup[] = [], now = new Date()): ConfigExport {
  const config: ConfigDoc = {}
  for (const spec of FIELDS) {
    const section = user?.[spec.section]
    if (spec.local === true || !isRecord(section) || !Object.hasOwn(section, spec.key) || section[spec.key] === undefined) continue
    let value = normalizeText(section[spec.key])
    if (spec.kind === 'connectors' && Array.isArray(value)) value = value.map((entry) => portableConnector(entry, repos))
    ;(config[spec.section] ??= {})[spec.key] = value
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), config }
}

function portableConnector(entry: unknown, repos: readonly RepoGroup[]): unknown {
  if (!isRecord(entry) || !isStrings(entry.repos)) return entry
  return {
    ...entry,
    repos: entry.repos.map((path) => ({
      name: repos.find((group) => samePath(group.key, path))?.name ?? folderName(path),
      path: portablePath(path),
    })),
  }
}

export function serializeExport(file: ConfigExport): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

export const exportFileName = (now = new Date()): string => `agent-hub-config-${now.toISOString().slice(0, 10)}.json`

export type ParseResult =
  | { ok: true; config: ConfigDoc; skipped: string[] }
  | { ok: false; reason: 'json' | 'format' | 'version' }

/** Read an exported file. An option this version does not know, or a value it would refuse, is skipped and named. */
export function parseExport(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false, reason: 'json' }
  }
  if (!isRecord(data) || data.format !== EXPORT_FORMAT || !isRecord(data.config)) return { ok: false, reason: 'format' }
  if (typeof data.version !== 'number' || data.version > EXPORT_VERSION) return { ok: false, reason: 'version' }
  const config: ConfigDoc = {}
  const skipped: string[] = []
  for (const [section, values] of Object.entries(data.config)) {
    if (!isRecord(values)) {
      skipped.push(section)
      continue
    }
    for (const [key, raw] of Object.entries(values)) {
      const spec = FIELDS.find((candidate) => candidate.section === section && candidate.key === key)
      const value = normalizeText(raw)
      if (spec === undefined || spec.local === true || !acceptable(spec, value)) {
        skipped.push(`${section}.${key}`)
        continue
      }
      ;(config[spec.section] ??= {})[spec.key] = value
    }
  }
  return { ok: true, config, skipped }
}

const portableRepo = (value: unknown): boolean =>
  typeof value === 'string' ? value !== '' : isRecord(value) && typeof value.path === 'string' && value.path !== '' && (value.name === undefined || typeof value.name === 'string')

/** Whether a value has the shape the option stores (the host's schema still has the last word). */
function acceptable(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'switch': return typeof value === 'boolean'
    case 'integer': case 'number': case 'uiScale':
      return typeof value === 'number' && Number.isFinite(value) && (spec.kind === 'number' || Number.isInteger(value))
        && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max)
    case 'text': case 'textarea': case 'route': case 'effort': return typeof value === 'string'
    case 'agentModels': case 'providers': return isStrings(value)
    case 'blockedScans': return isStrings(value) && value.every((rule) => (SCAN_RULES as readonly string[]).includes(rule))
    case 'blockedCommands': case 'syncExclude': return isStrings(value)
    case 'reviewRepos': return isStrings(value)
    case 'bot': case 'hotkey': return typeof value === 'string'
    case 'font': return (FONTS as readonly unknown[]).includes(value)
    case 'choice': return typeof value === 'string' && (spec.options ?? []).includes(value)
    case 'scaleRegions':
      return isRecord(value) && Object.entries(value).every(([region, offset]) =>
        (SCALE_REGIONS as readonly string[]).includes(region) && regionsOf({ [region]: offset })[region as ScaleRegion] === offset)
    case 'efforts': return Array.isArray(value) && value.every((rule) => isRecord(rule) && typeof rule.provider === 'string' && typeof rule.model === 'string' && typeof rule.effort === 'string')
    case 'agents':
      return profilesValid(value) && (value as unknown[]).every((profile) => isRecord(profile)
        && ['description', 'provider', 'model', 'persona'].every((key) => profile[key] === undefined || typeof profile[key] === 'string')
        && (profile.tools === undefined || isStrings(profile.tools)))
    case 'identities': return identitiesValid(value)
    case 'connectors':
      return Array.isArray(value) && value.every((entry) => isRecord(entry) && (entry.repos === undefined || (Array.isArray(entry.repos) && entry.repos.every(portableRepo))))
        && connectorsValid(value.map((entry) => ({ ...entry, repos: undefined })))
  }
}

export interface ImportPlan {
  ops: Op[]
  /** Options the file sets. */
  set: number
  /** Options this profile overrides that the file leaves at their default. */
  reset: number
  /** Linked repositories with no registered repository of the same path or name here; kept as written. */
  unmatched: string[]
}

/**
 * The writes that make this profile's overrides those of the file: every option it sets is
 * stored, every other one this profile overrides goes back to its default.
 */
export function planImport(config: ConfigDoc, user: ConfigDoc | undefined, repos: readonly RepoGroup[]): ImportPlan {
  const ops: Op[] = []
  const unmatched: string[] = []
  let set = 0
  let reset = 0
  for (const spec of FIELDS) {
    // This machine's own (local paths): an import neither sets nor resets it.
    if (spec.local === true) continue
    const path = [spec.section, spec.key]
    const incoming = config[spec.section]
    if (incoming !== undefined && Object.hasOwn(incoming, spec.key)) {
      let value = incoming[spec.key]
      if (spec.kind === 'connectors') value = (value as PortableConnector[]).map((entry) => localConnector(entry, repos, unmatched))
      ops.push({ op: 'set', path, value })
      set++
    } else if (isRecord(user?.[spec.section]) && Object.hasOwn(user[spec.section]!, spec.key)) {
      ops.push({ op: 'unset', path })
      reset++
    }
  }
  return { ops, set, reset, unmatched }
}

function localConnector(entry: PortableConnector | ConnectorEntry, repos: readonly RepoGroup[], unmatched: string[]): ConnectorEntry {
  const { repos: linked, ...rest } = entry
  if (linked === undefined || linked.length === 0) return rest
  const local: string[] = []
  for (const item of linked as Array<PortableRepo | string>) {
    const repo = typeof item === 'string' ? { path: item, name: folderName(item) } : { path: item.path, name: item.name ?? folderName(item.path) }
    const key = resolveRepo(repo, repos)
    if (key === undefined) unmatched.push(repo.name)
    const path = key ?? repo.path
    if (!local.some((known) => samePath(known, path))) local.push(path)
  }
  return { ...rest, repos: local }
}

/** The registered repository a portable one stands for: the same path, else the only one of that name. */
export function resolveRepo(repo: PortableRepo, repos: readonly RepoGroup[]): string | undefined {
  const same = repos.find((group) => samePath(group.key, repo.path))
  if (same !== undefined) return same.key
  const named = repos.filter((group) => group.name.toLowerCase() === repo.name.toLowerCase())
  return named.length === 1 ? named[0]!.key : undefined
}

