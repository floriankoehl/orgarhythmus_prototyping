import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { api, projectsApi } from '../api'
import styles from './ProjectDashboard.module.css'
import { playSound } from '../sounds/sound_registry'

const STAT_LABELS = {
  notes:        'Notes',
  timeSlots:   'Time slots',
  dimensions:   'Dimensions',
  categories:   'Categories',
  dependencies: 'Dependencies',
  perspectives: 'Perspectives',
}

const MIN_TIME_SLOT_DURATION = 10
const DAY_MINUTES = 60 * 24
const MONTH_MINUTES = DAY_MINUTES * 30

function timelineAnchor(project) {
  const raw = project?.createdAt ? String(project.createdAt).replace(' ', 'T') : ''
  const parsed = raw ? new Date(raw) : new Date()
  const anchor = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  anchor.setHours(0, 0, 0, 0)
  return anchor
}

function dateAtMinute(anchor, minute) {
  const date = new Date(anchor.getTime())
  date.setMinutes(date.getMinutes() + Math.max(0, Number(minute) || 0))
  return date
}

function scheduleScaleForRange(start, duration) {
  const value = Math.max(MIN_TIME_SLOT_DURATION, Number(duration) || MIN_TIME_SLOT_DURATION)
  if (value < DAY_MINUTES) return 'minute'
  if (value < MONTH_MINUTES) return 'day'
  return 'month'
}

function formatScheduleMoment(anchor, minute, scale) {
  const date = dateAtMinute(anchor, minute)
  if (scale === 'minute') {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  if (scale === 'month') {
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatScheduleDuration(minutes) {
  const value = Math.max(MIN_TIME_SLOT_DURATION, Number(minutes) || MIN_TIME_SLOT_DURATION)
  if (value < 60) return `${value} min`
  if (value < DAY_MINUTES) return `${Number((value / 60).toFixed(value % 60 === 0 ? 0 : 1))} h`
  if (value < MONTH_MINUTES) return `${Number((value / DAY_MINUTES).toFixed(value % DAY_MINUTES === 0 ? 0 : 1))} d`
  return `${Number((value / MONTH_MINUTES).toFixed(value % MONTH_MINUTES === 0 ? 0 : 1))} mo`
}

function collectDescendantNoteIds(notes, rootNoteId) {
  const childrenByParent = new Map()
  notes.forEach(note => {
    if (!note.parentNoteId) return
    if (!childrenByParent.has(note.parentNoteId)) childrenByParent.set(note.parentNoteId, [])
    childrenByParent.get(note.parentNoteId).push(note.id)
  })

  const descendants = new Set()
  const queue = [...(childrenByParent.get(rootNoteId) || [])]
  while (queue.length) {
    const id = queue.shift()
    if (!id || descendants.has(id)) continue
    descendants.add(id)
    queue.push(...(childrenByParent.get(id) || []))
  }
  return descendants
}

function collectAncestorNoteIds(notes, rootNoteId) {
  const notesById = new Map(notes.map(note => [note.id, note]))
  const ancestors = []
  let current = notesById.get(rootNoteId)
  const seen = new Set([rootNoteId])
  while (current?.parentNoteId && !seen.has(current.parentNoteId)) {
    ancestors.push(current.parentNoteId)
    seen.add(current.parentNoteId)
    current = notesById.get(current.parentNoteId)
  }
  return ancestors
}

function buildAncestorPath(notes, noteId) {
  if (!noteId) return []
  const notesById = new Map(notes.map(note => [note.id, note]))
  const path = []
  const seen = new Set()
  let current = notesById.get(noteId)

  while (current && !seen.has(current.id)) {
    path.unshift(current)
    seen.add(current.id)
    current = current.parentNoteId ? notesById.get(current.parentNoteId) : null
  }

  return path
}

function buildWorkspaceHierarchy(notes, noteId) {
  const ancestorPath = buildAncestorPath(notes, noteId)
  if (!ancestorPath.length) return []

  const childrenByParent = new Map()
  notes.forEach(note => {
    if (!note.parentNoteId) return
    if (!childrenByParent.has(note.parentNoteId)) childrenByParent.set(note.parentNoteId, [])
    childrenByParent.get(note.parentNoteId).push(note)
  })
  childrenByParent.forEach(children => children.sort((a, b) => {
    const aOrder = a.orderIdx ?? a.order_idx ?? Number.MIN_SAFE_INTEGER
    const bOrder = b.orderIdx ?? b.order_idx ?? Number.MIN_SAFE_INTEGER
    // The ancestor path is rendered separately above. Within every project,
    // show the most recently added child notes first (new notes receive the
    // highest sibling order index).
    if (aOrder !== bOrder) return bOrder - aOrder
    return String(a.title || '').localeCompare(String(b.title || ''))
  }))

  const rows = ancestorPath.map((note, depth) => ({
    note,
    depth,
    relation: note.id === noteId ? 'current' : 'ancestor',
    hasChildren: (childrenByParent.get(note.id) || []).length > 0,
  }))
  const seen = new Set(ancestorPath.map(note => note.id))
  const visitChildren = (parentId, depth) => {
    ;(childrenByParent.get(parentId) || []).forEach(child => {
      if (seen.has(child.id)) return
      seen.add(child.id)
      rows.push({
        note: child,
        depth,
        relation: depth === ancestorPath.length ? 'child' : 'descendant',
        hasChildren: (childrenByParent.get(child.id) || []).length > 0,
      })
      visitChildren(child.id, depth + 1)
    })
  }
  visitChildren(noteId, ancestorPath.length)
  return rows
}

function windowFromSlots(slots) {
  if (!slots.length) return null
  const start = Math.min(...slots.map(slot => Math.max(0, Number(slot.startCol) || 0)))
  const end = Math.max(...slots.map(slot => {
    const slotStart = Math.max(0, Number(slot.startCol) || 0)
    return slotStart + Math.max(MIN_TIME_SLOT_DURATION, Number(slot.duration) || MIN_TIME_SLOT_DURATION)
  }))
  return { start, end, duration: Math.max(MIN_TIME_SLOT_DURATION, end - start) }
}

function deriveWorkspaceWindow({ project, notes, timeSlots, rootNoteId }) {
  if (!rootNoteId) return null

  const ownSlots = timeSlots.filter(slot => slot.noteId === rootNoteId)
  const descendantIds = collectDescendantNoteIds(notes, rootNoteId)
  const descendantSlots = timeSlots.filter(slot => descendantIds.has(slot.noteId))
  const nearestAncestorSlot = collectAncestorNoteIds(notes, rootNoteId)
    .map(noteId => timeSlots.find(slot => slot.noteId === noteId))
    .find(Boolean)
  const sourceSlots = ownSlots.length ? ownSlots : (descendantSlots.length ? descendantSlots : (nearestAncestorSlot ? [nearestAncestorSlot] : []))

  if (!sourceSlots.length) return null

  const sourceWindow = windowFromSlots(sourceSlots)
  const { start, end, duration } = sourceWindow
  const scale = sourceSlots.reduce((largest, slot) => {
    const current = scheduleScaleForRange(slot.startCol, slot.duration)
    const rank = { minute: 0, day: 1, month: 2 }
    return rank[current] > rank[largest] ? current : largest
  }, scheduleScaleForRange(start, duration))
  const anchor = timelineAnchor(project)

  return {
    start,
    end,
    duration,
    scale,
    source: ownSlots.length ? 'own' : (descendantSlots.length ? 'children' : 'ancestor'),
    startLabel: formatScheduleMoment(anchor, start, scale),
    endLabel: formatScheduleMoment(anchor, end, scale),
    durationLabel: formatScheduleDuration(duration),
  }
}

function StatCard({ label, value }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue}>{value ?? '—'}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function HierarchyTypeIcon({ hasChildren }) {
  if (hasChildren) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        <path d="M3.5 9h17" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5h8l4 4V20H6z" />
      <path d="M14 3.5V8h4" />
      <path d="M9 12h6M9 15.5h6" />
    </svg>
  )
}

export default function ProjectDashboard({ project, notes = [], workspaceRootNote = null, workspaceNote = null, onUpdate, onWorkspaceNoteUpdated, onWorkspaceOpen, onNotesChanged, isActive }) {
  const isNoteWorkspace = Boolean(workspaceNote)
  const workspaceName = workspaceNote?.title || project.name
  const workspaceDesc = workspaceNote?.html || project.description || ''
  const [name,        setName]        = useState(workspaceName)
  const [desc,        setDesc]        = useState(workspaceDesc)
  const [stats,       setStats]       = useState(null)
  const [timeSlots,   setTimeSlots]   = useState([])
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [draftDesc,   setDraftDesc]   = useState(workspaceDesc)
  const [exporting,   setExporting]   = useState(false)
  const [showAllDescendants, setShowAllDescendants] = useState(false)
  const [draggedHierarchyNoteId, setDraggedHierarchyNoteId] = useState(null)
  const [hierarchyDropTargetId, setHierarchyDropTargetId] = useState(null)
  const [hierarchyWarning, setHierarchyWarning] = useState(null)
  const nameInputRef = useRef()
  const saveTimerRef = useRef(null)
  const hierarchyWarningTimerRef = useRef(null)
  const workspaceRootNoteId = workspaceRootNote?.id || project.rootNoteId || null
  const scheduleWindow = useMemo(() => (
    deriveWorkspaceWindow({ project, notes, timeSlots, rootNoteId: workspaceRootNoteId })
  ), [project, notes, timeSlots, workspaceRootNoteId])
  const hierarchyRows = useMemo(
    () => buildWorkspaceHierarchy(notes, workspaceRootNoteId),
    [notes, workspaceRootNoteId],
  )
  const hasNestedDescendants = hierarchyRows.some(row => row.relation === 'descendant')
  const visibleHierarchyRows = showAllDescendants
    ? hierarchyRows
    : hierarchyRows.filter(row => row.relation !== 'descendant')

  useEffect(() => {
    setName(workspaceName)
    setDesc(workspaceDesc)
    setDraftDesc(workspaceDesc)
  }, [project.id, workspaceNote?.id, workspaceName, workspaceDesc]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setShowAllDescendants(false)
  }, [project.id, workspaceRootNoteId])

  useEffect(() => () => {
    if (hierarchyWarningTimerRef.current) window.clearTimeout(hierarchyWarningTimerRef.current)
  }, [])

  const showHierarchyWarning = useCallback((title, message) => {
    if (hierarchyWarningTimerRef.current) window.clearTimeout(hierarchyWarningTimerRef.current)
    setHierarchyWarning({ title, message })
    hierarchyWarningTimerRef.current = window.setTimeout(() => {
      setHierarchyWarning(null)
      hierarchyWarningTimerRef.current = null
    }, 4500)
  }, [])

  const moveHierarchyNote = useCallback(async (noteId, parentNoteId) => {
    if (!noteId || !parentNoteId || noteId === project.rootNoteId) return
    const note = notes.find(item => item.id === noteId)
    const parent = notes.find(item => item.id === parentNoteId)
    if (!note || !parent || note.parentNoteId === parentNoteId) return

    const descendants = new Set()
    const pending = [noteId]
    while (pending.length) {
      const currentId = pending.pop()
      notes.forEach(item => {
        if (item.parentNoteId !== currentId || descendants.has(item.id)) return
        descendants.add(item.id)
        pending.push(item.id)
      })
    }
    if (noteId === parentNoteId || descendants.has(parentNoteId)) {
      showHierarchyWarning('Note move blocked', 'A note cannot be moved into itself or one of its own descendants.')
      return
    }

    try {
      await api.updateNote(noteId, { parentNoteId })
    } catch (error) {
      console.error(error)
      const type = error?.detail?.type
      const title = type === 'inheritance_deadline'
        ? 'Hard deadline'
        : type === 'inheritance_earliest_start'
          ? 'Earliest start date'
          : type === 'inheritance_window' || type === 'inheritance_scale_mismatch'
            ? 'Time slot conflict'
            : 'Note move blocked'
      showHierarchyWarning(title, error?.message || 'This note cannot be moved to the selected project.')
      return
    }

    playSound('noteMove')
    await onNotesChanged?.().catch(error => console.error('Note moved, but hierarchy refresh failed', error))
  }, [notes, onNotesChanged, project.rootNoteId, showHierarchyWarning])

  useEffect(() => {
    if (isActive) {
      projectsApi.getProjectStats(project.id).then(setStats).catch(console.error)
    }
  }, [project.id, isActive])

  useEffect(() => {
    let cancelled = false
    if (!isActive) return undefined
    api.getTimeSlots()
      .then(items => { if (!cancelled) setTimeSlots(items) })
      .catch(console.error)
    return () => { cancelled = true }
  }, [project.id, isActive])

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus()
  }, [editingName])

  const persist = useCallback((patch) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      if (isNoteWorkspace) {
        const notePatch = {}
        if (patch.name !== undefined) notePatch.title = patch.name
        if (patch.description !== undefined) notePatch.html = patch.description
        const updated = await api.updateNote(workspaceNote.id, notePatch)
        onWorkspaceNoteUpdated?.(updated.id, updated)
      } else {
        const updated = await projectsApi.updateProject(project.id, patch)
        onUpdate(updated)
      }
    }, 400)
  }, [isNoteWorkspace, project.id, workspaceNote?.id, onUpdate, onWorkspaceNoteUpdated])

  const handleNameBlur = () => {
    setEditingName(false)
    const trimmed = name.trim() || workspaceName
    setName(trimmed)
    if (trimmed !== workspaceName) { playSound('projectNameSave'); persist({ name: trimmed }) }
  }

  const handleNameKey = e => {
    if (e.key === 'Enter' || e.key === 'Escape') nameInputRef.current?.blur()
  }

  const handleDescSave = () => {
    setDesc(draftDesc)
    setEditingDesc(false)
    playSound('projectDescriptionSave')
    persist({ description: draftDesc })
  }

  const handleDescCancel = () => {
    setDraftDesc(desc)
    setEditingDesc(false)
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const data = await projectsApi.exportDatabase(project.id)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const date = new Date().toISOString().split('T')[0]
      a.download = `orgarythmus_${date}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      playSound('projectSnapshotSave')
    } catch (e) {
      console.error('Export failed', e)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className={styles.note}>
      <div className={styles.content}>

        {/* Project name */}
        <div className={styles.nameRow}>
          {editingName ? (
            <input
              ref={nameInputRef}
              className={styles.nameInput}
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKey}
            />
          ) : (
            <h1 className={styles.projectName} onClick={() => setEditingName(true)} title="Click to edit">
              {name}
              <span className={styles.nameEditIcon}>✎</span>
            </h1>
          )}
        </div>

        {/* Note-as-project ancestry */}
        {hierarchyRows.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <label className={styles.sectionLabel}>Hierarchy</label>
              {hasNestedDescendants && (
                <button
                  type="button"
                  className={styles.hierarchyToggle}
                  onClick={() => setShowAllDescendants(value => !value)}>
                  {showAllDescendants ? 'Show direct children' : 'Show all descendants'}
                </button>
              )}
            </div>
            <div className={styles.hierarchyTree} role="tree" aria-label="Project, ancestors, and child notes">
              {visibleHierarchyRows.map(({ note: hierarchyNote, depth, hasChildren }) => {
                const ancestor = hierarchyNote
                const isCurrent = ancestor.id === workspaceRootNoteId
                const isProjectRoot = ancestor.id === project.rootNoteId
                const displayTitle = isProjectRoot ? project.name : ancestor.title
                return (
                  <div
                    key={ancestor.id}
                    className={[
                      styles.hierarchyRow,
                      isCurrent && styles.hierarchyRowCurrent,
                      hierarchyDropTargetId === ancestor.id && draggedHierarchyNoteId !== ancestor.id && styles.hierarchyRowDropTarget,
                      draggedHierarchyNoteId === ancestor.id && styles.hierarchyRowDragging,
                    ].filter(Boolean).join(' ')}
                    style={{ '--tree-depth': depth }}
                    role="treeitem"
                    aria-current={isCurrent ? 'page' : undefined}
                    aria-level={depth + 1}
                    draggable={!isProjectRoot}
                    onDragStart={event => {
                      if (isProjectRoot) return
                      event.dataTransfer.setData('project-hierarchy-note-id', ancestor.id)
                      event.dataTransfer.effectAllowed = 'move'
                      setDraggedHierarchyNoteId(ancestor.id)
                    }}
                    onDragOver={event => {
                      if (!event.dataTransfer.types.includes('project-hierarchy-note-id')) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setHierarchyDropTargetId(ancestor.id)
                    }}
                    onDragLeave={event => {
                      if (!event.currentTarget.contains(event.relatedTarget)) {
                        setHierarchyDropTargetId(current => current === ancestor.id ? null : current)
                      }
                    }}
                    onDrop={event => {
                      event.preventDefault()
                      const movedNoteId = event.dataTransfer.getData('project-hierarchy-note-id')
                      setHierarchyDropTargetId(null)
                      setDraggedHierarchyNoteId(null)
                      moveHierarchyNote(movedNoteId, ancestor.id)
                    }}
                    onDragEnd={() => {
                      setHierarchyDropTargetId(null)
                      setDraggedHierarchyNoteId(null)
                    }}>
                    <span className={styles.hierarchyBranch} aria-hidden="true" />
                    <button
                      type="button"
                      className={styles.hierarchyNode}
                      aria-disabled={isCurrent}
                      onClick={() => { if (!isCurrent) onWorkspaceOpen?.(ancestor.id) }}
                      title={isCurrent ? `Current ${hasChildren ? 'project' : 'note'}` : `Open ${displayTitle || 'Untitled'}`}>
                      <span
                        className={`${styles.hierarchyIcon} ${hasChildren ? styles.hierarchyProjectIcon : styles.hierarchyNoteIcon}`}
                        title={hasChildren ? 'Project · contains child notes' : 'Note · no child notes'}>
                        <HierarchyTypeIcon hasChildren={hasChildren} />
                      </span>
                      <span className={styles.hierarchyTitle}>{displayTitle || 'Untitled'}</span>
                      <span className={styles.hierarchyKind}>
                        {hasChildren ? 'Project' : 'Note'}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Overview</label>
          <div className={styles.statsGrid}>
            {Object.entries(STAT_LABELS).map(([key, label]) => (
              <StatCard key={key} label={label} value={stats?.[key]} />
            ))}
          </div>
        </div>

        {/* Timeline dates */}
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Timeline</label>
          {scheduleWindow ? (
            <div className={styles.dateRow}>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>Start time</label>
                <div className={styles.dateReadOnly}>{scheduleWindow.startLabel}</div>
              </div>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>End time</label>
                <div className={styles.dateReadOnly}>{scheduleWindow.endLabel}</div>
              </div>
              <div className={styles.dateField}>
                <label className={styles.dateLabel}>Duration</label>
                <div className={styles.dateReadOnly}>{scheduleWindow.durationLabel}</div>
              </div>
              <div className={styles.timelineSource}>
                {scheduleWindow.source === 'own'
                  ? 'Uses this project note time slot.'
                  : scheduleWindow.source === 'children'
                    ? 'Inherited from scheduled child notes.'
                    : 'Inherited from the closest scheduled parent project.'}
              </div>
            </div>
          ) : (
            <p className={styles.descText}>No scheduled time yet.</p>
          )}
        </div>

        {/* Description */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <label className={styles.sectionLabel}>Description</label>
            {!editingDesc && (
              <button className={styles.editBtn} onClick={() => { setDraftDesc(desc); setEditingDesc(true) }}>
                Edit
              </button>
            )}
          </div>
          {editingDesc ? (
            <div className={styles.descEditBlock}>
              <textarea
                className={styles.descTextarea}
                value={draftDesc}
                onChange={e => setDraftDesc(e.target.value)}
                placeholder="Add a description for this project…"
                rows={4}
                autoFocus
              />
              <div className={styles.descActions}>
                <button className={styles.descCancel} onClick={handleDescCancel}>Cancel</button>
                <button className={styles.descSave} onClick={handleDescSave}>Save</button>
              </div>
            </div>
          ) : (
            <p className={styles.descText}>
              {desc || <span className={styles.descPlaceholder}>No description yet.</span>}
            </p>
          )}
        </div>

        {/* Footer row: export */}
        <div className={styles.footerRow}>
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            disabled={exporting}
            title="Download a JSON snapshot of this project"
          >
            {exporting ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>

      </div>

      {hierarchyWarning && (
        <div className={styles.hierarchyWarning} role="alert">
          <button
            type="button"
            className={styles.hierarchyWarningClose}
            aria-label="Close warning"
            onClick={() => setHierarchyWarning(null)}>×</button>
          <strong>{hierarchyWarning.title}</strong>
          <span>{hierarchyWarning.message}</span>
        </div>
      )}
    </div>
  )
}
