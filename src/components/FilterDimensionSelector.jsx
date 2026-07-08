import { useState } from 'react'
import { COLOR_ALL_CATEGORY_ID, COLOR_UNASSIGNED_CATEGORY_ID, colorPickerCategories } from './colorPickerCategories'
import { CategoryIconGlyph, iconForCategory } from './iconRegistry'

function isSpecialDimension(dimension) {
  return Boolean(dimension?.dynamic || dimension?.system)
}

export default function FilterDimensionSelector({ dimensions, categories, selections, onToggle, styles }) {
  const [expandedDimensionIds, setExpandedDimensionIds] = useState(() => new Set())
  const groups = [
    { label: 'Special dimensions', dimensions: dimensions.filter(isSpecialDimension), special: true },
    { label: 'Project dimensions', dimensions: dimensions.filter(dimension => !isSpecialDimension(dimension)), special: false },
  ].filter(group => group.dimensions.length > 0)

  return (
    <div className={styles.filterDimList}>
      {groups.map(group => (
        <div key={group.label} className={styles.filterDimGroup}>
          <div className={`${styles.filterDimGroupTitle} ${group.special ? styles.filterDimGroupTitleSpecial : ''}`}>
            {group.label}
          </div>
          {group.dimensions.map(dimension => {
            const dimensionCategories = colorPickerCategories(categories, dimensions, dimension.id)
              .filter(category => category.filterable !== false && category.id !== COLOR_UNASSIGNED_CATEGORY_ID && category.id !== COLOR_ALL_CATEGORY_ID)
            const selectedIds = selections[dimension.id] ?? []
            const headerMode = selectedIds.includes(COLOR_ALL_CATEGORY_ID)
              ? COLOR_ALL_CATEGORY_ID
              : selectedIds.includes(COLOR_UNASSIGNED_CATEGORY_ID)
              ? COLOR_UNASSIGNED_CATEGORY_ID
              : ''
            const categoryIds = dimensionCategories.map(category => category.id)
            const expanded = expandedDimensionIds.has(dimension.id)
            const toggleExpanded = () => {
              setExpandedDimensionIds(previous => {
                const next = new Set(previous)
                if (next.has(dimension.id)) next.delete(dimension.id)
                else next.add(dimension.id)
                return next
              })
            }
            const clearDimensionSelections = () => {
              selectedIds.forEach(categoryId => onToggle(dimension.id, categoryId))
            }
            const toggleHeaderMode = mode => {
              clearDimensionSelections()
              if (headerMode !== mode) onToggle(dimension.id, mode)
            }
            const toggleCategory = categoryId => {
              if (headerMode) {
                clearDimensionSelections()
              } else {
                selectedIds
                  .filter(id => !categoryIds.includes(id))
                  .forEach(id => onToggle(dimension.id, id))
              }
              onToggle(dimension.id, categoryId)
            }
            return (
              <section key={dimension.id} className={`${styles.filterDimSection} ${group.special ? styles.filterDimSectionSpecial : ''}`}>
                <div className={styles.filterDimTitle}>
                  <button
                    type="button"
                    className={styles.filterDimExpandBtn}
                    aria-label={expanded ? `Collapse ${dimension.name}` : `Expand ${dimension.name}`}
                    onClick={toggleExpanded}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                      <path d="M7 10l5 5 5-5z" />
                    </svg>
                  </button>
                  <button type="button" className={styles.filterDimNameBtn} onClick={toggleExpanded}>
                    {dimension.name}
                  </button>
                  <div className={styles.filterDimHeaderToggle}>
                    <button
                      type="button"
                      className={headerMode === COLOR_ALL_CATEGORY_ID ? styles.filterDimHeaderToggleActive : ''}
                      onClick={() => toggleHeaderMode(COLOR_ALL_CATEGORY_ID)}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      className={headerMode === COLOR_UNASSIGNED_CATEGORY_ID ? styles.filterDimHeaderToggleActive : ''}
                      onClick={() => toggleHeaderMode(COLOR_UNASSIGNED_CATEGORY_ID)}
                    >
                      Unassigned
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className={`${styles.filterCatGrid} ${headerMode ? styles.filterCatGridMuted : ''}`}>
                    {dimensionCategories.length === 0 ? (
                      <span className={styles.filterEmpty}>No categories</span>
                    ) : dimensionCategories.map(category => (
                      <label key={category.id} className={`${styles.filterCatOption} ${headerMode ? styles.filterCatOptionMuted : ''} ${(group.special || category.dynamic || category.system || category.colorPickerSpecial) ? styles.filterCatOptionSpecial : ''}`}>
                        <input
                          type="checkbox"
                          checked={!headerMode && selectedIds.includes(category.id)}
                          onChange={() => toggleCategory(category.id)}
                        />
                        <span className={styles.filterCatIcon} style={{ color: category.color || '#64748b' }}>
                          <CategoryIconGlyph icon={iconForCategory(category)} size={14} strokeWidth={2.35} />
                        </span>
                        <span className={styles.filterCatName}>{category.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      ))}
    </div>
  )
}
