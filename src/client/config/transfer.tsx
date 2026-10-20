/**
 * 设置 → Agent Hub's 导出 / 导入 controls (transfer.ts). Export downloads the
 * profile's overrides; import reads a file, says what it will change, and
 * replaces the overrides in one save once confirmed.
 */

import { useRef, useState, type ReactNode } from 'react'
import type { ReposStore } from '../repos/api.ts'
import type { RepoGroup } from '../../repos/types.ts'
import type { ConfigFormModel } from './form.ts'
import { t } from './i18n.ts'
import { exportConfig, exportFileName, parseExport, planImport, serializeExport, type ImportPlan } from './transfer.ts'

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

type Notice = { tone: 'ok' | 'bad'; text: string }
type Pending = { file: string; plan: ImportPlan; skipped: string[] }

/** The head's buttons and the panel shown under the head while an import is confirmed or reported. */
export function useTransfer(props: { form: ConfigFormModel; repos?: ReposStore; writable: boolean }): { controls: ReactNode; panel: ReactNode } {
  const { form, repos } = props
  const input = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)

  const known = async (): Promise<readonly RepoGroup[]> => {
    if (repos === undefined) return []
    await repos.load()
    return repos.getSnapshot().repos ?? []
  }
  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    void work().catch((error: unknown) => setNotice({ tone: 'bad', text: t('transfer.failed', { message: (error as Error).message }) }))
      .finally(() => setBusy(false))
  }

  const exportNow = (): void => run(async () => {
    setPending(null)
    const [user, groups] = await Promise.all([form.overrides(), known()])
    const now = new Date()
    const file = exportConfig(user, groups, now)
    download(exportFileName(now), serializeExport(file))
    const n = Object.values(file.config).reduce((sum, section) => sum + Object.keys(section ?? {}).length, 0)
    setNotice({ tone: 'ok', text: n === 0 ? t('transfer.exportedEmpty') : t('transfer.exported', { n }) })
  })

  const read = (file: File): void => run(async () => {
    setNotice(null)
    setPending(null)
    const parsed = parseExport(await file.text())
    if (!parsed.ok) return setNotice({ tone: 'bad', text: t(`transfer.error.${parsed.reason}`) })
    const [user, groups] = await Promise.all([form.overrides(), known()])
    setPending({ file: file.name, plan: planImport(parsed.config, user, groups), skipped: parsed.skipped })
  })

  const confirm = (): void => {
    if (pending === null) return
    run(async () => {
      const landed = await form.apply(pending.plan.ops)
      setPending(null)
      setNotice(landed ? { tone: 'ok', text: t('transfer.imported') } : { tone: 'bad', text: t('transfer.importFailed') })
    })
  }

  const controls = (
    <>
      <button type="button" className="ac-link ac-transfer" disabled={busy} onClick={exportNow}>{t('transfer.export')}</button>
      <button type="button" className="ac-link ac-transfer" disabled={busy || !props.writable} onClick={() => input.current?.click()}>{t('transfer.import')}</button>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file !== undefined) read(file)
      }} />
    </>
  )

  let panel: ReactNode = null
  if (pending !== null) {
    const { plan, skipped } = pending
    panel = (
      <div className="ac-notice ac-transfer-panel" role="dialog" aria-label={t('transfer.confirmTitle')}>
        <p><strong>{t('transfer.confirmTitle')}</strong> · {pending.file}</p>
        <p>{plan.set === 0 && plan.reset === 0 ? t('transfer.nothing') : t('transfer.summary', { set: plan.set, reset: plan.reset })}</p>
        {plan.unmatched.length > 0 && <p>{t('transfer.unmatched', { repos: [...new Set(plan.unmatched)].join(', ') })}</p>}
        {skipped.length > 0 && <p>{t('transfer.skipped', { fields: skipped.join(', ') })}</p>}
        <p className="ac-muted">{t('transfer.credentials')}</p>
        <div className="ac-transfer-actions">
          <button type="button" className="ah-btn" disabled={busy} onClick={() => setPending(null)}>{t('transfer.cancel')}</button>
          <button type="button" className="ah-btn" data-variant="primary" disabled={busy || !props.writable || plan.ops.length === 0} onClick={confirm}>{t('transfer.apply')}</button>
        </div>
      </div>
    )
  } else if (notice !== null) {
    panel = (
      <p className="ac-notice ac-transfer-panel" role="status" data-tone={notice.tone}>
        {notice.text}{' '}
        <button type="button" className="ac-link" onClick={() => setNotice(null)}>{t('transfer.dismiss')}</button>
      </p>
    )
  }
  return { controls, panel }
}
