import { useState, useEffect, useRef, useCallback } from 'react'
import { projectsApi } from '../api'
import styles from './ProjectDashboard.module.css'

const PROJECT_METRICS = [
  { value: 'days',   label: 'Days' },
  { value: 'weeks',  label: 'Weeks' },
  { value: 'months', label: 'Months' },
  { value: 'hours',  label: 'Hours' },
]

const STAT_LABELS = {
  goals:        'Goals',
  milestones:   'Milestones',
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
  const [metric,      setMetric]      = useState(project.metric || 'days')
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
    setMetric(project.metric || 'days')
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

  const handleMetricChange = (e) => {
    const val = e.target.value
    setMetric(val)
    persist({ metric: val })
    onUpdate({ ...project, metric: val })
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const data = await projectsApi.exportDatabase()
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
    <div className={styles.page}>
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

        {/* Footer row: metric + export */}
        <div className={styles.footerRow}>
          <div className={styles.metricRow}>
            <label className={styles.metricLabel} htmlFor="metric-select">Metric</label>
            <select
              id="metric-select"
              className={styles.metricSelect}
              value={metric}
              onChange={handleMetricChange}
            >
              {PROJECT_METRICS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <button
            className={styles.exportBtn}
            onClick={handleExport}
            disabled={exporting}
            title="Download a JSON snapshot of all projects and data"
          >
            {exporting ? 'Saving…' : 'Save snapshot'}
          </button>
        </div>

      </div>
    </div>
  )
}
