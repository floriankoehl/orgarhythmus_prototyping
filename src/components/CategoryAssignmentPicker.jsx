import { createPortal } from 'react-dom'
import styles from './CategoryAssignmentPicker.module.css'
import { playSound } from '../sounds/sound_registry'

export default function CategoryAssignmentPicker({
  open,
  dimensions,
  categories,
  selections,
  onChange,
  onClose,
}) {
  if (!open) return null

  const toggle = (dimId, catId) => {
    const removing = selections[dimId] === catId
    playSound(removing ? 'categoryUnassign' : 'categoryAssign')
    onChange({
      ...selections,
      [dimId]: removing ? null : catId,
    })
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>

        <div className={styles.header}>
          <span className={styles.title}>Assign categories</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          {dimensions.length === 0 && (
            <div className={styles.empty}>No dimensions defined yet.</div>
          )}
          {dimensions.map(dim => {
            const dimCats = categories.filter(c => c.dimensionId === dim.id)
            const manyCategories = dimCats.length > 10
            return (
              <div key={dim.id} className={styles.dimRow}>
                <div className={styles.dimName}>{dim.name}</div>
                <div className={styles.divider} />
                {dimCats.length === 0 ? (
                  <span className={styles.emptySmall}>No categories</span>
                ) : (
                  <div className={`${styles.catRow} ${manyCategories ? styles.catRowWrap : ''}`}>
                    {dimCats.map(cat => {
                      const active = selections[dim.id] === cat.id
                      return (
                        <button
                          key={cat.id}
                          className={`${styles.catBtn} ${active ? styles.catBtnActive : ''}`}
                          style={active ? { borderColor: cat.color, background: `${cat.color}18`, color: cat.color } : {}}
                          onClick={() => toggle(dim.id, cat.id)}>
                          <span className={styles.dot} style={{ background: cat.color }} />
                          {cat.name}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>

      </div>
    </div>,
    document.body
  )
}
