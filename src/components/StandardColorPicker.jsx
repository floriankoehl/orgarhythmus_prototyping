import ColorPickerIcon from './ColorPickerIcon'
import DimensionLegendPicker, { EditIcon } from './DimensionLegendPicker'
import { colorPickerCategories } from './colorPickerCategories'
import { CategoryIconGlyph, iconForCategory } from './iconRegistry'
import styles from './StandardColorPicker.module.css'

export default function StandardColorPicker({
  dimensions = [], categories = [], colorDimensionId = '', onColorDimensionChange,
  onDimensionDataChanged, expanded, onExpandedChange, paintCategoryId = '', onPaintCategory,
  onCreateSavedFilter, onEditSavedFilter, variant = 'dock', emptyLabel = 'Color legend',
  hint = 'Color and filter notes', onSwapWithCanvasDim, align = 'right', onEditCategory,
}) {
  const pickerCategories = colorPickerCategories(categories, dimensions, colorDimensionId)
  const className = `${styles.widget} ${variant === 'people' ? styles.widgetPeople : ''}`

  return (
    <DimensionLegendPicker
      className={className}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      align={align}
      title="Color legend"
      subtitle={colorDimensionId ? 'Color, filter, or edit categories' : 'Pick a dimension below'}
      categories={pickerCategories}
      dimensionCategories={categories}
      dimensions={dimensions}
      dimensionId={colorDimensionId}
      onDimensionChange={onColorDimensionChange}
      onDimensionDataChanged={onDimensionDataChanged}
      emptyLabel={emptyLabel}
      toggleTitle="Collapse color picker"
      collapsedTitle="Color and filter notes"
      hintTitle="Color dimension"
      hint={hint}
      toggleIcon={<ColorPickerIcon size={22} />}
      topAction={onCreateSavedFilter ? (
        <button type="button" className={styles.createFilter} onClick={onCreateSavedFilter}>+ Create filter</button>
      ) : null}
      onSwapWithCanvasDim={onSwapWithCanvasDim}
      onEditCategory={onEditCategory}
      renderCategory={(category, { openCategoryEditor }) => {
        const savedFilter = category.dynamicType === 'filter'
        const editable = Boolean(!category.colorPickerSpecial && !category.dynamic && !category.system)
        const paintable = Boolean(!category.readOnly && (category.unassign || !category.dynamic))
        const interactive = paintable
        const active = paintCategoryId === category.id

        return (
          <div
            key={category.id}
            className={`${styles.item} ${interactive ? styles.itemPaintable : ''} ${active ? styles.itemActive : ''} ${category.colorPickerSpecial || category.dynamic ? styles.itemSpecial : ''}`}
            onClick={() => {
              if (category.unassign) onPaintCategory?.(category.id, category.color)
              else if (paintable) onPaintCategory?.(category.id, category.color)
            }}
          >
            <span className={styles.iconDot} style={{ color: category.color || '#64748b' }}>
              <CategoryIconGlyph icon={iconForCategory(category)} size={16} strokeWidth={2.35} />
            </span>
            <span className={styles.name}>{category.name}</span>
            {(category.specialLabel || category.dynamicLabel || category.dynamicType) && (
              <span className={styles.badge}>{category.specialLabel || category.dynamicLabel || category.dynamicType}</span>
            )}
            {savedFilter ? (
              <button type="button" className={styles.action} title="Edit filter" onClick={event => { event.stopPropagation(); onEditSavedFilter?.(category.filterId) }}><EditIcon /></button>
            ) : editable ? (
              <button type="button" className={styles.action} title="Edit category" onClick={event => { event.stopPropagation(); openCategoryEditor(category) }}><EditIcon /></button>
            ) : null}
          </div>
        )
      }}
    />
  )
}
