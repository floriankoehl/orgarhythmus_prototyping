import { useEffect, useState } from 'react'
import { activeHashtagQuery, groupedCategorySuggestions, replaceActiveHashtag } from '../categoryHashtags'
import styles from './CategoryHashtagSuggestions.module.css'

export default function CategoryHashtagSuggestions({
  editorRef,
  dimensions = [],
  categories = [],
  onPick,
  placement = 'below',
  className = '',
}) {
  const [active, setActive] = useState(null)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const update = () => {
      const next = activeHashtagQuery(editor)
      setActive(next || null)
    }
    editor.addEventListener('keyup', update)
    editor.addEventListener('mouseup', update)
    editor.addEventListener('input', update)
    document.addEventListener('selectionchange', update)
    update()
    return () => {
      editor.removeEventListener('keyup', update)
      editor.removeEventListener('mouseup', update)
      editor.removeEventListener('input', update)
      document.removeEventListener('selectionchange', update)
    }
  }, [editorRef])

  const groups = active ? groupedCategorySuggestions(active.query, dimensions, categories) : []
  if (!groups.length) return null

  const pick = (cat) => {
    const editor = editorRef.current
    if (editor) {
      editor.focus()
      replaceActiveHashtag(editor, cat.name)
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    }
    onPick?.(cat)
  }

  return (
    <div className={`${styles.panel} ${placement === 'above' ? styles.above : ''} ${className}`}>
      {groups.map(group => (
        <div key={group.dimension.id} className={styles.group}>
          <div className={styles.dimension}>{group.dimension.name}</div>
          <div className={styles.categories}>
            {group.categories.map(cat => (
              <button
                key={cat.id}
                type="button"
                className={styles.category}
                onMouseDown={e => e.preventDefault()}
                onClick={() => pick(cat)}>
                <span className={styles.dot} style={{ background: cat.color }} />
                <span>{cat.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
