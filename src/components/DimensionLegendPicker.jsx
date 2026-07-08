import { useState } from 'react'
import { api } from '../api'
import { playSound } from '../sounds/sound_registry'
import CategoryEditModal from './CategoryEditModal'
import DimensionDropUp from './DimensionDropUp'
import styles from './StandardColorPicker.module.css'

export function EditIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
}

export function SwapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16V4m0 0L3 8m4-4 4 4"/>
      <path d="M17 8v12m0 0 4-4m-4 4-4-4"/>
    </svg>
  )
}

export default function DimensionLegendPicker({
  className = styles.widget,
  expanded,
  onExpandedChange,
  align = 'right',
  title,
  subtitle,
  empty,
  categories = [],
  dimensionCategories = categories,
  dimensions = [],
  dimensionId = '',
  onDimensionChange,
  onDimensionDataChanged,
  emptyLabel,
  toggleTitle,
  collapsedTitle,
  hintTitle,
  hint,
  toggleIcon,
  topAction = null,
  onSwapWithCanvasDim,
  onEditCategory,
  renderCategory,
}) {
  const [editingCategory, setEditingCategory] = useState(null)

  const openCategoryEditor = category => {
    if (!category || category.colorPickerSpecial || category.dynamic || category.system) return
    if (onEditCategory) onEditCategory(category)
    else setEditingCategory(category)
  }

  const updateCategory = async (id, patch) => {
    await api.updateCategory(id, patch)
    playSound('categoryRename')
    onDimensionDataChanged?.()
  }

  const deleteCategory = async id => {
    await api.deleteCategory(id)
    playSound('categoryDelete')
    onDimensionDataChanged?.()
  }

  return (
    <div className={className} onClick={event => event.stopPropagation()}>
      {expanded && (
        <div className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''} ${align === 'dock-left' ? styles.panelDockLeft : ''}`}>
          <div className={styles.iconPanelHeader}>
            <span>{title}</span>
            <small>{subtitle}</small>
          </div>
          {topAction}
          {empty && categories.length === 0 && (
            <div className={styles.emptyState}>
              <strong>{empty.title}</strong>
              <span>{empty.text}</span>
            </div>
          )}
          <div className={styles.categoryList}>
            {categories.map(category => renderCategory(category, { openCategoryEditor }))}
          </div>
          <div className={`${styles.selector} ${onSwapWithCanvasDim ? styles.selectorWithSwap : ''}`}>
            <div className={styles.selectorDrop}>
              <DimensionDropUp
                dimensions={dimensions}
                categories={dimensionCategories}
                value={dimensionId}
                onChange={onDimensionChange}
                onDimDataChanged={onDimensionDataChanged}
                emptyLabel={emptyLabel}
              />
            </div>
            {onSwapWithCanvasDim && (
              <button type="button" className={styles.swapBtn} onClick={onSwapWithCanvasDim} title="Swap color dimension with canvas dimension">
                <SwapIcon />
              </button>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className={`${styles.toggle} ${expanded ? styles.toggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? toggleTitle : collapsedTitle}
      >
        {toggleIcon}
      </button>
      {!expanded && <span className={styles.hint}><strong>{hintTitle}</strong><small>{hint}</small></span>}
      {editingCategory && (
        <CategoryEditModal
          cat={editingCategory}
          onClose={() => setEditingCategory(null)}
          onSave={updateCategory}
          onDelete={deleteCategory}
        />
      )}
    </div>
  )
}
