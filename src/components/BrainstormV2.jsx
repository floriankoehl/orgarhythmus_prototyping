import { useState, useRef, useEffect } from 'react'
import styles from './BrainstormV2.module.css'
import { api } from '../api'

const DRIFT_VARIANTS = 6

function deriveTitle(text) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ') || 'Untitled'
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
  const [title, setTitle]                     = useState('')
  const [headlineMode, setHeadlineMode]       = useState(false)
  const [wordRects, setWordRects]             = useState([])
  const [headlineStarted, setHeadlineStarted] = useState(false)

  const editorRef    = useRef(null)
  const positionsRef = useRef({})  // stable random positions per goal id

  // Assign stable random style per goal (persists across re-renders)
  const getPos = (goalId) => {
    if (!positionsRef.current[goalId]) {
      positionsRef.current[goalId] = {
        left:     3 + Math.random() * 87,     // % from left
        top:      4 + Math.random() * 82,     // % from top
        variant:  Math.floor(Math.random() * DRIFT_VARIANTS),
        duration: 38 + Math.random() * 50,    // seconds
        delay:    -(Math.random() * 45),      // start mid-animation
        size:     11 + Math.random() * 10,    // px
        opacity:  0.05 + Math.random() * 0.11,
      }
    }
    return positionsRef.current[goalId]
  }

  // Focus editor on mount
  useEffect(() => { editorRef.current?.focus() }, [])

  // Escape exits headline mode
  useEffect(() => {
    if (!headlineMode) return
    const h = (e) => { if (e.key === 'Escape') setHeadlineMode(false) }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [headlineMode])

  const submit = async () => {
    const content = editorRef.current?.innerText?.trim() || ''
    if (!content) return
    const finalTitle = title.trim() || deriveTitle(content)
    const html = editorRef.current?.innerHTML || ''
    const newGoal = { id: crypto.randomUUID(), html, title: finalTitle, collapsed: false }
    try {
      await api.createPage(newGoal)
      onGoalCreated?.(newGoal)
      if (editorRef.current) { editorRef.current.innerHTML = ''; editorRef.current.focus() }
      setTitle('')
      setHeadlineMode(false)
      setHeadlineStarted(false)
    } catch (e) { console.error(e) }
  }

  const enterHeadlineMode = () => {
    if (!editorRef.current) return
    setWordRects(computeWordRects(editorRef.current))
    setHeadlineStarted(false)
    setHeadlineMode(true)
  }

  const handleWordClick = (word) => {
    const next = headlineStarted ? title + ' ' + word : word
    setHeadlineStarted(true)
    setTitle(next)
  }

  return (
    <div className={styles.page}>

      {/* ── Floating background goals ───────────────────────────────────── */}
      <div className={styles.floatingLayer} aria-hidden="true">
        {goals.map(g => {
          const p = getPos(g.id)
          return (
            <span
              key={g.id}
              className={`${styles.floatingGoal} ${styles[`drift${p.variant}`]}`}
              style={{
                left:             `${p.left}%`,
                top:              `${p.top}%`,
                fontSize:         `${p.size}px`,
                opacity:          p.opacity,
                animationDuration:`${p.duration}s`,
                animationDelay:   `${p.delay}s`,
              }}
            >
              {g.title}
            </span>
          )
        })}
      </div>

      {/* ── Central input ───────────────────────────────────────────────── */}
      <div className={styles.center}>

        {/* Optional title — subtle, above description */}
        <input
          className={styles.titleInput}
          value={title}
          onChange={e => { setTitle(e.target.value); setHeadlineStarted(false) }}
          placeholder="title (optional)"
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submit() }
          }}
        />

        {/* Description editor + headline overlay */}
        <div className={styles.editorWrap}>
          <div
            ref={editorRef}
            className={styles.editor}
            contentEditable={!headlineMode}
            suppressContentEditableWarning
            data-placeholder="what's on your mind…"
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
          />
          {headlineMode && (
            <div className={styles.overlay} onClick={() => setHeadlineMode(false)}>
              {wordRects.map((w, i) => (
                <button
                  key={i}
                  className={styles.wordBtn}
                  style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                  onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Actions row */}
        <div className={styles.actions}>
          <button
            className={`${styles.headlineBtn} ${headlineMode ? styles.headlineBtnActive : ''}`}
            onClick={headlineMode ? () => setHeadlineMode(false) : enterHeadlineMode}
          >
            {headlineMode ? '✕ exit headline' : '# headline'}
          </button>
          <button className={styles.submitBtn} onClick={submit}>
            add ↵
          </button>
        </div>
      </div>
    </div>
  )
}
