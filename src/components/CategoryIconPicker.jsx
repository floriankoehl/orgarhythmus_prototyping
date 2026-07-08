import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CategoryIconGlyph, ICON_GROUPS, ICON_OPTIONS, normalizeIconKey } from './iconRegistry'
import styles from './CategoryIconPicker.module.css'

export default function CategoryIconPicker({
  value,
  onChange,
  color = '#64748b',
  size = 18,
  className = '',
  disabled = false,
  ariaLabel = 'Choose icon',
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const buttonRef = useRef(null)
  const panelRef = useRef(null)
  const icon = normalizeIconKey(value) || 'star'

  const openPanel = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      const width = 272
      const height = 340
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
      const hasRoomBelow = rect.bottom + height + 8 < window.innerHeight
      const top = hasRoomBelow
        ? rect.bottom + 8
        : Math.max(8, rect.top - height - 8)
      setPos({ left, top, width })
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return undefined
    const close = event => {
      if (buttonRef.current?.contains(event.target)) return
      if (panelRef.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.trigger} ${className}`}
        style={{ color }}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={event => {
          event.stopPropagation()
          if (disabled) return
          if (open) setOpen(false)
          else openPanel()
        }}
      >
        <CategoryIconGlyph icon={icon} size={size} strokeWidth={2.4} />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          className={styles.panel}
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          onClick={event => event.stopPropagation()}
        >
          {ICON_GROUPS.map(group => {
            const options = ICON_OPTIONS.filter(option => option.group === group)
            if (!options.length) return null
            return (
              <section key={group} className={styles.group}>
                <div className={styles.groupTitle}>{group}</div>
                <div className={styles.grid}>
                  {options.map(option => (
                    <button
                      key={option.key}
                      type="button"
                      className={`${styles.option} ${option.key === icon ? styles.optionActive : ''}`}
                      style={{ color }}
                      aria-label={option.label}
                      title={option.label}
                      onClick={() => {
                        onChange?.(option.key)
                        setOpen(false)
                      }}
                    >
                      <CategoryIconGlyph icon={option.key} size={17} strokeWidth={2.35} />
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>,
        document.body
      )}
    </>
  )
}
