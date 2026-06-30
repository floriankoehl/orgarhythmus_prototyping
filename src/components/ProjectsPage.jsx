import { useState, useEffect, useRef } from 'react'
import { projectsApi } from '../api'
import styles from './ProjectsPage.module.css'
import { playSound } from '../sounds/sound_registry'

function CreateProjectModal({ onClose, onCreate }) {
  const [name,   setName]   = useState('')
  const inputRef = useRef()

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await onCreate({ name: trimmed })
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
        <div className={styles.modalActions}>
          <button className={styles.modalCancel} onClick={onClose}>Cancel</button>
          <button className={styles.modalCreate} onClick={submit} disabled={!name.trim()}>Create</button>
        </div>
      </div>
    </div>
  )
}

function ArchiveModal({ archive, onClose, onRestoreProject, onRestoreNoteTree }) {
  const projects = archive?.projects || []
  const noteTrees = archive?.noteTrees || []
  return (
    <div className={styles.modalOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`${styles.modal} ${styles.archiveModal}`}>
        <h2 className={styles.modalTitle}>Global archive</h2>
        <p className={styles.modalText}>Deleted projects and note trees remain here until you restore them.</p>
        <div className={styles.archiveList}>
          {projects.map(project => (
            <div className={styles.archiveRow} key={`project-${project.id}`}>
              <div><strong>{project.name}</strong><span>Project · complete structure</span></div>
              <button onClick={() => onRestoreProject(project.id)}>Restore</button>
            </div>
          ))}
          {noteTrees.map(tree => (
            <div className={styles.archiveRow} key={`notes-${tree.id}`}>
              <div><strong>{tree.title}</strong><span>{tree.noteCount} note{tree.noteCount === 1 ? '' : 's'} · {tree.projectName}</span></div>
              <button disabled={tree.projectArchived} title={tree.projectArchived ? 'Restore its project first' : undefined} onClick={() => onRestoreNoteTree(tree.id)}>Restore</button>
            </div>
          ))}
          {projects.length === 0 && noteTrees.length === 0 && <div className={styles.archiveEmpty}>The archive is empty.</div>}
        </div>
        <div className={styles.modalActions}><button className={styles.modalCancel} onClick={onClose}>Close</button></div>
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

  const date = new Date(String(project.createdAt).replace(' ', 'T'))
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className={styles.card} onClick={() => { playSound('projectOpen'); onOpen(project) }}>
      <div className={styles.cardBody}>
        <div className={styles.cardName}>{project.name}</div>
        <div className={styles.cardMeta}>
          <span className={styles.cardDate}>Created {dateStr}</span>
        </div>
        {project.description && (
          <div className={styles.cardDesc}>{project.description}</div>
        )}
      </div>
      <div className={styles.cardMenu} ref={menuRef}>
        <button
          className={styles.cardMenuBtn}
          onClick={e => { e.stopPropagation(); playSound('projectMenuOpen'); setMenuOpen(v => !v) }}
          title="Project options">
          ···
        </button>
        {menuOpen && (
          <div className={styles.cardMenuDropdown}>
            <button
              className={`${styles.cardMenuItem} ${styles.cardMenuItemDanger}`}
              onClick={e => { e.stopPropagation(); setMenuOpen(false); playSound('projectDelete'); onDelete(project) }}>
              Delete project
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ProfileMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef()
  const name = user?.displayName || user?.email || 'Profile'
  const initial = name.trim().charAt(0).toUpperCase() || 'U'

  useEffect(() => {
    if (!open) return
    const handler = e => { if (!menuRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className={styles.profile} ref={menuRef}>
      <button
        className={styles.profileButton}
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Profile"
        aria-label="Profile"
        aria-expanded={open}
      >
        <span className={styles.profileAvatar}>{initial}</span>
      </button>

      {open && (
        <div className={styles.profilePanel}>
          <div className={styles.profileInfo}>
            <span className={styles.profileName}>{name}</span>
            <span className={styles.profileEmail}>{user?.email}</span>
            {user?.isSuperuser && <span className={styles.profileBadge}>Superuser</span>}
          </div>
          <button className={styles.profileAction} type="button" onClick={() => { playSound('logout'); onLogout() }}>
            Logout
          </button>
        </div>
      )}
    </div>
  )
}

export default function ProjectsPage({ onOpenProject, currentUser, onLogout }) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading]   = useState(true)
  const [creating, setCreating] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [archive, setArchive] = useState(null)

  useEffect(() => {
    projectsApi.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleCreate = async (data) => {
    const project = await projectsApi.createProject(data)
    playSound('projectCreate')
    setProjects(prev => [...prev, project])
    onOpenProject(project)
  }

  const handleDelete = async (project) => {
    await projectsApi.deleteProject(project.id)
    playSound('projectDelete')
    setProjects(prev => prev.filter(p => p.id !== project.id))
    setDeleteConfirm(null)
  }

  const openArchive = async () => setArchive(await projectsApi.getArchive())
  const restoreArchivedProject = async id => {
    const restored = await projectsApi.restoreArchivedProject(id)
    setProjects(previous => [...previous, restored])
    setArchive(await projectsApi.getArchive())
  }
  const restoreArchivedNoteTree = async id => {
    await projectsApi.restoreArchivedNoteTree(id)
    setArchive(await projectsApi.getArchive())
  }

  return (
    <div className={styles.note}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.logo}>◆</span>
          <span className={styles.appName}>Orgarythmus</span>
        </div>
        <ProfileMenu user={currentUser} onLogout={onLogout} />
      </div>

      <div className={styles.content}>
        <div className={styles.contentHeader}>
          <h1 className={styles.title}>Projects</h1>
          <div className={styles.headerActions}>
            <button className={styles.archiveBtn} type="button" onClick={openArchive}>Archive</button>
            <button className={styles.createBtn} type="button" onClick={() => setCreating(true)}>Create project</button>
          </div>
        </div>
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
              "{deleteConfirm.name}" and its complete structure will be moved to the global archive and can be restored later.
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

      {archive && (
        <ArchiveModal
          archive={archive}
          onClose={() => setArchive(null)}
          onRestoreProject={restoreArchivedProject}
          onRestoreNoteTree={restoreArchivedNoteTree}
        />
      )}
    </div>
  )
}
