const BASE = 'http://localhost:8000'

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let detail = ''
    let rawDetail = null
    try {
      const data = await res.json()
      rawDetail = data.detail
      detail = typeof data.detail === 'string'
        ? data.detail
        : data.detail?.message || JSON.stringify(data.detail)
    } catch {}
    const err = new Error(detail || `${method} ${path} → ${res.status}`)
    err.detail = rawDetail
    throw err
  }
  if (res.status === 204) return null
  return res.json()
}

export const api = {
  // Goals (pages)
  getPages:     ()            => req('GET',    '/pages'),
  createPage:   (page)        => req('POST',   '/pages', page),
  updatePage:   (id, patch)   => req('PATCH',  `/pages/${id}`, patch),
  deletePage:   (id)          => req('DELETE', `/pages/${id}`),
  reorderPages: (ids)         => req('PUT',    '/pages/order', { ids }),

  // Dimensions
  getDimensions:   ()         => req('GET',    '/dimensions'),
  createDimension: (data)     => req('POST',   '/dimensions', data),
  updateDimension: (id, patch)=> req('PATCH',  `/dimensions/${id}`, patch),
  deleteDimension: (id)       => req('DELETE', `/dimensions/${id}`),

  // Categories
  getAllCategories:    ()         => req('GET',    '/categories'),
  createCategory:     (dimId, d) => req('POST',   `/dimensions/${dimId}/categories`, d),
  updateCategory:     (id, patch) => req('PATCH', `/categories/${id}`, patch),
  deleteCategory:     (id)       => req('DELETE', `/categories/${id}`),
  reorderCategories:  (ids)      => req('PUT',    '/categories/order', { ids }),

  // Assignments
  getAssignments: ()                      => req('GET',    '/assignments'),
  assign:         (goalId, dimId, catId)  => req('PUT',    `/goals/${goalId}/assign/${dimId}`, { categoryId: catId }),
  unassign:       (goalId, dimId)         => req('DELETE', `/goals/${goalId}/assign/${dimId}`),
  reorderAssignments: (dimId, catId, goalIds) => req('PUT', '/assignments/order', { dimensionId: dimId, categoryId: catId, goalIds }),

  // Saved filters
  getFilters:    ()           => req('GET',    '/filters'),
  createFilter:  (filter)     => req('POST',   '/filters', filter),
  updateFilter:  (id, patch)  => req('PATCH',  `/filters/${id}`, patch),
  deleteFilter:  (id)         => req('DELETE', `/filters/${id}`),

  // Schedule perspectives
  getSchedulePerspectives:    ()              => req('GET',    '/schedule-perspectives'),
  createSchedulePerspective:  (perspective)   => req('POST',   '/schedule-perspectives', perspective),
  updateSchedulePerspective:  (id, patch)     => req('PATCH',  `/schedule-perspectives/${id}`, patch),
  deleteSchedulePerspective:  (id)            => req('DELETE', `/schedule-perspectives/${id}`),

  // Classification perspectives
  getClassificationPerspectives:    ()              => req('GET',    '/classification-perspectives'),
  createClassificationPerspective:  (perspective)   => req('POST',   '/classification-perspectives', perspective),
  updateClassificationPerspective:  (id, patch)     => req('PATCH',  `/classification-perspectives/${id}`, patch),
  deleteClassificationPerspective:  (id)            => req('DELETE', `/classification-perspectives/${id}`),

  // Milestones
  getMilestones:         ()        => req('GET',    '/milestones'),
  createMilestone:       (data)    => req('POST',   '/milestones', data),
  updateMilestone:       (id, patch) => req('PATCH', `/milestones/${id}`, patch),
  deleteMilestone:       (id)      => req('DELETE', `/milestones/${id}`),
  batchUpdateMilestones: (updates) => req('PUT',    '/milestones/batch', { updates }),

  // Gantt transactions
  getTransactionHistory: ()            => req('GET',  '/transactions/history'),
  applyTransaction:     (transaction)  => req('POST', '/transactions', { transaction }),
  undoTransaction:      ()             => req('POST', '/transactions/undo'),
  redoTransaction:      ()             => req('POST', '/transactions/redo'),

  // Dependencies
  getDependencies:       ()         => req('GET',    '/dependencies'),
  createDependency:      (data)     => req('POST',   '/dependencies', data),
  updateDependencyReason:(id, reason) => req('PATCH', `/dependencies/${id}`, { reason }),
  deleteDependency:      (id)       => req('DELETE', `/dependencies/${id}`),

  // Deadlines
  getDeadlines:   ()               => req('GET',    '/deadlines'),
  setDeadline:    (goalId, col)    => req('PUT',    `/deadlines/${goalId}`, { col }),
  removeDeadline: (goalId)         => req('DELETE', `/deadlines/${goalId}`),
}
