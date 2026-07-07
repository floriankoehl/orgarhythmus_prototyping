import ColorPickerIcon from './ColorPickerIcon'
import DimensionDropUp from './DimensionDropUp'
import { colorPickerCategories } from './colorPickerCategories'
import styles from './StandardColorPicker.module.css'

function FilterIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/></svg>
}

function EditIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
}

function SwapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16V4m0 0L3 8m4-4 4 4"/>
      <path d="M17 8v12m0 0 4-4m-4 4-4-4"/>
    </svg>
  )
}

export default function StandardColorPicker({
  dimensions = [], categories = [], colorDimensionId = '', onColorDimensionChange,
  onDimensionDataChanged, expanded, onExpandedChange, paintCategoryId = '', onPaintCategory,
  quickFilters = [], onToggleQuickFilter, activeSavedFilterIds = [], onToggleSavedFilter,
  onCreateSavedFilter, onEditSavedFilter, variant = 'dock', emptyLabel = 'Color legend',
  hint = 'Color and filter notes', onSwapWithCanvasDim,
}) {
  const pickerCategories = colorPickerCategories(categories, dimensions, colorDimensionId)
  const className = `${styles.widget} ${variant === 'people' ? styles.widgetPeople : ''}`

  return (
    <div className={className} onClick={event => event.stopPropagation()}>
      {expanded && (
        <div className={styles.panel}>
          {onCreateSavedFilter && <button type="button" className={styles.createFilter} onClick={onCreateSavedFilter}>+ Create filter</button>}
          {pickerCategories.map(category => {
            const savedFilter = category.dynamicType === 'filter'
            const filterActive = savedFilter
              ? activeSavedFilterIds.includes(category.filterId)
              : quickFilters.some(filter => filter.dimId === colorDimensionId && filter.catId === category.id)
            const paintable = Boolean(!category.readOnly && (category.unassign || !category.dynamic))
            const interactive = paintable || savedFilter
            const active = savedFilter ? filterActive : paintCategoryId === category.id
            return (
              <div key={category.id} className={`${styles.item} ${interactive ? styles.itemPaintable : ''} ${active ? styles.itemActive : ''} ${category.colorPickerSpecial || category.dynamic ? styles.itemSpecial : ''}`}
                onClick={() => {
                  if (category.unassign) onPaintCategory?.(category.id, category.color)
                  else if (savedFilter) onToggleSavedFilter?.(category.filterId)
                  else if (paintable) onPaintCategory?.(category.id, category.color)
                }}>
                <span className={styles.dot} style={{ background: category.color || '#9ca3af' }} />
                <span className={styles.name}>{category.name}</span>
                {(category.specialLabel || category.dynamicLabel || category.dynamicType) && <span className={styles.badge}>{category.specialLabel || category.dynamicLabel || category.dynamicType}</span>}
                {savedFilter ? (
                  <button type="button" className={`${styles.action} ${filterActive ? styles.actionActive : ''}`} title="Edit filter" onClick={event => { event.stopPropagation(); onEditSavedFilter?.(category.filterId) }}><EditIcon /></button>
                ) : category.filterable !== false && onToggleQuickFilter ? (
                  <button type="button" className={`${styles.action} ${filterActive ? styles.actionActive : ''}`} title="Quick filter by this category" onClick={event => { event.stopPropagation(); onToggleQuickFilter(colorDimensionId, category.id) }}><FilterIcon /></button>
                ) : null}
              </div>
            )
          })}
          <div className={`${styles.selector} ${onSwapWithCanvasDim ? styles.selectorWithSwap : ''}`}>
            <div className={styles.selectorDrop}>
              <DimensionDropUp dimensions={dimensions} categories={categories} value={colorDimensionId} onChange={onColorDimensionChange} onDimDataChanged={onDimensionDataChanged} emptyLabel={emptyLabel} />
            </div>
            {onSwapWithCanvasDim && (
              <button type="button" className={styles.swapBtn} onClick={onSwapWithCanvasDim} title="Swap color dimension with canvas dimension">
                <SwapIcon />
              </button>
            )}
          </div>
        </div>
      )}
      <button type="button" className={`${styles.toggle} ${expanded ? styles.toggleActive : ''}`} onClick={() => onExpandedChange(!expanded)} title={expanded ? 'Collapse color picker' : 'Color and filter notes'}><ColorPickerIcon /></button>
      {!expanded && <span className={styles.hint}><strong>Color dimension</strong><small>{hint}</small></span>}
    </div>
  )
}
