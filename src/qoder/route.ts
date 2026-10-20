/**
 * The `qoder-agent` model route: Qoder CLI CN's agent over ACP
 * (`qoderclicn --acp`), one process for every model. Its models (Qwen, GLM,
 * Kimi, DeepSeek, MiniMax…) come from the CLI's own list; each one's credit
 * rate, which the CLI puts in its description ("Reasoning · Vision · 0.50x
 * Credit"), follows its name in the selector. Sessions start in the CLI's
 * default permission mode, so its prompts become DSH approval dialogs.
 */

import type { ModelChoice } from '../acp/client.ts'
import type { AcpProfile, RouteModel } from '../acp/route.ts'
import { findQoder, INSTALL_HINT } from './cli.ts'

export const QODER_PROVIDER = 'qoder-agent'
/** Failure code for a signed-out CLI; outside DSH's retryable set, like Claude Agent's. */
export const QODER_AUTH = 'QODER_AUTH'

/** `0.50x Credit` → `0.5×`; undefined when the description names no rate. */
export function creditRate(description: string | undefined): string | undefined {
  const match = /(\d+(?:\.\d+)?)x\s*Credit/i.exec(description ?? '')
  return match === null ? undefined : `${Number(match[1])}×`
}

export function presentQoderModel(model: ModelChoice): RouteModel {
  const rate = creditRate(model.description)
  return { id: model.id, name: rate === undefined ? model.name : `${model.name} · ${rate}` }
}

export function qoderProfile(find: () => string | undefined = findQoder): AcpProfile {
  return {
    provider: QODER_PROVIDER,
    name: 'Qoder',
    process: () => {
      const command = find()
      return command === undefined ? undefined : { key: 'qoder', command, args: ['--acp'], env: { ...process.env } }
    },
    missing: INSTALL_HINT,
    signIn: 'Qoder CLI CN is not signed in, so this turn was not sent. Run qodercn in a terminal and /login, then send again.',
    authCode: QODER_AUTH,
    present: presentQoderModel,
  }
}
