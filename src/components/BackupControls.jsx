import React, { useRef, useState } from 'react'
import { exportAllData, importAllData } from '../utils/db.js'

/**
 * BackupControls — download-everything / restore-from-file backup pair.
 * This is a safety net against local data loss (origin change, browser clear,
 * eviction) — NOT a sync mechanism. Cross-device sync is a separate feature.
 * Mount anywhere (settings/footer): <BackupControls />
 */
export default function BackupControls() {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState('')

  const doExport = async () => {
    try {
      const data = await exportAllData()
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `stockanalyzr-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      setMsg('Backup downloaded.')
    } catch (e) {
      setMsg('Export failed: ' + (e?.message || e))
    }
  }

  const doImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const backup = JSON.parse(text)
      const { restored } = await importAllData(backup)
      setMsg(`Restored ${restored} records. Reloading…`)
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      setMsg('Import failed: ' + (err?.message || err))
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={doExport} className="btn-ghost text-xs">⬇ Export backup</button>
        <button onClick={() => fileRef.current?.click()} className="btn-ghost text-xs">⬆ Restore backup</button>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={doImport} className="hidden" />
      </div>
      {msg && <p className="text-[11px] text-slate-500">{msg}</p>}
      <p className="text-[10px] text-slate-600">
        Backup saves all tickers, guidance, documents &amp; swaps to a file. Restore merges it back
        (safety net for this device — not cross-device sync).
      </p>
    </div>
  )
}
