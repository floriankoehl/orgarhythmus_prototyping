import { colorPickerCategories } from './colorPickerCategories'

function isSpecialDimension(dimension) {
  return Boolean(dimension?.dynamic || dimension?.system)
}

export default function FilterDimensionSelector({ dimensions, categories, selections, onToggle, styles }) {
  const groups = [
    { label: 'Project dimensions', dimensions: dimensions.filter(dimension => !isSpecialDimension(dimension)), special: false },
    { label: 'Special dimensions', dimensions: dimensions.filter(isSpecialDimension), special: true },
  ].filter(group => group.dimensions.length > 0)

  return (
    <div className={styles.filterDimList}>
      {groups.map(group => (
        <div key={group.label} className={styles.filterDimGroup}>
          <div className={`${styles.filterDimGroupTitle} ${group.special ? styles.filterDimGroupTitleSpecial : ''}`}>
            {group.label}
          </div>
          {group.dimensions.map(dimension => {
            const dimensionCategories = colorPickerCategories(categories, dimensions, dimension.id).filter(category => category.filterable !== false)
            return (
              <section key={dimension.id} className={`${styles.filterDimSection} ${group.special ? styles.filterDimSectionSpecial : ''}`}>
                <div className={styles.filterDimTitle}>
                  <span>{dimension.name}</span>
                  {group.special && <em className={styles.filterSpecialBadge}>{dimension.dynamicLabel || dimension.dynamicType || dimension.systemType || 'Special'}</em>}
                </div>
                <div className={styles.filterCatGrid}>
                  {dimensionCategories.length === 0 ? (
                    <span className={styles.filterEmpty}>No categories</span>
                  ) : dimensionCategories.map(category => (
                    <label key={category.id} className={`${styles.filterCatOption} ${(group.special || category.dynamic || category.system || category.colorPickerSpecial) ? styles.filterCatOptionSpecial : ''}`}>
                      <input
                        type="checkbox"
                        checked={(selections[dimension.id] ?? []).includes(category.id)}
                        onChange={() => onToggle(dimension.id, category.id)}
                      />
                      <span className={styles.legendDot} style={{ background: category.color }} />
                      <span className={styles.filterCatName}>{category.name}</span>
                      {(group.special || category.dynamic || category.system || category.colorPickerSpecial) && (
                        <em className={styles.filterSpecialBadge}>{category.dynamicLabel || category.dynamicType || category.systemType || 'Special'}</em>
                      )}
                    </label>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      ))}
    </div>
  )
}
