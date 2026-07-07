import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { api, projectsApi } from '../api'
import styles from './ProjectDashboard.module.css'
import { playSound } from '../sounds/sound_registry'
import { useConfirmDialog } from './ConfirmDialog'
import NoteHierarchyTree, { buildNoteHierarchyRows } from './NoteHierarchyTree'
import StandardColorPicker from './StandardColorPicker'
import { COLOR_UNASSIGNED_CATEGORY_ID } from './colorPickerCategories'

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

function formatHierarchyCreatedAt(value) {
  if (!value) return ''
  const date = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function descriptionText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
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

function collectDescendantIdsForNote(notes, noteId) {
  const descendants = new Set()
  const pending = [noteId]
  while (pending.length) {
    const currentId = pending.pop()
    notes.forEach(note => {
      if (note.parentNoteId !== currentId || descendants.has(note.id)) return
      descendants.add(note.id)
      pending.push(note.id)
    })
  }
  return descendants
}

function compareHierarchyNoteOrder(a, b) {
  const aOrder = a.orderIdx ?? a.order_idx ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.orderIdx ?? b.order_idx ?? Number.MAX_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  return String(a.title || '').localeCompare(String(b.title || ''))
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

function makeColorCursor(color) {
  const safeColor = /^#[0-9a-f]{3,8}$/i.test(String(color)) ? color : '#1a73e8'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="${safeColor}" stroke="white" stroke-width="2"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`
}

export default function ProjectDashboard({ project, notes = [], workspaceRootNote = null, workspaceNote = null, onUpdate, onWorkspaceNoteUpdated, onWorkspaceOpen, onNoteOpen, onNotesChanged, onProjectDeleted, isActive, structureOnly = false }) {
  const isNoteWorkspace = Boolean(workspaceNote)
  const workspaceName = workspaceNote?.title || project.name
  const workspaceDesc = isNoteWorkspace ? (workspaceNote?.html ?? '') : (project.description || '')
  const [name,        setName]        = useState(workspaceName)
  const [desc,        setDesc]        = useState(workspaceDesc)
  const [stats,       setStats]       = useState(null)
  const [timeSlots,   setTimeSlots]   = useState([])
  const [overviewScopeData, setOverviewScopeData] = useState({
    assignments: [],
    dependencies: [],
  })
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [draftDesc,   setDraftDesc]   = useState(descriptionText(workspaceDesc))
  const [exporting,   setExporting]   = useState(false)
  const [descendantDepth, setDescendantDepth] = useState(1)
  const [expandedHierarchyNoteIds, setExpandedHierarchyNoteIds] = useState(() => new Set())
  const [collapsedHierarchyNoteIds, setCollapsedHierarchyNoteIds] = useState(() => new Set())
  const [draggedHierarchyNoteIds, setDraggedHierarchyNoteIds] = useState(() => new Set())
  const [hierarchyDropTargetId, setHierarchyDropTargetId] = useState(null)
  const [hierarchyReorderDragId, setHierarchyReorderDragId] = useState(null)
  const [hierarchyReorderTarget, setHierarchyReorderTarget] = useState(null)
  const [hierarchyWarning, setHierarchyWarning] = useState(null)
  const [hierarchyContextMenu, setHierarchyContextMenu] = useState(null)
  const [selectedHierarchyNoteIds, setSelectedHierarchyNoteIds] = useState(() => new Set())
  const [newNoteDraft, setNewNoteDraft] = useState(null)
  const [creatingHierarchyNote, setCreatingHierarchyNote] = useState(false)
  const [structureDimensions, setStructureDimensions] = useState([])
  const [structureCategories, setStructureCategories] = useState([])
  const [structureAssignments, setStructureAssignments] = useState([])
  const [structureColorDimId, setStructureColorDimId] = useState('')
  const [structurePaintCat, setStructurePaintCat] = useState(null)
  const [structureColorExpanded, setStructureColorExpanded] = useState(false)
  const nameInputRef = useRef()
  const saveTimerRef = useRef(null)
  const hierarchyWarningTimerRef = useRef(null)
  const { confirm: confirmDialog, dialog: confirmDialogNode } = useConfirmDialog()
  const workspaceRootNoteId = workspaceRootNote?.id || project.rootNoteId || null
  const workspaceDescendantNoteIds = useMemo(
    () => workspaceRootNoteId ? collectDescendantNoteIds(notes, workspaceRootNoteId) : new Set(),
    [notes, workspaceRootNoteId],
  )
  const workspaceScopeNoteIds = useMemo(
    () => new Set(workspaceRootNoteId ? [workspaceRootNoteId, ...workspaceDescendantNoteIds] : []),
    [workspaceDescendantNoteIds, workspaceRootNoteId],
  )
  const scopedStats = useMemo(() => {
    if (!isNoteWorkspace) return null
    const scopedTimeSlots = timeSlots.filter(slot => workspaceScopeNoteIds.has(slot.noteId))
    const scopedTimeSlotIds = new Set(scopedTimeSlots.map(slot => slot.id))
    const scopedAssignments = overviewScopeData.assignments.filter(assignment => workspaceScopeNoteIds.has(assignment.noteId))
    return {
      notes: workspaceDescendantNoteIds.size,
      timeSlots: scopedTimeSlots.length,
      dimensions: new Set(scopedAssignments.map(assignment => assignment.dimensionId)).size,
      categories: new Set(scopedAssignments.map(assignment => assignment.categoryId)).size,
      dependencies: overviewScopeData.dependencies.filter(dep => scopedTimeSlotIds.has(dep.fromId) && scopedTimeSlotIds.has(dep.toId)).length,
      perspectives: 0,
    }
  }, [isNoteWorkspace, overviewScopeData, timeSlots, workspaceDescendantNoteIds, workspaceScopeNoteIds])
  const displayedStats = scopedStats || stats
  const scheduleWindow = useMemo(() => (
    deriveWorkspaceWindow({ project, notes, timeSlots, rootNoteId: workspaceRootNoteId })
  ), [project, notes, timeSlots, workspaceRootNoteId])
  const hierarchyRows = useMemo(
    () => buildNoteHierarchyRows(notes, workspaceRootNoteId, { includeAncestors: !structureOnly }),
    [notes, structureOnly, workspaceRootNoteId],
  )
  const currentHierarchyDepth = hierarchyRows.find(row => row.relation === 'current')?.depth ?? 0
  const localHierarchyBaseDepth = Math.max(0, currentHierarchyDepth - 1)
  const hierarchyDepthById = useMemo(
    () => new Map(hierarchyRows.map(row => [row.note.id, row.depth])),
    [hierarchyRows],
  )
  const notesById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes])
  const isHierarchyNodeExpanded = useCallback(noteId => {
    if (collapsedHierarchyNoteIds.has(noteId)) return false
    if (expandedHierarchyNoteIds.has(noteId)) return true
    const nodeDepth = hierarchyDepthById.get(noteId)
    if (nodeDepth === undefined || nodeDepth < currentHierarchyDepth) return false
    const hopsBelowCurrent = nodeDepth - currentHierarchyDepth
    return descendantDepth === 'all' || hopsBelowCurrent < descendantDepth
  }, [collapsedHierarchyNoteIds, currentHierarchyDepth, descendantDepth, expandedHierarchyNoteIds, hierarchyDepthById])
  const visibleHierarchyRows = hierarchyRows.filter(row => {
    if (row.relation === 'current') return true
    if (row.relation === 'ancestor') return row.depth === currentHierarchyDepth - 1
    const seen = new Set()
    let parentId = row.note.parentNoteId
    while (parentId && parentId !== workspaceRootNoteId && !seen.has(parentId)) {
      seen.add(parentId)
      if (!isHierarchyNodeExpanded(parentId)) return false
      parentId = notesById.get(parentId)?.parentNoteId || null
    }
    return parentId === workspaceRootNoteId && isHierarchyNodeExpanded(workspaceRootNoteId)
  })
  const structureColorByNoteId = useMemo(() => {
    if (!structureColorDimId) return {}
    const categoriesById = new Map(structureCategories.map(category => [category.id, category]))
    const colors = {}
    structureAssignments.forEach(assignment => {
      if (assignment.dimensionId !== structureColorDimId) return
      const color = categoriesById.get(assignment.categoryId)?.color
      if (color) colors[assignment.noteId] = color
    })
    return colors
  }, [structureAssignments, structureCategories, structureColorDimId])
  const structurePaintCursor = structurePaintCat ? makeColorCursor(structurePaintCat.color) : ''

  useEffect(() => {
    setName(workspaceName)
    setDesc(workspaceDesc)
    setDraftDesc(descriptionText(workspaceDesc))
  }, [project.id, workspaceNote?.id, workspaceName, workspaceDesc]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDescendantDepth(1)
    setExpandedHierarchyNoteIds(new Set())
    setCollapsedHierarchyNoteIds(new Set())
    setSelectedHierarchyNoteIds(new Set())
    setHierarchyReorderDragId(null)
    setHierarchyReorderTarget(null)
  }, [project.id, workspaceRootNoteId])

  useEffect(() => {
    const visibleIds = new Set(visibleHierarchyRows.map(row => row.note.id))
    setSelectedHierarchyNoteIds(previous => {
      const next = new Set([...previous].filter(id => visibleIds.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [visibleHierarchyRows])

  const changeDescendantDepth = useCallback(value => {
    setDescendantDepth(value)
    setExpandedHierarchyNoteIds(new Set())
    setCollapsedHierarchyNoteIds(new Set())
  }, [])

  const cycleDescendantDepth = useCallback(deltaY => {
    const options = [1, 2, 3, 'all']
    const currentIndex = Math.max(0, options.findIndex(option => option === descendantDepth))
    const direction = deltaY > 0 ? 1 : -1
    changeDescendantDepth(options[(currentIndex + direction + options.length) % options.length])
  }, [changeDescendantDepth, descendantDepth])

  const hierarchyDescendantIds = useCallback(noteId => collectDescendantIdsForNote(notes, noteId), [notes])

  const toggleHierarchyNode = useCallback(noteId => {
    const currentlyExpanded = isHierarchyNodeExpanded(noteId)
    const descendantIds = hierarchyDescendantIds(noteId)
    setExpandedHierarchyNoteIds(previous => {
      const next = new Set(previous)
      descendantIds.forEach(id => next.delete(id))
      if (currentlyExpanded) next.delete(noteId)
      else next.add(noteId)
      return next
    })
    setCollapsedHierarchyNoteIds(previous => {
      const next = new Set(previous)
      descendantIds.forEach(id => next.delete(id))
      if (currentlyExpanded) next.add(noteId)
      else next.delete(noteId)
      return next
    })
  }, [hierarchyDescendantIds, isHierarchyNodeExpanded])

  const expandHierarchySubtree = useCallback(noteId => {
    const ids = new Set([noteId, ...hierarchyDescendantIds(noteId)])
    setCollapsedHierarchyNoteIds(previous => {
      const next = new Set(previous)
      ids.forEach(id => next.delete(id))
      return next
    })
    setExpandedHierarchyNoteIds(previous => new Set([...previous, ...ids]))
    playSound('collapseToggle')
  }, [hierarchyDescendantIds])

  useEffect(() => () => {
    if (hierarchyWarningTimerRef.current) window.clearTimeout(hierarchyWarningTimerRef.current)
  }, [])

  useEffect(() => {
    if (!hierarchyContextMenu) return undefined
    const close = () => setHierarchyContextMenu(null)
    const onKeyDown = event => { if (event.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [hierarchyContextMenu])

  const showHierarchyWarning = useCallback((title, message) => {
    if (hierarchyWarningTimerRef.current) window.clearTimeout(hierarchyWarningTimerRef.current)
    setHierarchyWarning({ title, message })
    hierarchyWarningTimerRef.current = window.setTimeout(() => {
      setHierarchyWarning(null)
      hierarchyWarningTimerRef.current = null
    }, 4500)
  }, [])

  const moveHierarchyNotes = useCallback(async (noteIds, parentNoteId) => {
    const requestedIds = Array.isArray(noteIds) ? noteIds : [noteIds]
    const uniqueIds = [...new Set(requestedIds)].filter(noteId => noteId && noteId !== project.rootNoteId)
    if (!uniqueIds.length || !parentNoteId) return
    const parent = notes.find(item => item.id === parentNoteId)
    if (!parent) return

    const topLevelIds = uniqueIds.filter(noteId => {
      const note = notes.find(item => item.id === noteId)
      if (!note) return false
      return !uniqueIds.some(otherId => otherId !== noteId && collectDescendantIdsForNote(notes, otherId).has(noteId))
    })
    const movableIds = topLevelIds.filter(noteId => notes.find(item => item.id === noteId)?.parentNoteId !== parentNoteId)
    if (!movableIds.length) return

    const blockedByTarget = movableIds.some(noteId => {
      const descendants = collectDescendantIdsForNote(notes, noteId)
      return noteId === parentNoteId || descendants.has(parentNoteId)
    })
    if (blockedByTarget) {
      showHierarchyWarning('Note move blocked', 'A note cannot be moved into itself or one of its own descendants.')
      return
    }

    try {
      await Promise.all(movableIds.map(noteId => api.updateNote(noteId, { parentNoteId })))
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
      showHierarchyWarning(title, error?.message || 'The selected notes cannot be moved to the selected project.')
      return
    }

    playSound('noteMove')
    await onNotesChanged?.().catch(error => console.error('Note moved, but hierarchy refresh failed', error))
  }, [notes, onNotesChanged, project.rootNoteId, showHierarchyWarning])

  const reorderHierarchyNote = useCallback(async (noteId, targetNoteId, position = 'before') => {
    if (!noteId || !targetNoteId || noteId === targetNoteId) return
    const note = notes.find(item => item.id === noteId)
    const target = notes.find(item => item.id === targetNoteId)
    if (!note || !target) return
    if (note.id === project.rootNoteId || note.id === workspaceRootNoteId) return
    if (target.id === project.rootNoteId || target.id === workspaceRootNoteId) return
    if ((note.parentNoteId || '') !== (target.parentNoteId || '')) {
      showHierarchyWarning('Reorder blocked', 'The reorder handle only changes order inside the current parent note.')
      return
    }
    const siblings = notes
      .filter(item => (item.parentNoteId || '') === (note.parentNoteId || ''))
      .sort(compareHierarchyNoteOrder)
    const fromIdx = siblings.findIndex(item => item.id === noteId)
    const targetIdx = siblings.findIndex(item => item.id === targetNoteId)
    if (fromIdx === -1 || targetIdx === -1) return
    const reordered = [...siblings]
    reordered.splice(fromIdx, 1)
    const targetAfterRemovalIdx = reordered.findIndex(item => item.id === targetNoteId)
    if (targetAfterRemovalIdx === -1) return
    reordered.splice(position === 'after' ? targetAfterRemovalIdx + 1 : targetAfterRemovalIdx, 0, note)
    if (reordered.every((item, index) => item.id === siblings[index]?.id)) return
    try {
      await api.reorderNotes(reordered.map(item => item.id))
      playSound('noteMove')
      await onNotesChanged?.()
    } catch (error) {
      console.error(error)
      showHierarchyWarning('Reorder failed', error?.message || 'The note order could not be saved.')
    }
  }, [notes, onNotesChanged, project.rootNoteId, showHierarchyWarning, workspaceRootNoteId])

  const deleteHierarchyProject = useCallback(async noteToDelete => {
    if (!noteToDelete) return
    const isProjectRoot = noteToDelete.id === project.rootNoteId
    const descendantIds = new Set()
    const pending = [noteToDelete.id]
    while (pending.length) {
      const parentId = pending.pop()
      notes.forEach(note => {
        if (note.parentNoteId !== parentId || descendantIds.has(note.id)) return
        descendantIds.add(note.id)
        pending.push(note.id)
      })
    }
    const descendants = notes.filter(note => descendantIds.has(note.id))
    const displayName = isProjectRoot ? project.name : noteToDelete.title || 'Untitled'
    const confirmed = await confirmDialog({
      title: `Delete project “${displayName}”?`,
      message: isProjectRoot
        ? 'This moves the entire project into the global archive, including every note, time slot, deadline, dimension, relationship, and perspective. It can be restored later.'
        : `This deletes this project and all ${descendants.length} descendant note${descendants.length === 1 ? '' : 's'}, including their schedules and relationships, as one undoable transaction.`,
      items: descendants.map(note => note.title || 'Untitled'),
      emptyText: isProjectRoot ? 'The complete project will be removed.' : 'This project has no descendant notes.',
      confirmLabel: 'Delete project',
    })
    if (!confirmed) return

    try {
      if (isProjectRoot) {
        await projectsApi.deleteProject(project.id)
        playSound('projectDelete')
        onProjectDeleted?.()
        return
      }

      const deletesCurrentWorkspace = noteToDelete.id === workspaceRootNoteId || descendantIds.has(workspaceRootNoteId)
      const fallbackWorkspaceId = noteToDelete.parentNoteId || project.rootNoteId
      await api.deleteNoteTree(noteToDelete.id)
      playSound('projectDelete')
      if (deletesCurrentWorkspace) onWorkspaceOpen?.(fallbackWorkspaceId)
      await onNotesChanged?.()
    } catch (error) {
      console.error(error)
      showHierarchyWarning('Project not deleted', error?.message || 'The project could not be deleted.')
    }
  }, [confirmDialog, notes, onNotesChanged, onProjectDeleted, onWorkspaceOpen, project.id, project.name, project.rootNoteId, showHierarchyWarning, workspaceRootNoteId])

  const deleteHierarchyNote = useCallback(async noteToDelete => {
    if (!noteToDelete || noteToDelete.id === project.rootNoteId) return
    const displayName = noteToDelete.title || 'Untitled'
    const confirmed = await confirmDialog({
      title: `Delete note “${displayName}”?`,
      message: 'This deletes the note, its schedule, deadlines, assignments, and relationships as one undoable transaction.',
      confirmLabel: 'Delete note',
    })
    if (!confirmed) return

    try {
      const deletesCurrentWorkspace = noteToDelete.id === workspaceRootNoteId
      const fallbackWorkspaceId = noteToDelete.parentNoteId || project.rootNoteId
      await api.deleteNote(noteToDelete.id)
      playSound('noteDelete')
      if (deletesCurrentWorkspace) onWorkspaceOpen?.(fallbackWorkspaceId)
      await onNotesChanged?.()
    } catch (error) {
      console.error(error)
      showHierarchyWarning('Note not deleted', error?.message || 'The note could not be deleted.')
    }
  }, [confirmDialog, onNotesChanged, onWorkspaceOpen, project.rootNoteId, showHierarchyWarning, workspaceRootNoteId])

  const createHierarchyNote = useCallback(async (parentNoteId, title) => {
    const parent = notes.find(note => note.id === parentNoteId)
    const trimmedTitle = String(title || '').trim()
    if (!parent || !trimmedTitle) return null
    try {
      const created = await api.createNote({
        id: crypto.randomUUID(),
        parentNoteId,
        title: trimmedTitle,
        html: '',
        collapsed: false,
      })
      playSound('noteCreate')
      setExpandedHierarchyNoteIds(previous => new Set([...previous, parentNoteId]))
      setCollapsedHierarchyNoteIds(previous => {
        const next = new Set(previous)
        next.delete(parentNoteId)
        return next
      })
      await onNotesChanged?.()
      onNoteOpen?.(created.id)
      return created
    } catch (error) {
      console.error(error)
      showHierarchyWarning('Note not created', error?.message || 'The note could not be created here.')
      return null
    }
  }, [notes, onNoteOpen, onNotesChanged, showHierarchyWarning])

  const submitNewHierarchyNote = useCallback(async () => {
    if (!newNoteDraft?.title?.trim() || creatingHierarchyNote) return
    setCreatingHierarchyNote(true)
    const created = await createHierarchyNote(newNoteDraft.parentNoteId, newNoteDraft.title)
    setCreatingHierarchyNote(false)
    if (created) setNewNoteDraft(null)
  }, [createHierarchyNote, creatingHierarchyNote, newNoteDraft])

  const openHierarchyContextMenu = useCallback((event, noteId) => {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 210
    const menuHeight = 126
    setHierarchyContextMenu({
      noteId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    })
    setSelectedHierarchyNoteIds(previous => previous.has(noteId) ? previous : new Set([noteId]))
    playSound('projectMenuOpen')
  }, [])

  const handleHierarchyNodeClick = useCallback((event, noteId) => {
    event.stopPropagation()
    if (event.ctrlKey || event.metaKey) {
      setSelectedHierarchyNoteIds(previous => {
        const next = new Set(previous)
        if (next.has(noteId)) {
          next.delete(noteId)
          playSound('noteDeselect')
        } else {
          next.add(noteId)
          playSound('noteSelect')
        }
        return next
      })
      return
    }
    setSelectedHierarchyNoteIds(new Set([noteId]))
    playSound('noteSelect')
  }, [])

  const selectAllVisibleHierarchyRows = useCallback(() => {
    const ids = visibleHierarchyRows.map(row => row.note.id)
    setSelectedHierarchyNoteIds(new Set(ids))
    if (ids.length > 0) playSound('noteMarqueeSelect')
  }, [visibleHierarchyRows])

  useEffect(() => {
    if (!isActive) return undefined
    const onKeyDown = event => {
      const target = event.target
      const isEditable = target?.closest?.('input, textarea, select, [contenteditable="true"]')
      if (isEditable) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAllVisibleHierarchyRows()
      }
      if (event.key === 'Escape') {
        setSelectedHierarchyNoteIds(new Set())
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isActive, selectAllVisibleHierarchyRows])

  useEffect(() => {
    if (isActive && !isNoteWorkspace) {
      projectsApi.getProjectStats(project.id).then(setStats).catch(console.error)
    }
    if (isActive && isNoteWorkspace) setStats(null)
  }, [project.id, isActive, isNoteWorkspace])

  useEffect(() => {
    if (!isActive || !isNoteWorkspace) return undefined
    let cancelled = false
    Promise.all([
      api.getAssignments(),
      api.getDependencies(),
    ])
      .then(([assignments, dependencies]) => {
        if (cancelled) return
        setOverviewScopeData({
          assignments,
          dependencies,
        })
      })
      .catch(console.error)
    return () => { cancelled = true }
  }, [isActive, isNoteWorkspace, project.id])

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

  const reloadStructureColorData = useCallback(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getAssignments()])
      .then(([dims, cats, assignments]) => {
        setStructureDimensions(dims)
        setStructureCategories(cats)
        setStructureAssignments(assignments)
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!isActive || !structureOnly) return
    reloadStructureColorData()
  }, [isActive, reloadStructureColorData, structureOnly])

  useEffect(() => {
    if (structureColorDimId && !structureDimensions.some(dim => dim.id === structureColorDimId)) {
      setStructureColorDimId('')
      setStructurePaintCat(null)
    }
  }, [structureColorDimId, structureDimensions])

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
    setDraftDesc(descriptionText(desc))
    setEditingDesc(false)
  }
  const displayedDesc = descriptionText(desc)

  const handleExport = async () => {
    setExporting(true)
    try {
      const data = await projectsApi.exportDatabase(project.id)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const date = new Date().toISOString().split('T')[0]
      const safeName = String(project.name || 'project').trim().replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'project'
      a.download = `orgarythmus_project_${safeName}_${date}.json`
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

  const changeStructureColorDim = dimId => {
    setStructureColorDimId(dimId)
    setStructurePaintCat(null)
  }

  const activateStructurePaint = (catId, color) => {
    const deactivating = structurePaintCat?.id === catId
    playSound(deactivating ? 'paintModeDeactivate' : 'paintModeActivate')
    setStructurePaintCat(previous => previous?.id === catId ? null : { id: catId, color })
  }

  const applyStructurePaint = async noteId => {
    if (!structurePaintCat || !structureColorDimId || !noteId) return
    playSound('paintApply')
    try {
      if (structurePaintCat.id === COLOR_UNASSIGNED_CATEGORY_ID) {
        await api.unassign(noteId, structureColorDimId)
        setStructureAssignments(previous => previous.filter(assignment => !(assignment.noteId === noteId && assignment.dimensionId === structureColorDimId)))
        return
      }
      await api.assign(noteId, structureColorDimId, structurePaintCat.id)
      setStructureAssignments(previous => [
        ...previous.filter(assignment => !(assignment.noteId === noteId && assignment.dimensionId === structureColorDimId)),
        { noteId, dimensionId: structureColorDimId, categoryId: structurePaintCat.id },
      ])
    } catch (error) {
      console.error(error)
      showHierarchyWarning('Category not assigned', error?.message || 'The category could not be assigned to this note.')
    }
  }

  const hierarchySection = hierarchyRows.length > 0 && (
    <div className={`${styles.section} ${structureOnly ? styles.structureSection : ''}`}>
      <div className={styles.sectionHeader}>
        <label className={styles.sectionLabel}>Hierarchy</label>
        <label className={styles.hierarchyDepthControl}>
          <span>Descendant depth</span>
          <select
            value={descendantDepth}
            onWheel={event => {
              event.preventDefault()
              cycleDescendantDepth(event.deltaY)
            }}
            onChange={event => changeDescendantDepth(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
            <option value={1}>1 hop</option>
            <option value={2}>2 hops</option>
            <option value={3}>3 hops</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      <div className={styles.hierarchyTree}>
        <NoteHierarchyTree
          rows={visibleHierarchyRows}
          rootNoteId={workspaceRootNoteId}
          projectRootNoteId={project.rootNoteId}
          project={project}
          localBaseDepth={localHierarchyBaseDepth}
          selectedIds={selectedHierarchyNoteIds}
          draggedIds={draggedHierarchyNoteIds}
          dropTargetId={hierarchyDropTargetId}
          reorderDragId={hierarchyReorderDragId}
          reorderTarget={hierarchyReorderTarget}
          isExpanded={isHierarchyNodeExpanded}
          onToggle={toggleHierarchyNode}
          onSelect={(event, noteId) => {
            if (structureOnly && structurePaintCat) {
              event.stopPropagation()
              applyStructurePaint(noteId)
              return
            }
            handleHierarchyNodeClick(event, noteId)
          }}
          onOpenWorkspace={noteId => { playSound('viewChange'); onWorkspaceOpen?.(noteId) }}
          onOpenDetails={noteId => { playSound('noteOpen'); onNoteOpen?.(noteId) }}
          onContextMenu={openHierarchyContextMenu}
          onMove={moveHierarchyNotes}
          onReorder={reorderHierarchyNote}
          onDragStartIds={noteId => selectedHierarchyNoteIds.has(noteId)
            ? [...selectedHierarchyNoteIds].filter(selectedId => selectedId !== project.rootNoteId)
            : [noteId]}
          onDragStateChange={({ draggedIds, selectedId, dropTargetId, onlyIfDropTargetId }) => {
            if (draggedIds) setDraggedHierarchyNoteIds(draggedIds)
            if (selectedId && !selectedHierarchyNoteIds.has(selectedId)) setSelectedHierarchyNoteIds(new Set([selectedId]))
            if (dropTargetId !== undefined) {
              if (onlyIfDropTargetId) setHierarchyDropTargetId(current => current === onlyIfDropTargetId ? dropTargetId : current)
              else setHierarchyDropTargetId(dropTargetId)
            }
          }}
          onReorderDragStateChange={({ dragId, target, onlyIfTargetId }) => {
            if (dragId !== undefined) setHierarchyReorderDragId(dragId)
            if (target !== undefined) {
              if (onlyIfTargetId) setHierarchyReorderTarget(current => current?.noteId === onlyIfTargetId ? target : current)
              else setHierarchyReorderTarget(target)
            }
          }}
          onClearSelection={() => setSelectedHierarchyNoteIds(new Set())}
          colorByNoteId={structureOnly ? structureColorByNoteId : {}}
          paintCategoryId={structureOnly ? structurePaintCat?.id : ''}
          paintCursor={structureOnly ? structurePaintCursor : ''}
          ariaLabel="Project, ancestors, and child notes"
        />
      </div>
    </div>
  )

  return (
    <div
      className={`${styles.note} ${structurePaintCursor ? styles.paintMode : ''}`}
      style={structurePaintCursor ? { '--paint-cursor': structurePaintCursor, cursor: structurePaintCursor } : undefined}
      onClick={structurePaintCat ? () => setStructurePaintCat(null) : undefined}>
      <div className={`${styles.content} ${structureOnly ? styles.structureContent : ''}`}>

        {/* Project name */}
        {!structureOnly && <div className={styles.nameRow}>
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
        </div>}

        {structureOnly ? hierarchySection : null}

        {/* Stats */}
        {!structureOnly && <div className={styles.section}>
          <label className={styles.sectionLabel}>Overview</label>
          <div className={styles.statsGrid}>
            {Object.entries(STAT_LABELS).map(([key, label]) => (
              <StatCard key={key} label={label} value={displayedStats?.[key]} />
            ))}
          </div>
        </div>}

        {/* Timeline dates */}
        {!structureOnly && <div className={styles.section}>
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
        </div>}

        {/* Description */}
        {!structureOnly && <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <label className={styles.sectionLabel}>Description</label>
            {!editingDesc && (
              <button className={styles.editBtn} onClick={() => { setDraftDesc(descriptionText(desc)); setEditingDesc(true) }}>
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
              {displayedDesc || <span className={styles.descPlaceholder}>No description yet.</span>}
            </p>
          )}
        </div>}

        {/* Footer row: export */}
        {!structureOnly && <div className={styles.footerRow}>
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            disabled={exporting}
            title="Download a complete JSON snapshot of this project"
          >
            {exporting ? 'Saving…' : 'Save project'}
          </button>
        </div>}

      </div>

      {structureOnly && (
        <div className={styles.structureFloatingTools}>
          <StandardColorPicker
            dimensions={structureDimensions}
            categories={structureCategories}
            colorDimensionId={structureColorDimId}
            onColorDimensionChange={changeStructureColorDim}
            onDimensionDataChanged={reloadStructureColorData}
            paintCategoryId={structurePaintCat?.id}
            onPaintCategory={activateStructurePaint}
            expanded={structureColorExpanded}
            onExpandedChange={setStructureColorExpanded}
            hint="Assign note categories"
          />
        </div>
      )}

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
      {hierarchyContextMenu && (() => {
        const contextNote = notes.find(note => note.id === hierarchyContextMenu.noteId)
        if (!contextNote) return null
        const hasChildren = notes.some(note => note.parentNoteId === contextNote.id)
        const isProjectRoot = contextNote.id === project.rootNoteId
        return (
          <div
            className={styles.hierarchyContextMenu}
            style={{ left: hierarchyContextMenu.x, top: hierarchyContextMenu.y }}
            role="menu"
            onMouseDown={event => event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={() => {
              setHierarchyContextMenu(null)
              setNewNoteDraft({ parentNoteId: contextNote.id, title: '' })
            }}>
              New note inside
            </button>
            {hasChildren && (
              <button type="button" role="menuitem" onClick={() => {
                setHierarchyContextMenu(null)
                expandHierarchySubtree(contextNote.id)
              }}>
                Expand all
              </button>
            )}
            <button type="button" role="menuitem" onClick={() => {
              setHierarchyContextMenu(null)
              playSound('viewChange')
              onWorkspaceOpen?.(contextNote.id)
            }}>
              Open as project
            </button>
            <div className={styles.hierarchyContextDivider} />
            <button type="button" role="menuitem" className={styles.hierarchyContextDanger} onClick={() => {
              setHierarchyContextMenu(null)
              if (hasChildren || isProjectRoot) deleteHierarchyProject(contextNote)
              else deleteHierarchyNote(contextNote)
            }}>
              {hasChildren || isProjectRoot ? 'Delete project…' : 'Delete note…'}
            </button>
          </div>
        )
      })()}
      {newNoteDraft && (
        <div className={styles.newNoteBackdrop} onMouseDown={event => {
          if (event.target === event.currentTarget && !creatingHierarchyNote) setNewNoteDraft(null)
        }}>
          <div className={styles.newNoteDialog} role="dialog" aria-modal="true" aria-labelledby="new-note-headline-label">
            <label id="new-note-headline-label" className={styles.newNoteLabel} htmlFor="new-hierarchy-note-title">
              Note headline
            </label>
            <input
              id="new-hierarchy-note-title"
              className={styles.newNoteInput}
              value={newNoteDraft.title}
              onChange={event => setNewNoteDraft(draft => ({ ...draft, title: event.target.value }))}
              onKeyDown={event => {
                if (event.key === 'Enter') submitNewHierarchyNote()
                if (event.key === 'Escape' && !creatingHierarchyNote) setNewNoteDraft(null)
              }}
              placeholder="Enter a headline…"
              autoFocus
              disabled={creatingHierarchyNote}
            />
            <div className={styles.newNoteActions}>
              <button type="button" className={styles.newNoteCancel} disabled={creatingHierarchyNote} onClick={() => setNewNoteDraft(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.newNoteCreate}
                disabled={!newNoteDraft.title.trim() || creatingHierarchyNote}
                onClick={submitNewHierarchyNote}>
                {creatingHierarchyNote ? 'Creating…' : 'Create note'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialogNode}
    </div>
  )
}
