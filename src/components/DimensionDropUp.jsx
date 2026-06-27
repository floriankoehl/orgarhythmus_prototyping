import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import styles from './DimensionDropUp.module.css'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']

export default function DimensionDropUp({
  dimensions,
  categories = [],
  value,
  onChange,
  onDimDataChanged,  // () => void — called after any successful mutation
  onReorder,         // legacy prop, kept for compat
  emptyLabel = 'Color legend',
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)
  const [expandedDimId, setExpandedDimId] = useState(null)
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatColor, setNewCatColor] = useState(PRESET_COLORS[0])
  const [editingCatId, setEditingCatId] = useState(null)
  const [editCatName, setEditCatName] = useState('')
  const [editCatColor, setEditCatColor] = useState('')
  const [addingDim, setAddingDim] = useState(false)
  const [newDimName, setNewDimName] = useState('')
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  const wheelAtRef = useRef(0)
  const newCatInputRef = useRef(null)
  const newDimInputRef = useRef(null)
  const editCatInputRef = useRef(null)

  const notify = () => { onDimDataChanged?.() }

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

  useEffect(() => { if (addingCat) newCatInputRef.current?.focus() }, [addingCat])
  useEffect(() => { if (addingDim) newDimInputRef.current?.focus() }, [addingDim])
  useEffect(() => { if (editingCatId) editCatInputRef.current?.select() }, [editingCatId])

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

  // Reorderable = user-created dims only (no dynamic/system)
  const reorderableDims = dimensions.filter(d => !d.dynamic && !d.system)
  const dynamicDims = dimensions.filter(d => d.dynamic || d.system)

  const previewDims = dragIdx !== null && overIdx !== null && dragIdx !== overIdx
    ? (() => { const a = [...reorderableDims]; const [x] = a.splice(dragIdx, 1); a.splice(overIdx, 0, x); return a })()
    : reorderableDims

  const handleDrop = async toIdx => {
    if (dragIdx === null || dragIdx === toIdx) { setDragIdx(null); setOverIdx(null); return }
    const arr = [...reorderableDims]
    const [item] = arr.splice(dragIdx, 1)
    arr.splice(toIdx, 0, item)
    const ids = arr.map(d => d.id)
    setDragIdx(null); setOverIdx(null)
    try { await api.reorderDimensions(ids); notify(); onReorder?.(ids) }
    catch (e) { console.error(e) }
  }

  const handleAddDim = async e => {
    e.preventDefault()
    if (!newDimName.trim()) return
    try {
      await api.createDimension({ name: newDimName.trim() })
      setNewDimName(''); setAddingDim(false)
      notify()
    } catch (e) { console.error(e) }
  }

  const handleAddCat = async (dimId, e) => {
    e.preventDefault()
    if (!newCatName.trim()) return
    try {
      await api.createCategory(dimId, { name: newCatName.trim(), color: newCatColor })
      setNewCatName(''); setNewCatColor(PRESET_COLORS[0]); setAddingCat(false)
      notify()
    } catch (e) { console.error(e) }
  }

  const startEditCat = cat => {
    setEditingCatId(cat.id)
    setEditCatName(cat.name)
    setEditCatColor(cat.color)
    setAddingCat(false)
  }

  const handleEditCatSave = async () => {
    if (!editingCatId || !editCatName.trim()) return
    try {
      await api.updateCategory(editingCatId, { name: editCatName.trim(), color: editCatColor })
      setEditingCatId(null)
      notify()
    } catch (e) { console.error(e) }
  }

  const handleDeleteCat = async catId => {
    try { await api.deleteCategory(catId); notify() }
    catch (e) { console.error(e) }
  }

  const toggleExpand = dimId => {
    setExpandedDimId(prev => prev === dimId ? null : dimId)
    setAddingCat(false); setEditingCatId(null)
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
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: Math.max(pos.width, 200) }}
        >
          {/* None */}
          <button
            className={`${styles.option} ${!value ? styles.active : ''}`}
            onClick={() => { onChange(''); setOpen(false) }}
          >
            None
          </button>

          {/* Reorderable dims */}
          {previewDims.map((dim, i) => (
            <div key={dim.id}>
              <div
                className={`${styles.dimRow} ${overIdx === i ? styles.dimRowOver : ''}`}
                draggable
                onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(i) }}
                onDragOver={e => { e.preventDefault(); if (dragIdx !== null) setOverIdx(i) }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                onDrop={e => { e.preventDefault(); handleDrop(i) }}
              >
                <span className={styles.dragHandle}>
                  <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
                    <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
                    <circle cx="2" cy="6" r="1.2"/><circle cx="6" cy="6" r="1.2"/>
                    <circle cx="2" cy="10" r="1.2"/><circle cx="6" cy="10" r="1.2"/>
                  </svg>
                </span>
                <button
                  className={`${styles.option} ${styles.optionInRow} ${dim.id === value ? styles.active : ''}`}
                  onClick={() => { onChange(dim.id); setOpen(false) }}
                >
                  {dim.name}
                </button>
                {onDimDataChanged && (
                  <button
                    className={styles.expandBtn}
                    title={expandedDimId === dim.id ? 'Collapse' : 'Manage categories'}
                    onClick={e => { e.stopPropagation(); toggleExpand(dim.id) }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
                      style={{ transform: expandedDimId === dim.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.1s' }}>
                      <path d="M7 10l5 5 5-5z"/>
                    </svg>
                  </button>
                )}
              </div>

              {/* Category management panel */}
              {onDimDataChanged && expandedDimId === dim.id && (
                <div className={styles.catSection}>
                  {categories.filter(c => c.dimensionId === dim.id).map(cat => (
                    <div key={cat.id} className={styles.catRow}>
                      {editingCatId === cat.id ? (
                        <div className={styles.catEditForm}>
                          <div className={styles.catEditColors}>
                            {PRESET_COLORS.map(c => (
                              <button key={c} type="button"
                                className={`${styles.catEditSwatch} ${editCatColor === c ? styles.catEditSwatchActive : ''}`}
                                style={{ background: c }}
                                onClick={() => setEditCatColor(c)}
                              />
                            ))}
                            <input type="color" className={styles.catEditColorFull}
                              value={editCatColor} onChange={e => setEditCatColor(e.target.value)} />
                          </div>
                          <div className={styles.catEditNameRow}>
                            <input ref={editCatInputRef} className={styles.catEditInput}
                              value={editCatName} onChange={e => setEditCatName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleEditCatSave()
                                if (e.key === 'Escape') setEditingCatId(null)
                              }}
                            />
                            <button className={styles.catSaveBtn} onClick={handleEditCatSave}>✓</button>
                            <button className={styles.catCancelBtn} onClick={() => setEditingCatId(null)}>✕</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <span className={styles.catDot} style={{ background: cat.color }} />
                          <span className={styles.catName}>{cat.name}</span>
                          <button className={styles.catEditBtn} title="Edit" onClick={() => startEditCat(cat)}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
                            </svg>
                          </button>
                          <button className={styles.catDeleteBtn} title="Delete" onClick={() => handleDeleteCat(cat.id)}>✕</button>
                        </>
                      )}
                    </div>
                  ))}

                  {/* Add category */}
                  {addingCat ? (
                    <form className={styles.addCatForm} onSubmit={e => handleAddCat(dim.id, e)}>
                      <div className={styles.catEditColors}>
                        {PRESET_COLORS.map(c => (
                          <button key={c} type="button"
                            className={`${styles.catEditSwatch} ${newCatColor === c ? styles.catEditSwatchActive : ''}`}
                            style={{ background: c }}
                            onClick={() => setNewCatColor(c)}
                          />
                        ))}
                        <input type="color" className={styles.catEditColorFull}
                          value={newCatColor} onChange={e => setNewCatColor(e.target.value)} />
                      </div>
                      <div className={styles.catEditNameRow}>
                        <input ref={newCatInputRef} className={styles.catEditInput}
                          placeholder="Category name…"
                          value={newCatName} onChange={e => setNewCatName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Escape') { setAddingCat(false); setNewCatName('') } }}
                        />
                        <button type="submit" className={styles.catSaveBtn}>✓</button>
                        <button type="button" className={styles.catCancelBtn}
                          onClick={() => { setAddingCat(false); setNewCatName('') }}>✕</button>
                      </div>
                    </form>
                  ) : (
                    <button className={styles.addCatBtn}
                      onClick={() => { setAddingCat(true); setEditingCatId(null) }}>
                      + Add category
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Dynamic dims (not reorderable, just selectable) */}
          {dynamicDims.length > 0 && (
            <div className={styles.sectionDivider}>
              <span>Special</span>
            </div>
          )}
          {dynamicDims.map(dim => (
            <div key={dim.id} className={styles.dimRow}>
              <button
                className={`${styles.option} ${styles.optionInRow} ${dim.id === value ? styles.active : ''}`}
                style={{ paddingLeft: 14 }}
                onClick={() => { onChange(dim.id); setOpen(false) }}
              >
                {dim.name}
              </button>
            </div>
          ))}

          {/* Add dimension */}
          {onDimDataChanged && (
            addingDim ? (
              <form className={styles.addDimForm} onSubmit={handleAddDim}>
                <input ref={newDimInputRef} className={styles.addDimInput}
                  placeholder="Dimension name…"
                  value={newDimName} onChange={e => setNewDimName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setAddingDim(false); setNewDimName('') } }}
                />
                <button type="submit" className={styles.catSaveBtn}>✓</button>
                <button type="button" className={styles.catCancelBtn}
                  onClick={() => { setAddingDim(false); setNewDimName('') }}>✕</button>
              </form>
            ) : (
              <button className={styles.addDimBtn} onClick={() => setAddingDim(true)}>
                + New dimension
              </button>
            )
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
