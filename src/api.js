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
  getPages:     ()           => req('GET',    '/pages'),
  createPage:   (page)       => req('POST',   '/pages', page),
  updatePage:   (id, patch)  => req('PATCH',  `/pages/${id}`, patch),
  deletePage:   (id)         => req('DELETE', `/pages/${id}`),
  reorderPages: (ids)        => req('PUT',    '/pages/order', { ids }),
}
