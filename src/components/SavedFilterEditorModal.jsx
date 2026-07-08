import { useState } from 'react'
import { createPortal } from 'react-dom'
import CategoryIconPicker from './CategoryIconPicker'
import FilterDimensionSelector from './FilterDimensionSelector'
import { normalizeSavedFilter } from './savedFilterUtils'
import styles from './SavedFilterEditorModal.module.css'

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#64748b']

export default function SavedFilterEditorModal({ filter = {}, dimensions, categories, onSave, onDelete, onClose }) {
  const [name, setName] = useState(filter.name || 'New filter')
  const [gate, setGate] = useState(filter.gate === 'OR' ? 'OR' : 'AND')
  const [color, setColor] = useState(filter.color || '#64748b')
  const [icon, setIcon] = useState(filter.icon || 'filter')
  const [selections, setSelections] = useState(filter.selections || {})
  const toggle = (dimensionId, categoryId) => setSelections(previous => {
    const values = new Set(previous[dimensionId] || [])
    values.has(categoryId) ? values.delete(categoryId) : values.add(categoryId)
    const next = { ...previous }
    if (values.size) next[dimensionId] = [...values]
    else delete next[dimensionId]
    return next
  })
  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.modal} onMouseDown={event => event.stopPropagation()}>
        <div className={styles.header}>
          <input className={styles.name} value={name} onChange={event => setName(event.target.value)} autoFocus />
          <div className={styles.gate}><button className={gate === 'AND' ? styles.gateActive : ''} onClick={() => setGate('AND')}>AND</button><button className={gate === 'OR' ? styles.gateActive : ''} onClick={() => setGate('OR')}>OR</button></div>
        </div>
        <div className={styles.colors}>{COLORS.map(value => <button key={value} className={styles.swatch} style={{ background: value, boxShadow: color === value ? `0 0 0 2px #fff,0 0 0 4px ${value}` : 'none' }} onClick={() => setColor(value)} />)}</div>
        <div className={styles.iconRow}>
          <span>Icon</span>
          <CategoryIconPicker value={icon} color={color} size={18} ariaLabel="Filter icon" onChange={setIcon} />
        </div>
        <FilterDimensionSelector dimensions={dimensions} categories={categories} selections={selections} onToggle={toggle} styles={styles} />
        <div className={styles.actions}>
          {filter.id && <button className={styles.delete} onClick={() => onDelete(filter.id)}>Delete</button>}
          <button className={styles.cancel} onClick={onClose}>Cancel</button>
          <button className={styles.save} onClick={() => onSave(normalizeSavedFilter({ ...filter, name, gate, color, icon, selections }))}>{filter.id ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </div>, document.body
  )
}
