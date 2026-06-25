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

export default function ProjectDashboard({ project, onUpdate, onBack, onEnterWorkspace }) {
  const [name,   setName]   = useState(project.name)
  const [desc,   setDesc]   = useState(project.description || '')
  const [metric, setMetric] = useState(project.metric || 'days')
  const [stats,  setStats]  = useState(null)
  const [editingName, setEditingName] = useState(false)
  const nameInputRef = useRef()
  const saveTimerRef = useRef(null)

  useEffect(() => {
    setName(project.name)
    setDesc(project.description || '')
    setMetric(project.metric || 'days')
  }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    projectsApi.getProjectStats(project.id).then(setStats).catch(console.error)
  }, [project.id])

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

  const handleDescChange = (val) => {
    setDesc(val)
    persist({ description: val })
  }

  const handleMetricChange = (val) => {
    setMetric(val)
    persist({ metric: val })
    onUpdate({ ...project, metric: val })
  }

  const metricLabel = PROJECT_METRICS.find(m => m.value === metric)?.label ?? metric
  const date = new Date(project.createdAt)
  const dateStr = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className={styles.page}>
      {/* Top bar */}
      <div className={styles.topBar}>
        <button className={styles.backBtn} onClick={onBack}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          All projects
        </button>
        <div className={styles.topBarRight}>
          <span className={styles.topBarDate}>Created {dateStr}</span>
        </div>
      </div>

      {/* Main content */}
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

        {/* Description */}
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Description</label>
          <textarea
            className={styles.descTextarea}
            value={desc}
            onChange={e => handleDescChange(e.target.value)}
            placeholder="Add a description for this project…"
            rows={3}
          />
        </div>

        {/* Metric */}
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Time metric</label>
          <div className={styles.metricPills}>
            {PROJECT_METRICS.map(m => (
              <button
                key={m.value}
                className={`${styles.metricPill} ${metric === m.value ? styles.metricPillActive : ''}`}
                onClick={() => handleMetricChange(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <p className={styles.metricHint}>
            Sets how columns are labelled on the Gantt chart. Currently: <strong>{metricLabel}</strong>.
          </p>
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

        {/* Enter workspace */}
        <div className={styles.workspaceRow}>
          <button className={styles.workspaceBtn} onClick={() => onEnterWorkspace(0)}>
            Goals
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button className={styles.workspaceBtn} onClick={() => onEnterWorkspace(1)}>
            Classification
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button className={`${styles.workspaceBtn} ${styles.workspaceBtnPrimary}`} onClick={() => onEnterWorkspace(2)}>
            Schedule
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
