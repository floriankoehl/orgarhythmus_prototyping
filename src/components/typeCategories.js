export const TYPE_DIMENSION_ID = '__type__'
export const TYPE_CATEGORY_PREFIX = 'type:'

export const TYPE_DYNAMIC_CATEGORIES = [
  { id: `${TYPE_CATEGORY_PREFIX}thought`, name: 'Thought', color: '#94a3b8', typeRole: 'thought', readOnly: true, filterable: true },
  { id: `${TYPE_CATEGORY_PREFIX}task`, name: 'Task', color: '#3b82f6', typeRole: 'task', readOnly: true, filterable: true },
  { id: `${TYPE_CATEGORY_PREFIX}project`, name: 'Project', color: '#22c55e', typeRole: 'project', readOnly: true, filterable: true },
]

export function typeCategoryIdForNote(note, context = {}) {
  if (!note) return `${TYPE_CATEGORY_PREFIX}thought`
  const noteId = note.id
  const notes = context.notes || []
  const timeSlots = context.timeSlots || []
  const hasChildren = Boolean(
    note.hasChildren
    || note.childCount > 0
    || notes.some(candidate => candidate.parentNoteId === noteId)
  )
  if (hasChildren) return `${TYPE_CATEGORY_PREFIX}project`
  const hasTimeSlot = Boolean(
    note.hasTimeSlot
    || timeSlots.some(slot => slot.noteId === noteId)
  )
  return hasTimeSlot ? `${TYPE_CATEGORY_PREFIX}task` : `${TYPE_CATEGORY_PREFIX}thought`
}
