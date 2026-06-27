import { useState, useRef, useEffect } from 'react'
import styles from './Header.module.css'
import { api } from '../api'
import CategoryAssignmentPicker from './CategoryAssignmentPicker'
import CategoryHashtagSuggestions from './CategoryHashtagSuggestions'
import { mergeSelectionsWithHashtags } from '../categoryHashtags'
import { useProgressiveNoteSearch } from '../useProgressiveNoteSearch'

const PAGES = [
  { name: 'Notes', view: 1 },
  { name: 'Classification', view: 2 },
  { name: 'Schedule', view: 3 },
  { name: 'People', view: 5 },
]

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

export default function Header({ view, onNavigate, onQuickAdd, projectName, onBack, notes = [], onNoteOpen }) {
  // quick-add state
  const [open, setOpen]               = useState(false)
  const [titleVal, setTitleVal]       = useState('')
  const [titleManual, setTitleManual] = useState(false)
  const [headlineMode, setHeadlineMode] = useState(false)
  const [wordRects, setWordRects]     = useState([])
  const [dimensions, setDimensions]   = useState([])
  const [categories, setCategories]   = useState([])
  const [categorySelections, setCategorySelections] = useState({})
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false)

  // search state
  const [searchOpen, setSearchOpen]   = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const editorRef      = useRef(null)
  const titleInputRef  = useRef(null)
  const wrapRef        = useRef(null)
  const searchInputRef = useRef(null)
  const searchWrapRef  = useRef(null)

  useEffect(() => {
    if (open) setTimeout(() => editorRef.current?.focus(), 20)
  }, [open])

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 20)
    else setSearchQuery('')
  }, [searchOpen])

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
    const text = editorRef.current?.innerText || ''
    if (text.includes('#')) ensureCategoryData()
    if (!titleManual && editorRef.current) {
      const words = text.trim().split(/\s+/).filter(Boolean)
      setTitleVal(words.slice(0, 7).join(' '))
    }
    setCategorySelections(prev => mergeSelectionsWithHashtags(prev, text, categories))
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
    onQuickAdd?.(desc, titleVal.trim() || null, mergeSelectionsWithHashtags(categorySelections, desc, categories))
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

  useEffect(() => {
    if (!searchOpen) return
    const handler = e => {
      if (searchWrapRef.current?.contains(e.target)) return
      setSearchOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchOpen])

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === 'Escape') closePopup()
  }

  const toggleHeadline = () => {
    const next = !headlineMode
    setHeadlineMode(next)
    if (next && editorRef.current) setWordRects(computeWordRects(editorRef.current))
  }

  // search logic
  const { results: searchResults, searchingDescriptions, validQuery } = useProgressiveNoteSearch(notes, searchQuery)
  const headlineSearchResults = searchResults.filter(result => result.matchType === 'strong')
  const descriptionSearchResults = searchResults.filter(result => result.matchType === 'weak')

  const openResult = (noteId) => {
    setSearchOpen(false)
    onNoteOpen?.(noteId)
  }

  return (
    <header className={styles.header}>
      {onBack && (
        <button className={styles.backBtn} onClick={onBack} title="See all projects" aria-label="See all projects">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8A1.5 1.5 0 0 0 13 12.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M9 2h5v5M14 2 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
      {projectName && (
        <button
          className={`${styles.projectNameBtn} ${view === 0 ? styles.projectNameBtnActive : ''}`}
          onClick={() => onNavigate(0)}
          title="Open project overview">
          {projectName}
        </button>
      )}

      <nav className={styles.nav}>
        {PAGES.map(note => (
          <button key={note.view}
            className={`${styles.navItem} ${view === note.view ? styles.active : ''}`}
            onClick={() => onNavigate(note.view)}>
            {note.name}
          </button>
        ))}
      </nav>

      {/* Search button */}
      {view !== 1 && <div ref={searchWrapRef} className={styles.searchWrap}>
        <button
          className={`${styles.searchBtn} ${searchOpen ? styles.searchBtnActive : ''}`}
          onClick={() => setSearchOpen(o => !o)}
          title="Search notes">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M10 10l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>

        {searchOpen && (
          <div className={styles.searchPanel}>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearchOpen(false) }}
              placeholder="Search notes… (regex ok)"
            />
            {searchQuery.trim() && (
              <div className={styles.searchResults}>
                {!validQuery ? (
                  <div className={styles.searchEmpty}>Invalid regex</div>
                ) : searchResults.length === 0 && !searchingDescriptions ? (
                  <div className={styles.searchEmpty}>No results</div>
                ) : (
                  <>
                    {headlineSearchResults.length > 0 && (
                      <div className={styles.searchResultSection}>
                        <div className={styles.searchResultSectionTitle}>In headline</div>
                        {headlineSearchResults.map(({ note }) => (
                          <button
                            key={note.id}
                            className={styles.searchResultCard}
                            onClick={() => openResult(note.id)}>
                            <span className={styles.searchResultTitle}>{note.title || 'Untitled'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {descriptionSearchResults.length > 0 && (
                      <div className={styles.searchResultSection}>
                        <div className={styles.searchResultSectionTitle}>In description</div>
                        {descriptionSearchResults.map(({ note, snippet }) => (
                          <button
                            key={note.id}
                            className={styles.searchResultCard}
                            onClick={() => openResult(note.id)}>
                          <span className={styles.searchResultTitle}>{note.title || 'Untitled'}</span>
                            {snippet && (
                              <span className={styles.searchResultSnippet}>{snippet}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                    {searchingDescriptions && (
                      <div className={styles.searchLoading}>Searching descriptions...</div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>}

      {/* Quick-add button */}
      {view !== 1 && <div ref={wrapRef} className={styles.quickAddWrap}>
        <button className={styles.quickAddBtn} onClick={() => setOpen(o => !o)} title="Quick add note">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 8h6M5 5.5h4M5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M11.5 10l1 1 1.5-1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {open && (
          <div className={styles.quickAddPopup}>
            <div className={styles.quickAddTopRow}>
              <span className={styles.quickAddLabel}>Quick add note</span>
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
                data-placeholder="Describe your note…"
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
              {!headlineMode && (
                <CategoryHashtagSuggestions
                  editorRef={editorRef}
                  dimensions={dimensions}
                  categories={categories}
                  placement="above"
                  onPick={cat => setCategorySelections(prev => ({ ...prev, [cat.dimensionId]: cat.id }))}
                />
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
      </div>}
    </header>
  )
}
