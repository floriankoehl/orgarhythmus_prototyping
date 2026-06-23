import { useState, useRef, useEffect } from 'react'
import styles from './DocumentCanvas.module.css'
import { api } from '../api'

// ── Page factory ──────────────────────────────────────────────────────────────
// html is initial content only; live content lives in the DOM via contentEditable
const mkPage = (overrides = {}) => ({
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

// ── Gap between pages ─────────────────────────────────────────────────────────
function PageGap({ onMerge, disabled }) {
  const [hot, setHot] = useState(false)
  return (
    <div className={styles.gap} onMouseEnter={() => setHot(true)} onMouseLeave={() => setHot(false)}>
      {hot && !disabled && (
        <button className={styles.mergeBtn} onClick={onMerge} title="Merge pages">
          <MergeIcon /> merge
        </button>
      )}
    </div>
  )
}

// ── Single page card ──────────────────────────────────────────────────────────
function Page({ page, hoverY, onUpdate, onZoneMove, onZoneLeave, onZoneClick, onRegister, onEmpty }) {
  const [titleIsCustom, setTitleIsCustom] = useState(page.title !== 'Untitled')
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
    const next = headlineStarted ? page.title + ' ' + word : word
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
    <div className={styles.pageContainer} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className={styles.titleRow}>
        <button className={styles.collapseBtn} onClick={() => onUpdate({ collapsed: !page.collapsed })} title={page.collapsed ? 'Expand' : 'Collapse'}>
          <ChevronIcon collapsed={page.collapsed} />
        </button>
        {editingTitle ? (
          <input
            className={styles.titleInput}
            defaultValue={page.title}
            autoFocus
            onFocus={e => e.target.select()}
            onBlur={e => commitTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur() }}
          />
        ) : (
          <span className={styles.pageTitle} onDoubleClick={() => setEditingTitle(true)} title="Double-click to edit">
            {page.title}
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

      {!page.collapsed && <div
        ref={el => { onRegister(page.id, 'page', el); pageElRef.current = el }}
        className={styles.page}
      >
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
            onRegister(page.id, 'editor', el)
            if (el && !el._ready) { el.innerHTML = page.html; el._ready = true; editorElRef.current = el }
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
      </div>}
    </div>
  )
}

// ── Canvas ────────────────────────────────────────────────────────────────────
export default function DocumentCanvas() {
  const initialPage = useRef(mkPage())
  const [pages, setPages] = useState([initialPage.current])
  const [hoverInfo, setHoverInfo] = useState(null)
  const refs = useRef({})
  const htmlSaveTimers = useRef({})

  // ── Load from backend on mount ─────────────────────────────────────────────
  useEffect(() => {
    api.getPages()
      .then(data => {
        if (data.length > 0) {
          setPages(data)
        } else {
          // Backend is empty — register the default page so PATCHes don't 404
          api.createPage(initialPage.current).catch(console.error)
        }
      })
      .catch(() => { /* backend not running — use local default */ })
  }, [])

  // ── Registration ───────────────────────────────────────────────────────────
  const register = (pageId, type, el) => {
    if (!refs.current[pageId]) refs.current[pageId] = {}
    refs.current[pageId][type] = el
  }

  // ── Page updates (title / collapsed / html) ────────────────────────────────
  const updatePage = (id, patch) => {
    setPages(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p))

    if (patch.html !== undefined) {
      // Debounce html saves — no point hitting the API on every keystroke
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
  const addPageAtTop = async () => {
    const page = mkPage()
    try {
      await api.createPage(page)
      setPages(prev => {
        const next = [page, ...prev]
        api.reorderPages(next.map(p => p.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  const handleEmpty = id => {
    setPages(prev => {
      if (prev.length <= 1) return prev
      const next = prev.filter(p => p.id !== id)
      api.deletePage(id).catch(console.error)
      return next
    })
  }

  const handleMerge = async i => {
    const a = pages[i], b = pages[i + 1]
    const htmlA = refs.current[a.id]?.editor?.innerHTML ?? a.html
    const htmlB = refs.current[b.id]?.editor?.innerHTML ?? b.html
    const merged = mkPage({ html: htmlA + htmlB, title: a.title })
    try {
      await Promise.all([api.deletePage(a.id), api.deletePage(b.id)])
      await api.createPage(merged)
      setPages(prev => {
        const next = [...prev]; next.splice(i, 2, merged)
        api.reorderPages(next.map(p => p.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  // ── Cut ────────────────────────────────────────────────────────────────────
  const handleZoneMove = (pageId, e) => {
    const pageEl = refs.current[pageId]?.page
    if (!pageEl) return
    setHoverInfo({ pageId, snapY: snapToLineTop(pageEl, e.clientY) })
  }

  const handleZoneLeave = () => setHoverInfo(null)

  const handleZoneClick = async pageId => {
    const info = hoverInfo
    if (!info || info.pageId !== pageId) return
    const { page: pageEl, editor: editorEl } = refs.current[pageId] || {}
    if (!pageEl || !editorEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const cutRange = caretAt(pageRect.left + 97, pageRect.top + info.snapY + 2)
    if (!cutRange) return

    const [html1, html2] = splitAt(editorEl, cutRange)
    const isEmpty = html => { const d = document.createElement('div'); d.innerHTML = html; return d.innerText.trim() === '' }

    const original = pages.find(p => p.id === pageId)
    const idx = pages.findIndex(p => p.id === pageId)
    const halves = [
      mkPage({ html: html1, title: original?.title ?? 'Untitled' }),
      mkPage({ html: html2 }),
    ].filter(p => !isEmpty(p.html))
    if (!halves.length) return

    setHoverInfo(null)
    try {
      await api.deletePage(pageId)
      await Promise.all(halves.map(p => api.createPage(p)))
      setPages(prev => {
        const next = [...prev]; next.splice(idx, 1, ...halves)
        api.reorderPages(next.map(p => p.id)).catch(console.error)
        return next
      })
    } catch (e) { console.error(e) }
  }

  return (
    <div className={styles.canvas}>
      <button className={styles.addBtn} onClick={addPageAtTop} title="New page">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
      </button>
      {pages.flatMap((page, i) => {
        const elements = [
          <Page
            key={page.id}
            page={page}
            hoverY={hoverInfo?.pageId === page.id ? hoverInfo.snapY : null}
            onUpdate={patch => updatePage(page.id, patch)}
            onRegister={register}
            onZoneMove={e => handleZoneMove(page.id, e)}
            onZoneLeave={handleZoneLeave}
            onZoneClick={() => handleZoneClick(page.id)}
            onEmpty={() => handleEmpty(page.id)}
          />
        ]
        if (i < pages.length - 1) {
          const mergeDisabled = pages[i].collapsed || pages[i + 1].collapsed
          elements.push(<PageGap key={`gap-${i}`} onMerge={() => handleMerge(i)} disabled={mergeDisabled} />)
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
