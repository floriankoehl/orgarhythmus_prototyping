import { useState, useEffect, useRef } from 'react'
import { projectsApi } from '../api'
import styles from './ProjectsPage.module.css'

const COLORS = [
  '#1a73e8', '#0f9d58', '#e53935', '#fb8c00',
  '#8e24aa', '#00897b', '#3949ab', '#e91e63',
]

function ColorDot({ color, selected, onClick }) {
  return (
    <button
      className={`${styles.colorDot} ${selected ? styles.colorDotSelected : ''}`}
      style={{ background: color }}
      onClick={onClick}
      title={color}
    />
  )
}

function CreateProjectModal({ onClose, onCreate }) {
  const [name, setName]   = useState('')
  const [color, setColor] = useState(COLORS[0])
  const inputRef = useRef()

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await onCreate({ name: trimmed, color })
    onClose()
  }

  const onKey = e => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className={styles.modalOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <h2 className={styles.modalTitle}>New project</h2>
        <input
          ref={inputRef}
          className={styles.modalInput}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={onKey}
          placeholder="Project name"
        />
        <div className={styles.colorRow}>
          {COLORS.map(c => (
            <ColorDot key={c} color={c} selected={color === c} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className={styles.modalActions}>
          <button className={styles.modalCancel} onClick={onClose}>Cancel</button>
          <button className={styles.modalCreate} onClick={submit} disabled={!name.trim()}>Create</button>
        </div>
      </div>
    </div>
  )
}

function ProjectCard({ project, onOpen, onDelete }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef()

  useEffect(() => {
    if (!menuOpen) return
    const handler = e => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const date = new Date(project.createdAt)
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className={styles.card} onClick={() => onOpen(project)}>
      <div className={styles.cardAccent} style={{ background: project.color }} />
      <div className={styles.cardBody}>
        <div className={styles.cardName}>{project.name}</div>
        <div className={styles.cardDate}>Created {dateStr}</div>
      </div>
      <div className={styles.cardMenu} ref={menuRef}>
        <button
          className={styles.cardMenuBtn}
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v) }}
          title="Project options">
          ···
        </button>
        {menuOpen && (
          <div className={styles.cardMenuDropdown}>
            <button
              className={`${styles.cardMenuItem} ${styles.cardMenuItemDanger}`}
              onClick={e => { e.stopPropagation(); setMenuOpen(false); onDelete(project) }}>
              Delete project
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ProjectsPage({ onOpenProject }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading]   = useState(true)
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null) // project to delete

  useEffect(() => {
    projectsApi.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleCreate = async (data) => {
    const project = await projectsApi.createProject(data)
    setProjects(prev => [...prev, project])
    onOpenProject(project)
  }

  const handleDelete = async (project) => {
    await projectsApi.deleteProject(project.id)
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setDeleteConfirm(null)
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo}>◆</span>
          <span className={styles.appName}>Orgarythmus</span>
        </div>
        <button className={styles.newBtn} onClick={() => setCreating(true)}>
          + New project
        </button>
      </div>

      <div className={styles.content}>
        <h1 className={styles.title}>Projects</h1>
        {loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : projects.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>◇</div>
            <p>No projects yet. Create one to get started.</p>
            <button className={styles.emptyBtn} onClick={() => setCreating(true)}>
              Create your first project
            </button>
          </div>
        ) : (
          <div className={styles.grid}>
            {projects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={onOpenProject}
                onDelete={setDeleteConfirm}
              />
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateProjectModal
          onClose={() => setCreating(false)}
          onCreate={handleCreate}
        />
      )}

      {deleteConfirm && (
        <div className={styles.modalOverlay} onMouseDown={e => { if (e.target === e.currentTarget) setDeleteConfirm(null) }}>
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Delete project?</h2>
            <p className={styles.modalText}>
              "{deleteConfirm.name}" and all its goals, milestones, dimensions, and perspectives will be permanently deleted.
            </p>
            <div className={styles.modalActions}>
              <button className={styles.modalCancel} onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className={`${styles.modalCreate} ${styles.modalDelete}`} onClick={() => handleDelete(deleteConfirm)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
