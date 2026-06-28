import { useState, useEffect } from 'react'
import { api } from '../api'
import styles from './PeopleWidget.module.css'

const CHAR_KEYS = 'abcdefghijklmnopqr'.split('')
const RETRO_KEY_FALLBACKS = { humanFemaleA: 'a', humanMaleA: 'b', zombieFemaleA: 'c', zombieMaleA: 'd' }
const resolveModelKey = key => CHAR_KEYS.includes(key) ? key : (RETRO_KEY_FALLBACKS[key] ?? 'a')

function PeopleIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    </svg>
  )
}

export default function PeopleWidget({
  // null | personaId — the currently active persona for assignment
  paintPersonaId,
  // (personaId | null) => void
  onPaintPersonaChange,
  expanded,
  onExpandedChange,
  refreshKey = 0,
  onApplyQuickFilter,
}) {
  const [personas, setPersonas] = useState([])

  useEffect(() => {
    api.getPersonas().then(setPersonas).catch(console.error)
  }, [refreshKey])

  const activePersona = personas.find(p => p.id === paintPersonaId) ?? null
  const activatePersona = personaId => {
    onPaintPersonaChange(paintPersonaId === personaId ? null : personaId)
  }

  return (
    <div className={styles.widget} onClick={e => e.stopPropagation()}>
      {expanded && (
        <div className={styles.panel}>
          {paintPersonaId && (
            <div className={styles.activeHint}>
              <span className={styles.activeHintDot} />
              <span>Click a note or category{activePersona ? ` to assign ${activePersona.name}` : ''}</span>
            </div>
          )}
          {personas.length === 0 && (
            <div className={styles.empty}>No people added yet</div>
          )}
          {personas.map(persona => {
            const isActive = paintPersonaId === persona.id
            return (
              <div
                key={persona.id}
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData('persona-drag', persona.id)
                  e.dataTransfer.effectAllowed = 'all'
                }}
                onClick={() => activatePersona(persona.id)}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  activatePersona(persona.id)
                }}
                title={isActive ? `Deactivate ${persona.name}` : `Activate ${persona.name} for assignment`}
              >
                <img
                  src={`/models/previews/character-${resolveModelKey(persona.modelKey)}.png`}
                  alt={persona.name}
                  className={styles.avatar}
                />
                <span className={styles.name}>{persona.name}</span>
                {isActive && (
                  <svg className={styles.checkIcon} width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                )}
                {onApplyQuickFilter && (
                  <button
                    type="button"
                    draggable={false}
                    className={styles.filterBtn}
                    title={`Filter now to notes involving ${persona.name}`}
                    onClick={e => {
                      e.stopPropagation()
                      onApplyQuickFilter(persona.id)
                    }}
                    onKeyDown={e => e.stopPropagation()}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/>
                    </svg>
                  </button>
                )}
              </div>
            )
          })}
          {paintPersonaId && (
            <button className={styles.cancelBtn} onClick={() => onPaintPersonaChange(null)}>
              Cancel
            </button>
          )}
        </div>
      )}

      <button
        className={[
          styles.toggleBtn,
          expanded ? styles.toggleActive : '',
          paintPersonaId ? styles.togglePainting : '',
        ].filter(Boolean).join(' ')}
        onClick={() => onExpandedChange(!expanded)}
        title={expanded ? 'Collapse people panel' : 'Assign people or filter notes by responsibility'}
      >
        <PeopleIcon size={16} />
      </button>

      {!expanded && (
        <span className={styles.hint}>
          <strong>People</strong>
          <small>{paintPersonaId && activePersona ? `Assigning ${activePersona.name}` : 'Assign people or filter the current view once'}</small>
        </span>
      )}
    </div>
  )
}
