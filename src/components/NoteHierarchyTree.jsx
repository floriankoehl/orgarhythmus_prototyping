import { CategoryIconGlyph, DEFAULT_TYPE_ICONS } from './iconRegistry'
import styles from './NoteHierarchyTree.module.css'

function descriptionText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function formatCreatedAt(value) {
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

function compareNotes(a, b) {
  const aOrder = a.orderIdx ?? a.order_idx ?? Number.MIN_SAFE_INTEGER
  const bOrder = b.orderIdx ?? b.order_idx ?? Number.MIN_SAFE_INTEGER
  if (aOrder !== bOrder) return aOrder - bOrder
  return String(a.title || '').localeCompare(String(b.title || ''))
}

export function buildNoteHierarchyRows(notes, rootNoteId, { includeAncestors = false, includeRoot = true } = {}) {
  if (!rootNoteId) return []
  const notesById = new Map(notes.map(note => [note.id, note]))
  const root = notesById.get(rootNoteId)
  if (!root) return []

  const childrenByParent = new Map()
  notes.forEach(note => {
    if (!note.parentNoteId) return
    if (!childrenByParent.has(note.parentNoteId)) childrenByParent.set(note.parentNoteId, [])
    childrenByParent.get(note.parentNoteId).push(note)
  })
  childrenByParent.forEach(children => children.sort(compareNotes))

  const rows = []
  const seen = new Set()
  let baseDepth = 0
  if (includeAncestors) {
    const path = []
    let current = root
    while (current && !seen.has(current.id)) {
      path.unshift(current)
      seen.add(current.id)
      current = current.parentNoteId ? notesById.get(current.parentNoteId) : null
    }
    seen.clear()
    path.forEach((note, depth) => {
      rows.push({
        note,
        depth,
        relation: note.id === rootNoteId ? 'current' : 'ancestor',
        hasChildren: (childrenByParent.get(note.id) || []).length > 0,
      })
      seen.add(note.id)
    })
    baseDepth = path.length
  } else if (includeRoot) {
    rows.push({
      note: root,
      depth: 0,
      relation: 'current',
      hasChildren: (childrenByParent.get(root.id) || []).length > 0,
    })
    seen.add(root.id)
    baseDepth = 1
  }

  const visitChildren = (parentId, depth) => {
    ;(childrenByParent.get(parentId) || []).forEach(child => {
      if (seen.has(child.id)) return
      seen.add(child.id)
      rows.push({
        note: child,
        depth,
        relation: depth === baseDepth ? 'child' : 'descendant',
        hasChildren: (childrenByParent.get(child.id) || []).length > 0,
      })
      visitChildren(child.id, depth + 1)
    })
  }
  visitChildren(rootNoteId, baseDepth)
  return rows
}

export function HierarchyTypeIcon({ hasChildren }) {
  if (hasChildren) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v7A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3.5h7l3 3V20a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z" />
      <path d="M14 3.5V7h3.5" />
      <path d="M9 11h6M9 14.5h6" />
    </svg>
  )
}

function NoteCategoryIcon({ icon, role }) {
  return <CategoryIconGlyph icon={icon || DEFAULT_TYPE_ICONS[role] || DEFAULT_TYPE_ICONS.thought} />
}

export function DoneKindIcon() {
  return (
    <svg className={styles.hierarchyDoneIcon} viewBox="0 0 20 20" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect className={styles.hierarchyDoneIconBox} x="2.8" y="2.8" width="14.4" height="14.4" rx="2.8" />
      <path className={styles.hierarchyDoneIconCheck} d="M6.6 10.2 9 12.6 13.7 7.5" />
    </svg>
  )
}

export default function NoteHierarchyTree({
  rows,
  rootNoteId,
  projectRootNoteId = null,
  project = null,
  localBaseDepth = 0,
  selectedIds = new Set(),
  draggedIds = new Set(),
  dropTargetId = null,
  reorderDragId = null,
  reorderTarget = null,
  isExpanded,
  onToggle,
  onSelect,
  onOpenWorkspace,
  onOpenDetails,
  onContextMenu,
  onMove,
  onReorder,
  onDragStartIds,
  onDragStateChange,
  onReorderDragStateChange,
  onClearSelection,
  colorByNoteId = null,
  getNoteDoneInfo = null,
  getNoteTypeInfo = null,
  getNoteOverview = null,
  showHierarchyTypeIcon = true,
  paintCategoryId = '',
  paintCursor = '',
  ariaLabel = 'Note hierarchy',
}) {
  const rowById = new Map(rows.map(row => [row.note.id, row]))
  const reorderDragParentId = reorderDragId ? (rowById.get(reorderDragId)?.note.parentNoteId || '') : null
  return (
    <div
      className={[
        styles.hierarchyTree,
        reorderDragId && styles.hierarchyTreeReordering,
        paintCursor && styles.hierarchyTreePaintMode,
      ].filter(Boolean).join(' ')}
      style={paintCursor ? { '--paint-cursor': paintCursor, cursor: paintCursor } : undefined}
      role="tree"
      aria-multiselectable="true"
      aria-label={ariaLabel}
      onClick={event => {
        if (event.target === event.currentTarget) onClearSelection?.()
      }}
      onContextMenu={event => onContextMenu?.(event, rootNoteId)}>
      {rows.map(({ note, depth, hasChildren }) => {
        const isCurrent = note.id === rootNoteId
        const isProjectRoot = note.id === projectRootNoteId
        const displayTitle = isProjectRoot && project?.name ? project.name : note.title
        const hoverDescription = descriptionText(isProjectRoot && project?.description ? project.description : note.html)
        const displayDepth = Math.max(0, depth - localBaseDepth)
        const expanded = hasChildren && isExpanded?.(note.id)
        const selected = selectedIds.has(note.id)
        const reorderSibling = reorderDragId && (note.parentNoteId || '') === reorderDragParentId
        const reorderPosition = reorderTarget?.noteId === note.id ? reorderTarget.position : null
        const createdLabel = formatCreatedAt(note.createdAt || (isProjectRoot ? project?.createdAt : ''))
        const color = colorByNoteId?.[note.id]
        const doneInfo = getNoteDoneInfo?.(note.id)
        const done = Boolean(doneInfo?.done)
        const doneLabel = doneInfo?.inherited
          ? `Done via ${doneInfo.inheritedFrom?.title || 'parent'}`
          : 'Done'
        const typeInfo = getNoteTypeInfo?.(note.id)
        const typeRole = typeInfo?.role || 'thought'
        const typeLabel = typeInfo?.label || 'Thought'
        const typeIcon = typeInfo?.icon || ''
        const overviewLabel = getNoteOverview?.(note.id)
        const overviewRows = overviewLabel
          ? overviewLabel.split('\n').map(line => {
            const [label, ...valueParts] = line.split(':')
            return { label: label.trim(), value: valueParts.join(':').trim() }
          })
          : []
        const hoverTitle = [
          createdLabel ? `Created ${createdLabel}` : '',
          hoverDescription || `Double-click to open ${displayTitle || 'Untitled'} details`,
        ].filter(Boolean).join('\n')
        return (
          <div
            key={note.id}
            className={[
              styles.hierarchyRow,
              isCurrent && styles.hierarchyRowCurrent,
              selected && styles.hierarchyRowSelected,
              dropTargetId === note.id && !draggedIds.has(note.id) && styles.hierarchyRowDropTarget,
              draggedIds.has(note.id) && styles.hierarchyRowDragging,
              reorderDragId && reorderSibling && styles.hierarchyRowReorderSibling,
              reorderDragId && !reorderSibling && styles.hierarchyRowReorderOutside,
              reorderPosition === 'before' && styles.hierarchyRowReorderBefore,
              reorderPosition === 'after' && styles.hierarchyRowReorderAfter,
            ].filter(Boolean).join(' ')}
            style={{
              '--tree-depth': displayDepth,
              ...(paintCursor ? { cursor: paintCursor } : {}),
            }}
            role="treeitem"
            aria-current={isCurrent ? 'page' : undefined}
            aria-level={displayDepth + 1}
            draggable={!isProjectRoot && !paintCursor}
            onContextMenu={event => onContextMenu?.(event, note.id)}
            onDragStart={event => {
              if (event.dataTransfer.types.includes('hierarchy-note-reorder-id')) return
              if (isProjectRoot) return
              const dragged = onDragStartIds?.(note.id) || [note.id]
              event.dataTransfer.setData('project-hierarchy-note-ids', JSON.stringify(dragged))
              event.dataTransfer.setData('project-hierarchy-note-id', note.id)
              event.dataTransfer.effectAllowed = 'move'
              onDragStateChange?.({ draggedIds: new Set(dragged), selectedId: note.id })
            }}
            onDragOver={event => {
              if (event.dataTransfer.types.includes('hierarchy-note-reorder-id')) {
                const reorderNoteId = event.dataTransfer.getData('hierarchy-note-reorder-id') || reorderDragId
                const reorderNote = rowById.get(reorderNoteId)?.note
                if (!reorderNote || reorderNote.id === note.id || (reorderNote.parentNoteId || '') !== (note.parentNoteId || '')) {
                  onReorderDragStateChange?.({ target: null })
                  return
                }
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const rect = event.currentTarget.getBoundingClientRect()
                const position = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
                onReorderDragStateChange?.({ target: { noteId: note.id, position } })
                return
              }
              if (!event.dataTransfer.types.includes('project-hierarchy-note-ids') && !event.dataTransfer.types.includes('project-hierarchy-note-id')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              onDragStateChange?.({ dropTargetId: note.id })
            }}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                onDragStateChange?.({ dropTargetId: null, onlyIfDropTargetId: note.id })
                onReorderDragStateChange?.({ target: null, onlyIfTargetId: note.id })
              }
            }}
            onDrop={event => {
              event.preventDefault()
              const reorderNoteId = event.dataTransfer.getData('hierarchy-note-reorder-id')
              if (reorderNoteId) {
                const position = reorderTarget?.noteId === note.id ? reorderTarget.position : 'before'
                onReorderDragStateChange?.({ dragId: null, target: null })
                onReorder?.(reorderNoteId, note.id, position)
                return
              }
              const rawMovedNoteIds = event.dataTransfer.getData('project-hierarchy-note-ids')
              const fallbackMovedNoteId = event.dataTransfer.getData('project-hierarchy-note-id')
              let movedNoteIds = fallbackMovedNoteId ? [fallbackMovedNoteId] : []
              try {
                const parsed = JSON.parse(rawMovedNoteIds)
                if (Array.isArray(parsed)) movedNoteIds = parsed
              } catch {}
              onDragStateChange?.({ dropTargetId: null, draggedIds: new Set() })
              onMove?.(movedNoteIds, note.id)
            }}
            onDragEnd={() => {
              onDragStateChange?.({ dropTargetId: null, draggedIds: new Set() })
              onReorderDragStateChange?.({ dragId: null, target: null })
            }}>
            <span className={styles.hierarchyBranch} aria-hidden="true" />
            <div className={styles.hierarchyNodeLine} style={paintCursor ? { cursor: paintCursor } : undefined}>
              {hasChildren ? (
                <button
                  type="button"
                  className={`${styles.hierarchyExpandBtn} ${expanded ? styles.hierarchyExpandBtnOpen : ''}`}
                  style={paintCursor ? { cursor: paintCursor } : undefined}
                  aria-label={expanded ? `Collapse ${displayTitle || 'project'}` : `Expand ${displayTitle || 'project'}`}
                  aria-expanded={expanded}
                  draggable={false}
                  onMouseDown={event => event.stopPropagation()}
                  onClick={event => {
                    event.stopPropagation()
                    onToggle?.(note.id)
                  }}>
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M7 5.5 12 10l-5 4.5z" />
                  </svg>
                </button>
              ) : (
                <span className={styles.hierarchyExpandSpacer} aria-hidden="true" />
              )}
              <button
                type="button"
                className={[
                  styles.hierarchyNode,
                  !showHierarchyTypeIcon && styles.hierarchyNodeNoFileIcon,
                  (paintCategoryId || paintCursor) && styles.hierarchyNodePaintMode,
                ].filter(Boolean).join(' ')}
                style={{
                  ...(color ? { '--hierarchy-color': color } : {}),
                  ...(color ? { borderLeftColor: color, background: `${color}28` } : {}),
                  ...(paintCursor ? { cursor: paintCursor } : {}),
                }}
                aria-selected={selected}
                onClick={event => onSelect?.(event, note.id)}
                onDoubleClick={event => {
                  event.stopPropagation()
                  onOpenDetails?.(note.id)
                }}
                title={overviewRows.length ? undefined : hoverTitle}>
                <span
                  className={[
                    styles.hierarchyReorderHandle,
                    (isProjectRoot || isCurrent) && styles.hierarchyReorderHandleDisabled,
                  ].filter(Boolean).join(' ')}
                  draggable={!isProjectRoot && !isCurrent}
                  title={!isProjectRoot && !isCurrent ? 'Drag to reorder inside this parent note' : 'This root row cannot be reordered'}
                  aria-label="Reorder note"
                  onMouseDown={event => {
                    event.stopPropagation()
                    if (isProjectRoot || isCurrent || paintCursor) event.preventDefault()
                  }}
                  onClick={event => event.stopPropagation()}
                  onDragStart={event => {
                    if (isProjectRoot || isCurrent || paintCursor) {
                      event.preventDefault()
                      return
                    }
                    event.stopPropagation()
                    event.dataTransfer.setData('hierarchy-note-reorder-id', note.id)
                    event.dataTransfer.effectAllowed = 'move'
                    onReorderDragStateChange?.({ dragId: note.id, target: null })
                  }}
                  onDragEnd={event => {
                    event.stopPropagation()
                    onReorderDragStateChange?.({ dragId: null, target: null })
                  }}>
                  <span aria-hidden="true">⋮⋮</span>
                </span>
                {showHierarchyTypeIcon && (
                  <span
                    className={`${styles.hierarchyIcon} ${hasChildren ? styles.hierarchyProjectIcon : styles.hierarchyNoteIcon}`}
                    title={hasChildren ? 'Project · contains child notes' : 'Note · no child notes'}>
                    <HierarchyTypeIcon hasChildren={hasChildren} />
                  </span>
                )}
                <span
                  className={[
                    styles.hierarchyDoneBadgeSlot,
                    overviewRows.length && styles.hierarchyOverviewAnchor,
                    done && styles.hierarchyDoneBadge,
                    doneInfo?.inherited && styles.hierarchyDoneBadgeInherited,
                    !done && typeInfo && styles[`hierarchyTypeBadge${typeRole[0].toUpperCase()}${typeRole.slice(1)}`],
                  ].filter(Boolean).join(' ')}
                  style={!done && typeInfo?.color ? { color: typeInfo.color } : undefined}
                  title={overviewRows.length ? undefined : (done ? doneLabel : typeInfo ? typeLabel : undefined)}
                  aria-label={overviewLabel || (done ? doneLabel : typeInfo ? typeLabel : undefined)}
                  aria-hidden={done || typeInfo ? undefined : 'true'}
                >
                  {done ? <DoneKindIcon /> : typeInfo ? <NoteCategoryIcon role={typeRole} icon={typeIcon} /> : ''}
                  {overviewRows.length > 0 && (
                    <span className={styles.hierarchyOverviewTooltip} role="tooltip">
                      {overviewRows.map(row => (
                        <span key={row.label} className={styles.hierarchyOverviewRow}>
                          <span className={styles.hierarchyOverviewLabel}>{row.label}</span>
                          <span className={styles.hierarchyOverviewValue}>{row.value}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className={styles.hierarchyTitle}>{displayTitle || 'Untitled'}</span>
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
