import { COLOR_ALL_CATEGORY_ID, COLOR_UNASSIGNED_CATEGORY_ID } from './colorPickerCategories'
import { TIME_DIMENSION_ID, timeCategoryIdForNote } from './timeCategories'
import { TYPE_DIMENSION_ID, typeCategoryIdForNote } from './typeCategories'

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

function valuesForDimension(note, dimensionId, assignmentForDimension, context) {
  if (dimensionId === TIME_DIMENSION_ID) {
    return context.timeCategoryIdsForNote?.(note) ?? [timeCategoryIdForNote(note)]
  }
  if (dimensionId === TYPE_DIMENSION_ID) {
    return [typeCategoryIdForNote(note, context)]
  }
  return [assignmentForDimension(note.id, dimensionId)]
}

export function filterMatchesNote(filter, note, assignmentForDimension, context = {}) {
  if (!filter || !note) return false
  const entries = Object.entries(filter.selections ?? {}).filter(([, ids]) => ids.length)
  if (!entries.length) return false
  const matchesDimension = ([dimensionId, categoryIds]) => {
    if (categoryIds.includes(COLOR_ALL_CATEGORY_ID)) return true
    const values = valuesForDimension(note, dimensionId, assignmentForDimension, context)
    return values.some(value => categoryIds.includes(value) || (!value && categoryIds.includes(COLOR_UNASSIGNED_CATEGORY_ID)))
  }
  return filter.gate === 'OR' ? entries.some(matchesDimension) : entries.every(matchesDimension)
}

export function quickFilterMatchesNote(filters, note, assignmentForDimension, context = {}) {
  return filters.some(filter => {
    if (filter.catId === COLOR_ALL_CATEGORY_ID) return true
    const values = valuesForDimension(note, filter.dimId, assignmentForDimension, context)
    return filter.catId === COLOR_UNASSIGNED_CATEGORY_ID
      ? values.every(value => !value)
      : values.includes(filter.catId)
  })
}
