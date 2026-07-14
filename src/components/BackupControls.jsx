import React, { useRef, useState } from 'react'
import { exportAllData, importAllData } from '../utils/db.js'

/**
 * BackupControls — two round FAB icon buttons (⬇ export / ⬆ restore), styled like
 * the ⚙/📎 FABs. Parent positions them (e.g. a fixed bottom-right column).
 * Safety net against local data loss — not cross-device sync.
 */
export default function BackupControls() {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState('')

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 2500) }

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
      flash('Backup downloaded')
    } catch (e) { flash('Export failed') }
  }

  const doImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const backup = JSON.parse(await file.text())
      const { restored } = await importAllData(backup)
      flash(`Restored ${restored} — reloading…`)
      setTimeout(() => window.location.reload(), 1000)
    } catch (err) { flash('Import failed') }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  const fab = 'w-11 h-11 rounded-full bg-navy-800 border border-navy-600 text-slate-400 shadow-lg ' +
              'hover:text-white hover:border-accent active:scale-95 transition-all flex items-center justify-center text-lg'

  return (
    <>
      {msg && (
        <div className="absolute right-14 bottom-1 whitespace-nowrap text-[11px] text-slate-300 bg-navy-800 border border-navy-700 rounded-lg px-2 py-1 shadow-lg">
          {msg}
        </div>
      )}
      <button onClick={doExport} title="Export backup (download)" className={fab}>⬇</button>
      <button onClick={() => fileRef.current?.click()} title="Restore backup (upload)" className={fab}>⬆</button>
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={doImport} className="hidden" />
    </>
  )
}
