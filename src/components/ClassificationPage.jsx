import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import styles from './ClassificationPage.module.css'
import { api } from '../api'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

function makeColorCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

// ── Classification toolbar ────────────────────────────────────────────────────
function ClassificationToolbar({ dimensions, containerDimId, onContainerDimChange, onCreateDim, onRequestDeleteDim }) {
  const [dimMenuOpen, setDimMenuOpen] = useState(false)
  const [adding, setAdding]           = useState(false)
  const [newDimName, setNewDimName]   = useState('')
  const dimMenuRef  = useRef()
  const addInputRef = useRef()

  useEffect(() => {
    if (!dimMenuOpen) return
    const close = e => { if (!dimMenuRef.current?.contains(e.target)) setDimMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [dimMenuOpen])

  useEffect(() => { if (adding) addInputRef.current?.focus() }, [adding])

  const submit = e => {
    e.preventDefault()
    if (!newDimName.trim()) return
    onCreateDim(newDimName.trim())
    setNewDimName('')
    setAdding(false)
  }

  const cancel = () => { setAdding(false); setNewDimName('') }

  const Chevron = ({ open }) => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}>
      <path d="M7 10l5 5 5-5z"/>
    </svg>
  )

  return (
    <div className={styles.classToolbar}>
      {/* Left: inline group-by pills — no label */}
      <div className={styles.tbGroupBy}>
        <button
          className={`${styles.tbGroupByPill} ${!containerDimId ? styles.tbGroupByPillActive : ''}`}
          onClick={() => onContainerDimChange('')}>
          None
        </button>
        {dimensions.map(d => (
          <button key={d.id}
            className={`${styles.tbGroupByPill} ${d.id === containerDimId ? styles.tbGroupByPillActive : ''}`}
            onClick={() => onContainerDimChange(d.id)}>
            {d.name}
          </button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Dimensions dropdown */}
      <div ref={dimMenuRef} className={styles.tbSelector}>
        <button
          className={`${styles.tbSelectorBtn} ${dimMenuOpen ? styles.tbSelectorBtnOpen : ''}`}
          onClick={() => setDimMenuOpen(v => !v)}>
          Dimensions<Chevron open={dimMenuOpen} />
        </button>
        {dimMenuOpen && (
          <div className={`${styles.tbDropdown} ${styles.tbDropdownRight}`}>
            {dimensions.length === 0
              ? <div className={styles.tbDropdownEmpty}>No dimensions yet</div>
              : dimensions.map(dim => (
                  <div key={dim.id} className={styles.tbDimRow}>
                    <span className={styles.tbDimRowName}>{dim.name}</span>
                    <button className={styles.tbDimRowDelete}
                      onClick={() => onRequestDeleteDim(dim.id)}>✕</button>
                  </div>
                ))
            }
          </div>
        )}
      </div>

      {/* Far right: add dimension */}
      {adding ? (
        <form className={styles.tbAddDimForm} onSubmit={submit}>
          <input ref={addInputRef} className={styles.tbAddDimInput} value={newDimName}
            onChange={e => setNewDimName(e.target.value)} placeholder="Dimension name…"
            onKeyDown={e => e.key === 'Escape' && cancel()} />
          <button type="submit" className={styles.tbAddDimBtn}>Add</button>
          <button type="button" className={styles.cancelBtn} onClick={cancel}>✕</button>
        </form>
      ) : (
        <button className={styles.tbAddDimTrigger} onClick={() => setAdding(true)}>
          + Add dimension
        </button>
      )}
    </div>
  )
}

// ── Category edit modal ───────────────────────────────────────────────────────
function CategoryEditModal({ cat, onClose, onSave, onDelete }) {
  const [name, setName]           = useState(cat.name)
  const [color, setColor]         = useState(cat.color)
  const [editingName, setEditingName] = useState(false)
  const [confirm, setConfirm]     = useState(false)
  const nameInputRef = useRef()

  useEffect(() => { if (editingName) nameInputRef.current?.select() }, [editingName])

  const save = () => {
    onSave(cat.id, { name: name.trim() || cat.name, color })
    onClose()
  }

  return createPortal(
    <div className={styles.modalBackdrop} onClick={onClose}>
      {confirm ? (
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <p className={styles.confirmText}>
            All goals assigned to <strong>"{cat.name}"</strong> will be unassigned.
            The goals themselves won't be deleted.
          </p>
          <div className={styles.modalActions}>
            <button className={styles.dangerBtn}
              onClick={() => { onDelete(cat.id); onClose() }}>
              Yes, delete category
            </button>
            <button className={styles.cancelBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className={styles.modal} onClick={e => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <span className={styles.modalColorDot} style={{ background: color }} />
            {editingName ? (
              <input ref={nameInputRef} className={styles.modalNameInput}
                value={name} onChange={e => setName(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={e => {
                  if (e.key === 'Enter') setEditingName(false)
                  if (e.key === 'Escape') { setName(cat.name); setEditingName(false) }
                }} />
            ) : (
              <span className={styles.modalCatName} title="Double-click to rename"
                onDoubleClick={() => setEditingName(true)}>
                {name}
              </span>
            )}
          </div>

          <div className={styles.colorSection}>
            <span className={styles.sectionLabel}>Color</span>
            <div className={styles.colorSwatches}>
              {PRESET_COLORS.map(c => (
                <button key={c} type="button" className={styles.colorSwatch}
                  style={{ background: c, boxShadow: color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                  onClick={() => setColor(c)} />
              ))}
              <input type="color" className={styles.colorFullPicker}
                value={color} title="Custom color"
                onChange={e => setColor(e.target.value)} />
            </div>
          </div>

          <div className={styles.modalActions}>
            <button className={styles.dangerBtn} onClick={() => setConfirm(true)}>Delete</button>
            <div style={{ flex: 1 }} />
            <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={styles.submitBtn} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

// ── Goal row inside a container ───────────────────────────────────────────────
function GoalRow({ goal, paintCat, onPaint, legendColor }) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={`${styles.goalRow} ${dragging ? styles.dragging : ''}`}
      style={legendColor ? { borderLeft: `3px solid ${legendColor}`, background: `${legendColor}28` } : undefined}
      draggable={!paintCat}
      onDragStart={paintCat ? undefined : e => {
        e.dataTransfer.setData('goalId', goal.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={paintCat ? undefined : () => setDragging(false)}
      onClick={paintCat ? e => { e.stopPropagation(); onPaint(goal.id) } : undefined}
    >
      <div className={styles.goalRowHeader}>
        <button className={styles.rowChevron}
          onClick={paintCat ? undefined : () => setExpanded(e => !e)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <span className={styles.rowTitle}>{goal.title}</span>
      </div>
      {expanded && !paintCat && goal.html && (
        <div className={styles.goalContent} dangerouslySetInnerHTML={{ __html: goal.html }} />
      )}
    </div>
  )
}

// ── Category container box ────────────────────────────────────────────────────
function ContainerBox({ cat, goals, onDrop, paintCat, onPaint, getGoalColor, onEdit, onCollapse,
  onCatDragStart, onCatDragEnd, onCatDragOver, onCatDrop, insertSide, isDraggingCat }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)
  const boxRef = useRef()

  const handleDragEnter = e => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('catdrag')) return
    dragCounter.current++
    setIsDragOver(true)
  }
  const handleDragLeave = () => {
    if (dragCounter.current === 0) return
    dragCounter.current--
    if (dragCounter.current === 0) setIsDragOver(false)
  }
  const handleDragOver = e => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('catdrag')) {
      const rect = boxRef.current?.getBoundingClientRect()
      if (rect && cat && onCatDragOver) {
        onCatDragOver(cat.id, e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
      }
      return
    }
    e.dataTransfer.dropEffect = 'move'
  }
  const handleDrop = e => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setIsDragOver(false)
    if (e.dataTransfer.types.includes('catdrag')) { onCatDrop?.(); return }
    const goalId = e.dataTransfer.getData('goalId')
    if (goalId) onDrop(goalId)
  }

  const cls = [
    styles.catBox,
    isDragOver      ? styles.dragOver    : '',
    insertSide === 'before' ? styles.insertBefore : '',
    insertSide === 'after'  ? styles.insertAfter  : '',
    isDraggingCat   ? styles.catDragging  : '',
  ].filter(Boolean).join(' ')

  return (
    <div ref={boxRef} className={cls}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className={styles.catBoxHeader} style={{ borderTopColor: cat?.color ?? '#e0e0e0' }}>
        {cat && (
          <div className={styles.dragHandle}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData('catdrag', cat.id)
              e.dataTransfer.effectAllowed = 'move'
              onCatDragStart?.(cat.id)
            }}
            onDragEnd={() => onCatDragEnd?.()}
            title="Drag to reorder"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
              <circle cx="3" cy="2.5" r="1.3"/><circle cx="7" cy="2.5" r="1.3"/>
              <circle cx="3" cy="7"   r="1.3"/><circle cx="7" cy="7"   r="1.3"/>
              <circle cx="3" cy="11.5" r="1.3"/><circle cx="7" cy="11.5" r="1.3"/>
            </svg>
          </div>
        )}
        <span className={styles.catBoxName}>
          {cat?.name ?? 'Unassigned'}
          <span className={styles.catBoxCount}> {goals.length}</span>
        </span>
        {cat && onEdit && (
          <button className={styles.catEditBtn} onClick={onEdit} title="Edit category">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </button>
        )}
        {onCollapse && (
          <button className={styles.catCollapseBtn} onClick={onCollapse} title="Collapse">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13H5v-2h14v2z"/>
            </svg>
          </button>
        )}
      </div>
      <div className={styles.catBoxBody}>
        {goals.length === 0
          ? <div className={styles.catBoxEmpty}>Drop goals here</div>
          : goals.map(g => <GoalRow key={g.id} goal={g} paintCat={paintCat} onPaint={onPaint} legendColor={getGoalColor?.(g.id)} />)
        }
      </div>
    </div>
  )
}

// ── Add category box (last grid item) ─────────────────────────────────────────
function AddCatBox({ onAdd }) {
  const [active, setActive] = useState(false)
  const [name, setName] = useState('')

  const submit = e => {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    setName('')
    setActive(false)
  }

  if (active) {
    return (
      <div className={`${styles.catBox} ${styles.addCatActive}`}>
        <form className={styles.addCatForm} onSubmit={submit}>
          <input className={styles.addCatInput} value={name}
            onChange={e => setName(e.target.value)} placeholder="Category name"
            autoFocus onKeyDown={e => e.key === 'Escape' && setActive(false)} />
          <div className={styles.addCatActions}>
            <button type="submit" className={styles.submitBtn}>Add</button>
            <button type="button" className={styles.cancelBtn}
              onClick={() => { setActive(false); setName('') }}>✕</button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className={styles.addCatBox} onClick={() => setActive(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
      </svg>
    </div>
  )
}

// ── Legend drop-up (portal) ───────────────────────────────────────────────────
function LegendDropUp({ dimensions, legendDimId, onLegend }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef()
  const menuRef = useRef()
  const [pos, setPos] = useState(null)

  const toggle = () => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - r.top + 4, left: r.left, width: r.width })
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

  const current = dimensions.find(d => d.id === legendDimId)

  return (
    <div className={styles.dropUpWrap}>
      <button ref={btnRef} className={styles.dropUpBtn} onClick={toggle}>
        <span className={styles.dropUpLabel}>{current?.name ?? 'Color legend'}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className={styles.dropUpMenu}
          style={{ position: 'fixed', bottom: pos.bottom, left: pos.left, minWidth: pos.width }}>
          <button className={`${styles.dropUpOption} ${!legendDimId ? styles.dropUpActive : ''}`}
            onClick={() => { onLegend(''); setOpen(false) }}>None</button>
          {dimensions.map(d => (
            <button key={d.id}
              className={`${styles.dropUpOption} ${d.id === legendDimId ? styles.dropUpActive : ''}`}
              onClick={() => { onLegend(d.id); setOpen(false) }}>
              {d.name}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Legend widget (floating, collapsible) ─────────────────────────────────────
function LegendWidget({
  dimensions, categories, legendDimId, onLegend,
  filterLegendCatId, onFilterToggle, paintCat, onPaintActivate, onEditCat,
  onCreateCat,
}) {
  const [expanded, setExpanded] = useState(false)
  const [addingCat, setAddingCat] = useState(false)
  const [catName, setCatName] = useState('')
  const [catColor, setCatColor] = useState(PRESET_COLORS[0])

  const legendCats = categories.filter(c => c.dimensionId === legendDimId)

  const handleAddCat = e => {
    e.preventDefault()
    if (!catName.trim() || !legendDimId) return
    onCreateCat(legendDimId, catName.trim(), catColor)
    setCatName('')
    setAddingCat(false)
    setCatColor(PRESET_COLORS[(legendCats.length + 1) % PRESET_COLORS.length])
  }

  return (
    <div className={styles.legendWidget}>
      {expanded && (
        <div className={styles.legendPanel}>
          {/* Add category form */}
          {legendDimId && (
            addingCat ? (
              <form className={styles.legendCatForm} onSubmit={handleAddCat}>
                <div className={styles.colorPicker}>
                  {PRESET_COLORS.map(c => (
                    <button key={c} type="button" className={styles.colorSwatch}
                      style={{ background: c, boxShadow: catColor === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                      onClick={() => setCatColor(c)} />
                  ))}
                </div>
                <div className={styles.legendCatInputRow}>
                  <input className={styles.textInput} value={catName}
                    onChange={e => setCatName(e.target.value)}
                    placeholder="Category name" autoFocus />
                  <button type="submit" className={styles.submitBtn}>Add</button>
                  <button type="button" className={styles.cancelBtn}
                    onClick={() => { setAddingCat(false); setCatName('') }}>✕</button>
                </div>
              </form>
            ) : (
              <button className={styles.addLegendCatBtn} onClick={() => setAddingCat(true)}>
                + Add category
              </button>
            )
          )}

          {/* Legend items */}
          {legendCats.map(cat => (
            <div key={cat.id}
              className={`${styles.legendItem} ${filterLegendCatId === cat.id ? styles.legendItemActive : ''}`}
              onClick={() => onFilterToggle(cat.id)}
              onDoubleClick={() => onEditCat(cat)}>
              <span className={styles.legendDot} style={{ background: cat.color }} />
              <span className={styles.legendName}>{cat.name}</span>
              <button
                className={`${styles.legendPaintBtn} ${paintCat?.id === cat.id ? styles.legendPaintBtnActive : ''}`}
                title="Paint goals with this category"
                onClick={e => { e.stopPropagation(); onPaintActivate(cat.id, cat.color) }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37-1.34-1.34a1 1 0 0 0-1.41 0L9 12.25 11.75 15l8.96-8.96a1 1 0 0 0 0-1.41z"/>
                </svg>
              </button>
            </div>
          ))}

          {/* Dimension selector */}
          <LegendDropUp dimensions={dimensions} legendDimId={legendDimId} onLegend={onLegend} />
        </div>
      )}

      <button
        className={`${styles.legendToggleBtn} ${expanded ? styles.legendToggleActive : ''}`}
        onClick={() => setExpanded(v => !v)}
        title={expanded ? 'Collapse legend' : 'Color legend'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
        </svg>
      </button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ClassificationPage({ goals = [] }) {
  const [dimensions, setDimensions]         = useState([])
  const [categories, setCategories]         = useState([])
  const [assignments, setAssignments]       = useState({})
  const [containerDimId, setContainerDimId] = useState('')
  const [legendDimId, setLegendDimId]       = useState('')
  const [filterLegendCatId, setFilterLegendCatId] = useState('')
  const [paintCat, setPaintCat]             = useState(null)
  const [editCat, setEditCat]               = useState(null)
  const [confirmDeleteDimId, setConfirmDeleteDimId] = useState(null)
  const [catDragId, setCatDragId]         = useState(null)
  const [catInsertIdx, setCatInsertIdx]   = useState(null)
  const [collapsedCatIds, setCollapsedCatIds]     = useState(new Set())
  const [unassignedCollapsed, setUnassignedCollapsed] = useState(false)

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments()])
      .then(([dims, cats, assigns]) => {
        setDimensions(dims)
        setCategories(cats)
        const map = {}
        assigns.forEach(a => {
          if (!map[a.goalId]) map[a.goalId] = {}
          map[a.goalId][a.dimensionId] = a.categoryId
        })
        setAssignments(map)
        const groupDim    = dims.find(d => d.name === 'Group')
        const priorityDim = dims.find(d => d.name === 'Priority')
        if (groupDim)    setContainerDimId(groupDim.id)
        if (priorityDim) setLegendDimId(priorityDim.id)
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    setFilterLegendCatId('')
    setPaintCat(null)
  }, [legendDimId])

  useEffect(() => { setCollapsedCatIds(new Set()); setUnassignedCollapsed(false) }, [containerDimId])

  const createDimension = async name => {
    try { const d = await api.createDimension({ name }); setDimensions(p => [...p, d]) }
    catch (e) { console.error(e) }
  }

  const deleteDimension = async id => {
    try {
      await api.deleteDimension(id)
      setDimensions(p => p.filter(d => d.id !== id))
      setCategories(p => p.filter(c => c.dimensionId !== id))
      if (containerDimId === id) setContainerDimId('')
      if (legendDimId === id) setLegendDimId('')
    } catch (e) { console.error(e) }
  }

  const createCategory = async (dimId, name, color) => {
    try { const c = await api.createCategory(dimId, { name, color }); setCategories(p => [...p, c]) }
    catch (e) { console.error(e) }
  }

  const updateCategory = async (id, patch) => {
    try {
      const updated = await api.updateCategory(id, patch)
      setCategories(p => p.map(c => c.id === id ? updated : c))
    } catch (e) { console.error(e) }
  }

  const deleteCategory = async id => {
    try {
      await api.deleteCategory(id)
      setCategories(p => p.filter(c => c.id !== id))
      setAssignments(prev => {
        const next = {}
        for (const [goalId, dims] of Object.entries(prev)) {
          next[goalId] = Object.fromEntries(Object.entries(dims).filter(([, catId]) => catId !== id))
        }
        return next
      })
      if (paintCat?.id === id) setPaintCat(null)
      if (filterLegendCatId === id) setFilterLegendCatId('')
    } catch (e) { console.error(e) }
  }

  const toggleFilter = catId => setFilterLegendCatId(prev => prev === catId ? '' : catId)

  const activatePaint = (catId, color) => {
    setPaintCat(prev => prev?.id === catId ? null : { id: catId, color })
  }

  const assignGoal = async (goalId, catId) => {
    if (!containerDimId) return
    try {
      if (catId) {
        await api.assign(goalId, containerDimId, catId)
        setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [containerDimId]: catId } }))
      } else {
        await api.unassign(goalId, containerDimId)
        setAssignments(prev => {
          const g = { ...(prev[goalId] ?? {}) }
          delete g[containerDimId]
          return { ...prev, [goalId]: g }
        })
      }
    } catch (e) { console.error(e) }
  }

  const paintGoal = async goalId => {
    if (!paintCat || !legendDimId) return
    try {
      await api.assign(goalId, legendDimId, paintCat.id)
      setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [legendDimId]: paintCat.id } }))
    } catch (e) { console.error(e) }
  }

  // ── Derived (needed by reorder handlers below) ───────────────────────────────
  const containerCats = categories.filter(c => c.dimensionId === containerDimId)

  // ── Category reorder ────────────────────────────────────────────────────────
  const handleCatDragOver = (overCatId, side) => {
    const overIdx = containerCats.findIndex(c => c.id === overCatId)
    if (overIdx === -1) return
    setCatInsertIdx(side === 'before' ? overIdx : overIdx + 1)
  }

  const reorderCatsDrop = async () => {
    if (!catDragId || catInsertIdx === null) return
    const oldIdx = containerCats.findIndex(c => c.id === catDragId)
    if (oldIdx === -1) return
    const reordered = [...containerCats]
    const [moved] = reordered.splice(oldIdx, 1)
    const target = catInsertIdx > oldIdx ? catInsertIdx - 1 : catInsertIdx
    reordered.splice(target, 0, moved)
    setCategories(prev => [...prev.filter(c => c.dimensionId !== containerDimId), ...reordered])
    try { await api.reorderCategories(reordered.map(c => c.id)) }
    catch (e) { console.error(e) }
  }

  const catDragCleanup = () => { setCatDragId(null); setCatInsertIdx(null) }

  const getCatInsertSide = catId => {
    if (!catDragId || catInsertIdx === null) return null
    const idx = containerCats.findIndex(c => c.id === catId)
    if (idx === catInsertIdx) return 'before'
    if (idx + 1 === catInsertIdx) return 'after'
    return null
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const getGoalLegendColor = goalId => {
    if (!legendDimId) return null
    const catId = assignments[goalId]?.[legendDimId]
    if (!catId) return null
    return categories.find(c => c.id === catId)?.color ?? null
  }

  const visibleGoals = filterLegendCatId && legendDimId
    ? goals.filter(g => assignments[g.id]?.[legendDimId] === filterLegendCatId)
    : goals

  const goalsForCat = catId => visibleGoals.filter(g => assignments[g.id]?.[containerDimId] === catId)
  const unassignedGoals = containerDimId
    ? visibleGoals.filter(g => !assignments[g.id]?.[containerDimId])
    : visibleGoals

  const visibleContainerCats = containerCats.filter(c => !collapsedCatIds.has(c.id))
  const numBoxes = visibleContainerCats.length + 1
  const gridCols = Math.min(numBoxes, 6)
  const colTemplate = gridCols === 1 ? 'min(100%, 480px)' : '1fr'
  const gridStyle = {
    gridTemplateColumns: `repeat(${gridCols}, ${colTemplate})`,
    justifyContent: gridCols === 1 ? 'center' : undefined,
  }

  const confirmDim = dimensions.find(d => d.id === confirmDeleteDimId)

  return (
    <div
      className={`${styles.page} ${paintCat ? styles.paintMode : ''}`}
      style={paintCat ? { cursor: makeColorCursor(paintCat.color) } : undefined}
      onClick={paintCat ? () => setPaintCat(null) : undefined}
    >
      <ClassificationToolbar
        dimensions={dimensions}
        containerDimId={containerDimId}
        onContainerDimChange={setContainerDimId}
        onCreateDim={createDimension}
        onRequestDeleteDim={setConfirmDeleteDimId}
      />

      <div className={styles.body}>
        {/* Collapsed categories strip */}
        {(collapsedCatIds.size > 0 || unassignedCollapsed) && (
          <div className={styles.collapsedStrip}>
            {containerCats.filter(c => collapsedCatIds.has(c.id)).map(cat => (
              <button key={cat.id} className={styles.collapsedChip}
                style={{ borderColor: cat.color }}
                onClick={() => setCollapsedCatIds(prev => { const n = new Set(prev); n.delete(cat.id); return n })}>
                <span className={styles.collapsedDot} style={{ background: cat.color }} />
                <span style={{ color: '#444' }}>{cat.name}</span>
                <span style={{ color: '#aaa', fontWeight: 400 }}> {goalsForCat(cat.id).length}</span>
              </button>
            ))}
            {unassignedCollapsed && (
              <button className={styles.collapsedChip}
                style={{ borderColor: '#ccc' }}
                onClick={() => setUnassignedCollapsed(false)}>
                <span className={styles.collapsedDot} style={{ background: '#ccc' }} />
                <span style={{ color: '#444' }}>Unassigned</span>
                <span style={{ color: '#aaa', fontWeight: 400 }}> {unassignedGoals.length}</span>
              </button>
            )}
          </div>
        )}

        <div className={styles.canvas} style={gridStyle}
          onDragOver={e => { if (e.dataTransfer.types.includes('catdrag')) e.preventDefault() }}
          onDrop={e => { if (e.dataTransfer.types.includes('catdrag')) { reorderCatsDrop(); catDragCleanup() } }}
        >
          {containerCats.filter(c => !collapsedCatIds.has(c.id)).map(cat => (
            <ContainerBox key={cat.id} cat={cat} goals={goalsForCat(cat.id)}
              onDrop={goalId => assignGoal(goalId, cat.id)}
              onEdit={() => setEditCat(cat)}
              onCollapse={() => setCollapsedCatIds(prev => new Set([...prev, cat.id]))}
              paintCat={paintCat} onPaint={paintGoal} getGoalColor={getGoalLegendColor}
              onCatDragStart={setCatDragId}
              onCatDragEnd={catDragCleanup}
              onCatDragOver={handleCatDragOver}
              onCatDrop={() => { reorderCatsDrop(); catDragCleanup() }}
              insertSide={getCatInsertSide(cat.id)}
              isDraggingCat={catDragId === cat.id}
            />
          ))}
          {!unassignedCollapsed && (
            <ContainerBox cat={null} goals={unassignedGoals}
              onDrop={goalId => assignGoal(goalId, null)}
              onCollapse={() => setUnassignedCollapsed(true)}
              paintCat={paintCat} onPaint={paintGoal} getGoalColor={getGoalLegendColor} />
          )}
          {containerDimId && <AddCatBox onAdd={name => createCategory(containerDimId, name, PRESET_COLORS[containerCats.length % PRESET_COLORS.length])} />}
        </div>

        <LegendWidget
          dimensions={dimensions}
          categories={categories}
          legendDimId={legendDimId}
          onLegend={setLegendDimId}
          filterLegendCatId={filterLegendCatId}
          onFilterToggle={toggleFilter}
          paintCat={paintCat}
          onPaintActivate={activatePaint}
          onEditCat={setEditCat}
          onCreateCat={createCategory}
        />

      </div>

      {/* Confirm delete dimension */}
      {confirmDim && createPortal(
        <div className={styles.modalBackdrop} onClick={() => setConfirmDeleteDimId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <p className={styles.confirmText}>
              Delete dimension <strong>"{confirmDim.name}"</strong>?
              All its categories will be removed and any goals assigned to them will be unassigned.
              The goals themselves won't be deleted.
            </p>
            <div className={styles.modalActions}>
              <button className={styles.dangerBtn} onClick={() => {
                deleteDimension(confirmDeleteDimId)
                setConfirmDeleteDimId(null)
              }}>
                Yes, delete dimension
              </button>
              <button className={styles.cancelBtn} onClick={() => setConfirmDeleteDimId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {editCat && (
        <CategoryEditModal
          cat={editCat}
          onClose={() => setEditCat(null)}
          onSave={updateCategory}
          onDelete={deleteCategory}
        />
      )}
    </div>
  )
}
