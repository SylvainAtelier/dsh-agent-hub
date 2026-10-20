/**
 * How a Cursor model is paid for. Cursor's own models (Auto, Composer) draw
 * on the plan's Auto + Composer allowance; every other model draws on its API
 * allowance and, once that is spent, bills on demand. The CLI does not say
 * which is which, so the id decides. Shared by the host and the browser.
 */

export type Billing = 'included' | 'on-demand'

const INCLUDED = /^(auto|composer)(-|$)/i

export function cursorBilling(model: string): Billing {
  return INCLUDED.test(model) ? 'included' : 'on-demand'
}
