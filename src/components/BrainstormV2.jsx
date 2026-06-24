import { useState, useRef, useEffect } from 'react'
import styles from './BrainstormV2.module.css'
import { api } from '../api'

const DRIFT_VARIANTS = 6

function deriveTitle(text) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ') || ''
}

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
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        result.push({ word: m[0], top: rect.top - base.top, left: rect.left - base.left, width: rect.width, height: rect.height })
    }
  }
  return result
}

export default function BrainstormV2({ goals, onGoalCreated }) {
  const [titleVal, setTitleVal]   = useState('')
  const [titleManual, setTitleManual] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects] = useState([])
  const [ghost, setGhost]         = useState(null)

  const editorRef     = useRef(null)
  const titleInputRef = useRef(null)
  const positionsRef  = useRef({})

  // Focus + select-all when title edit activates
  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitle])

  // Focus description on mount
  useEffect(() => { editorRef.current?.focus() }, [])

  // Escape: exit headline / title edit
  useEffect(() => {
    if (!headlineMode && !editingTitle) return
    const h = (e) => {
      if (e.key === 'Escape') { setHeadlineMode(false); setEditingTitle(false) }
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [headlineMode, editingTitle])

  const getPos = (goalId) => {
    if (!positionsRef.current[goalId]) {
      positionsRef.current[goalId] = {
        left:     3 + Math.random() * 87,
        top:      4 + Math.random() * 82,
        variant:  Math.floor(Math.random() * DRIFT_VARIANTS),
        duration: 38 + Math.random() * 50,
        delay:    -(Math.random() * 45),
        size:     11 + Math.random() * 10,
        opacity:  0.06 + Math.random() * 0.09,
      }
    }
    return positionsRef.current[goalId]
  }

  // Live-derive title from first 7 words while user types
  const handleDescriptionInput = () => {
    if (!titleManual && editorRef.current) {
      const derived = deriveTitle(editorRef.current.innerText || '')
      setTitleVal(derived)
    }
    // Refresh word rects when in headline mode
    if (headlineMode && editorRef.current) {
      setWordRects(computeWordRects(editorRef.current))
    }
  }

  // Clicking the title: edit + headline mode, select-all
  const handleTitleClick = () => {
    setEditingTitle(true)
    setHeadlineMode(true)
    if (editorRef.current) setWordRects(computeWordRects(editorRef.current))
  }

  // Word click: uses functional setState so the prev value is always current (no stale closure)
  const handleWordClick = (word) => {
    setTitleVal(prev => prev ? prev + ' ' + word : word)
    setTitleManual(true)
    titleInputRef.current?.focus()
  }

  const submit = async () => {
    const content = editorRef.current?.innerText?.trim() || ''
    if (!content) return
    const finalTitle = titleVal.trim() || deriveTitle(content) || 'Untitled'
    const html = editorRef.current?.innerHTML || ''

    // Trigger float-away, then clear immediately
    const rect = editorRef.current?.getBoundingClientRect()
    if (rect) setGhost({ html, rect })
    if (editorRef.current) { editorRef.current.innerHTML = ''; editorRef.current.focus() }
    setTitleVal('')
    setTitleManual(false)
    setEditingTitle(false)
    setHeadlineMode(false)

    const newGoal = { id: crypto.randomUUID(), html, title: finalTitle, collapsed: false }
    api.createPage(newGoal).then(() => onGoalCreated?.(newGoal)).catch(console.error)
  }

  return (
    <div className={styles.page}>

      {/* ── Floating background goals ─────────────────────────────────── */}
      <div className={styles.floatingLayer} aria-hidden="true">
        {goals.map(g => {
          const p = getPos(g.id)
          return (
            <span
              key={g.id}
              className={`${styles.floatingGoal} ${styles[`drift${p.variant}`]}`}
              style={{
                left:              `${p.left}%`,
                top:               `${p.top}%`,
                fontSize:          `${p.size}px`,
                opacity:           p.opacity,
                animationDuration: `${p.duration}s`,
                animationDelay:    `${p.delay}s`,
              }}
            >
              {g.title}
            </span>
          )
        })}
      </div>

      {/* ── Central input ─────────────────────────────────────────────── */}
      <div className={styles.center}>

        {/* Title — sits above the card */}
        <div className={styles.titleRow}>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className={styles.titleEditInput}
              value={titleVal}
              onChange={e => { setTitleVal(e.target.value); setTitleManual(true) }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submit() }
              }}
              placeholder="Title…"
            />
          ) : (
            <div className={styles.titleDisplay} onClick={handleTitleClick}>
              <span className={titleVal ? styles.titleText : styles.titlePlaceholder}>
                {titleVal || 'Title…'}
              </span>
              <svg className={styles.editIcon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </div>
          )}
        </div>

        {/* Description editor + headline overlay */}
        <div className={styles.editorWrap}>
          <div
            ref={editorRef}
            className={styles.editor}
            contentEditable={!headlineMode}
            suppressContentEditableWarning
            data-placeholder="define goals…"
            onInput={handleDescriptionInput}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
          />
          {headlineMode && (
            <div className={styles.overlay} onClick={() => { setHeadlineMode(false); setEditingTitle(false) }}>
              {wordRects.map((w, i) => (
                <button
                  key={i}
                  className={styles.wordBtn}
                  style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.submitBtn} onClick={submit}>add ↵</button>
        </div>
      </div>

      {/* ── Float-away ghost ─────────────────────────────────────────── */}
      {ghost && (
        <div
          className={styles.floatGhost}
          style={{ left: ghost.rect.left, top: ghost.rect.top, width: ghost.rect.width, height: ghost.rect.height }}
          dangerouslySetInnerHTML={{ __html: ghost.html }}
          onAnimationEnd={() => setGhost(null)}
        />
      )}
    </div>
  )
}
