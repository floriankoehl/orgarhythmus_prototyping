import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { usePersonaCursor } from '../hooks/usePersonaCursor'
import { playSound } from '../sounds/sound_registry'
import { buildNoteHierarchyRows } from './NoteHierarchyTree'
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

function ReportInsertPoint({ row, primaryMode, initiallyOpen = false, hoverIntent = true, onCreate }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [draftTitle, setDraftTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [hoverReady, setHoverReady] = useState(false)
  const hoverTimer = useRef(null)
  const primaryLabel = primaryMode === 'child' ? 'inside' : 'below'
  const secondaryMode = primaryMode === 'child' ? 'after' : 'child'
  const canAddBelow = row.depth > 0 && Boolean(row.note.parentNoteId)

  const clearHoverTimer = useCallback(() => {
    if (!hoverTimer.current) return
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }, [])

  const scheduleHoverReady = useCallback(() => {
    if (!hoverIntent || open) {
      setHoverReady(true)
      return
    }
    setHoverReady(false)
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      setHoverReady(true)
      hoverTimer.current = null
    }, 180)
  }, [clearHoverTimer, hoverIntent, open])

  const resetHoverReady = useCallback(() => {
    clearHoverTimer()
    setHoverReady(false)
  }, [clearHoverTimer])

  useEffect(() => () => clearHoverTimer(), [clearHoverTimer])

  const submit = async mode => {
    const title = draftTitle.trim()
    if (!title || creating) return
    setCreating(true)
    const created = await onCreate({ row, title, mode })
    setCreating(false)
    if (created) {
      setDraftTitle('')
      setOpen(false)
    }
  }

  if (!open) {
    return (
      <div
        className={styles.insertPoint}
        data-hover-ready={hoverReady ? 'true' : undefined}
        onPointerEnter={scheduleHoverReady}
        onPointerMove={scheduleHoverReady}
        onPointerLeave={resetHoverReady}>
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
      className={styles.insertEditor}
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
            setDraftTitle('')
            setOpen(false)
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

function ReportSection({ row, project, isProjectRoot, childrenCollapsed, attributes, detailsVisible, activeColor, sideMeta, paintCat, paintPersonaId, registerSection, onTitleChange, onBodyChange, onToggleChildren, onToggleDetails, onPaint, onPersonaPaint }) {
  const title = isProjectRoot && project?.name ? project.name : row.note.title || 'Untitled'
  const body = isProjectRoot && project?.description ? project.description : row.note.html || ''
  const isReportRoot = row.relation === 'current' || row.depth === 0
  const headingLevel = isReportRoot ? 1 : Math.min(6, row.depth + 1)
  const HeadingTag = `h${headingLevel}`

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
        <button
          type="button"
          className={styles.headingTypeIcon}
          style={{ '--attribute-color': sideMeta.typeCategory?.color || '#64748b' }}
          onClick={() => onToggleDetails(row.note.id)}
          title={detailsVisible ? 'Hide note details' : 'Show note details'}
          aria-label={detailsVisible ? `Hide details for ${title}` : `Show details for ${title}`}
          aria-pressed={detailsVisible}>
          <CategoryIconGlyph icon={iconForCategory(sideMeta.typeCategory)} strokeWidth={2.35} />
        </button>
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
        {detailsVisible && (
          <>
            <ReportAttributes attributes={attributes} />
            <EditableBody
              html={body}
              editable={!isProjectRoot}
              onChange={html => onBodyChange(row.note.id, html)}
            />
          </>
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
  const [hiddenDetailNoteIds, setHiddenDetailNoteIds] = useState(() => new Set())
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

  useEffect(() => {
    setVisibleStructureNoteIds(null)
    setCollapsedStructureNoteIds(new Set())
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
    }
  }, [isActive])

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

  const createReportNote = useCallback(async ({ row, title, mode }) => {
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
      html: '',
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
    setHiddenDetailNoteIds(previous => {
      const next = new Set(previous)
      if (next.has(noteId)) next.delete(noteId)
      else next.add(noteId)
      return next
    })
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
        <article className={styles.sheet} dir="ltr">
          {visibleReportRows.map((row, index) => {
            const isRootRow = row.note.id === rootNoteId || row.relation === 'current' || row.depth === 0
            const previousRow = visibleReportRows[index - 1]
            const nextRow = visibleReportRows[index + 1]
            const hasVisibleChildAfter = nextRow && nextRow.depth > row.depth
            const primaryInsertMode = isRootRow || hasVisibleChildAfter ? 'child' : 'after'
            const levelRise = previousRow ? Math.max(0, previousRow.depth - row.depth) : 0
            const sameLevel = previousRow && previousRow.depth === row.depth
            const deeperLevel = previousRow && previousRow.depth < row.depth
            const sectionTopGap = index === 0
              ? 0
              : levelRise > 0
                ? 14 + levelRise * 12
                : sameLevel
                  ? Math.max(4, 12 - row.depth * 2)
                  : deeperLevel
                    ? Math.max(0, 6 - row.depth * 2)
                    : 0
            return (
              <div
                key={row.note.id}
                className={styles.sectionBlock}
                style={{ '--section-top-gap': `${sectionTopGap}px` }}>
                <ReportSection
                  row={row}
                  project={project}
                  isProjectRoot={row.note.id === project?.rootNoteId}
                  childrenCollapsed={collapsedStructureNoteIds.has(row.note.id)}
                  attributes={reportAttributesByNoteId.get(row.note.id) || []}
                  detailsVisible={!hiddenDetailNoteIds.has(row.note.id)}
                  activeColor={activeColorByNoteId.get(row.note.id)}
                  sideMeta={{
                    typeCategory: typeCategoryByNoteId.get(row.note.id),
                    people: peopleByNoteId.get(row.note.id) || [],
                  }}
                  paintCat={paintCat}
                  paintPersonaId={paintPersonaId}
                  registerSection={registerSection}
                  onTitleChange={saveTitle}
                  onBodyChange={saveBody}
                  onToggleChildren={requestHierarchyToggle}
                  onToggleDetails={toggleDetails}
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
