/**
 * The preset identities (`git.identities`) as the settings form holds them, so
 * the pane can keep an identity it binds a repository to: presets sync with the
 * profile to every machine. Attached where DSH's configuration forms exist;
 * without them the pane still binds, it just cannot remember.
 */

import { identityOf, sameEmail, type Identity } from '../../git/identity.ts'
import type { ConfigScope } from '../config/form.ts'

let scope: ConfigScope | undefined

export function attachPresets(next: ConfigScope): () => void {
  scope = next
  return () => { if (scope === next) scope = undefined }
}

const ready = (): ReturnType<ConfigScope['getSnapshot']> | undefined => {
  const snapshot = scope?.getSnapshot()
  return snapshot?.status === 'ready' && snapshot.writable ? snapshot : undefined
}

export const canRemember = (): boolean => ready() !== undefined

/** Add `identity` to the presets unless its email is there already. */
export async function remember(identity: Identity): Promise<boolean> {
  const snapshot = ready()
  if (scope === undefined || snapshot === undefined) return false
  const listed = snapshot.value?.git?.identities
  const current = (Array.isArray(listed) ? listed : []).map(identityOf).filter((item): item is Identity => item !== undefined)
  if (current.some((preset) => sameEmail(preset.email, identity.email))) return true
  return scope.mutate([{ op: 'set', path: ['git', 'identities'], value: [...current, identity] }], snapshot.revision)
}
