import type { CodexAccount } from './accounts.tsx'

/**
 * Chip label per account id. Codex labels are generic ("Account 1"), so the
 * email wins: its local part keeps the chip short, and the full address is
 * used only when two accounts share that local part (a@x.com vs a@y.com).
 */
export function codexAccountLabels(accounts: readonly CodexAccount[]): Map<string, string> {
  const local = (email: string): string => { const at = email.lastIndexOf('@'); return at > 0 ? email.slice(0, at) : email }
  const counts = new Map<string, number>()
  for (const account of accounts) if (account.email) counts.set(local(account.email), (counts.get(local(account.email)) ?? 0) + 1)
  return new Map(accounts.map((account) => {
    if (!account.email) return [account.id, account.label ?? account.id]
    const short = local(account.email)
    return [account.id, (counts.get(short) ?? 0) > 1 ? account.email : short]
  }))
}
