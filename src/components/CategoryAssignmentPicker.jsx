import { createPortal } from 'react-dom'
import styles from './CategoryAssignmentPicker.module.css'

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
    onChange({
      ...selections,
      [dimId]: selections[dimId] === catId ? null : catId,
    })
  }

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Assign categories</div>
            <div className={styles.sub}>Pick one category per dimension.</div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>Close</button>
        </div>
        <div className={styles.body}>
          {dimensions.length === 0 && (
            <div className={styles.empty}>No dimensions defined yet.</div>
          )}
          {dimensions.map(dim => {
            const dimCats = categories.filter(cat => cat.dimensionId === dim.id)
            return (
              <div key={dim.id} className={styles.dimBlock}>
                <div className={styles.dimName}>{dim.name}</div>
                {dimCats.length === 0 ? (
                  <div className={styles.emptySmall}>No categories</div>
                ) : (
                  <div className={styles.catGrid}>
                    {dimCats.map(cat => {
                      const active = selections[dim.id] === cat.id
                      return (
                        <button
                          key={cat.id}
                          className={`${styles.catBtn} ${active ? styles.catBtnActive : ''}`}
                          style={active ? { borderColor: cat.color, background: `${cat.color}20`, color: cat.color } : undefined}
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
