import { useEffect, useMemo, useState } from 'react'

export function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getSnippet(html, re) {
  const text = stripHtml(html)
  const match = re.exec(text)
  if (!match) return text.slice(0, 120)
  const start = Math.max(0, match.index - 40)
  return (start > 0 ? '...' : '') + text.slice(start, start + 120) + (start + 120 < text.length ? '...' : '')
}

function compileRegex(query) {
  const q = query.trim()
  if (!q) return null
  try {
    return new RegExp(q, 'i')
  } catch {
    return null
  }
}

export function useProgressiveNoteSearch(notes, query) {
  const re = useMemo(() => compileRegex(query), [query])
  const [weakResults, setWeakResults] = useState([])
  const [searchingDescriptions, setSearchingDescriptions] = useState(false)

  const strongResults = useMemo(() => {
    if (!re) return []
    return notes
      .filter(note => re.test(note.title || ''))
      .map(note => ({ note, matchType: 'strong', snippet: '' }))
  }, [notes, re])

  useEffect(() => {
    setWeakResults([])
    if (!re) {
      setSearchingDescriptions(false)
      return
    }

    let cancelled = false
    let timer = null
    let index = 0
    const strongIds = new Set(strongResults.map(result => result.note.id))
    setSearchingDescriptions(true)

    const runChunk = () => {
      if (cancelled) return
      const batch = []
      const startedAt = performance.now()
      while (index < notes.length && performance.now() - startedAt < 8) {
        const note = notes[index]
        index += 1
        if (strongIds.has(note.id)) continue
        const text = stripHtml(note.html || '')
        if (re.test(text)) {
          batch.push({ note, matchType: 'weak', snippet: getSnippet(note.html || '', re) })
        }
      }

      if (batch.length) setWeakResults(prev => [...prev, ...batch])
      if (index < notes.length) {
        timer = window.setTimeout(runChunk, 0)
      } else {
        setSearchingDescriptions(false)
      }
    }

    timer = window.setTimeout(runChunk, 0)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [notes, re, strongResults])

  return {
    results: [...strongResults, ...weakResults],
    searchingDescriptions,
    validQuery: Boolean(re),
  }
}
