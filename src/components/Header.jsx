import { useState, useRef, useEffect } from 'react'
import styles from './Header.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'

const PAGES = ['Goals', 'Classification', 'Schedule']

function computeWordRects(el) {
  const base = el.getBoundingClientRect()
  const result = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const re = /\S+/g; let m
    while ((m = re.exec(node.textContent)) !== null) {
      const range = document.createRange()
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
      const r = range.getBoundingClientRect()
      if (r.width > 0 && r.height > 0)
        result.push({ word: m[0], top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height })
    }
  }
  return result
}

export default function Header({ view, onNavigate, onQuickAdd, projectName, onBack }) {
  const [open, setOpen]               = useState(false)
  const [titleVal, setTitleVal]       = useState('')
  const [titleManual, setTitleManual] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects]     = useState([])
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [categorySelections, setCategorySelections] = useState({})
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)

  const editorRef    = useRef(null)
  const titleInputRef = useRef(null)
  const wrapRef      = useRef(null)

  useEffect(() => {
    if (open) setTimeout(() => editorRef.current?.focus(), 20)
  }, [open])

  const closePopup = () => {
    setOpen(false); setTitleVal(''); setTitleManual(false)
    setHeadlineMode(false); setWordRects([])
    setCategorySelections({})
    setCategoryPickerOpen(false)
    if (editorRef.current) editorRef.current.innerHTML = ''
  }

  const ensureCategoryData = () => {
    if (dimensions.length || categories.length) return
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats) })
      .catch(console.error)
  }

  const handleDescInput = () => {
    if (!titleManual && editorRef.current) {
      const words = (editorRef.current.innerText || '').trim().split(/\s+/).filter(Boolean)
      setTitleVal(words.slice(0, 7).join(' '))
    }
    if (headlineMode) setWordRects(computeWordRects(editorRef.current))
  }

  const handleWordClick = word => {
    setTitleVal(prev => prev ? prev + ' ' + word : word)
    setTitleManual(true)
    titleInputRef.current?.focus()
  }

  const hasDraft = () => {
    const desc = editorRef.current?.innerText?.trim() || ''
    return Boolean(desc || titleVal.trim())
  }

  const submit = () => {
    const desc = editorRef.current?.innerText?.trim() || ''
    if (!desc && !titleVal.trim()) return
    onQuickAdd?.(desc, titleVal.trim() || null, categorySelections)
    closePopup()
  }

  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (wrapRef.current?.contains(e.target)) return
      if (categoryPickerOpen) return
      if (hasDraft()) submit()
      else closePopup()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, categoryPickerOpen, titleVal, categorySelections]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === 'Escape') closePopup()
  }

  const toggleHeadline = () => {
    const next = !headlineMode
    setHeadlineMode(next)
    if (next && editorRef.current) setWordRects(computeWordRects(editorRef.current))
  }

  return (
    <header className={styles.header}>
      {onBack && (
        <button className={styles.backBtn} onClick={onBack} title="Back to projects">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {projectName && <span className={styles.projectName}>{projectName}</span>}
        </button>
      )}
      <div ref={wrapRef} className={styles.quickAddWrap}>
        <button className={styles.quickAddBtn} onClick={() => setOpen(o => !o)} title="Quick add goal">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 8h6M5 5.5h4M5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11.5 10l1 1 1.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {open && (
          <div className={styles.quickAddPopup}>
            <div className={styles.quickAddTopRow}>
              <span className={styles.quickAddLabel}>Quick add goal</span>
              <button
                className={`${styles.quickAddHdrBtn} ${headlineMode ? styles.quickAddHdrBtnActive : ''}`}
                onClick={toggleHeadline}>
                Header mode
              </button>
              <button
                className={styles.quickAddHdrBtn}
                onClick={() => { ensureCategoryData(); setCategoryPickerOpen(true) }}>
                Categories
              </button>
            </div>

            <input
              ref={titleInputRef}
              className={styles.quickAddTitleInput}
              value={titleVal}
              onChange={e => { setTitleVal(e.target.value); setTitleManual(true) }}
              onKeyDown={handleKey}
              placeholder="Title (auto-fills from text below)"
            />

            <div className={styles.quickAddEditorWrap}>
              <div
                ref={editorRef}
                className={styles.quickAddEditor}
                contentEditable={!headlineMode}
                suppressContentEditableWarning
                data-placeholder="Describe your goal…"
                onInput={handleDescInput}
                onKeyDown={handleKey}
              />
              {headlineMode && (
                <div className={styles.quickAddOverlay} onClick={() => setHeadlineMode(false)}>
                  {wordRects.map((w, i) => (
                    <button key={i} className={styles.quickAddWordBtn}
                      style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className={styles.quickAddBottomRow}>
              <p className={styles.quickAddHint}>Enter to add · click away saves · Esc to close</p>
              <button className={styles.quickAddSubmit} onClick={submit}>Add</button>
            </div>
            <CategoryAssignmentPicker
              open={categoryPickerOpen}
              dimensions={dimensions}
              categories={categories}
              selections={categorySelections}
              onChange={setCategorySelections}
              onClose={() => setCategoryPickerOpen(false)}
            />
          </div>
        )}
      </div>

      <nav className={styles.nav}>
        {PAGES.map((name, i) => (
          <button key={i}
            className={`${styles.navItem} ${view === i ? styles.active : ''}`}
            onClick={() => onNavigate(i)}>
            {name}
          </button>
        ))}
      </nav>
    </header>
  )
}
