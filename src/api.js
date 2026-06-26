const BASE = 'http://localhost:8000'
const ACCESS_KEY = 'orgarhythmus.accessToken'
const REFRESH_KEY = 'orgarhythmus.refreshToken'

let _projectId = 'default'
export function setProjectId(id) { _projectId = id }

function getStoredAccessToken() {
  return localStorage.getItem(ACCESS_KEY) || ''
}

function getStoredRefreshToken() {
  return localStorage.getItem(REFRESH_KEY) || ''
}

export function hasAuthSession() {
  return Boolean(getStoredAccessToken() || getStoredRefreshToken())
}

export function setAuthTokens(tokens = {}) {
  if (tokens.accessToken) localStorage.setItem(ACCESS_KEY, tokens.accessToken)
  if (tokens.refreshToken) localStorage.setItem(REFRESH_KEY, tokens.refreshToken)
}

export function clearAuthTokens() {
  localStorage.removeItem(ACCESS_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

function authHeaders(body) {
  const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {}
  const token = getStoredAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function parseError(res, method, path) {
  let detail = ''
  let rawDetail = null
  try {
    const data = await res.json()
    rawDetail = data.detail
    detail = typeof data.detail === 'string'
      ? data.detail
      : data.detail?.message || JSON.stringify(data.detail)
  } catch {}
  const err = new Error(detail || `${method} ${path} -> ${res.status}`)
  err.detail = rawDetail
  err.status = res.status
  throw err
}

async function refreshAccessToken() {
  const refreshToken = getStoredRefreshToken()
  if (!refreshToken) return false
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!res.ok) {
    clearAuthTokens()
    return false
  }
  const data = await res.json()
  setAuthTokens(data)
  return true
}

async function fetchJson(method, url, body, { retryAuth = true } = {}) {
  let res = await fetch(url, {
    method,
    headers: authHeaders(body),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && retryAuth && await refreshAccessToken()) {
    res = await fetch(url, {
      method,
      headers: authHeaders(body),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }
  if (!res.ok) await parseError(res, method, url.replace(BASE, ''))
  if (res.status === 204) return null
  return res.json()
}

async function req(method, path, body) {
  const sep = path.includes('?') ? '&' : '?'
  const url = `${BASE}${path}${sep}project_id=${encodeURIComponent(_projectId)}`
  return fetchJson(method, url, body)
}

async function baseReq(method, path, body) {
  return fetchJson(method, `${BASE}${path}`, body)
}

export const authApi = {
  register: async ({ email, displayName, password }) => {
    const tokens = await fetchJson('POST', `${BASE}/auth/register`, { email, displayName, password }, { retryAuth: false })
    setAuthTokens(tokens)
    return tokens
  },
  login: async ({ email, password }) => {
    const tokens = await fetchJson('POST', `${BASE}/auth/login`, { email, password }, { retryAuth: false })
    setAuthTokens(tokens)
    return tokens
  },
  me: () => baseReq('GET', '/auth/me'),
  logout: () => clearAuthTokens(),
}

export const projectsApi = {
  getProjects:      ()          => baseReq('GET',    '/projects'),
  createProject:    (data)      => baseReq('POST',   '/projects', data),
  updateProject:    (id, patch) => baseReq('PATCH',  `/projects/${id}`, patch),
  deleteProject:    (id)        => baseReq('DELETE', `/projects/${id}`),
  getProjectStats:  (id)        => baseReq('GET',    `/projects/${id}/stats`),
  exportDatabase:   (id)        => baseReq('GET',    `/export/db?project_id=${encodeURIComponent(id)}`),
}

export const api = {
  // Notes
  getNotes:     ()            => req('GET',    '/notes'),
  createNote:   (note)        => req('POST',   '/notes', note),
  updateNote:   (id, patch)   => req('PATCH',  `/notes/${id}`, patch),
  deleteNote:   (id)          => req('DELETE', `/notes/${id}`),
  reorderNotes: (ids)         => req('PUT',    '/notes/order', { ids }),

  // Dimensions
  getDimensions:      ()         => req('GET',    '/dimensions'),
  createDimension:    (data)     => req('POST',   '/dimensions', data),
  updateDimension:    (id, patch)=> req('PATCH',  `/dimensions/${id}`, patch),
  deleteDimension:    (id)       => req('DELETE', `/dimensions/${id}`),
  reorderDimensions:  (ids)      => req('PUT',    '/dimensions/reorder', { ids }),

  // Categories
  getAllCategories:    ()         => req('GET',    '/categories'),
  createCategory:     (dimId, d) => req('POST',   `/dimensions/${dimId}/categories`, d),
  updateCategory:     (id, patch) => req('PATCH', `/categories/${id}`, patch),
  deleteCategory:     (id)       => req('DELETE', `/categories/${id}`),
  reorderCategories:  (ids)      => req('PUT',    '/categories/order', { ids }),

  // Personas
  getPersonas:    ()           => req('GET',    '/personas'),
  createPersona:  (data)       => req('POST',   '/personas', data),
  updatePersona:  (id, patch)  => req('PATCH',  `/personas/${id}`, patch),
  deletePersona:  (id)         => req('DELETE', `/personas/${id}`),
  getPersonaAssignments: ()              => req('GET',    '/persona-assignments'),
  getDirectPersonaAssignments: ()        => req('GET',    '/persona-assignments/direct'),
  assignPersona:        (id, dimId, catId) => req('PUT',  `/personas/${id}/assign`, { dimensionId: dimId, categoryId: catId }),
  unassignPersona:      (id, dimId, catId) => req('DELETE', `/personas/${id}/assign/${dimId}/${catId}`),
  getPersonaNoteAssignments: ()            => req('GET',    '/persona-note-assignments'),
  getDirectPersonaNoteAssignments: ()      => req('GET',    '/persona-note-assignments/direct'),
  assignPersonaToNote:  (personaId, noteId) => req('PUT',  `/personas/${personaId}/note-assign/${noteId}`),
  unassignPersonaFromNote: (personaId, noteId) => req('DELETE', `/personas/${personaId}/note-assign/${noteId}`),
  getPersonaMilestoneAssignments: ()            => req('GET',    '/persona-milestone-assignments'),
  assignPersonaToMilestone:  (personaId, milestoneId) => req('PUT',  `/personas/${personaId}/milestone-assign/${milestoneId}`),
  unassignPersonaFromMilestone: (personaId, milestoneId) => req('DELETE', `/personas/${personaId}/milestone-assign/${milestoneId}`),
  getCategoryLeaders:     ()               => req('GET',    '/category-leaders'),
  addCategoryLeader:    (catId, personaId) => req('PUT',    `/categories/${catId}/leaders/${personaId}`),
  removeCategoryLeader: (catId, personaId) => req('DELETE', `/categories/${catId}/leaders/${personaId}`),

  // Assignments
  getAssignments: ()                      => req('GET',    '/assignments'),
  assign:         (noteId, dimId, catId)  => req('PUT',    `/notes/${noteId}/assign/${dimId}`, { categoryId: catId }),
  unassign:       (noteId, dimId)         => req('DELETE', `/notes/${noteId}/assign/${dimId}`),
  reorderAssignments: (dimId, catId, noteIds) => req('PUT', '/assignments/order', { dimensionId: dimId, categoryId: catId, noteIds }),

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
  getDependencyViolations: ()       => req('GET',    '/dependencies/violations'),
  createDependency:      (data)     => req('POST',   '/dependencies', data),
  updateDependencyReason:(id, reason) => req('PATCH', `/dependencies/${id}`, { reason }),
  deleteDependency:      (id)       => req('DELETE', `/dependencies/${id}`),

  // Deadlines
  getDeadlines:   ()               => req('GET',    '/deadlines'),
  setDeadline:    (noteId, col)    => req('PUT',    `/deadlines/${noteId}`, { col }),
  removeDeadline: (noteId)         => req('DELETE', `/deadlines/${noteId}`),
}
