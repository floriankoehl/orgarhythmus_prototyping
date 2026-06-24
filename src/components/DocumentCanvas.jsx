import { useState, useRef, useEffect } from 'react'
import styles from './DocumentCanvas.module.css'
import { api } from '../api'

const mkGoal = (overrides = {}) => ({
  id: crypto.randomUUID(),
  html: '',
  title: 'Untitled',
  collapsed: false,
  ...overrides,
})

// ── DOM helpers ───────────────────────────────────────────────────────────────
function caretAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y)
  const pos = document.caretPositionFromPoint?.(x, y)
  if (!pos) return null
  const r = document.createRange()
  r.setStart(pos.offsetNode, pos.offset)
  r.collapse(true)
  return r
}

function snapToLineTop(pageEl, clientY) {
  const rect = pageEl.getBoundingClientRect()
  const range = caretAt(rect.left + 200, clientY)
  if (range) {
    const rects = range.getClientRects()
    if (rects.length > 0) return Math.round(rects[0].top - rect.top)
  }
  return Math.round(clientY - rect.top)
}

function splitAt(editorEl, cutRange) {
  const top = document.createRange()
  top.selectNodeContents(editorEl)
  top.setEnd(cutRange.startContainer, cutRange.startOffset)
  const bot = document.createRange()
  bot.selectNodeContents(editorEl)
  bot.setStart(cutRange.startContainer, cutRange.startOffset)
  const html = r => { const d = document.createElement('div'); d.appendChild(r.cloneContents()); return d.innerHTML }
  return [html(top), html(bot)]
}

function deriveTitle(el) {
  const words = (el?.innerText || '').trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 7).join(' ') || 'Untitled'
}

function computeWordRects(editorEl, pageEl) {
  const pageRect = pageEl.getBoundingClientRect()
  const result = []
  const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const re = /\S+/g; let m
    while ((m = re.exec(node.textContent)) !== null) {
      const range = document.createRange()
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0)
        result.push({ word: m[0], top: rect.top - pageRect.top, left: rect.left - pageRect.left, width: rect.width, height: rect.height })
    }
  }
  return result
}

// ── Gap between goals ─────────────────────────────────────────────────────────
function GoalGap({ onMerge, disabled }) {
  const [hot, setHot] = useState(false)
  return (
    <div className={styles.gap} onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}>
      {hot && !disabled && (
        <button className={styles.mergeBtn} onClick={onMerge} title="Merge goals">
          <MergeIcon /> merge
        </button>
      )}
    </div>
  )
}

// ── Single goal card ──────────────────────────────────────────────────────────
function Goal({ goal, hoverY, onUpdate, onZoneMove, onZoneLeave, onZoneClick, onRegister, onEmpty }) {
  const [titleIsCustom, setTitleIsCustom] = useState(goal.title !== 'Untitled')
  const [editingTitle, setEditingTitle] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects] = useState([])
  const [headlineStarted, setHeadlineStarted] = useState(false)
  const [hovered, setHovered] = useState(false)
  const editorElRef = useRef(null)
  const pageElRef = useRef(null)

  useEffect(() => {
    if (!titleIsCustom) {
      const derived = deriveTitle(editorElRef.current)
      if (derived !== 'Untitled') onUpdate({ title: derived })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!headlineMode) return
    const onKey = e => { if (e.key === 'Escape') setHeadlineMode(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [headlineMode])

  const enterHeadlineMode = () => {
    if (!editorElRef.current || !pageElRef.current) return
    setWordRects(computeWordRects(editorElRef.current, pageElRef.current))
    setHeadlineStarted(false)
    setHeadlineMode(true)
  }

  const handleWordClick = word => {
    const next = headlineStarted ? goal.title + ' ' + word : word
    if (!headlineStarted) setHeadlineStarted(true)
    setTitleIsCustom(true)
    onUpdate({ title: next })
  }

  const commitTitle = val => {
    onUpdate({ title: val.trim() || 'Untitled' })
    setTitleIsCustom(true)
    setEditingTitle(false)
  }

  return (
    <div className={styles.goalContainer} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className={styles.titleRow}>
        <button className={styles.collapseBtn} onClick={() => onUpdate({ collapsed: !goal.collapsed })} title={goal.collapsed ? 'Expand' : 'Collapse'}>
          <ChevronIcon collapsed={goal.collapsed} />
        </button>
        {editingTitle ? (
          <input
            className={styles.titleInput}
            defaultValue={goal.title}
            autoFocus
            onFocus={e => e.target.select()}
            onBlur={e => commitTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur() }}
          />
        ) : (
          <span className={styles.goalTitle} onDoubleClick={() => setEditingTitle(true)} title="Double-click to edit">
            {goal.title}
          </span>
        )}
        {(hovered || headlineMode) && !editingTitle && (
          <button
            className={`${styles.headlineBtn} ${headlineMode ? styles.headlineBtnActive : ''}`}
            onClick={headlineMode ? () => setHeadlineMode(false) : enterHeadlineMode}
            title={headlineMode ? 'Exit headline mode (Esc)' : 'Pick headline from text'}
          >
            {headlineMode ? '✕' : <TagIcon />}
          </button>
        )}
      </div>

      {!goal.collapsed && (
        <div ref={el => { onRegister(goal.id, 'page', el); pageElRef.current = el }} className={styles.goal}>
          {!headlineMode && (
            <div className={styles.leftZone} onMouseMove={onZoneMove} onMouseLeave={onZoneLeave} onClick={onZoneClick} />
          )}
          {!headlineMode && hoverY !== null && (
            <div className={styles.hoverLine} style={{ top: hoverY }} />
          )}
          {headlineMode && (
            <div className={styles.headlineOverlay} onClick={() => setHeadlineMode(false)}>
              {wordRects.map((w, i) => (
                <button key={i} className={styles.wordBtn}
                  style={{ top: w.top, left: w.left, width: w.width, height: w.height }}
                  onClick={e => { e.stopPropagation(); handleWordClick(w.word) }}
                />
              ))}
            </div>
          )}
          <div
            ref={el => {
              onRegister(goal.id, 'editor', el)
              if (el && !el._ready) { el.innerHTML = goal.html; el._ready = true; editorElRef.current = el }
            }}
            className={styles.editor}
            contentEditable={!headlineMode}
            suppressContentEditableWarning
            spellCheck={!headlineMode}
            onInput={e => {
              const el = e.currentTarget
              if (!titleIsCustom) onUpdate({ title: deriveTitle(el) })
              onUpdate({ html: el.innerHTML })
              if (el.innerText.trim() === '') onEmpty?.()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                document.execCommand('insertParagraph')
                document.execCommand('insertParagraph')
              }
            }}
            data-placeholder="Start typing…"
          />
        </div>
      )}
    </div>
  )
}

// ── Canvas ────────────────────────────────────────────────────────────────────
export default function DocumentCanvas({ onGoalsChange, refreshKey }) {
  const initialGoal = useRef(mkGoal())
  const [goals, setGoals] = useState([initialGoal.current])
  const [hoverInfo, setHoverInfo] = useState(null)
  const refs = useRef({})
  const htmlSaveTimers = useRef({})

  // Notify parent whenever goals change (for Classification page)
  useEffect(() => {
    onGoalsChange?.(goals)
  }, [goals]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load from backend on mount ─────────────────────────────────────────────
  useEffect(() => {
    api.getPages()
      .then(data => {
        if (data.length > 0) {
          setGoals(data)
        } else {
          api.createPage(initialGoal.current).catch(console.error)
        }
      })
      .catch(() => {})
  }, [])

  // ── Re-fetch when a goal is added externally (e.g. quick-add in header) ────
  useEffect(() => {
    if (!refreshKey) return
    api.getPages().then(data => { if (data.length > 0) setGoals(data) }).catch(console.error)
  }, [refreshKey])

  const register = (goalId, type, el) => {
    if (!refs.current[goalId]) refs.current[goalId] = {}
    refs.current[goalId][type] = el
  }

  const updateGoal = (id, patch) => {
    setGoals(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g))

    if (patch.html !== undefined) {
      clearTimeout(htmlSaveTimers.current[id])
      htmlSaveTimers.current[id] = setTimeout(() => {
        api.updatePage(id, { html: patch.html }).catch(console.error)
      }, 800)
      const { html, ...rest } = patch
      if (Object.keys(rest).length > 0)
        api.updatePage(id, rest).catch(console.error)
    } else {
      api.updatePage(id, patch).catch(console.error)
    }
  }

  // ── Structural operations ──────────────────────────────────────────────────
  const addGoalAtTop = async () => {
    const goal = mkGoal()
    try {
      await api.createPage(goal)
      setGoals(prev => {
        const next = [goal, ...prev]
        api.reorderPages(next.map(g => g.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  const handleEmpty = id => {
    setGoals(prev => {
      if (prev.length <= 1) return prev
      const next = prev.filter(g => g.id !== id)
      api.deletePage(id).catch(console.error)
      return next
    })
  }

  const handleMerge = async i => {
    const a = goals[i], b = goals[i + 1]
    const htmlA = refs.current[a.id]?.editor?.innerHTML ?? a.html
    const htmlB = refs.current[b.id]?.editor?.innerHTML ?? b.html
    const merged = mkGoal({ html: htmlA + htmlB, title: a.title })
    try {
      await Promise.all([api.deletePage(a.id), api.deletePage(b.id)])
      await api.createPage(merged)
      setGoals(prev => {
        const next = [...prev]; next.splice(i, 2, merged)
        api.reorderPages(next.map(g => g.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  // ── Cut ────────────────────────────────────────────────────────────────────
  const handleZoneMove = (goalId, e) => {
    const pageEl = refs.current[goalId]?.page
    if (!pageEl) return
    setHoverInfo({ goalId, snapY: snapToLineTop(pageEl, e.clientY) })
  }

  const handleZoneLeave = () => setHoverInfo(null)

  const handleZoneClick = async goalId => {
    const info = hoverInfo
    if (!info || info.goalId !== goalId) return
    const { page: pageEl, editor: editorEl } = refs.current[goalId] || {}
    if (!pageEl || !editorEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const cutRange = caretAt(pageRect.left + 97, pageRect.top + info.snapY + 2)
    if (!cutRange) return

    const [html1, html2] = splitAt(editorEl, cutRange)
    const isEmpty = html => { const d = document.createElement('div'); d.innerHTML = html; return d.innerText.trim() === '' }

    const original = goals.find(g => g.id === goalId)
    const idx = goals.findIndex(g => g.id === goalId)
    const halves = [
      mkGoal({ html: html1, title: original?.title ?? 'Untitled' }),
      mkGoal({ html: html2 }),
    ].filter(g => !isEmpty(g.html))
    if (!halves.length) return

    setHoverInfo(null)
    try {
      await api.deletePage(goalId)
      await Promise.all(halves.map(g => api.createPage(g)))
      setGoals(prev => {
        const next = [...prev]; next.splice(idx, 1, ...halves)
        api.reorderPages(next.map(g => g.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  return (
    <div className={styles.canvas}>
      <button className={styles.addBtn} onClick={addGoalAtTop} title="New goal">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
      </button>
      {goals.flatMap((goal, i) => {
        const elements = [
          <Goal
            key={goal.id}
            goal={goal}
            hoverY={hoverInfo?.goalId === goal.id ? hoverInfo.snapY : null}
            onUpdate={patch => updateGoal(goal.id, patch)}
            onRegister={register}
            onZoneMove={e => handleZoneMove(goal.id, e)}
            onZoneLeave={handleZoneLeave}
            onZoneClick={() => handleZoneClick(goal.id)}
            onEmpty={() => handleEmpty(goal.id)}
          />
        ]
        if (i < goals.length - 1) {
          const mergeDisabled = goals[i].collapsed || goals[i + 1].collapsed
          elements.push(<GoalGap key={`gap-${i}`} onMerge={() => handleMerge(i)} disabled={mergeDisabled} />)
        }
        return elements
      })}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const ChevronIcon = ({ collapsed }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
    style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
    <path d="M7 10l5 5 5-5z"/>
  </svg>
)
const TagIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21.41 11.58l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .59 1.42l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.84zM5.5 7A1.5 1.5 0 1 1 7 5.5 1.5 1.5 0 0 1 5.5 7z"/>
  </svg>
)
const MergeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4 }}>
    <path d="M16 13h-3V3h-2v10H8l4 4 4-4zm-8 6v2h16v-2H8z"/>
  </svg>
)
