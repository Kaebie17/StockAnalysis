import React, { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * Modal — the one dialog shell for the app. Every backdrop dialog used to
 * hand-roll its own overlay, close button and height handling, which is why
 * the mobile "footer cut off by the URL bar" fix landed in some modals and
 * not others: there was no single place to put it. This is that place.
 *
 * Layout: a flex-column panel capped at 90dvh (dvh, not vh, so a collapsing
 * mobile URL bar can't crop the footer) with only the body scrolling — header
 * and footer stay pinned. Bottom sheet on mobile (slides up from the edge),
 * centered card from `sm:` up.
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  actions,           // extra header content, left of the close button
  children,
  footer,
  widthClass = 'sm:max-w-lg',
  dismissible = true, // Escape key + backdrop click close it
  showClose = true,
  solid = false,      // opaque full-bleed background instead of a floating card (e.g. a blocking gate)
  bodyClassName = 'space-y-4',
  zIndexClass = 'z-50',
}) {
  const titleId = useId()
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onKey = e => { if (e.key === 'Escape' && dismissible) onClose?.() }
    document.addEventListener('keydown', onKey)
    // Land focus inside the dialog so Escape and Tab work immediately for
    // keyboard/screen-reader users, without hijacking it on every re-render.
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissible, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex items-end sm:items-center justify-center
                  p-0 sm:p-4 overflow-y-auto
                  ${solid ? 'bg-navy-950' : 'bg-black/60 backdrop-blur-sm'}`}
      onClick={e => { if (dismissible && e.target === e.currentTarget) onClose?.() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`w-full ${widthClass} bg-navy-900 border border-navy-700
                    rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[90dvh]
                    outline-none`}
      >
        {(title || showClose) && (
          <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-navy-700 shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 id={titleId} className="font-semibold text-white truncate">
                  {icon ? `${icon} ` : ''}{title}
                </h2>
              )}
              {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {actions}
              {showClose && (
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="text-slate-400 hover:text-white text-lg leading-none"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}

        <div className={`p-5 overflow-y-auto flex-1 ${bodyClassName}
                        ${footer ? '' : 'pb-[max(1.25rem,env(safe-area-inset-bottom))]'}`}>
          {children}
        </div>

        {footer && (
          <div className="flex gap-2 px-5 py-4 border-t border-navy-700 shrink-0
                          pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
