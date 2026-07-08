import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CategoryIconPicker from './CategoryIconPicker'
import { CategoryIconGlyph, iconForCategory } from './iconRegistry'
import styles from './CategoryEditModal.module.css'

const PRESET_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#94a3b8']

export default function CategoryEditModal({ cat, onClose, onSave, onDelete }) {
  const [name, setName] = useState(cat.name)
  const [color, setColor] = useState(cat.color || '#94a3b8')
  const [icon, setIcon] = useState(iconForCategory(cat))
  const [editingName, setEditingName] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const nameInputRef = useRef(null)

  useEffect(() => { if (editingName) nameInputRef.current?.select() }, [editingName])

  const save = () => {
    onSave(cat.id, { name: name.trim() || cat.name, color, icon })
    onClose()
  }

  return createPortal(
    <div className={styles.modalBackdrop} onClick={onClose}>
      {confirm ? (
        <div className={styles.modal} onClick={event => event.stopPropagation()}>
          <p className={styles.confirmText}>
            {cat.customTimeRange ? (
              <>The custom time category <strong>"{cat.name}"</strong> will be removed. The notes themselves won't be deleted.</>
            ) : (
              <>All notes assigned to <strong>"{cat.name}"</strong> will be unassigned. The notes themselves won't be deleted.</>
            )}
          </p>
          <div className={styles.modalActions}>
            <button className={styles.dangerBtn} onClick={() => { onDelete(cat.id); onClose() }}>
              Yes, delete category
            </button>
            <button className={styles.cancelBtn} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className={styles.modal} onClick={event => event.stopPropagation()}>
          <div className={styles.modalHeader}>
            <span className={styles.modalColorDot} style={{ background: color }} />
            <span className={styles.modalIconPreview} style={{ color }}>
              <CategoryIconGlyph icon={icon} size={16} strokeWidth={2.4} />
            </span>
            {editingName ? (
              <input
                ref={nameInputRef}
                className={styles.modalNameInput}
                value={name}
                onChange={event => setName(event.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={event => {
                  if (event.key === 'Enter') setEditingName(false)
                  if (event.key === 'Escape') { setName(cat.name); setEditingName(false) }
                }}
              />
            ) : (
              <span className={styles.modalCatName} title="Double-click to rename" onDoubleClick={() => setEditingName(true)}>
                {name}
              </span>
            )}
          </div>

          <div className={styles.colorSection}>
            <span className={styles.sectionLabel}>Color</span>
            <div className={styles.colorSwatches}>
              {PRESET_COLORS.map(option => (
                <button
                  key={option}
                  type="button"
                  className={styles.colorSwatch}
                  style={{ background: option, boxShadow: color === option ? `0 0 0 2px #fff, 0 0 0 3.5px ${option}` : 'none' }}
                  onClick={() => setColor(option)}
                />
              ))}
              <input
                type="color"
                className={styles.colorFullPicker}
                value={color}
                title="Custom color"
                onChange={event => setColor(event.target.value)}
              />
            </div>
          </div>

          <div className={styles.colorSection}>
            <span className={styles.sectionLabel}>Icon</span>
            <div className={styles.iconPickerRow}>
              <CategoryIconPicker
                value={icon}
                color={color}
                size={18}
                ariaLabel="Category icon"
                onChange={setIcon}
              />
            </div>
          </div>

          <div className={styles.modalActions}>
            <button className={styles.dangerBtn} onClick={() => setConfirm(true)}>Delete</button>
            <div className={styles.spacer} />
            <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button className={styles.submitBtn} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
