import { useState, useRef, useCallback } from 'react'

export function useEditorState() {
  const editorRef = useRef(null)
  const [wordCount, setWordCount] = useState(0)
  const [charCount, setCharCount] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [fontSize, setFontSize] = useState(11)
  const [fontFamily, setFontFamily] = useState('Arial')

  const updateCounts = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const text = el.innerText || ''
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length
    setWordCount(words)
    setCharCount(text.length)
  }, [])

  const execCommand = useCallback((command, value = null) => {
    document.execCommand(command, false, value)
    editorRef.current?.focus()
  }, [])

  const applyFontSize = useCallback((size) => {
    setFontSize(size)
    execCommand('fontSize', '7')
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const fontEls = editorRef.current?.querySelectorAll('font[size="7"]')
      fontEls?.forEach(el => {
        el.removeAttribute('size')
        el.style.fontSize = `${size}pt`
      })
    }
  }, [execCommand])

  const applyFontFamily = useCallback((family) => {
    setFontFamily(family)
    execCommand('fontName', family)
  }, [execCommand])

  return {
    editorRef,
    wordCount,
    charCount,
    zoom,
    setZoom,
    fontSize,
    fontFamily,
    updateCounts,
    execCommand,
    applyFontSize,
    applyFontFamily,
  }
}
