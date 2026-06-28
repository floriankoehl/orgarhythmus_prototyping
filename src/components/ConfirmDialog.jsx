import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './ConfirmDialog.module.css'

export function useConfirmDialog() {
  const [config, setConfig] = useState(null)
  const resolverRef = useRef(null)

  const close = useCallback(result => {
    resolverRef.current?.(result)
    resolverRef.current = null
    setConfig(null)
  }, [])

  const confirm = useCallback(options => new Promise(resolve => {
    resolverRef.current = resolve
    setConfig(options)
  }), [])

  const dialog = config ? createPortal(
    <div className={styles.backdrop} onMouseDown={() => close(false)}>
      <div className={styles.modal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <div className={styles.title}>{config.title}</div>
        {config.message && <p className={styles.message}>{config.message}</p>}
        {config.items?.length > 0 ? (
          <div className={styles.list}>
            {config.items.map((item, idx) => (
              <div key={`${item}:${idx}`} className={styles.item}>{item}</div>
            ))}
          </div>
        ) : (
          config.emptyText && <div className={styles.empty}>{config.emptyText}</div>
        )}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={() => close(false)}>
            {config.cancelLabel || 'Cancel'}
          </button>
          <button className={styles.confirmBtn} onClick={() => close(true)} autoFocus>
            {config.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  ) : null

  return { confirm, dialog }
}
