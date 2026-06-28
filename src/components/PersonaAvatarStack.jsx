import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './PersonaAvatarStack.module.css'

const CHAR_KEYS = 'abcdefghijklmnopqr'.split('')
const RETRO_KEY_FALLBACKS = { humanFemaleA: 'a', humanMaleA: 'b', zombieFemaleA: 'c', zombieMaleA: 'd' }
const resolveModelKey = key => CHAR_KEYS.includes(key) ? key : (RETRO_KEY_FALLBACKS[key] ?? 'a')

export default function PersonaAvatarStack({ personas = [], onRemove }) {
  const [open, setOpen] = useState(false)
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 })
  const stackRef = useRef(null)
  const closeTimer = useRef(null)

  useEffect(() => () => clearTimeout(closeTimer.current), [])

  if (!personas.length) return null

  const showAll = personas.length <= 3
  const visible = showAll ? personas : personas.slice(0, 2)
  const overflow = showAll ? 0 : personas.length - 2

  const openPopup = () => {
    clearTimeout(closeTimer.current)
    if (stackRef.current) {
      const rect = stackRef.current.getBoundingClientRect()
      setPopupPos({ top: rect.top - 8, left: rect.left })
    }
    setOpen(true)
  }

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }

  const cancelClose = () => clearTimeout(closeTimer.current)

  return (
    <>
      <div
        ref={stackRef}
        className={styles.stack}
        onMouseEnter={openPopup}
        onMouseLeave={scheduleClose}
        onClick={e => e.stopPropagation()}
      >
        {visible.map(persona => (
          <div
            key={persona.id}
            className={styles.avatar}
          >
            <img
              src={`/models/previews/character-${resolveModelKey(persona.modelKey)}.png`}
              alt={persona.name}
            />
          </div>
        ))}
        {overflow > 0 && (
          <div className={styles.overflow}>
            +{overflow}
          </div>
        )}
      </div>

      {open && createPortal(
        <div
          className={styles.popup}
          style={{ top: popupPos.top, left: popupPos.left }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onClick={e => e.stopPropagation()}
        >
          {personas.map(persona => (
            <div key={persona.id} className={styles.popupRow}>
              <div className={styles.popupAvatar}>
                <img
                  src={`/models/previews/character-${resolveModelKey(persona.modelKey)}.png`}
                  alt={persona.name}
                />
              </div>
              <span className={styles.popupName}>{persona.name}</span>
              {onRemove && (
                <button
                  className={styles.popupRemove}
                  title={`Remove ${persona.name}`}
                  onClick={() => {
                    onRemove(persona.id)
                    setOpen(false)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}
