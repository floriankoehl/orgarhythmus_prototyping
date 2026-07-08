import { Image } from 'lucide-react'
import DimensionLegendPicker, { EditIcon } from './DimensionLegendPicker'
import { colorPickerCategories } from './colorPickerCategories'
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
  onEditCategory,
}) {
  const pickerCategories = colorPickerCategories(categories, dimensions, iconDimensionId)

  return (
    <DimensionLegendPicker
      className={styles.widget}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      align={align}
      title="Category icons"
      subtitle={iconDimensionId ? 'Choose icons for this dimension' : 'Pick a dimension below'}
      empty={{ title: 'Automatic icons', text: 'None keeps the current type and done icons.' }}
      categories={pickerCategories}
      dimensionCategories={categories}
      dimensions={dimensions}
      dimensionId={iconDimensionId}
      onDimensionChange={onIconDimensionChange}
      onDimensionDataChanged={onDimensionDataChanged}
      emptyLabel={emptyLabel}
      toggleTitle="Collapse icon picker"
      collapsedTitle="Icon dimension"
      hintTitle="Icon dimension"
      hint={hint}
      toggleIcon={<Image size={22} strokeWidth={2.35} />}
      onEditCategory={onEditCategory}
      renderCategory={(category, { openCategoryEditor }) => {
        const paintable = Boolean(enablePainting && onPaintCategory && !category.readOnly && (category.unassign || !category.dynamic))
        const editable = Boolean(!category.colorPickerSpecial && !category.dynamic && !category.system)
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
            {editable && (
              <button type="button" className={styles.action} title="Edit category" onClick={event => { event.stopPropagation(); openCategoryEditor(category) }}>
                <EditIcon />
              </button>
            )}
          </div>
        )
      }}
    />
  )
}
