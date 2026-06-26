import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './DimensionDropUp.module.css'

export default function DimensionDropUp({
  dimensions,
  value,
  onChange,
  onReorder,
  emptyLabel = 'Color legend',
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)
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

  const previewDims = onReorder && dragIdx !== null && overIdx !== null && dragIdx !== overIdx
    ? (() => { const a = [...dimensions]; const [x] = a.splice(dragIdx, 1); a.splice(overIdx, 0, x); return a })()
    : dimensions

  const handleDrop = (toIdx) => {
    if (dragIdx === null || dragIdx === toIdx) { setDragIdx(null); setOverIdx(null); return }
    const arr = [...dimensions]
    const [item] = arr.splice(dragIdx, 1)
    arr.splice(toIdx, 0, item)
    onReorder(arr.map(d => d.id))
    setDragIdx(null); setOverIdx(null)
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
          {previewDims.map((dim, i) => (
            <div
              key={dim.id}
              className={`${styles.dimRow} ${overIdx === i && onReorder ? styles.dimRowOver : ''}`}
              draggable={!!onReorder}
              onDragStart={onReorder ? e => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(i) } : undefined}
              onDragOver={onReorder ? e => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i) } : undefined}
              onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
              onDrop={onReorder ? e => { e.preventDefault(); handleDrop(i) } : undefined}
            >
              {onReorder && (
                <span className={styles.dragHandle}>
                  <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
                    <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
                    <circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>
                    <circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>
                  </svg>
                </span>
              )}
              <button
                className={`${styles.option} ${styles.optionInRow} ${dim.id === value ? styles.active : ''}`}
                onClick={() => { onChange(dim.id); setOpen(false) }}
              >
                {dim.name}
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
