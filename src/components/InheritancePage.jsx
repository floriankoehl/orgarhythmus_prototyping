import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import styles from './InheritancePage.module.css'

const SCALE_ORDER = ['minute', 'day', 'month']

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

function milestoneScale(milestone) {
  if (!milestone) return null
  if (isCalendarMonthRange(milestone.startCol, milestone.duration)) return 'month'
  const duration = Math.max(10, Number(milestone.duration) || 10)
  if (duration >= 43200) return 'month'
  if (duration >= 1440) return 'day'
  return 'minute'
}

function formatWindow(milestone) {
  if (!milestone) return 'No milestone'
  const start = minuteToDate(milestone.startCol)
  const end = minuteToDate(milestone.startCol + milestone.duration)
  return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`
}

function noteTitle(note) {
  return note?.title || 'Untitled'
}

export default function InheritancePage({ notes = [], isActive = false, onNoteOpen }) {
  const [milestones, setMilestones] = useState([])
  const [inheritance, setInheritance] = useState([])
  const [mode, setMode] = useState('minute-day')
  const [error, setError] = useState('')

  const load = () => {
    Promise.all([api.getMilestones(), api.getNoteInheritance()])
      .then(([mss, links]) => { setMilestones(mss); setInheritance(links); setError('') })
      .catch(err => setError(err.message || 'Could not load inheritance'))
  }

  useEffect(() => {
    if (isActive) load()
  }, [isActive])

  const milestoneByNote = useMemo(() => {
    const map = new Map()
    milestones.forEach(ms => {
      if (!map.has(ms.noteId)) map.set(ms.noteId, ms)
    })
    return map
  }, [milestones])

  const noteById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])
  const parentByChild = useMemo(() => new Map(inheritance.map(link => [link.childNoteId, link.parentNoteId])), [inheritance])

  const [childScale, parentScale] = mode === 'minute-day' ? ['minute', 'day'] : ['day', 'month']
  const parentNotes = notes.filter(note => milestoneScale(milestoneByNote.get(note.id)) === parentScale)
  const childNotes = notes.filter(note => milestoneScale(milestoneByNote.get(note.id)) === childScale)
  const assignedChildren = childNotes.filter(note => parentByChild.has(note.id))
  const unassignedChildren = childNotes.filter(note => !parentByChild.has(note.id))

  const assign = async (childId, parentId) => {
    if (!parentId) return
    try {
      const saved = await api.setNoteInheritance(childId, parentId)
      setInheritance(prev => [...prev.filter(link => link.childNoteId !== childId), saved])
      setError('')
    } catch (err) {
      setError(err.message || 'Inheritance could not be assigned')
    }
  }

  const remove = async (childId) => {
    try {
      await api.removeNoteInheritance(childId)
      setInheritance(prev => prev.filter(link => link.childNoteId !== childId))
      setError('')
    } catch (err) {
      setError(err.message || 'Inheritance could not be removed')
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.segmented}>
          <button className={mode === 'minute-day' ? styles.active : ''} onClick={() => setMode('minute-day')}>
            Minutes to Days
          </button>
          <button className={mode === 'day-month' ? styles.active : ''} onClick={() => setMode('day-month')}>
            Days to Months
          </button>
        </div>
        <button className={styles.refreshBtn} onClick={load}>Refresh</button>
        {error && <div className={styles.error}>{error}</div>}
      </div>

      <div className={styles.content}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}>Parent {parentScale} notes</div>
          <div className={styles.parentGrid}>
            {parentNotes.map(parent => {
              const parentMs = milestoneByNote.get(parent.id)
              const children = assignedChildren.filter(child => parentByChild.get(child.id) === parent.id)
              return (
                <article key={parent.id} className={styles.parentCard}>
                  <button className={styles.noteTitle} onClick={() => onNoteOpen?.(parent.id)}>{noteTitle(parent)}</button>
                  <div className={styles.window}>{formatWindow(parentMs)}</div>
                  <div className={styles.childList}>
                    {children.length === 0 && <div className={styles.empty}>No children</div>}
                    {children.map(child => (
                      <div key={child.id} className={styles.childRow}>
                        <button onClick={() => onNoteOpen?.(child.id)}>{noteTitle(child)}</button>
                        <button className={styles.removeBtn} onClick={() => remove(child.id)}>Remove</button>
                      </div>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <aside className={styles.panel}>
          <div className={styles.panelTitle}>Unassigned {childScale} notes</div>
          <div className={styles.unassignedList}>
            {unassignedChildren.length === 0 && <div className={styles.empty}>Nothing to assign</div>}
            {unassignedChildren.map(child => (
              <div key={child.id} className={styles.assignCard}>
                <button className={styles.noteTitle} onClick={() => onNoteOpen?.(child.id)}>{noteTitle(child)}</button>
                <div className={styles.window}>{formatWindow(milestoneByNote.get(child.id))}</div>
                <select defaultValue="" onChange={e => assign(child.id, e.target.value)}>
                  <option value="" disabled>Assign parent...</option>
                  {parentNotes.map(parent => (
                    <option key={parent.id} value={parent.id}>{noteTitle(parent)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
