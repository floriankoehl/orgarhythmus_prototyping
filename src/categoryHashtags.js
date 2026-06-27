export function normalizeCategoryName(value) {
  return String(value || '')
    .replace(/^#/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function categoryHashtagLabel(categoryName) {
  return `#${String(categoryName || '').trim().replace(/\s+/g, '_')}`
}

export function categoryMatchesForHashtags(text, categories = []) {
  const wanted = new Set()
  const re = /#([^\s#.,;:!?()[\]{}<>]+)/g
  let match
  while ((match = re.exec(text || '')) !== null) {
    const normalized = normalizeCategoryName(match[1])
    if (normalized) wanted.add(normalized)
  }
  if (!wanted.size) return []
  return categories.filter(cat => wanted.has(normalizeCategoryName(cat.name)))
}

export function mergeSelectionsWithHashtags(selections = {}, text = '', categories = []) {
  const next = { ...selections }
  categoryMatchesForHashtags(text, categories).forEach(cat => {
    if (cat.dimensionId) next[cat.dimensionId] = cat.id
  })
  return next
}

export function groupedCategorySuggestions(query, dimensions = [], categories = []) {
  const q = normalizeCategoryName(query)
  const matching = categories
    .filter(cat => !q || normalizeCategoryName(cat.name).includes(q))
    .slice(0, 24)
  return dimensions
    .map(dim => ({
      dimension: dim,
      categories: matching.filter(cat => cat.dimensionId === dim.id),
    }))
    .filter(group => group.categories.length > 0)
}

function textOffsetToDomPosition(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  while (walker.nextNode()) {
    const node = walker.currentNode
    const len = node.textContent.length
    if (remaining <= len) return { node, offset: remaining }
    remaining -= len
  }
  return { node: root, offset: root.childNodes.length }
}

export function activeHashtagQuery(editorEl) {
  const selection = window.getSelection()
  if (!editorEl || !selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!editorEl.contains(range.startContainer)) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(editorEl)
  pre.setEnd(range.startContainer, range.startOffset)
  const text = pre.toString()
  const match = /(^|\s)#([^\s#]*)$/.exec(text)
  if (!match) return null
  return {
    query: match[2],
    startOffset: text.length - match[2].length - 1,
    endOffset: text.length,
  }
}

export function replaceActiveHashtag(editorEl, categoryName) {
  const active = activeHashtagQuery(editorEl)
  if (!active) return false
  const selection = window.getSelection()
  if (!selection) return false
  const start = textOffsetToDomPosition(editorEl, active.startOffset)
  const end = textOffsetToDomPosition(editorEl, active.endOffset)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  selection.removeAllRanges()
  selection.addRange(range)
  document.execCommand('insertText', false, `${categoryHashtagLabel(categoryName)} `)
  return true
}
