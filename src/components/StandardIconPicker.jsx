import { Image } from 'lucide-react'
import { api } from '../api'
import { playSound } from '../sounds/sound_registry'
import CategoryIconPicker from './CategoryIconPicker'
import DimensionDropUp from './DimensionDropUp'
import { COLOR_UNASSIGNED_CATEGORY_ID, colorPickerCategories } from './colorPickerCategories'
import { CategoryIconGlyph, iconForCategory } from './iconRegistry'
import styles from './StandardColorPicker.module.css'

export default function StandardIconPicker({
  dimensions = [],
  categories = [],
  iconDimensionId = '',
  onIconDimensionChange,
  onDimensionDataChanged,
  paintCategoryId = '',
  onPaintCategory,
  expanded,
  onExpandedChange,
  emptyLabel = 'Icon dimension',
  hint = 'Assign note icons',
  align = 'right',
  enablePainting = true,
}) {
  const pickerCategories = colorPickerCategories(categories, dimensions, iconDimensionId)

  const updateCategoryIcon = async (category, icon) => {
    if (!category?.id || category.dynamic || category.readOnly || category.unassign || category.id === COLOR_UNASSIGNED_CATEGORY_ID) return
    try {
      await api.updateCategory(category.id, { icon })
      playSound('categoryRename')
      onDimensionDataChanged?.()
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <div className={styles.widget} onClick={event => event.stopPropagation()}>
      {expanded && (
        <div className={`${styles.panel} ${align === 'left' ? styles.panelLeft : ''}`}>
          <div className={styles.iconPanelHeader}>
            <span>Category icons</span>
            <small>{iconDimensionId ? 'Choose icons for this dimension' : 'Pick a dimension below'}</small>
          </div>
          {pickerCategories.length === 0 && (
            <div className={styles.emptyState}>
              <strong>Automatic icons</strong>
              <span>None keeps the current type and done icons.</span>
            </div>
          )}
          {pickerCategories.map(category => {
            const paintable = Boolean(enablePainting && onPaintCategory && !category.readOnly && (category.unassign || !category.dynamic))
            const active = paintCategoryId === category.id
            const icon = category.unassign ? 'circle-minus' : iconForCategory(category)
            return (
              <div
                key={category.id}
                className={`${styles.item} ${paintable ? styles.itemPaintable : ''} ${active ? styles.itemActive : ''} ${category.colorPickerSpecial || category.dynamic ? styles.itemSpecial : ''}`}
                onClick={() => {
                  if (paintable) onPaintCategory?.(category.id, icon)
                }}
              >
                <span className={styles.iconDot} style={{ color: category.color || '#64748b' }}>
                  <CategoryIconGlyph icon={icon} size={16} strokeWidth={2.35} />
                </span>
                <span className={styles.name}>{category.name}</span>
                {(category.specialLabel || category.dynamicLabel || category.dynamicType) && (
                  <span className={styles.badge}>{category.specialLabel || category.dynamicLabel || category.dynamicType}</span>
                )}
                {!category.colorPickerSpecial && !category.dynamic && !category.system && (
                  <CategoryIconPicker
                    value={icon}
                    color={category.color || '#64748b'}
                    size={16}
                    ariaLabel={`Icon for ${category.name}`}
                    onChange={nextIcon => updateCategoryIcon(category, nextIcon)}
                  />
                )}
              </div>
            )
          })}
          <div className={styles.selector}>
            <div className={styles.selectorDrop}>
              <DimensionDropUp
                dimensions={dimensions}
                categories={categories}
                value={iconDimensionId}
                onChange={onIconDimensionChange}
                onDimDataChanged={onDimensionDataChanged}
                emptyLabel={emptyLabel}
              />
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        className={`${styles.toggle} ${expanded ? styles.toggleActive : ''}`}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse icon picker' : 'Icon dimension'}
      >
        <Image size={22} strokeWidth={2.35} />
      </button>
      {!expanded && <span className={styles.hint}><strong>Icon dimension</strong><small>{hint}</small></span>}
    </div>
  )
}
