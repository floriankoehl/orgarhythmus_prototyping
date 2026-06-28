import { COLOR_ALL_CATEGORY_ID, COLOR_UNASSIGNED_CATEGORY_ID } from './colorPickerCategories'
import { TIME_DIMENSION_ID, timeCategoryIdForNote } from './timeCategories'

export const FILTER_DIMENSION_ID = '__filters__'
export const FILTER_CATEGORY_PREFIX = 'filter:'

export function normalizeSavedFilter(filter = {}) {
  const selections = {}
  Object.entries(filter.selections ?? {}).forEach(([dimensionId, categoryIds]) => {
    const ids = Array.isArray(categoryIds) ? [...new Set(categoryIds)].filter(Boolean) : []
    if (ids.length) selections[dimensionId] = ids
  })
  return {
    ...filter,
    name: (filter.name || 'Untitled filter').trim(),
    gate: filter.gate === 'OR' ? 'OR' : 'AND',
    color: filter.color || '#64748b',
    selections,
  }
}

export function filterCategoryId(filterId) {
  return `${FILTER_CATEGORY_PREFIX}${filterId}`
}

export function filterMatchesNote(filter, note, assignmentForDimension) {
  if (!filter || !note) return false
  const entries = Object.entries(filter.selections ?? {}).filter(([, ids]) => ids.length)
  if (!entries.length) return false
  const matchesDimension = ([dimensionId, categoryIds]) => {
    if (categoryIds.includes(COLOR_ALL_CATEGORY_ID)) return true
    const value = dimensionId === TIME_DIMENSION_ID
      ? timeCategoryIdForNote(note)
      : assignmentForDimension(note.id, dimensionId)
    return categoryIds.includes(value) || (!value && categoryIds.includes(COLOR_UNASSIGNED_CATEGORY_ID))
  }
  return filter.gate === 'OR' ? entries.some(matchesDimension) : entries.every(matchesDimension)
}

export function quickFilterMatchesNote(filters, note, assignmentForDimension) {
  return filters.some(filter => {
    if (filter.catId === COLOR_ALL_CATEGORY_ID) return true
    const value = filter.dimId === TIME_DIMENSION_ID
      ? timeCategoryIdForNote(note)
      : assignmentForDimension(note.id, filter.dimId)
    return filter.catId === COLOR_UNASSIGNED_CATEGORY_ID ? !value : value === filter.catId
  })
}
