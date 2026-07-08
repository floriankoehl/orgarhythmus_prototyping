export const COLOR_ALL_CATEGORY_ID = '__color_all__'
export const COLOR_UNASSIGNED_CATEGORY_ID = '__color_unassigned__'

export function colorPickerCategories(categories, dimensions, dimensionId) {
  if (!dimensionId) return []
  const dimension = dimensions.find(item => item.id === dimensionId)
  const computed = Boolean(dimension?.dynamic)
  return [
    {
      id: COLOR_UNASSIGNED_CATEGORY_ID,
      dimensionId,
      name: 'Unassigned',
      color: '#9ca3af',
      colorPickerSpecial: true,
      unassign: !computed,
      readOnly: computed,
      filterable: !computed,
      specialLabel: computed ? 'Computed' : 'Unassign',
    },
    ...categories.filter(category => category.dimensionId === dimensionId),
  ]
}
