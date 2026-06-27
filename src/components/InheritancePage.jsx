import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import styles from './InheritancePage.module.css'

const INHERITANCE_MODES = {
  'minute-minute': ['minute', 'minute', 'Minutes to Minutes'],
  'minute-day': ['minute', 'day', 'Minutes to Days'],
  'day-day': ['day', 'day', 'Days to Days'],
  'day-month': ['day', 'month', 'Days to Months'],
  'month-month': ['month', 'month', 'Months to Months'],
}

function minuteToDate(minute) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setMinutes(d.getMinutes() + (Number(minute) || 0))
  return d
}

function timelineStartDate() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function addCalendarMonths(date, months) {
  const source = new Date(date)
  const day = source.getDate()
  const target = new Date(source)
  target.setDate(1)
  target.setMonth(target.getMonth() + months)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDay))
  return target
}

function minutesBetweenDates(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 60000)
}

function calendarMonthBoundaryMinute(col) {
  return minutesBetweenDates(timelineStartDate(), addCalendarMonths(timelineStartDate(), col))
}

function calendarMonthColForMinute(minute) {
  const value = Math.max(0, Number(minute) || 0)
  let col = Math.max(0, Math.floor(value / 43200))
  while (calendarMonthBoundaryMinute(col + 1) <= value) col += 1
  while (col > 0 && calendarMonthBoundaryMinute(col) > value) col -= 1
  return col
}

function isCalendarMonthBoundary(minute) {
  const value = Math.max(0, Number(minute) || 0)
  return calendarMonthBoundaryMinute(calendarMonthColForMinute(value)) === value
}

function isCalendarMonthRange(startCol, duration) {
  const start = Math.max(0, Number(startCol) || 0)
  const end = start + Math.max(0, Number(duration) || 0)
  return end > start && isCalendarMonthBoundary(start) && isCalendarMonthBoundary(end)
}

function timeSlotScale(timeSlot) {
  if (!timeSlot) return null
  if (isCalendarMonthRange(timeSlot.startCol, timeSlot.duration)) return 'month'
  const duration = Math.max(10, Number(timeSlot.duration) || 10)
  if (duration >= 43200) return 'month'
  if (duration >= 1440) return 'day'
  return 'minute'
}

function formatWindow(timeSlot) {
  if (!timeSlot) return 'No time slot'
  const start = minuteToDate(timeSlot.startCol)
  const end = minuteToDate(timeSlot.startCol + timeSlot.duration)
  return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`
}

function noteTitle(note) {
  return note?.title || 'Untitled'
}

export default function InheritancePage({ notes = [], isActive = false, onNoteOpen }) {
  const [timeSlots, setTimeSlots] = useState([])
  const [inheritance, setInheritance] = useState([])
  const [mode, setMode] = useState('minute-day')
  const [error, setError] = useState('')

  const load = () => {
    Promise.all([api.getTimeSlots(), api.getNoteInheritance()])
      .then(([mss, links]) => { setTimeSlots(mss); setInheritance(links); setError('') })
      .catch(err => setError(err.message || 'Could not load inheritance'))
  }

  useEffect(() => {
    if (isActive) load()
  }, [isActive])

  const timeSlotByNote = useMemo(() => {
    const map = new Map()
    timeSlots.forEach(ms => {
      if (!map.has(ms.noteId)) map.set(ms.noteId, ms)
    })
    return map
  }, [timeSlots])

  const parentsByChild = useMemo(() => {
    const map = new Map()
    inheritance.forEach(link => {
      if (!map.has(link.childNoteId)) map.set(link.childNoteId, new Set())
      map.get(link.childNoteId).add(link.parentNoteId)
    })
    return map
  }, [inheritance])

  const [childScale, parentScale] = INHERITANCE_MODES[mode] ?? INHERITANCE_MODES['minute-day']
  const parentNotes = notes.filter(note => timeSlotScale(timeSlotByNote.get(note.id)) === parentScale)
  const childNotes = notes.filter(note => timeSlotScale(timeSlotByNote.get(note.id)) === childScale)
  const assignedChildren = childNotes.filter(note => parentsByChild.has(note.id))

  const assign = async (childId, parentId) => {
    if (!parentId) return
    try {
      const saved = await api.setNoteInheritance(childId, parentId)
      setInheritance(prev => [
        ...prev.filter(link => !(link.childNoteId === saved.childNoteId && link.parentNoteId === saved.parentNoteId)),
        saved,
      ])
      setError('')
    } catch (err) {
      setError(err.message || 'Inheritance could not be assigned')
    }
  }

  const remove = async (childId, parentId) => {
    try {
      await api.removeNoteInheritance(childId, parentId)
      setInheritance(prev => prev.filter(link => !(link.childNoteId === childId && link.parentNoteId === parentId)))
      setError('')
    } catch (err) {
      setError(err.message || 'Inheritance could not be removed')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.segmented}>
          {Object.entries(INHERITANCE_MODES).map(([key, [, , label]]) => (
            <button key={key} className={mode === key ? styles.active : ''} onClick={() => setMode(key)}>
              {label}
            </button>
          ))}
        </div>
        <button className={styles.refreshBtn} onClick={load}>Refresh</button>
        {error && <div className={styles.error}>{error}</div>}
      </div>

      <div className={styles.content}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}>Parent {parentScale} notes</div>
          <div className={styles.parentGrid}>
            {parentNotes.map(parent => {
              const parentMs = timeSlotByNote.get(parent.id)
              const children = assignedChildren.filter(child => parentsByChild.get(child.id)?.has(parent.id))
              return (
                <article key={parent.id} className={styles.parentCard}>
                  <button className={styles.noteTitle} onClick={() => onNoteOpen?.(parent.id)}>{noteTitle(parent)}</button>
                  <div className={styles.window}>{formatWindow(parentMs)}</div>
                  <div className={styles.childList}>
                    {children.length === 0 && <div className={styles.empty}>No children</div>}
                    {children.map(child => (
                      <div key={child.id} className={styles.childRow}>
                        <button onClick={() => onNoteOpen?.(child.id)}>{noteTitle(child)}</button>
                        <button className={styles.removeBtn} onClick={() => remove(child.id, parent.id)}>Remove</button>
                      </div>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <aside className={styles.panel}>
          <div className={styles.panelTitle}>Child {childScale} notes</div>
          <div className={styles.unassignedList}>
            {childNotes.length === 0 && <div className={styles.empty}>Nothing to assign</div>}
            {childNotes.map(child => {
              const availableParents = parentNotes.filter(parent => parent.id !== child.id && !parentsByChild.get(child.id)?.has(parent.id))
              return (
              <div key={child.id} className={styles.assignCard}>
                <button className={styles.noteTitle} onClick={() => onNoteOpen?.(child.id)}>{noteTitle(child)}</button>
                <div className={styles.window}>{formatWindow(timeSlotByNote.get(child.id))}</div>
                <select defaultValue="" onChange={e => assign(child.id, e.target.value)}>
                  <option value="" disabled>{availableParents.length ? 'Assign parent...' : 'No more parents available'}</option>
                  {availableParents.map(parent => (
                    <option key={parent.id} value={parent.id}>{noteTitle(parent)}</option>
                  ))}
                </select>
              </div>
              )
            })}
          </div>
        </aside>
      </div>
    </div>
  )
}
