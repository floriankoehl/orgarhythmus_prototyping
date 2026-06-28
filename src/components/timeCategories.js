export const TIME_DIMENSION_ID = '__time__'
export const TIME_CATEGORY_PREFIX = 'time:'

export const TIME_DYNAMIC_CATEGORIES = [
  { id: `${TIME_CATEGORY_PREFIX}hour`, name: 'Last hour', color: '#22c55e', maxAgeMs: 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}day`, name: 'Last day', color: '#3b82f6', maxAgeMs: 24 * 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}week`, name: 'Last week', color: '#8b5cf6', maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  { id: `${TIME_CATEGORY_PREFIX}older`, name: 'Older than a week', color: '#94a3b8', maxAgeMs: Infinity },
]

export function noteCreatedAtMs(note) {
  const raw = note?.createdAt ?? note?.created_at
  if (!raw) return Date.now()
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : Date.now()
}

export function timeCategoryIdForNote(note, nowMs = Date.now()) {
  const createdAt = noteCreatedAtMs(note)
  const age = createdAt > 0 ? Math.max(0, nowMs - createdAt) : Infinity
  return TIME_DYNAMIC_CATEGORIES.find(category => age <= category.maxAgeMs)?.id ?? `${TIME_CATEGORY_PREFIX}older`
}
