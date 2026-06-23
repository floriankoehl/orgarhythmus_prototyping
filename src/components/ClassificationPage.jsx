import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import styles from './ClassificationPage.module.css'
import { api } from '../api'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

// ── Goal row inside a container ───────────────────────────────────────────────
function GoalRow({ goal }) {
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)

  return (
    <div
      className={`${styles.goalRow} ${dragging ? styles.dragging : ''}`}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('goalId', goal.id)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
    >
      <div className={styles.goalRowHeader}>
        <button className={styles.rowChevron} onClick={() => setExpanded(e => !e)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <span className={styles.rowTitle}>{goal.title}</span>
      </div>
      {expanded && goal.html && (
        <div className={styles.goalContent} dangerouslySetInnerHTML={{ __html: goal.html }} />
      )}
    </div>
  )
}

// ── Category container box ────────────────────────────────────────────────────
function ContainerBox({ cat, goals, onDrop }) {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounter = useRef(0)

  const handleDragEnter = e => { e.preventDefault(); dragCounter.current++; setIsDragOver(true) }
  const handleDragLeave = () => { dragCounter.current--; if (dragCounter.current === 0) setIsDragOver(false) }
  const handleDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const handleDrop = e => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragOver(false)
    const goalId = e.dataTransfer.getData('goalId')
    if (goalId) onDrop(goalId)
  }

  return (
    <div
      className={`${styles.catBox} ${isDragOver ? styles.dragOver : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className={styles.catBoxHeader} style={{ borderTopColor: cat?.color ?? '#e0e0e0' }}>
        <span className={styles.catBoxName}>{cat?.name ?? 'Unassigned'}</span>
        <span className={styles.catBoxCount}>{goals.length}</span>
      </div>
      <div className={styles.catBoxBody}>
        {goals.length === 0
          ? <div className={styles.catBoxEmpty}>Drop goals here</div>
          : goals.map(g => <GoalRow key={g.id} goal={g} />)
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
          <input
            className={styles.addCatInput}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Category name"
            autoFocus
            onKeyDown={e => e.key === 'Escape' && setActive(false)}
          />
          <div className={styles.addCatActions}>
            <button type="submit" className={styles.submitBtn}>Add</button>
            <button type="button" className={styles.cancelBtn} onClick={() => { setActive(false); setName('') }}>✕</button>
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

// ── Left panel ────────────────────────────────────────────────────────────────
function LeftPanel({ dimensions, categories, legendDimId, onLegend, onCreateDim, onDeleteDim, onCreateCat, onDeleteCat }) {
  const [expandedDims, setExpandedDims] = useState(new Set())
  const [newDimName, setNewDimName] = useState('')
  const [newCat, setNewCat] = useState({})
  const [addingLegendCat, setAddingLegendCat] = useState(false)
  const [legendCatName, setLegendCatName] = useState('')
  const [legendCatColor, setLegendCatColor] = useState(PRESET_COLORS[0])

  const toggleDim = id => setExpandedDims(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
  })

  const catsOf = dimId => categories.filter(c => c.dimensionId === dimId)

  const catInput = dimId => newCat[dimId] ?? {
    name: '', color: PRESET_COLORS[catsOf(dimId).length % PRESET_COLORS.length],
  }

  const handleCreateDim = e => {
    e.preventDefault(); if (!newDimName.trim()) return
    onCreateDim(newDimName.trim()); setNewDimName('')
  }

  const handleCreateCat = (e, dimId) => {
    e.preventDefault(); const inp = catInput(dimId); if (!inp.name.trim()) return
    onCreateCat(dimId, inp.name.trim(), inp.color)
    setNewCat(prev => ({ ...prev, [dimId]: { name: '', color: PRESET_COLORS[(catsOf(dimId).length + 1) % PRESET_COLORS.length] } }))
  }

  const legendCats = categories.filter(c => c.dimensionId === legendDimId)

  const handleAddLegendCat = e => {
    e.preventDefault(); if (!legendCatName.trim() || !legendDimId) return
    onCreateCat(legendDimId, legendCatName.trim(), legendCatColor)
    setLegendCatName('')
    setAddingLegendCat(false)
    setLegendCatColor(PRESET_COLORS[(legendCats.length + 1) % PRESET_COLORS.length])
  }

  return (
    <div className={styles.leftPanel}>

      {/* Upper — dimension management */}
      <div className={styles.panelUpper}>
        <span className={styles.panelLabel}>Dimensions</span>
        <form className={styles.newDimForm} onSubmit={handleCreateDim}>
          <input className={styles.textInput} value={newDimName}
            onChange={e => setNewDimName(e.target.value)} placeholder="New dimension…" />
          <button type="submit" className={styles.submitBtn}>Add</button>
        </form>
        <div className={styles.dimList}>
          {dimensions.map(dim => (
            <div key={dim.id} className={styles.dimItem}>
              <div className={styles.dimHeader}>
                <button className={styles.dimToggle} onClick={() => toggleDim(dim.id)}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"
                    style={{ transform: expandedDims.has(dim.id) ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.12s' }}>
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>
                <span className={styles.dimName}>{dim.name}</span>
                <button className={styles.deleteBtn} onClick={() => onDeleteDim(dim.id)}>✕</button>
              </div>
              {expandedDims.has(dim.id) && (
                <div className={styles.dimBody}>
                  {catsOf(dim.id).map(cat => (
                    <div key={cat.id} className={styles.catRow}>
                      <span className={styles.catDot} style={{ background: cat.color }} />
                      <span className={styles.catName}>{cat.name}</span>
                      <button className={styles.deleteBtn} onClick={() => onDeleteCat(cat.id)}>✕</button>
                    </div>
                  ))}
                  <form className={styles.newCatForm} onSubmit={e => handleCreateCat(e, dim.id)}>
                    <input className={styles.textInput} value={catInput(dim.id).name}
                      onChange={e => setNewCat(prev => ({ ...prev, [dim.id]: { ...catInput(dim.id), name: e.target.value } }))}
                      placeholder="Category name" />
                    <div className={styles.colorPicker}>
                      {PRESET_COLORS.map(c => (
                        <button key={c} type="button" className={styles.colorSwatch}
                          style={{ background: c, boxShadow: catInput(dim.id).color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                          onClick={() => setNewCat(prev => ({ ...prev, [dim.id]: { ...catInput(dim.id), color: c } }))} />
                      ))}
                    </div>
                    <button type="submit" className={styles.submitBtn}>Add</button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Lower — color legend */}
      <div className={styles.panelLower}>
        {/* Add category to legend dimension */}
        {legendDimId && (
          addingLegendCat ? (
            <form className={styles.legendCatForm} onSubmit={handleAddLegendCat}>
              <div className={styles.colorPicker}>
                {PRESET_COLORS.map(c => (
                  <button key={c} type="button" className={styles.colorSwatch}
                    style={{ background: c, boxShadow: legendCatColor === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                    onClick={() => setLegendCatColor(c)} />
                ))}
              </div>
              <div className={styles.legendCatInputRow}>
                <input className={styles.textInput} value={legendCatName}
                  onChange={e => setLegendCatName(e.target.value)}
                  placeholder="Category name" autoFocus />
                <button type="submit" className={styles.submitBtn}>Add</button>
                <button type="button" className={styles.cancelBtn}
                  onClick={() => { setAddingLegendCat(false); setLegendCatName('') }}>✕</button>
              </div>
            </form>
          ) : (
            <button className={styles.addLegendCatBtn} onClick={() => setAddingLegendCat(true)}>
              + Add category
            </button>
          )
        )}

        {/* Legend items */}
        {legendCats.map(cat => (
          <div key={cat.id} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: cat.color }} />
            <span className={styles.legendName}>{cat.name}</span>
          </div>
        ))}

        {/* Drop-up dimension selector — always at the bottom */}
        <LegendDropUp dimensions={dimensions} legendDimId={legendDimId} onLegend={onLegend} />
      </div>

    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ClassificationPage({ goals = [] }) {
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [assignments, setAssignments] = useState({})
  const [containerDimId, setContainerDimId] = useState('')
  const [legendDimId, setLegendDimId] = useState('')

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
      })
      .catch(console.error)
  }, [])

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

  const deleteCategory = async id => {
    try {
      await api.deleteCategory(id)
      setCategories(p => p.filter(c => c.id !== id))
    } catch (e) { console.error(e) }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const containerCats = categories.filter(c => c.dimensionId === containerDimId)

  const goalsForCat = catId => goals.filter(g => assignments[g.id]?.[containerDimId] === catId)
  const unassignedGoals = containerDimId
    ? goals.filter(g => !assignments[g.id]?.[containerDimId])
    : goals

  // Grid columns: max 6 per row, scales with number of boxes
  const numBoxes = containerCats.length + 1 // category boxes + unassigned
  const gridCols = Math.min(numBoxes, 6)
  const colTemplate = gridCols === 1 ? 'min(100%, 480px)' : '1fr'
  const gridStyle = {
    gridTemplateColumns: `repeat(${gridCols}, ${colTemplate})`,
    justifyContent: gridCols === 1 ? 'center' : undefined,
  }

  const handleCanvasAddCat = (name) => {
    if (!containerDimId) return
    const color = PRESET_COLORS[containerCats.length % PRESET_COLORS.length]
    createCategory(containerDimId, name, color)
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

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <span className={styles.pageLabel}>Classification</span>
        <div className={styles.topBarRight}>
          <span className={styles.controlLabel}>Group by</span>
          <select className={styles.dimSelect} value={containerDimId}
            onChange={e => setContainerDimId(e.target.value)}>
            <option value="">None</option>
            {dimensions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>

      <div className={styles.body}>
        <LeftPanel
          dimensions={dimensions}
          categories={categories}
          legendDimId={legendDimId}
          onLegend={setLegendDimId}
          onCreateDim={createDimension}
          onDeleteDim={deleteDimension}
          onCreateCat={createCategory}
          onDeleteCat={deleteCategory}
        />

        <div className={styles.canvas} style={gridStyle}>
          {containerCats.map(cat => (
            <ContainerBox key={cat.id} cat={cat} goals={goalsForCat(cat.id)}
              onDrop={goalId => assignGoal(goalId, cat.id)} />
          ))}
          <ContainerBox cat={null} goals={unassignedGoals}
            onDrop={goalId => assignGoal(goalId, null)} />
          {containerDimId && <AddCatBox onAdd={handleCanvasAddCat} />}
        </div>
      </div>
    </div>
  )
}
