const BASE = 'http://localhost:8000'

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`)
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

  // Milestones
  getMilestones:         ()        => req('GET',    '/milestones'),
  createMilestone:       (data)    => req('POST',   '/milestones', data),
  updateMilestone:       (id, patch) => req('PATCH', `/milestones/${id}`, patch),
  deleteMilestone:       (id)      => req('DELETE', `/milestones/${id}`),
  batchUpdateMilestones: (updates) => req('PUT',    '/milestones/batch', { updates }),

  // Dependencies
  getDependencies:  ()             => req('GET',    '/dependencies'),
  createDependency: (data)         => req('POST',   '/dependencies', data),
  deleteDependency: (id)           => req('DELETE', `/dependencies/${id}`),

  // Deadlines
  getDeadlines:   ()               => req('GET',    '/deadlines'),
  setDeadline:    (goalId, col)    => req('PUT',    `/deadlines/${goalId}`, { col }),
  removeDeadline: (goalId)         => req('DELETE', `/deadlines/${goalId}`),
}
