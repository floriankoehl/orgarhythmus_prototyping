import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './DimensionDropUp.module.css'

export default function DimensionDropUp({
  dimensions,
  value,
  onChange,
  emptyLabel = 'Color legend',
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const wheelAtRef = useRef(0)

  const toggle = () => {
    if (!open) {
      const rect = btnRef.current?.getBoundingClientRect()
      if (rect) setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, width: rect.width })
    }
    setOpen(v => !v)
  }

  useEffect(() => {
    if (!open) return
    const close = e => {
      if (btnRef.current?.contains(e.target)) return
      if (menuRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const current = dimensions.find(d => d.id === value)
  const cycleDimension = deltaY => {
    const options = ['', ...dimensions.map(d => d.id)]
    if (options.length <= 1) return
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    const activeIdx = Math.max(0, options.indexOf(value))
    const dir = deltaY > 0 ? 1 : -1
    onChange(options[(activeIdx + dir + options.length) % options.length])
  }

  return (
    <div className={styles.wrap}>
      <button
        ref={btnRef}
        className={styles.button}
        onWheel={e => { e.preventDefault(); cycleDimension(e.deltaY) }}
        onClick={toggle}
      >
        <span className={styles.label}>{current?.name ?? emptyLabel}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: pos.width }}
        >
          <button
            className={`${styles.option} ${!value ? styles.active : ''}`}
            onClick={() => { onChange(''); setOpen(false) }}
          >
            None
          </button>
          {dimensions.map(dim => (
            <button
              key={dim.id}
              className={`${styles.option} ${dim.id === value ? styles.active : ''}`}
              onClick={() => { onChange(dim.id); setOpen(false) }}
            >
              {dim.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
