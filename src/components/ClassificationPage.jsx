import { useState, useEffect, useRef } from 'react'
import styles from './ClassificationPage.module.css'
import { api } from '../api'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

// ── Assignment dropdown ───────────────────────────────────────────────────────
function AssignDropdown({ categories, currentCatId, onSelect, onClose }) {
  const ref = useRef()

  useEffect(() => {
    const handler = e => { if (!ref.current?.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} className={styles.assignDropdown}>
      {categories.map(cat => (
        <button
          key={cat.id}
          className={`${styles.assignOption} ${cat.id === currentCatId ? styles.assignOptionActive : ''}`}
          onClick={() => onSelect(cat.id === currentCatId ? null : cat.id)}
        >
          <span className={styles.dotSmall} style={{ background: cat.color }} />
          <span>{cat.name}</span>
          {cat.id === currentCatId && <span className={styles.checkmark}>✓</span>}
        </button>
      ))}
      {currentCatId && (
        <>
          <div className={styles.assignDivider} />
          <button className={styles.assignRemove} onClick={() => onSelect(null)}>Remove</button>
        </>
      )}
    </div>
  )
}

// ── Goal row in center canvas ─────────────────────────────────────────────────
function GoalRow({ goal, colorCat, colorDimCats, onAssign }) {
  const [expanded, setExpanded] = useState(false)
  const [showAssign, setShowAssign] = useState(false)

  return (
    <div className={styles.goalRow}>
      <div className={styles.goalRowHeader}>
        <button className={styles.rowChevron} onClick={() => setExpanded(e => !e)}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <span className={styles.rowTitle}>{goal.title}</span>
        {colorDimCats.length > 0 && (
          <div className={styles.dotWrap}>
            <button
              className={styles.colorDot}
              style={{
                background: colorCat?.color ?? 'transparent',
                borderColor: colorCat?.color ?? '#ccc',
              }}
              onClick={e => { e.stopPropagation(); setShowAssign(v => !v) }}
              title={colorCat ? colorCat.name : 'Assign category'}
            />
            {showAssign && (
              <AssignDropdown
                categories={colorDimCats}
                currentCatId={colorCat?.id}
                onSelect={catId => { onAssign(catId); setShowAssign(false) }}
                onClose={() => setShowAssign(false)}
              />
            )}
          </div>
        )}
      </div>
      {expanded && goal.html && (
        <div className={styles.goalContent} dangerouslySetInnerHTML={{ __html: goal.html }} />
      )}
    </div>
  )
}

// ── Left panel ────────────────────────────────────────────────────────────────
function LeftPanel({ dimensions, categories, groupByDimId, onGroupBy, onCreateDim, onDeleteDim, onCreateCat, onDeleteCat }) {
  const [expandedDims, setExpandedDims] = useState(new Set())
  const [newCat, setNewCat] = useState({})
  const [newDimName, setNewDimName] = useState('')

  const toggleDim = id => setExpandedDims(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const catsOf = dimId => categories.filter(c => c.dimensionId === dimId)

  const catInput = dimId => newCat[dimId] ?? {
    name: '',
    color: PRESET_COLORS[catsOf(dimId).length % PRESET_COLORS.length],
  }

  const handleCreateDim = e => {
    e.preventDefault()
    if (!newDimName.trim()) return
    onCreateDim(newDimName.trim())
    setNewDimName('')
  }

  const handleCreateCat = (e, dimId) => {
    e.preventDefault()
    const inp = catInput(dimId)
    if (!inp.name.trim()) return
    onCreateCat(dimId, inp.name.trim(), inp.color)
    setNewCat(prev => ({
      ...prev,
      [dimId]: { name: '', color: PRESET_COLORS[(catsOf(dimId).length + 1) % PRESET_COLORS.length] },
    }))
  }

  return (
    <div className={styles.leftPanel}>

      {/* Upper block — add + list dimensions */}
      <div className={styles.panelUpper}>
        <span className={styles.panelLabel}>Dimensions</span>

        <form className={styles.newDimForm} onSubmit={handleCreateDim}>
          <input
            className={styles.textInput}
            value={newDimName}
            onChange={e => setNewDimName(e.target.value)}
            placeholder="New dimension…"
          />
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
                <button className={styles.deleteBtn} onClick={() => onDeleteDim(dim.id)} title="Delete">✕</button>
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
                    <input
                      className={styles.textInput}
                      value={catInput(dim.id).name}
                      onChange={e => setNewCat(prev => ({ ...prev, [dim.id]: { ...catInput(dim.id), name: e.target.value } }))}
                      placeholder="Category name"
                    />
                    <div className={styles.colorPicker}>
                      {PRESET_COLORS.map(c => (
                        <button key={c} type="button" className={styles.colorSwatch}
                          style={{ background: c, boxShadow: catInput(dim.id).color === c ? `0 0 0 2px #fff, 0 0 0 3.5px ${c}` : 'none' }}
                          onClick={() => setNewCat(prev => ({ ...prev, [dim.id]: { ...catInput(dim.id), color: c } }))}
                        />
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

      {/* Lower block — group-by selector */}
      <div className={styles.panelLower}>
        <span className={styles.panelLabel}>Group by</span>
        <select className={styles.dimSelect} value={groupByDimId} onChange={e => onGroupBy(e.target.value)}>
          <option value="">None</option>
          {dimensions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ClassificationPage({ goals = [] }) {
  const [dimensions, setDimensions] = useState([])
  const [categories, setCategories] = useState([])
  const [assignments, setAssignments] = useState({}) // { goalId: { dimId: catId } }
  const [colorByDimId, setColorByDimId] = useState('')
  const [groupByDimId, setGroupByDimId] = useState('')

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

  // ── Dimension CRUD ──────────────────────────────────────────────────────────
  const createDimension = async name => {
    try {
      const dim = await api.createDimension({ name })
      setDimensions(prev => [...prev, dim])
    } catch (e) { console.error(e) }
  }

  const deleteDimension = async id => {
    try {
      await api.deleteDimension(id)
      setDimensions(prev => prev.filter(d => d.id !== id))
      setCategories(prev => prev.filter(c => c.dimensionId !== id))
      if (colorByDimId === id) setColorByDimId('')
      if (groupByDimId === id) setGroupByDimId('')
    } catch (e) { console.error(e) }
  }

  // ── Category CRUD ───────────────────────────────────────────────────────────
  const createCategory = async (dimId, name, color) => {
    try {
      const cat = await api.createCategory(dimId, { name, color })
      setCategories(prev => [...prev, cat])
    } catch (e) { console.error(e) }
  }

  const deleteCategory = async id => {
    try {
      await api.deleteCategory(id)
      setCategories(prev => prev.filter(c => c.id !== id))
      setAssignments(prev => {
        const next = { ...prev }
        Object.keys(next).forEach(gid => {
          const dimId = Object.keys(next[gid] || {}).find(d => next[gid][d] === id)
          if (dimId) {
            next[gid] = { ...next[gid] }
            delete next[gid][dimId]
          }
        })
        return next
      })
    } catch (e) { console.error(e) }
  }

  // ── Assignment ──────────────────────────────────────────────────────────────
  const assign = async (goalId, dimId, catId) => {
    try {
      if (catId) {
        await api.assign(goalId, dimId, catId)
        setAssignments(prev => ({ ...prev, [goalId]: { ...(prev[goalId] ?? {}), [dimId]: catId } }))
      } else {
        await api.unassign(goalId, dimId)
        setAssignments(prev => {
          const g = { ...(prev[goalId] ?? {}) }
          delete g[dimId]
          return { ...prev, [goalId]: g }
        })
      }
    } catch (e) { console.error(e) }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const colorDimCats = categories.filter(c => c.dimensionId === colorByDimId)
  const groupDimCats = categories.filter(c => c.dimensionId === groupByDimId)

  const colorCatFor = goalId => {
    const catId = assignments[goalId]?.[colorByDimId]
    return colorDimCats.find(c => c.id === catId)
  }

  const buildGroups = () => {
    if (!groupByDimId) return [{ cat: null, goals }]
    const groups = groupDimCats.map(cat => ({
      cat,
      goals: goals.filter(g => assignments[g.id]?.[groupByDimId] === cat.id),
    }))
    const unassigned = goals.filter(g => !assignments[g.id]?.[groupByDimId])
    if (unassigned.length > 0) groups.push({ cat: null, goals: unassigned })
    return groups
  }

  return (
    <div className={styles.page}>
      {/* Top toolbar */}
      <div className={styles.topBar}>
        <span className={styles.pageLabel}>Classification</span>
        <div className={styles.topBarRight}>
          <span className={styles.controlLabel}>Color by</span>
          <select className={styles.dimSelect} value={colorByDimId} onChange={e => setColorByDimId(e.target.value)}>
            <option value="">None</option>
            {dimensions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>

      <div className={styles.body}>
        <LeftPanel
          dimensions={dimensions}
          categories={categories}
          groupByDimId={groupByDimId}
          onGroupBy={setGroupByDimId}
          onCreateDim={createDimension}
          onDeleteDim={deleteDimension}
          onCreateCat={createCategory}
          onDeleteCat={deleteCategory}
        />

        {/* Canvas */}
        <div className={styles.canvas}>
          <div className={styles.goalsBox}>
            <div className={styles.goalsBoxHeader}>
              <span className={styles.goalsBoxTitle}>Goals</span>
              <span className={styles.goalsBoxCount}>{goals.length}</span>
            </div>
            {goals.length === 0 ? (
              <p className={styles.empty}>No goals yet — define them on the brainstorm page.</p>
            ) : (
              <div className={styles.goalsList}>
                {buildGroups().map(group => (
                  <div key={group.cat?.id ?? '__unassigned'}>
                    {groupByDimId && (
                      <div className={styles.groupHeader}>
                        <span
                          className={styles.groupStripe}
                          style={{ background: group.cat?.color ?? '#ddd' }}
                        />
                        <span className={styles.groupName}>
                          {group.cat?.name ?? 'Unassigned'}
                        </span>
                        <span className={styles.groupCount}>{group.goals.length}</span>
                      </div>
                    )}
                    {group.goals.map(goal => (
                      <GoalRow
                        key={goal.id}
                        goal={goal}
                        colorCat={colorCatFor(goal.id)}
                        colorDimCats={colorDimCats}
                        onAssign={catId => assign(goal.id, colorByDimId, catId)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
