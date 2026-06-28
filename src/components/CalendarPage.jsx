import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import styles from './CalendarPage.module.css'

const DAY_MINUTES = 24 * 60
const HOUR_HEIGHT = 54
const VIEW_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: 'Month' },
]

function localMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function projectAnchor(project) {
  const raw = project?.createdAt
  if (!raw) return localMidnight()
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return localMidnight()
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function addDays(date, days) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function addMinutes(date, minutes) {
  const next = new Date(date)
  next.setMinutes(next.getMinutes() + minutes)
  return next
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function dayKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function fmtDay(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function fmtMonth(date) {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function overlapsDay(event, day) {
  const start = localMidnight(day)
  const end = addDays(start, 1)
  return event.start < end && event.end > start
}

function rangeLabel(event, day = null) {
  if (!day || isSameDay(event.start, event.end)) return `${fmtTime(event.start)} - ${fmtTime(event.end)}`
  if (isSameDay(event.start, day)) return `${fmtTime(event.start)} - continues`
  if (isSameDay(event.end, day)) return `until ${fmtTime(event.end)}`
  return 'all day'
}

function buildMonthDays(today) {
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const start = addDays(first, -first.getDay())
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}

function colorStyle(color) {
  return {
    '--event-color': color || '#1a73e8',
  }
}

function EventPill({ event, day, compact = false, onNoteOpen }) {
  return (
    <button
      type="button"
      className={`${styles.eventPill} ${compact ? styles.eventPillCompact : ''}`}
      style={colorStyle(event.color)}
      onClick={() => onNoteOpen?.(event.noteId)}
      title={`${event.title} · ${rangeLabel(event, day)}`}
    >
      <span className={styles.eventColor} />
      <span className={styles.eventText}>
        {!compact && <span className={styles.eventTime}>{rangeLabel(event, day)}</span>}
        <span className={styles.eventTitle}>{event.title}</span>
      </span>
    </button>
  )
}

export default function CalendarPage({ notes = [], project = null, isActive = false, onNoteOpen, refreshKey = 0 }) {
  const [view, setView] = useState('today')
  const [timeSlots, setTimeSlots] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    if (!isActive) return
    let alive = true
    setLoading(true)
    setError('')
    api.getTimeSlots()
      .then(data => { if (alive) setTimeSlots(data || []) })
      .catch(err => {
        console.error('Failed to load calendar time slots', err)
        if (alive) setError('Could not load scheduled notes')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [isActive, refreshKey, project?.id])

  useEffect(() => {
    if (!isActive) return
    setClock(new Date())
    const id = window.setInterval(() => setClock(new Date()), 60 * 1000)
    return () => window.clearInterval(id)
  }, [isActive])

  const today = useMemo(() => localMidnight(clock), [clock])
  const now = clock
  const anchor = useMemo(() => projectAnchor(project), [project?.createdAt])
  const notesById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])

  const events = useMemo(() => timeSlots.map(slot => {
    const note = notesById.get(slot.noteId)
    const start = addMinutes(anchor, Number(slot.startCol) || 0)
    const duration = Math.max(1, Number(slot.duration) || 1)
    const end = addMinutes(anchor, (Number(slot.startCol) || 0) + duration)
    return {
      id: slot.id,
      noteId: slot.noteId,
      title: note?.title || slot.title || 'Untitled note',
      color: slot.color || '#1a73e8',
      start,
      end,
    }
  }).sort((a, b) => a.start - b.start), [timeSlots, notesById, anchor])

  const todayEvents = useMemo(() => events.filter(event => overlapsDay(event, today)), [events, today])
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today])
  const monthDays = useMemo(() => buildMonthDays(today), [today])
  const monthEventsByDay = useMemo(() => {
    const map = new Map(monthDays.map(day => [dayKey(day), []]))
    events.forEach(event => {
      monthDays.forEach(day => {
        if (overlapsDay(event, day)) map.get(dayKey(day))?.push(event)
      })
    })
    return map
  }, [events, monthDays])

  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT
  const visibleRange = view === 'today'
    ? fmtDay(today)
    : view === 'week'
      ? `${fmtDay(weekDays[0])} - ${fmtDay(weekDays[6])}`
      : fmtMonth(today)

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <div className={styles.label}>Calendar</div>
          <div className={styles.range}>{visibleRange}</div>
        </div>

        <div className={styles.segmented} aria-label="Calendar view">
          {VIEW_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={`${styles.segment} ${view === option.id ? styles.segmentActive : ''}`}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className={styles.todayChip}>
          <span />
          Today
        </div>
      </div>

      <main className={styles.calendarShell}>
        {error && <div className={styles.status}>{error}</div>}
        {!error && loading && <div className={styles.status}>Loading scheduled notes...</div>}

        {!error && view === 'today' && (
          <section className={styles.todayView} aria-label="Today calendar">
            <div className={styles.todayHeader}>
              <div>
                <span className={styles.todayKicker}>Today</span>
                <strong>{fmtDay(today)}</strong>
              </div>
              <span>{todayEvents.length} scheduled</span>
            </div>
            <div className={styles.dayTimeline} style={{ '--hour-height': `${HOUR_HEIGHT}px` }}>
              <div className={styles.nowLine} style={{ top: `${nowTop}px` }}>
                <span>{fmtTime(now)}</span>
              </div>
              {Array.from({ length: 24 }, (_, hour) => (
                <div className={styles.hourRow} key={hour}>
                  <span>{String(hour).padStart(2, '0')}:00</span>
                </div>
              ))}
              {todayEvents.map(event => {
                const start = Math.max(0, (event.start - today) / 60000)
                const end = Math.min(DAY_MINUTES, (event.end - today) / 60000)
                const top = (start / 60) * HOUR_HEIGHT
                const height = Math.max(30, ((end - start) / 60) * HOUR_HEIGHT)
                return (
                  <button
                    type="button"
                    key={event.id}
                    className={styles.timelineEvent}
                    style={{ ...colorStyle(event.color), top: `${top}px`, height: `${height}px` }}
                    onClick={() => onNoteOpen?.(event.noteId)}
                    title={`${event.title} · ${rangeLabel(event, today)}`}
                  >
                    <span>{rangeLabel(event, today)}</span>
                    <strong>{event.title}</strong>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {!error && view === 'week' && (
          <section className={styles.weekGrid} aria-label="Seven day calendar">
            {weekDays.map(day => {
              const dayEvents = events.filter(event => overlapsDay(event, day))
              return (
                <div key={dayKey(day)} className={`${styles.weekDay} ${isSameDay(day, today) ? styles.todayCell : ''}`}>
                  <div className={styles.dayHeader}>
                    <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    <strong>{day.getDate()}</strong>
                    {isSameDay(day, today) && <em>Today</em>}
                  </div>
                  <div className={styles.eventStack}>
                    {dayEvents.length ? dayEvents.map(event => (
                      <EventPill key={`${dayKey(day)}-${event.id}`} event={event} day={day} onNoteOpen={onNoteOpen} />
                    )) : <span className={styles.emptyDay}>No scheduled notes</span>}
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {!error && view === 'month' && (
          <section className={styles.monthView} aria-label="Month calendar">
            <div className={styles.monthWeekdays}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <span key={day}>{day}</span>)}
            </div>
            <div className={styles.monthGrid}>
              {monthDays.map(day => {
                const dayEvents = monthEventsByDay.get(dayKey(day)) || []
                const visible = dayEvents.slice(0, 3)
                return (
                  <div
                    key={dayKey(day)}
                    className={[
                      styles.monthDay,
                      day.getMonth() !== today.getMonth() ? styles.outsideMonth : '',
                      isSameDay(day, today) ? styles.todayCell : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <div className={styles.monthDayHeader}>
                      <strong>{day.getDate()}</strong>
                      {isSameDay(day, today) && <em>Today</em>}
                    </div>
                    <div className={styles.monthEvents}>
                      {visible.map(event => (
                        <EventPill key={`${dayKey(day)}-${event.id}`} event={event} day={day} compact onNoteOpen={onNoteOpen} />
                      ))}
                      {dayEvents.length > visible.length && (
                        <span className={styles.moreEvents}>+{dayEvents.length - visible.length} more</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
