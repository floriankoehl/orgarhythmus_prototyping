import { useState, useEffect, useRef, useCallback } from 'react'
import { projectsApi } from '../api'
import styles from './ProjectDashboard.module.css'

const STAT_LABELS = {
  notes:        'Notes',
  timeSlots:   'Time slots',
  dimensions:   'Dimensions',
  categories:   'Categories',
  dependencies: 'Dependencies',
  perspectives: 'Perspectives',
}

function StatCard({ label, value }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statValue}>{value ?? '—'}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

export default function ProjectDashboard({ project, onUpdate, isActive }) {
  const [name,        setName]        = useState(project.name)
  const [desc,        setDesc]        = useState(project.description || '')
  const [startDate,   setStartDate]   = useState(project.startDate || '')
  const [endDate,     setEndDate]     = useState(project.endDate || '')
  const [stats,       setStats]       = useState(null)
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [draftDesc,   setDraftDesc]   = useState(project.description || '')
  const [exporting,   setExporting]   = useState(false)
  const nameInputRef = useRef()
  const saveTimerRef = useRef(null)

  useEffect(() => {
    setName(project.name)
    setDesc(project.description || '')
    setDraftDesc(project.description || '')
    setStartDate(project.startDate || '')
    setEndDate(project.endDate || '')
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isActive) {
      projectsApi.getProjectStats(project.id).then(setStats).catch(console.error)
    }
  }, [project.id, isActive])

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus()
  }, [editingName])

  const persist = useCallback((patch) => {
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      const updated = await projectsApi.updateProject(project.id, patch)
      onUpdate(updated)
    }, 400)
  }, [project.id, onUpdate])

  const handleNameBlur = () => {
    setEditingName(false)
    const trimmed = name.trim() || project.name
    setName(trimmed)
    if (trimmed !== project.name) persist({ name: trimmed })
  }

  const handleNameKey = e => {
    if (e.key === 'Enter' || e.key === 'Escape') nameInputRef.current?.blur()
  }

  const handleDescSave = () => {
    setDesc(draftDesc)
    setEditingDesc(false)
    persist({ description: draftDesc })
  }

  const handleDescCancel = () => {
    setDraftDesc(desc)
    setEditingDesc(false)
  }

  const handleStartDateBlur = () => {
    if (startDate !== (project.startDate || '')) persist({ startDate })
  }

  const handleEndDateBlur = () => {
    if (endDate !== (project.endDate || '')) persist({ endDate })
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
          <div className={styles.dateRow}>
            <div className={styles.dateField}>
              <label className={styles.dateLabel}>Start date</label>
              <input
                type="date"
                className={styles.dateInput}
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                onBlur={handleStartDateBlur}
              />
            </div>
            <div className={styles.dateField}>
              <label className={styles.dateLabel}>End date <span className={styles.dateOptional}>(optional)</span></label>
              <input
                type="date"
                className={styles.dateInput}
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                onBlur={handleEndDateBlur}
              />
            </div>
          </div>
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
    </div>
  )
}
