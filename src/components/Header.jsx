import { useState, useRef, useEffect } from 'react'
import styles from './Header.module.css'

const PAGES = ['Brainstorming', 'Classification', 'Schedule', 'Flow']

export default function Header({ view, onNavigate, onQuickAdd }) {
  const [open, setOpen]         = useState(false)
  const [text, setText]         = useState('')
  const [customTitle, setCustomTitle] = useState('')
  const inputRef  = useRef(null)
  const wrapRef   = useRef(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!wrapRef.current?.contains(e.target)) {
        setOpen(false)
        setText('')
        setCustomTitle('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const submit = () => {
    if (!text.trim()) return
    onQuickAdd?.(text, customTitle.trim() || null)
    setText('')
    setCustomTitle('')
    setOpen(false)
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === 'Escape') { setOpen(false); setText(''); setCustomTitle('') }
  }

  return (
    <header className={styles.header}>
      <div ref={wrapRef} className={styles.quickAddWrap}>
        <button
          className={styles.quickAddBtn}
          onClick={() => setOpen(o => !o)}
          title="Quick add goal"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 8h6M5 5.5h4M5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11.5 10l1 1 1.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {open && (
          <div className={styles.quickAddPopup}>
            <span className={styles.quickAddLabel}>Quick add goal</span>

            {/* Subtle optional title override */}
            <input
              className={styles.quickAddTitleInput}
              value={customTitle}
              onChange={e => setCustomTitle(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Title (optional — auto-fills from text below)"
            />

            <div className={styles.quickAddRow}>
              <textarea
                ref={inputRef}
                className={styles.quickAddInput}
                value={text}
                rows={3}
                onChange={e => setText(e.target.value)}
                onKeyDown={handleKey}
                placeholder="Describe your goal…"
              />
              <button className={styles.quickAddSubmit} onClick={submit}>Add</button>
            </div>
            <p className={styles.quickAddHint}>Enter to add · Shift+Enter for line break · Esc to close</p>
          </div>
        )}
      </div>

      <nav className={styles.nav}>
        {PAGES.map((name, i) => (
          <button
            key={i}
            className={`${styles.navItem} ${view === i ? styles.active : ''}`}
            onClick={() => onNavigate(i)}
          >
            {name}
          </button>
        ))}
      </nav>
    </header>
  )
}
