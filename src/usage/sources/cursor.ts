/**
 * Cursor plan usage through the Cursor CLI's login (see cursor/usage.ts).
 * Someone without the CLI and without a login gets no card at all; an
 * installed CLI that is signed out (or whose token the service refuses)
 * gets one that says how to sign in.
 */

import { createHash } from 'node:crypto'
import { accessToken, findCursorAgent } from '../../cursor/cli.ts'
import { readPlan, type Call } from '../../cursor/usage.ts'
import { HttpError } from './http.ts'
import type { PlanQuota } from '../types.ts'

export async function readCursor(call?: Call, installed = () => findCursorAgent() !== undefined, token = () => accessToken(), verifyIdentity = false): Promise<PlanQuota[]> {
  const signedOut = (): PlanQuota[] => [{ id: 'cursor', provider: 'cursor', windows: [], fetchedAt: 0, error: { code: 'not-signed-in' } }]
  const credential = await token()
  if (credential === undefined) return installed() ? signedOut() : []
  try {
    const quota = await readPlan(call)
    if (!verifyIdentity) return [quota]
    return [{ ...quota, identity: createHash('sha256').update(`cursor:${credential}`).digest('hex'),
      ...(await token() !== credential ? { stale: true } : {}),
    }]
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return signedOut()
    return [{ id: 'cursor', provider: 'cursor', windows: [], fetchedAt: 0, error: { code: 'failed', message: (error as Error).message } }]
  }
}
