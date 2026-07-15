import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, Eye, EyeOff, Settings } from 'lucide-react'
import { api } from '../api'
import { usePersonaCursor } from '../hooks/usePersonaCursor'
import { playSound } from '../sounds/sound_registry'
import { buildNoteHierarchyRows, DoneKindIcon } from './NoteHierarchyTree'
import PersonaAvatarStack from './PersonaAvatarStack'
import PeopleWidget from './PeopleWidget'
import ProjectDashboard from './ProjectDashboard'
import StandardColorPicker from './StandardColorPicker'
import { COLOR_UNASSIGNED_CATEGORY_ID } from './colorPickerCategories'
import { CategoryIconGlyph, iconForCategory } from './iconRegistry'
import { FILTER_DIMENSION_ID, filterCategoryId, filterMatchesNote, normalizeSavedFilter } from './savedFilterUtils'
import { TIME_DIMENSION_ID, TIME_DYNAMIC_CATEGORIES, timeCategoryIdForNote } from './timeCategories'
import { TYPE_DIMENSION_ID, TYPE_DYNAMIC_CATEGORIES, typeCategoryIdForNote } from './typeCategories'
import styles from './ReportPage.module.css'

const SAVE_DELAY = 550
const STRUCTURE_MIN_WIDTH = 220
const STRUCTURE_MAX_WIDTH = 480
const STRUCTURE_DEFAULT_WIDTH = 292
const STRUCTURE_COLLAPSED_WIDTH = 42
const DETAIL_MODE_ALL = 'all'
const DETAIL_MODE_DESCRIPTION = 'description'
const DETAIL_MODE_NONE = 'none'
const MIN_TIME_SLOT_DURATION = 10
const DAY_MINUTES = 60 * 24
const MONTH_MINUTES = DAY_MINUTES * 30

function makeColorCursor(color) {
  const safeColor = /^#[0-9a-f]{3,8}$/i.test(String(color)) ? color : '#64748b'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="9" cy="9" r="7" fill="${safeColor}" stroke="white" stroke-width="2"/><path d="M14 14l8 8" stroke="black" stroke-width="2.5" stroke-linecap="round"/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 9 9, pointer`
}

function addOutlineNumbers(rows) {
  const counters = []
  return rows.map(row => {
    const depth = Math.max(0, row.depth)
    counters.length = depth + 1
    counters[depth] = (counters[depth] || 0) + 1
    for (let index = 0; index < depth; index += 1) {
      if (!counters[index]) counters[index] = 1
    }
    return { ...row, outlineNumber: counters.slice(0, depth + 1).join('.') }
  })
}

function timelineAnchor(project) {
  const rawValue = project?.createdAt ?? project?.created_at
  const raw = rawValue ? String(rawValue).replace(' ', 'T') : ''
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

function scheduleScaleForRange(duration) {
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

function scheduleLabelForSlot(project, slot) {
  if (!slot) return null
  const start = Math.max(0, Number(slot.startCol ?? slot.start_col) || 0)
  const duration = Math.max(MIN_TIME_SLOT_DURATION, Number(slot.duration) || MIN_TIME_SLOT_DURATION)
  const end = start + duration
  const scale = scheduleScaleForRange(duration)
  const anchor = timelineAnchor(project)
  return {
    range: `${formatScheduleMoment(anchor, start, scale)} - ${formatScheduleMoment(anchor, end, scale)}`,
    duration: formatScheduleDuration(duration),
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function compareReportNoteOrder(a, b) {
  const aOrder = a.orderIdx ?? a.order_idx ?? Number.MAX_SAFE_INTEGER
  const bOrder = b.orderIdx ?? b.order_idx ?? Number.MAX_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  return String(a.title || '').localeCompare(String(b.title || ''))
}

function EditableHeading({ as: HeadingTag, title, editable, onCommit }) {
  const [draftTitle, setDraftTitle] = useState(title)
  const inputRef = useRef(null)

  const resizeInput = useCallback(() => {
    const element = inputRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [])

  useEffect(() => {
    setDraftTitle(title)
  }, [title])

  useLayoutEffect(() => {
    if (editable) resizeInput()
  }, [draftTitle, editable, resizeInput])

  if (!editable) {
    return <HeadingTag className={styles.sectionTitle} dir="ltr">{title}</HeadingTag>
  }

  return (
    <textarea
      ref={inputRef}
      className={`${styles.sectionTitle} ${styles.sectionTitleInput}`}
      dir="ltr"
      spellCheck
      value={draftTitle}
      rows={1}
      onChange={event => setDraftTitle(event.target.value)}
      onBlur={() => {
        const nextTitle = draftTitle.replace(/\s+/g, ' ').trim() || title || 'Untitled'
        setDraftTitle(nextTitle)
        onCommit(nextTitle)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraftTitle(title)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function EditableBody({ html, editable, onChange }) {
  const bodyRef = useRef(null)

  useLayoutEffect(() => {
    if (!editable) return
    if (document.activeElement !== bodyRef.current && bodyRef.current?.innerHTML !== html) {
      bodyRef.current.innerHTML = html
    }
  }, [editable, html])

  if (!editable) {
    return (
      <div
        className={styles.sectionBody}
        dir="ltr"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <div
      ref={bodyRef}
      className={styles.sectionBody}
      dir="ltr"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder="Write this section..."
      onInput={event => onChange(event.currentTarget.innerHTML)}
    />
  )
}

function ReportInsertPoint({ row, primaryMode, initiallyOpen = false, onCreate }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [creating, setCreating] = useState(false)
  const editorRef = useRef(null)
  const bodyInputRef = useRef(null)
  const primaryLabel = primaryMode === 'child' ? 'inside' : 'below'
  const secondaryMode = primaryMode === 'child' ? 'after' : 'child'
  const canAddBelow = row.depth > 0 && Boolean(row.note.parentNoteId)

  const closeEmptyEditor = () => {
    setDraftTitle('')
    setDraftBody('')
    setOpen(false)
  }

  const submit = async mode => {
    const title = draftTitle.trim()
    if (!title || creating) return
    setCreating(true)
    const html = draftBody.trim()
      ? draftBody
        .trim()
        .split(/\n{2,}/)
        .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('')
      : ''
    const created = await onCreate({ row, title, html, mode })
    setCreating(false)
    if (created) {
      setDraftTitle('')
      setDraftBody('')
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <div className={styles.insertPoint}>
        <button
          type="button"
          className={styles.insertGhostButton}
          onClick={() => setOpen(true)}>
          + Add {primaryLabel}
        </button>
      </div>
    )
  }

  return (
    <form
      ref={editorRef}
      className={styles.insertEditor}
      onBlur={event => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        if (!draftTitle.trim() && !draftBody.trim() && !creating) closeEmptyEditor()
      }}
      onSubmit={event => {
        event.preventDefault()
        submit(primaryMode)
      }}>
      <input
        className={styles.insertInput}
        dir="ltr"
        autoFocus
        value={draftTitle}
        placeholder="New note title"
        disabled={creating}
        onChange={event => setDraftTitle(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            closeEmptyEditor()
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            bodyInputRef.current?.focus()
          }
        }}
      />
      <textarea
        ref={bodyInputRef}
        className={styles.insertBodyInput}
        dir="ltr"
        spellCheck
        value={draftBody}
        rows={2}
        placeholder="Description"
        disabled={creating}
        onChange={event => setDraftBody(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            closeEmptyEditor()
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit(primaryMode)
          }
        }}
      />
      <button type="submit" className={styles.insertAction} disabled={!draftTitle.trim() || creating}>
        Add
      </button>
      {(secondaryMode === 'child' || canAddBelow) && (
        <button
          type="button"
          className={styles.insertActionSecondary}
          disabled={!draftTitle.trim() || creating}
          onClick={() => submit(secondaryMode)}>
          {secondaryMode === 'child' ? 'Inside' : 'Below'}
        </button>
      )}
    </form>
  )
}

function ReportEndInsert({ rootRow, onCreate }) {
  const [open, setOpen] = useState(false)

  if (!rootRow) return null

  if (!open) {
    return (
      <div
        className={styles.sheetEndInsert}
        role="button"
        tabIndex={0}
        aria-label="Add note at the end of the report"
        onClick={() => setOpen(true)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      />
    )
  }

  return (
    <div className={`${styles.sheetEndInsert} ${styles.sheetEndInsertOpen}`}>
      <ReportInsertPoint
        row={rootRow}
        primaryMode="child"
        initiallyOpen
        onCreate={async payload => {
          const created = await onCreate(payload)
          if (created) setOpen(false)
          return created
        }}
      />
    </div>
  )
}

function ReportAttributes({ attributes }) {
  if (!attributes.length) return null

  return (
    <div className={styles.sectionAttributes} aria-label="Assigned categories">
      {attributes.map(({ dim, cat }) => (
        <span
          key={`${dim.id}:${cat.id}`}
          className={styles.sectionAttributeBadge}
          style={{ '--attribute-color': cat.color || '#64748b' }}>
          <span className={styles.sectionAttributeIcon}>
            <CategoryIconGlyph icon={iconForCategory(cat)} size={14} strokeWidth={2.4} />
          </span>
          <span className={styles.sectionAttributeName}>{cat.name || 'Untitled'}</span>
        </span>
      ))}
    </div>
  )
}

function ReportScheduleBadge({ schedule }) {
  if (!schedule) return null

  return (
    <div className={styles.sectionSchedule}>
      <span className={styles.sectionScheduleIcon}>
        <CalendarClock size={14} strokeWidth={2.25} />
      </span>
      <span className={styles.sectionScheduleRange}>{schedule.range}</span>
      <span className={styles.sectionScheduleDuration}>{schedule.duration}</span>
    </div>
  )
}

function ReportSection({ row, project, isProjectRoot, childrenCollapsed, attributes, detailMode, activeColor, sideMeta, paintCat, paintPersonaId, registerSection, onTitleChange, onBodyChange, onToggleChildren, onToggleDetails, onTypeContextMenu, onPaint, onPersonaPaint }) {
  const title = isProjectRoot && project?.name ? project.name : row.note.title || 'Untitled'
  const body = isProjectRoot && project?.description ? project.description : row.note.html || ''
  const isReportRoot = row.relation === 'current' || row.depth === 0
  const headingLevel = isReportRoot ? 1 : Math.min(6, row.depth + 1)
  const HeadingTag = `h${headingLevel}`
  const showDescription = detailMode === DETAIL_MODE_ALL || detailMode === DETAIL_MODE_DESCRIPTION
  const showMetadata = detailMode === DETAIL_MODE_ALL
  const nextDetailLabel = detailMode === DETAIL_MODE_ALL
    ? 'show description only'
    : detailMode === DETAIL_MODE_DESCRIPTION
      ? 'hide details'
      : 'show all details'

  return (
    <section
      ref={element => registerSection(row.note.id, element)}
      className={`${styles.documentSection} ${paintCat || paintPersonaId ? styles.documentSectionPaintable : ''}`}
      style={activeColor ? { '--section-color': activeColor } : undefined}
      dir="ltr"
      data-depth={row.depth}
      data-report-root={isReportRoot ? 'true' : undefined}
      data-colored={activeColor ? 'true' : undefined}
      onClickCapture={(paintCat || paintPersonaId) ? event => {
        if (event.target.closest?.(`.${styles.sectionNumberButton}, .${styles.headingTypeIcon}`)) return
        event.preventDefault()
        event.stopPropagation()
        if (paintPersonaId) onPersonaPaint(row.note.id)
        else onPaint(row.note.id)
      } : undefined}>
      <div className={styles.sectionMain}>
        <div className={styles.sectionHeading}>
          <button
            type="button"
            className={styles.sectionNumberButton}
            onClick={() => onToggleChildren(row.note.id)}
            title={childrenCollapsed ? 'Expand child sections' : 'Collapse child sections'}
          aria-label={childrenCollapsed ? `Expand children of ${title}` : `Collapse children of ${title}`}>
            {row.outlineNumber}
          </button>
        {(() => {
          const doneInfo = sideMeta.doneInfo
          const done = Boolean(doneInfo?.done)
          const doneLabel = doneInfo?.inherited
            ? `Done via ${doneInfo.inheritedFrom?.title || 'parent'}`
            : 'Done'
          return (
        <button
          type="button"
          className={[
            styles.headingTypeIcon,
            done && styles.headingTypeDone,
            doneInfo?.inherited && styles.headingTypeDoneInherited,
          ].filter(Boolean).join(' ')}
          style={{ '--attribute-color': done ? '#16a34a' : (sideMeta.typeCategory?.color || '#64748b') }}
          onClick={() => onToggleDetails(row.note.id)}
          onContextMenu={event => onTypeContextMenu(event, row.note.id)}
          title={`Current detail view: ${detailMode}. Click to ${nextDetailLabel}.`}
          aria-label={`${done ? doneLabel : (sideMeta.typeCategory?.name || 'Type')}: ${nextDetailLabel} for ${title}`}
          aria-pressed={detailMode !== DETAIL_MODE_NONE}>
          {done ? <DoneKindIcon /> : <CategoryIconGlyph icon={iconForCategory(sideMeta.typeCategory)} strokeWidth={2.35} />}
        </button>
          )
        })()}
        <EditableHeading
          as={HeadingTag}
          title={title}
          editable={!isProjectRoot}
          onCommit={value => onTitleChange(row.note.id, value)}
        />
        {sideMeta.people.length > 0 && (
          <span className={styles.headingPeople}>
            <PersonaAvatarStack personas={sideMeta.people} />
          </span>
        )}
      </div>
        {showDescription && (
          <div className={styles.sectionDetails} data-detail-mode={detailMode}>
            {showMetadata && (
              <>
            <ReportAttributes attributes={attributes} />
            <ReportScheduleBadge schedule={sideMeta.schedule} />
              </>
            )}
            <EditableBody
              html={body}
              editable={!isProjectRoot}
              onChange={html => onBodyChange(row.note.id, html)}
            />
          </div>
        )}
      </div>
    </section>
  )
}

export default function ReportPage({
  notes = [],
  project = null,
  workspaceRootNoteId = null,
  workspaceRootNote = null,
  workspaceNote = null,
  onProjectUpdate,
  onWorkspaceNoteUpdated,
  onWorkspaceOpen,
  onNoteOpen,
  onProjectDeleted,
  onNotesChanged,
  onNoteUpdated,
  isActive = false,
  assignmentsRefreshKey = 0,
}) {
  const [savingIds, setSavingIds] = useState(() => new Set())
  const [structureWidth, setStructureWidth] = useState(STRUCTURE_DEFAULT_WIDTH)
  const [structureCollapsed, setStructureCollapsed] = useState(false)
  const [visibleStructureNoteIds, setVisibleStructureNoteIds] = useState(null)
  const [collapsedStructureNoteIds, setCollapsedStructureNoteIds] = useState(() => new Set())
  const [detailModesByNoteId, setDetailModesByNoteId] = useState(() => new Map())
  const [hierarchyToggleRequest, setHierarchyToggleRequest] = useState(null)
  const [classificationDimensions, setClassificationDimensions] = useState([])
  const [classificationCategories, setClassificationCategories] = useState([])
  const [classificationAssignments, setClassificationAssignments] = useState([])
  const [savedFilters, setSavedFilters] = useState([])
  const [timeSlots, setTimeSlots] = useState([])
  const [personas, setPersonas] = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])
  const [colorDimensionId, setColorDimensionId] = useState('')
  const [paintCat, setPaintCat] = useState(null)
  const [paintPersonaId, setPaintPersonaId] = useState(null)
  const [floatingPanel, setFloatingPanel] = useState(null)
  const [reportSettingsOpen, setReportSettingsOpen] = useState(false)
  const [typeContextMenu, setTypeContextMenu] = useState(null)
  const [pendingCreatedNoteId, setPendingCreatedNoteId] = useState(null)
  const sectionRefs = useRef({})
  const saveTimers = useRef({})
  const pendingPatches = useRef({})
  const reportRef = useRef(null)

  const rootNoteId = workspaceRootNoteId || project?.rootNoteId || null
  const rows = useMemo(
    () => buildNoteHierarchyRows(notes, rootNoteId, { includeRoot: true }),
    [notes, rootNoteId],
  )
  const notesById = useMemo(() => new Map(notes.map(note => [String(note.id), note])), [notes])
  const numberedRows = useMemo(() => addOutlineNumbers(rows), [rows])
  const rowById = useMemo(() => new Map(numberedRows.map(row => [row.note.id, row])), [numberedRows])
  const rootReportRow = useMemo(
    () => rowById.get(rootNoteId) || numberedRows[0] || null,
    [numberedRows, rootNoteId, rowById],
  )
  const noteParentById = useMemo(
    () => new Map(numberedRows.map(row => [row.note.id, row.note.parentNoteId || null])),
    [numberedRows],
  )
  const visibleReportRows = useMemo(() => {
    const isHiddenByCollapsedAncestor = noteId => {
      const seen = new Set()
      let parentId = noteParentById.get(noteId)
      while (parentId && !seen.has(parentId)) {
        if (collapsedStructureNoteIds.has(parentId)) return true
        seen.add(parentId)
        parentId = noteParentById.get(parentId)
      }
      return false
    }
    return numberedRows.filter(row => {
      if (visibleStructureNoteIds && !visibleStructureNoteIds.has(row.note.id)) return false
      return !isHiddenByCollapsedAncestor(row.note.id)
    })
  }, [collapsedStructureNoteIds, noteParentById, numberedRows, visibleStructureNoteIds])
  const visibleDepthSpan = useMemo(() => {
    const maxDepth = visibleReportRows.reduce((max, row) => Math.max(max, row.depth), 0)
    if (maxDepth <= 1) return 'shallow'
    if (maxDepth <= 2) return 'medium'
    return 'deep'
  }, [visibleReportRows])
  const assignmentForDimension = useCallback((noteId, dimensionId) => {
    const assignment = classificationAssignments.find(item => {
      const itemNoteId = item.noteId || item.note_id
      const itemDimensionId = item.dimensionId || item.dimension_id
      return itemNoteId === noteId && itemDimensionId === dimensionId
    })
    return assignment?.categoryId || assignment?.category_id || null
  }, [classificationAssignments])
  const filterCategories = useMemo(() => savedFilters.map((filter, index) => ({
    id: filterCategoryId(filter.id),
    dimensionId: FILTER_DIMENSION_ID,
    name: filter.name,
    color: filter.color || '#64748b',
    icon: filter.icon || 'filter',
    filterId: filter.id,
    orderIdx: index,
    dynamic: true,
    dynamicType: 'filter',
    dynamicLabel: 'Filter',
    readOnly: true,
  })), [savedFilters])
  const timeCategories = useMemo(() => TIME_DYNAMIC_CATEGORIES.map(category => ({
    ...category,
    dimensionId: TIME_DIMENSION_ID,
    dynamic: true,
    dynamicType: 'time',
    dynamicLabel: 'Time',
    readOnly: true,
  })), [])
  const typeCategories = useMemo(() => TYPE_DYNAMIC_CATEGORIES.map(category => ({
    ...category,
    dimensionId: TYPE_DIMENSION_ID,
    dynamic: true,
    dynamicType: 'type',
    dynamicLabel: 'Type',
    readOnly: true,
  })), [])
  const reportDimensions = useMemo(() => [
    ...classificationDimensions,
    { id: FILTER_DIMENSION_ID, name: 'Filters', dynamic: true, dynamicType: 'filter', dynamicLabel: 'Filter' },
    { id: TIME_DIMENSION_ID, name: 'Time', dynamic: true, dynamicType: 'time', dynamicLabel: 'Time' },
    { id: TYPE_DIMENSION_ID, name: 'Type', dynamic: true, dynamicType: 'type', dynamicLabel: 'Type' },
  ], [classificationDimensions])
  const reportCategories = useMemo(() => [
    ...classificationCategories,
    ...filterCategories,
    ...timeCategories,
    ...typeCategories,
  ], [classificationCategories, filterCategories, timeCategories, typeCategories])
  const reportAttributesByNoteId = useMemo(() => {
    const dimensionsById = new Map(reportDimensions.map(dimension => [dimension.id, dimension]))
    const categoriesById = new Map(reportCategories.map(category => [category.id, category]))
    const grouped = new Map()

    classificationAssignments.forEach(assignment => {
      const noteId = assignment.noteId || assignment.note_id
      const dimensionId = assignment.dimensionId || assignment.dimension_id
      const categoryId = assignment.categoryId || assignment.category_id
      const dim = dimensionsById.get(dimensionId)
      const cat = categoriesById.get(categoryId)
      if (!noteId || !dim || !cat) return
      if (!grouped.has(noteId)) grouped.set(noteId, [])
      grouped.get(noteId).push({ dim, cat })
    })

    numberedRows.forEach(row => {
      const note = row.note
      if (!note?.id) return
      const attributes = grouped.get(note.id) || []

      const timeDim = dimensionsById.get(TIME_DIMENSION_ID)
      const timeCat = categoriesById.get(timeCategoryIdForNote(note))
      if (timeDim && timeCat) attributes.push({ dim: timeDim, cat: timeCat })

      const filterDim = dimensionsById.get(FILTER_DIMENSION_ID)
      if (filterDim) {
        filterCategories.forEach(filterCategory => {
          const filter = savedFilters.find(item => item.id === filterCategory.filterId)
          if (filterMatchesNote(filter, note, assignmentForDimension, { notes, timeSlots })) {
            attributes.push({ dim: filterDim, cat: filterCategory })
          }
        })
      }

      if (attributes.length) grouped.set(note.id, attributes)
    })

    grouped.forEach(attributes => attributes.sort((a, b) => {
      const aOrder = a.dim.orderIdx ?? a.dim.order_idx ?? Number.MAX_SAFE_INTEGER
      const bOrder = b.dim.orderIdx ?? b.dim.order_idx ?? Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return String(a.dim.name || '').localeCompare(String(b.dim.name || ''))
    }))

    return grouped
  }, [assignmentForDimension, classificationAssignments, filterCategories, notes, numberedRows, reportCategories, reportDimensions, savedFilters, timeSlots])
  const assignedCategoryByNoteAndDimension = useMemo(() => {
    const grouped = new Map()
    classificationAssignments.forEach(assignment => {
      const noteId = assignment.noteId || assignment.note_id
      const dimensionId = assignment.dimensionId || assignment.dimension_id
      const categoryId = assignment.categoryId || assignment.category_id
      if (!noteId || !dimensionId || !categoryId) return
      if (!grouped.has(noteId)) grouped.set(noteId, new Map())
      grouped.get(noteId).set(dimensionId, categoryId)
    })
    return grouped
  }, [classificationAssignments])
  const activeColorByNoteId = useMemo(() => {
    if (!colorDimensionId) return new Map()
    const categoriesById = new Map(reportCategories.map(category => [category.id, category]))
    const colors = new Map()
    if (colorDimensionId === TIME_DIMENSION_ID) {
      numberedRows.forEach(row => {
        const category = categoriesById.get(timeCategoryIdForNote(row.note))
        if (category?.color) colors.set(row.note.id, category.color)
      })
      return colors
    }
    if (colorDimensionId === TYPE_DIMENSION_ID) {
      numberedRows.forEach(row => {
        const category = categoriesById.get(typeCategoryIdForNote(row.note, { notes, timeSlots }))
        if (category?.color) colors.set(row.note.id, category.color)
      })
      return colors
    }
    if (colorDimensionId === FILTER_DIMENSION_ID) {
      numberedRows.forEach(row => {
        const category = filterCategories.find(filterCategory => {
          const filter = savedFilters.find(item => item.id === filterCategory.filterId)
          return filterMatchesNote(filter, row.note, assignmentForDimension, { notes, timeSlots })
        })
        if (category?.color) colors.set(row.note.id, category.color)
      })
      return colors
    }
    assignedCategoryByNoteAndDimension.forEach((dimensions, noteId) => {
      const category = categoriesById.get(dimensions.get(colorDimensionId))
      if (category?.color) colors.set(noteId, category.color)
    })
    return colors
  }, [assignmentForDimension, assignedCategoryByNoteAndDimension, colorDimensionId, filterCategories, notes, numberedRows, reportCategories, savedFilters, timeSlots])
  const peopleByNoteId = useMemo(() => {
    const personasById = new Map(personas.map(persona => [persona.id, persona]))
    const grouped = new Map()
    personaNoteAssignments.forEach(assignment => {
      const noteId = assignment.noteId || assignment.note_id
      const personaId = assignment.personaId || assignment.persona_id
      const persona = personasById.get(personaId)
      if (!noteId || !persona) return
      if (!grouped.has(noteId)) grouped.set(noteId, [])
      grouped.get(noteId).push(persona)
    })
    return grouped
  }, [personaNoteAssignments, personas])
  const activePersona = useMemo(
    () => personas.find(persona => persona.id === paintPersonaId) || null,
    [paintPersonaId, personas],
  )
  const personaCursor = usePersonaCursor(activePersona)
  const typeCategoryByNoteId = useMemo(() => {
    const typeById = new Map(typeCategories.map(category => [category.id, category]))
    return new Map(numberedRows.map(row => [
      row.note.id,
      typeById.get(typeCategoryIdForNote(row.note, { notes, timeSlots })) || typeCategories[0],
    ]))
  }, [notes, numberedRows, timeSlots, typeCategories])
  const kanbanDoneCategory = useMemo(
    () => classificationCategories.find(category => category.systemType === 'kanban' && category.kanbanState === 'done'),
    [classificationCategories],
  )
  const explicitDoneNoteIds = useMemo(() => {
    if (!kanbanDoneCategory) return new Set()
    return new Set(
      classificationAssignments
        .filter(assignment => {
          const noteId = assignment.noteId || assignment.note_id
          const dimensionId = assignment.dimensionId || assignment.dimension_id
          const categoryId = assignment.categoryId || assignment.category_id
          return dimensionId === kanbanDoneCategory.dimensionId && categoryId === kanbanDoneCategory.id && noteId
        })
        .map(assignment => String(assignment.noteId || assignment.note_id)),
    )
  }, [classificationAssignments, kanbanDoneCategory])
  const doneInfoByNoteId = useMemo(() => {
    const fallback = { done: false, explicit: false, inherited: false, inheritedFrom: null }
    if (!kanbanDoneCategory) return new Map()
    const resolved = new Map()
    const resolving = new Set()
    const resolve = noteId => {
      const normalizedId = String(noteId || '')
      if (resolved.has(normalizedId)) return resolved.get(normalizedId)
      if (!normalizedId || resolving.has(normalizedId)) return fallback
      resolving.add(normalizedId)
      if (explicitDoneNoteIds.has(normalizedId)) {
        const info = { done: true, explicit: true, inherited: false, inheritedFrom: notesById.get(normalizedId) || null }
        resolved.set(normalizedId, info)
        resolving.delete(normalizedId)
        return info
      }
      const parentId = notesById.get(normalizedId)?.parentNoteId
      if (parentId) {
        const parentInfo = resolve(parentId)
        if (parentInfo.done) {
          const info = {
            done: true,
            explicit: false,
            inherited: true,
            inheritedFrom: parentInfo.inheritedFrom || notesById.get(String(parentId)) || null,
          }
          resolved.set(normalizedId, info)
          resolving.delete(normalizedId)
          return info
        }
      }
      resolved.set(normalizedId, fallback)
      resolving.delete(normalizedId)
      return fallback
    }
    notes.forEach(note => resolve(note.id))
    return resolved
  }, [explicitDoneNoteIds, kanbanDoneCategory, notes, notesById])
  const scheduleByNoteId = useMemo(() => {
    const grouped = new Map()
    timeSlots.forEach(slot => {
      const noteId = slot.noteId || slot.note_id
      if (!noteId) return
      const current = grouped.get(noteId)
      if (!current || (Number(slot.startCol ?? slot.start_col) || 0) < (Number(current.startCol ?? current.start_col) || 0)) {
        grouped.set(noteId, slot)
      }
    })
    const labels = new Map()
    grouped.forEach((slot, noteId) => {
      const label = scheduleLabelForSlot(project, slot)
      if (label) labels.set(noteId, label)
    })
    return labels
  }, [project, timeSlots])

  useEffect(() => {
    setVisibleStructureNoteIds(null)
    setCollapsedStructureNoteIds(new Set())
    setDetailModesByNoteId(new Map())
  }, [rootNoteId])

  useEffect(() => () => {
    Object.values(saveTimers.current).forEach(timer => window.clearTimeout(timer))
  }, [])

  const refreshClassificationData = useCallback(() => {
    Promise.all([
      api.getDimensions(),
      api.getAllCategories(),
      api.getAssignments(),
      api.getFilters(),
      api.getTimeSlots(),
      api.getPersonas(),
      api.getDirectPersonaNoteAssignments(),
    ])
      .then(([dimensions, categories, assignments, filters, slots, loadedPersonas, loadedPersonaNoteAssignments]) => {
        setClassificationDimensions(dimensions || [])
        setClassificationCategories(categories || [])
        setClassificationAssignments(assignments || [])
        setSavedFilters((filters || []).map(normalizeSavedFilter))
        setTimeSlots(slots || [])
        setPersonas(loadedPersonas || [])
        setPersonaNoteAssignments(loadedPersonaNoteAssignments || [])
      })
      .catch(error => {
        console.error('Failed to load report classification data', error)
      })
  }, [])

  useEffect(() => {
    if (!isActive) return
    refreshClassificationData()
  }, [isActive, assignmentsRefreshKey, refreshClassificationData])

  useEffect(() => {
    if (colorDimensionId && !reportDimensions.some(dimension => dimension.id === colorDimensionId)) {
      setColorDimensionId('')
      setPaintCat(null)
    }
  }, [colorDimensionId, reportDimensions])

  useEffect(() => {
    if (colorDimensionId || reportDimensions.length === 0) return
    const priorityDimension = reportDimensions.find(dimension => dimension.name === 'Priority')
    setColorDimensionId(priorityDimension?.id || reportDimensions[0]?.id || '')
  }, [colorDimensionId, reportDimensions])

  useEffect(() => {
    if (!isActive) {
      setFloatingPanel(null)
      setTypeContextMenu(null)
    }
  }, [isActive])

  useEffect(() => {
    if (!typeContextMenu) return undefined
    const close = () => setTypeContextMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [typeContextMenu])

  useEffect(() => {
    if (!pendingCreatedNoteId || !rowById.has(pendingCreatedNoteId)) return
    window.requestAnimationFrame(() => scrollToSection(pendingCreatedNoteId))
    setPendingCreatedNoteId(null)
  }, [pendingCreatedNoteId, rowById])

  const registerSection = (noteId, element) => {
    if (element) sectionRefs.current[noteId] = element
    else delete sectionRefs.current[noteId]
  }

  const markSaving = (noteId, saving) => {
    setSavingIds(previous => {
      const next = new Set(previous)
      if (saving) next.add(noteId)
      else next.delete(noteId)
      return next
    })
  }

  const saveNotePatch = (noteId, patch) => {
    onNoteUpdated?.(noteId, patch)
    pendingPatches.current[noteId] = { ...(pendingPatches.current[noteId] || {}), ...patch }
    markSaving(noteId, true)
    window.clearTimeout(saveTimers.current[noteId])
    saveTimers.current[noteId] = window.setTimeout(async () => {
      try {
        const pendingPatch = pendingPatches.current[noteId] || patch
        delete pendingPatches.current[noteId]
        await api.updateNote(noteId, pendingPatch)
      } catch (error) {
        console.error('Report note save failed', error)
      } finally {
        markSaving(noteId, false)
      }
    }, SAVE_DELAY)
  }

  const saveTitle = (noteId, rawTitle) => {
    const title = rawTitle.trim() || 'Untitled'
    if (rowById.get(noteId)?.note.title === title) return
    saveNotePatch(noteId, { title })
  }

  const saveBody = (noteId, html) => {
    if ((rowById.get(noteId)?.note.html || '') === html) return
    saveNotePatch(noteId, { html })
  }

  const scrollToSection = noteId => {
    sectionRefs.current[noteId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const createReportNote = useCallback(async ({ row, title, html = '', mode }) => {
    const trimmedTitle = String(title || '').trim()
    if (!row?.note?.id || !trimmedTitle) return null

    const isRootRow = row.note.id === rootNoteId || row.relation === 'current' || row.depth === 0
    const parentNoteId = mode === 'child' || isRootRow
      ? row.note.id
      : (row.note.parentNoteId || rootNoteId)
    if (!parentNoteId) return null

    const newNoteId = crypto.randomUUID()
    const createdNote = {
      id: newNoteId,
      parentNoteId,
      title: trimmedTitle,
      html,
      collapsed: false,
    }

    try {
      const savedNote = await api.createNote(createdNote)
      const noteToInsert = savedNote || createdNote
      if (mode === 'after' && !isRootRow) {
        const siblings = notes
          .filter(note => (note.parentNoteId || '') === (parentNoteId || '') && note.id !== noteToInsert.id)
          .sort(compareReportNoteOrder)
        const targetIndex = siblings.findIndex(note => note.id === row.note.id)
        if (targetIndex !== -1) {
          const reordered = [...siblings]
          reordered.splice(targetIndex + 1, 0, noteToInsert)
          await api.reorderNotes(reordered.map(note => note.id))
        }
      }

      playSound('noteCreate')
      setCollapsedStructureNoteIds(previous => {
        const next = new Set(previous)
        next.delete(parentNoteId)
        return next
      })
      if (collapsedStructureNoteIds.has(parentNoteId)) {
        setHierarchyToggleRequest({ id: crypto.randomUUID(), noteId: parentNoteId })
      }
      setVisibleStructureNoteIds(previous => {
        if (!previous) return previous
        return new Set([...previous, parentNoteId, row.note.id, noteToInsert.id])
      })
      await onNotesChanged?.()
      setPendingCreatedNoteId(noteToInsert.id)
      return noteToInsert
    } catch (error) {
      console.error('Report note create failed', error)
      return null
    }
  }, [collapsedStructureNoteIds, notes, onNotesChanged, rootNoteId])

  const syncVisibleStructureNoteIds = useCallback(ids => {
    const nextIds = Array.isArray(ids) ? ids : []
    setVisibleStructureNoteIds(previous => {
      const previousKey = previous ? [...previous].join('|') : ''
      const nextKey = nextIds.join('|')
      if (previousKey === nextKey) return previous
      return new Set(nextIds)
    })
  }, [])

  const syncCollapsedStructureNoteIds = useCallback(ids => {
    const nextIds = Array.isArray(ids) ? ids : []
    setCollapsedStructureNoteIds(previous => {
      const previousKey = [...previous].join('|')
      const nextKey = nextIds.join('|')
      if (previousKey === nextKey) return previous
      return new Set(nextIds)
    })
  }, [])

  const requestHierarchyToggle = noteId => {
    setCollapsedStructureNoteIds(previous => {
      const next = new Set(previous)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
    setHierarchyToggleRequest({ id: crypto.randomUUID(), noteId })
  }

  const toggleDetails = noteId => {
    setDetailModesByNoteId(previous => {
      const next = new Map(previous)
      const current = next.get(noteId) || DETAIL_MODE_ALL
      const nextMode = current === DETAIL_MODE_ALL
        ? DETAIL_MODE_DESCRIPTION
        : current === DETAIL_MODE_DESCRIPTION
          ? DETAIL_MODE_NONE
          : DETAIL_MODE_ALL
      if (nextMode === DETAIL_MODE_ALL) next.delete(noteId)
      else next.set(noteId, nextMode)
      return next
    })
  }

  const collapseAllDetails = () => {
    setDetailModesByNoteId(new Map(numberedRows.map(row => [row.note.id, DETAIL_MODE_NONE])))
    setReportSettingsOpen(false)
  }

  const expandAllDetails = () => {
    setDetailModesByNoteId(new Map())
    setReportSettingsOpen(false)
  }

  const openTypeContextMenu = (event, noteId) => {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 190
    const menuHeight = 54
    setTypeContextMenu({
      noteId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    })
  }

  const toggleDone = async noteId => {
    if (!noteId || !kanbanDoneCategory) {
      setTypeContextMenu(null)
      return
    }
    const doneInfo = doneInfoByNoteId.get(String(noteId)) || { explicit: false }
    const dimensionId = kanbanDoneCategory.dimensionId
    setTypeContextMenu(null)
    playSound('settingToggle')
    setClassificationAssignments(previous => {
      const withoutDone = previous.filter(assignment => {
        const assignmentNoteId = assignment.noteId || assignment.note_id
        const assignmentDimensionId = assignment.dimensionId || assignment.dimension_id
        return !(assignmentNoteId === noteId && assignmentDimensionId === dimensionId)
      })
      if (doneInfo.explicit) return withoutDone
      return [...withoutDone, { noteId, dimensionId, categoryId: kanbanDoneCategory.id }]
    })
    try {
      if (doneInfo.explicit) await api.unassign(noteId, dimensionId)
      else await api.assign(noteId, dimensionId, kanbanDoneCategory.id)
    } catch (error) {
      console.error(error)
      refreshClassificationData()
    }
  }

  const activatePaint = (catId, color) => {
    const deactivating = paintCat?.id === catId
    playSound(deactivating ? 'paintModeDeactivate' : 'paintModeActivate')
    setPaintPersonaId(null)
    setPaintCat(previous => previous?.id === catId ? null : { id: catId, color })
  }

  const paintNote = async noteId => {
    if (!paintCat || !colorDimensionId) return
    playSound('paintApply')
    try {
      if (paintCat.id === COLOR_UNASSIGNED_CATEGORY_ID) {
        await api.unassign(noteId, colorDimensionId)
        setClassificationAssignments(previous => previous.filter(assignment => {
          const assignmentNoteId = assignment.noteId || assignment.note_id
          const assignmentDimensionId = assignment.dimensionId || assignment.dimension_id
          return !(assignmentNoteId === noteId && assignmentDimensionId === colorDimensionId)
        }))
        return
      }

      await api.assign(noteId, colorDimensionId, paintCat.id)
      setClassificationAssignments(previous => [
        ...previous.filter(assignment => {
          const assignmentNoteId = assignment.noteId || assignment.note_id
          const assignmentDimensionId = assignment.dimensionId || assignment.dimension_id
          return !(assignmentNoteId === noteId && assignmentDimensionId === colorDimensionId)
        }),
        { noteId, dimensionId: colorDimensionId, categoryId: paintCat.id },
      ])
    } catch (error) {
      console.error(error)
      refreshClassificationData()
    }
  }

  const paintPersonaToNote = async noteId => {
    if (!paintPersonaId) return
    playSound('personaAssign')
    setPersonaNoteAssignments(previous => [
      ...previous.filter(assignment => !(
        (assignment.personaId || assignment.persona_id) === paintPersonaId &&
        (assignment.noteId || assignment.note_id) === noteId
      )),
      { personaId: paintPersonaId, noteId },
    ])
    try {
      await api.assignPersonaToNote(paintPersonaId, noteId)
    } catch (error) {
      console.error(error)
      api.getDirectPersonaNoteAssignments()
        .then(items => setPersonaNoteAssignments(items || []))
        .catch(console.error)
    }
  }

  const startStructureResize = event => {
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const reportLeft = reportRef.current?.getBoundingClientRect().left || 0

    const resize = pointerEvent => {
      const nextWidth = Math.max(STRUCTURE_COLLAPSED_WIDTH, pointerEvent.clientX - reportLeft)
      if (nextWidth < STRUCTURE_MIN_WIDTH - 70) {
        setStructureCollapsed(true)
        return
      }
      setStructureCollapsed(false)
      setStructureWidth(Math.min(STRUCTURE_MAX_WIDTH, Math.max(STRUCTURE_MIN_WIDTH, nextWidth)))
    }

    const stopResize = () => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stopResize)
      document.body.classList.remove(styles.resizingStructure)
    }

    document.body.classList.add(styles.resizingStructure)
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize)
  }

  if (!rows.length) {
    return (
      <main className={styles.reportPage}>
        <div className={styles.emptyState}>No report structure available.</div>
      </main>
    )
  }

  return (
    <main
      ref={reportRef}
      className={styles.reportPage}
      style={{
        '--structure-width': `${structureCollapsed ? STRUCTURE_COLLAPSED_WIDTH : structureWidth}px`,
        cursor: paintCat ? makeColorCursor(paintCat.color) : personaCursor || undefined,
      }}
      dir="ltr">
      <aside className={`${styles.structureRail} ${structureCollapsed ? styles.structureRailCollapsed : ''}`} aria-label="Report structure">
        <button
          type="button"
          className={styles.structureFoldBtn}
          onClick={() => setStructureCollapsed(collapsed => !collapsed)}
          title={structureCollapsed ? 'Expand structure sidebar' : 'Fold structure sidebar'}
          aria-label={structureCollapsed ? 'Expand structure sidebar' : 'Fold structure sidebar'}>
          {structureCollapsed ? '›' : '‹'}
        </button>
        {structureCollapsed ? (
          <button
            type="button"
            className={styles.structureCollapsedTab}
            onClick={() => setStructureCollapsed(false)}
            title="Expand structure sidebar">
            Structure
          </button>
        ) : (
          <ProjectDashboard
            project={project}
            notes={notes}
            workspaceRootNote={workspaceRootNote}
            workspaceNote={workspaceNote}
            onUpdate={onProjectUpdate}
            onWorkspaceNoteUpdated={onWorkspaceNoteUpdated}
            onWorkspaceOpen={onWorkspaceOpen}
            onNoteOpen={onNoteOpen}
            onNotesChanged={onNotesChanged}
            onProjectDeleted={onProjectDeleted}
            isActive={isActive}
            structureOnly
            embeddedStructure
            hierarchyToggleRequest={hierarchyToggleRequest}
            onVisibleHierarchyNoteIdsChange={syncVisibleStructureNoteIds}
            onCollapsedHierarchyNoteIdsChange={syncCollapsedStructureNoteIds}
            assignmentsRefreshKey={assignmentsRefreshKey}
          />
        )}
        <div
          className={styles.structureResizeHandle}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize structure sidebar"
          onPointerDown={startStructureResize}
        />
      </aside>

      <div className={styles.documentPane}>
        <div className={styles.reportToolbar}>
          <button
            type="button"
            className={`${styles.reportToolbarButton} ${reportSettingsOpen ? styles.reportToolbarButtonActive : ''}`}
            onClick={() => setReportSettingsOpen(open => !open)}
            title="Report settings"
            aria-label="Report settings"
            aria-expanded={reportSettingsOpen}>
            <Settings size={16} strokeWidth={2.2} />
          </button>
          {reportSettingsOpen && (
            <div className={styles.reportSettingsPanel}>
              <button type="button" className={styles.reportSettingsAction} onClick={collapseAllDetails}>
                <EyeOff size={15} strokeWidth={2.2} />
                <span>Collapse all descriptions</span>
              </button>
              <button type="button" className={styles.reportSettingsAction} onClick={expandAllDetails}>
                <Eye size={15} strokeWidth={2.2} />
                <span>Expand all descriptions</span>
              </button>
            </div>
          )}
        </div>
        {typeContextMenu && (() => {
          const doneInfo = doneInfoByNoteId.get(String(typeContextMenu.noteId)) || { done: false, explicit: false, inherited: false }
          return (
            <div
              className={styles.typeContextMenu}
              style={{ left: typeContextMenu.x, top: typeContextMenu.y }}
              role="menu"
              onPointerDown={event => event.stopPropagation()}>
              <button type="button" role="menuitem" onClick={() => toggleDone(typeContextMenu.noteId)}>
                {doneInfo.explicit
                  ? 'Mark as undone'
                  : doneInfo.inherited
                    ? 'Mark this note as done'
                    : 'Mark as done'}
              </button>
            </div>
          )
        })()}
        <article className={styles.sheet} data-depth-span={visibleDepthSpan} dir="ltr">
          {visibleReportRows.map((row, index) => {
            const isRootRow = row.note.id === rootNoteId || row.relation === 'current' || row.depth === 0
            const previousRow = visibleReportRows[index - 1]
            const nextRow = visibleReportRows[index + 1]
            const displayDepth = Math.max(0, row.depth - 1)
            const hasVisibleChildAfter = nextRow && nextRow.depth > row.depth
            const primaryInsertMode = isRootRow || hasVisibleChildAfter ? 'child' : 'after'
            const levelRise = previousRow ? Math.max(0, previousRow.depth - row.depth) : 0
            const sameLevel = previousRow && previousRow.depth === row.depth
            const deeperLevel = previousRow && previousRow.depth < row.depth
            const spacing = visibleDepthSpan === 'shallow'
              ? { riseBase: 6, riseStep: 5, sameBase: 6, childBase: 2 }
              : visibleDepthSpan === 'medium'
                ? { riseBase: 10, riseStep: 8, sameBase: 9, childBase: 4 }
                : { riseBase: 14, riseStep: 12, sameBase: 12, childBase: 6 }
            const sectionTopGap = index === 0
              ? 0
              : levelRise > 0
                ? spacing.riseBase + levelRise * spacing.riseStep
                : sameLevel
                  ? Math.max(2, spacing.sameBase - row.depth * 2)
                  : deeperLevel
                    ? Math.max(0, spacing.childBase - row.depth * 2)
                    : 0
            return (
              <div
                key={row.note.id}
                className={styles.sectionBlock}
                data-depth={row.depth}
                data-has-branch={displayDepth > 1 ? 'true' : undefined}
                style={{
                  '--section-top-gap': `${sectionTopGap}px`,
                  '--report-tree-depth': displayDepth,
                }}>
                <ReportSection
                  row={row}
                  project={project}
                  isProjectRoot={row.note.id === project?.rootNoteId}
                  childrenCollapsed={collapsedStructureNoteIds.has(row.note.id)}
                  attributes={reportAttributesByNoteId.get(row.note.id) || []}
                  detailMode={detailModesByNoteId.get(row.note.id) || DETAIL_MODE_ALL}
                  activeColor={activeColorByNoteId.get(row.note.id)}
                  sideMeta={{
                    typeCategory: typeCategoryByNoteId.get(row.note.id),
                    doneInfo: doneInfoByNoteId.get(String(row.note.id)),
                    people: peopleByNoteId.get(row.note.id) || [],
                    schedule: scheduleByNoteId.get(row.note.id),
                  }}
                  paintCat={paintCat}
                  paintPersonaId={paintPersonaId}
                  registerSection={registerSection}
                  onTitleChange={saveTitle}
                  onBodyChange={saveBody}
                  onToggleChildren={requestHierarchyToggle}
                  onToggleDetails={toggleDetails}
                  onTypeContextMenu={openTypeContextMenu}
                  onPaint={paintNote}
                  onPersonaPaint={paintPersonaToNote}
                />
                <ReportInsertPoint row={row} primaryMode={primaryInsertMode} onCreate={createReportNote} />
              </div>
            )
          })}
          <ReportEndInsert rootRow={rootReportRow} onCreate={createReportNote} />
        </article>
        {savingIds.size > 0 && <div className={styles.saveStatus}>Saving...</div>}
        <div className={styles.reportFloatingTools}>
          <StandardColorPicker
            dimensions={reportDimensions}
            categories={reportCategories}
            colorDimensionId={colorDimensionId}
            onColorDimensionChange={setColorDimensionId}
            onDimensionDataChanged={refreshClassificationData}
            paintCategoryId={paintCat?.id}
            onPaintCategory={activatePaint}
            hint="Browse report categories"
            align="right"
            expanded={floatingPanel === 'color'}
            onExpandedChange={open => setFloatingPanel(open ? 'color' : null)}
          />
          <PeopleWidget
            paintPersonaId={paintPersonaId}
            onPaintPersonaChange={id => { setPaintCat(null); setPaintPersonaId(id) }}
            expanded={floatingPanel === 'people'}
            onExpandedChange={open => setFloatingPanel(open ? 'people' : null)}
            refreshKey={assignmentsRefreshKey}
            iconSize={22}
            size="large"
          />
        </div>
      </div>
    </main>
  )
}
