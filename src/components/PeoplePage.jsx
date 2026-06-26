import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Text, ContactShadows, useGLTF, useAnimations } from '@react-three/drei'
import * as THREE from 'three'
import { api } from '../api'
import styles from './PeoplePage.module.css'

const CHAR_KEYS = 'abcdefghijklmnopqr'.split('')
const RETRO_KEY_FALLBACKS = {
  humanFemaleA: 'a',
  humanMaleA: 'b',
  zombieFemaleA: 'c',
  zombieMaleA: 'd',
}

// Derive a consistent highlight color per character so avatars look distinct when selected
const KEY_COLORS = ['#4f8ef7','#f77b4f','#4fc97f','#f7d44f','#b44ff7','#f74f8e',
                    '#4fe0f7','#f7944f','#7f4ff7','#4ff7d4','#f74f4f','#4fa8f7',
                    '#a0c44f','#f74fc9','#4fc9f7','#f7c44f','#c44ff7','#4ff7a0']
const resolveModelKey = (key = 'a') => CHAR_KEYS.includes(key) ? key : (RETRO_KEY_FALLBACKS[key] ?? 'a')
const keyColor = (k) => {
  const index = CHAR_KEYS.indexOf(resolveModelKey(k))
  return KEY_COLORS[index >= 0 ? index : 0] ?? '#4f8ef7'
}

CHAR_KEYS.forEach(k => useGLTF.preload(`/models/character-${k}.glb`))

const TARGET_HEIGHT = 1.7

// ── Cursor sync (must live inside Canvas) ────────────────────────────────────
function CursorManager({ dragging }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.domElement.style.cursor = dragging ? 'grabbing' : 'default'
    return () => { gl.domElement.style.cursor = 'default' }
  }, [dragging, gl])
  return null
}

function CameraLock({ locked }) {
  const { camera, controls } = useThree()
  useEffect(() => {
    if (!locked) return
    camera.position.set(0, 8, 14)
    camera.lookAt(0, 0, 0)
    if (controls?.target) {
      controls.target.set(0, 0, 0)
      controls.update()
    }
  }, [camera, controls, locked])
  return null
}

// ── Kenney character avatar ───────────────────────────────────────────────────
function PersonAvatar({ modelKey = 'a', position, name, color = '#4f8ef7',
                        selected, dragging, phaseId = 0,
                        onPointerDown, onClick }) {
  const groupRef = useRef()
  const [hovered, setHovered] = useState(false)
  const lit = hovered || selected
  const { gl } = useThree()

  const resolvedModelKey = resolveModelKey(modelKey)
  const { scene, animations } = useGLTF(`/models/character-${resolvedModelKey}.glb`)

  const { cloned, scale, yShift } = useMemo(() => {
    const c = scene.clone(true)
    c.traverse(child => {
      if (!child.isMesh) return
      child.castShadow = true
      child.material = Array.isArray(child.material)
        ? child.material.map(m => m.clone())
        : child.material.clone()
    })
    const box = new THREE.Box3().setFromObject(c)
    const h   = box.max.y - box.min.y
    const s   = TARGET_HEIGHT / h
    return { cloned: c, scale: s, yShift: -box.min.y * s }
  }, [scene])

  const { actions } = useAnimations(animations, cloned)
  useEffect(() => {
    const action = Object.values(actions)[0]
    if (!action) return
    action.reset().fadeIn(0.3).play()
    return () => { action.fadeOut(0.3) }
  }, [actions])

  useFrame(({ clock }) => {
    if (!groupRef.current) return
    groupRef.current.position.y = dragging
      ? position[1] + 0.18
      : position[1] + Math.sin(clock.elapsedTime * 0.7 + phaseId) * 0.05
  })

  useEffect(() => {
    cloned.traverse(child => {
      if (!child.isMesh) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach(m => {
        if (!m || !m.emissive) return
        m.emissive.set(lit ? color : '#000')
        m.emissiveIntensity = lit ? 0.35 : 0
        m.needsUpdate = true
      })
    })
  }, [cloned, lit, color])

  const handlePointerOver = (e) => {
    e.stopPropagation()
    setHovered(true)
    if (!dragging) gl.domElement.style.cursor = 'grab'
  }
  const handlePointerOut = () => {
    setHovered(false)
    if (!dragging) gl.domElement.style.cursor = 'default'
  }

  return (
    <group
      ref={groupRef}
      position={position}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <primitive object={cloned} scale={scale} position={[0, yShift, 0]} />

      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[0.26, 0.34, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.8} />
        </mesh>
      )}

      <Text
        position={[0, TARGET_HEIGHT + 0.2, 0]}
        fontSize={0.16}
        color={lit ? color : '#444'}
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.016}
        outlineColor="#fff"
      >
        {name}
      </Text>
    </group>
  )
}

// ── Category island ──────────────────────────────────────────────────────────
const ISLAND_W     = 5.0
const ISLAND_D     = 5.0
const ISLAND_H     = 0.42
const ISLAND_COLS  = 4
const ISLAND_SLOT_GRID = 10
const TILE_GRID    = 8
const ISLAND_RENDER_W = ISLAND_W * TILE_GRID / ISLAND_SLOT_GRID
const ISLAND_RENDER_D = ISLAND_D * TILE_GRID / ISLAND_SLOT_GRID
const LOCKED_CATEGORY_X = -7.5
const LOCKED_CATEGORY_Z = -7.5

function CategoryIsland({ position, color, name }) {
  const floorTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 96
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    ctx.strokeStyle = 'rgba(255,255,255,0.46)'
    ctx.lineWidth = 1.35
    for (let i = -96; i < 192; i += 24) {
      ctx.beginPath()
      ctx.moveTo(i, 0)
      ctx.lineTo(i + 96, 96)
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    for (let y = 12; y < 96; y += 24) {
      for (let x = 12; x < 96; x += 24) {
        ctx.beginPath()
        ctx.arc(x, y, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(3, 3)
    texture.needsUpdate = true
    return texture
  }, [])
  const sideLabelY = ISLAND_H / 2
  const sideLabelOffsetX = ISLAND_RENDER_W / 2 + 0.012
  const sideLabelOffsetZ = ISLAND_RENDER_D / 2 + 0.012
  const sideLabelProps = {
    fontSize: 0.19,
    color: '#fff',
    anchorX: 'center',
    anchorY: 'middle',
    outlineWidth: 0.026,
    outlineColor: color,
    outlineOpacity: 1,
  }

  return (
    <group position={position}>
      <mesh
        castShadow
        receiveShadow
        position={[0, ISLAND_H / 2, 0]}
      >
        <boxGeometry args={[ISLAND_RENDER_W, ISLAND_H, ISLAND_RENDER_D]} />
        <meshStandardMaterial color={color} roughness={0.88} metalness={0} />
      </mesh>
      <mesh
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ISLAND_H + 0.006, 0]}
      >
        <planeGeometry args={[ISLAND_RENDER_W, ISLAND_RENDER_D]} />
        <meshStandardMaterial color={color} roughness={0.86} metalness={0} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ISLAND_H + 0.012, 0]}
      >
        <planeGeometry args={[ISLAND_RENDER_W, ISLAND_RENDER_D]} />
        <meshBasicMaterial
          map={floorTexture}
          transparent
          opacity={0.82}
          depthWrite={false}
        />
      </mesh>
      <Text
        position={[0, ISLAND_H + 0.16, 0]}
        fontSize={0.24}
        color="#fff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.034}
        outlineColor={color}
        outlineOpacity={1}
      >
        {name}
      </Text>
      <Text position={[0, sideLabelY, sideLabelOffsetZ]} rotation={[0, 0, 0]} {...sideLabelProps}>
        {name}
      </Text>
      <Text position={[0, sideLabelY, -sideLabelOffsetZ]} rotation={[0, Math.PI, 0]} {...sideLabelProps}>
        {name}
      </Text>
      <Text position={[sideLabelOffsetX, sideLabelY, 0]} rotation={[0, Math.PI / 2, 0]} {...sideLabelProps}>
        {name}
      </Text>
      <Text position={[-sideLabelOffsetX, sideLabelY, 0]} rotation={[0, -Math.PI / 2, 0]} {...sideLabelProps}>
        {name}
      </Text>
    </group>
  )
}

function computeIslandLayout(cats, locked = false) {
  if (cats.length === 0) return []
  const cols     = Math.min(cats.length, ISLAND_COLS)
  const rows     = Math.ceil(cats.length / cols)
  if (locked) {
    return cats.map((cat, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      return { ...cat, islandPos: [LOCKED_CATEGORY_X + col * ISLAND_W, 0, LOCKED_CATEGORY_Z + row * ISLAND_D] }
    })
  }
  // Snap to section-cell midpoints so thick grid lines form island borders.
  // Section lines land at multiples of ISLAND_W (= sectionSize = 5).
  // Cell midpoints are at 5k + 2.5; startCol/Row picks the leftmost cell index
  // for a layout that is as centered around the origin as possible.
  const startCol = -Math.floor(cols / 2)
  const startRow = -Math.floor(rows / 2)
  return cats.map((cat, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x   = (startCol + col) * ISLAND_W + ISLAND_W / 2
    const z   = (startRow + row) * ISLAND_D + ISLAND_D / 2
    return { ...cat, islandPos: [x, 0, z] }
  })
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function personaSlotPosition(islandPos, idx, total) {
  const cols = Math.min(4, total)
  const rows = Math.ceil(total / cols)
  const col = idx % cols
  const row = Math.floor(idx / cols)
  const spacing = 0.78
  return [
    islandPos[0] + (col - (cols - 1) / 2) * spacing,
    ISLAND_H,
    islandPos[2] + (row - (rows - 1) / 2) * spacing,
  ]
}

function Scene({
  activeDimensionId,
  activeCats = [],
  personas = [],
  personaAssignments = [],
  layoutLocked = true,
  sourceDragPersonaId = null,
  onSourceDragEnd,
  onPositionUpdate,
  onAssign,
  onUnassign,
  onSelect,
  selected,
}) {
  const [dragId, setDragId]       = useState(null)
  const [posOverrides, setPosOverrides] = useState({})
  const dragIdRef      = useRef(null)
  const dragAssignmentRef = useRef(null)
  const posOverridesRef = useRef({})
  const dragMovedRef   = useRef(false)

  const islands = computeIslandLayout(activeCats, layoutLocked)
  const activeDragId = dragId ?? sourceDragPersonaId
  const activeDragPersona = activeDragId ? personas.find(p => p.id === activeDragId) : null
  const activeDragPos = activeDragId ? posOverrides[activeDragId] : null
  const draggedAssignment = dragAssignmentRef.current

  const stopDrag = useCallback(() => {
    const id = dragIdRef.current ?? sourceDragPersonaId
    if (id !== null) {
      const pos = posOverridesRef.current[id]
      if (pos) {
        if (dragIdRef.current && !layoutLocked) onPositionUpdate?.(id, pos[0], pos[2])
        const targetIsland = islands.find(cat =>
          Math.abs(pos[0] - cat.islandPos[0]) <= ISLAND_RENDER_W / 2 &&
          Math.abs(pos[2] - cat.islandPos[2]) <= ISLAND_RENDER_D / 2
        )
        if (targetIsland && activeDimensionId) {
          onAssign?.(id, activeDimensionId, targetIsland.id)
          if (dragAssignmentRef.current && dragAssignmentRef.current.categoryId !== targetIsland.id) {
            const assignment = dragAssignmentRef.current
            onUnassign?.(assignment.personaId, assignment.dimensionId, assignment.categoryId)
          }
        } else if (dragAssignmentRef.current) {
          const assignment = dragAssignmentRef.current
          onUnassign?.(assignment.personaId, assignment.dimensionId, assignment.categoryId)
        }
      }
    }
    if (id !== null) {
      posOverridesRef.current = { ...posOverridesRef.current }
      delete posOverridesRef.current[id]
      setPosOverrides(prev => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
    dragIdRef.current = null
    dragAssignmentRef.current = null
    setDragId(null)
    onSourceDragEnd?.()
  }, [activeDimensionId, islands, layoutLocked, onAssign, onPositionUpdate, onSourceDragEnd, onUnassign, sourceDragPersonaId])

  useEffect(() => {
    window.addEventListener('pointerup', stopDrag)
    return () => window.removeEventListener('pointerup', stopDrag)
  }, [stopDrag])

  const startDrag = (id, e) => {
    e.stopPropagation()
    dragMovedRef.current = false
    dragIdRef.current = id
    dragAssignmentRef.current = null
    setDragId(id)
    onSelect?.(id)
  }

  const startAssignmentDrag = (assignment, position, e) => {
    e.stopPropagation()
    dragMovedRef.current = false
    dragIdRef.current = assignment.personaId
    dragAssignmentRef.current = assignment
    posOverridesRef.current = { ...posOverridesRef.current, [assignment.personaId]: position }
    setPosOverrides(prev => ({ ...prev, [assignment.personaId]: position }))
    setDragId(assignment.personaId)
    onSelect?.(assignment.personaId)
  }

  const handleDragMove = (e) => {
    const id = dragIdRef.current ?? sourceDragPersonaId
    if (id === null) return
    e.stopPropagation()
    dragMovedRef.current = true
    const newPos = [e.point.x, ISLAND_H, e.point.z]
    posOverridesRef.current = { ...posOverridesRef.current, [id]: newPos }
    setPosOverrides(prev => ({ ...prev, [id]: newPos }))
  }

  const assignedCopies = islands.flatMap(cat => {
    const assigned = personaAssignments
      .filter(a => a.dimensionId === activeDimensionId && a.categoryId === cat.id)
      .filter(a => !draggedAssignment ||
        a.personaId !== draggedAssignment.personaId ||
        a.dimensionId !== draggedAssignment.dimensionId ||
        a.categoryId !== draggedAssignment.categoryId
      )
      .map(a => personas.find(p => p.id === a.personaId))
      .filter(Boolean)
    return assigned.map((persona, idx) => ({
      persona,
      catId: cat.id,
      assignment: { personaId: persona.id, dimensionId: activeDimensionId, categoryId: cat.id },
      position: personaSlotPosition(cat.islandPos, idx, assigned.length),
    }))
  })

  return (
    <>
      <ambientLight intensity={1.8} />
      <directionalLight position={[6, 10, 4]} intensity={1.0} castShadow />
      <pointLight position={[-4, 6, -4]} intensity={0.3} color="#c8d8ff" />

      <fog attach="fog" args={['#f8f8f6', 28, 70]} />
      <Environment preset="dawn" background={false} />
      <CursorManager dragging={activeDragId !== null} />
      <CameraLock locked={layoutLocked} />

      {/* Infinite white floor — sits slightly below y=0 to avoid z-fighting with brick tile bottoms */}
      <mesh
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.005, 0]}
        onClick={activeDragId === null ? () => onSelect?.(null) : undefined}
      >
        <planeGeometry args={[800, 800]} />
        <meshStandardMaterial color="#f8f8f6" roughness={0.92} metalness={0} />
      </mesh>

      {/* Grid lines sized to exactly match LEGO tile (0.5 units), sections at island width (5.0) */}
      <Grid
        position={[0, 0.001, 0]}
        infiniteGrid
        cellSize={0.5}
        cellThickness={0.9}
        cellColor="#c8c8c8"
        sectionSize={5}
        sectionThickness={1.6}
        sectionColor="#aaaaaa"
        fadeDistance={60}
        fadeStrength={1}
      />

      {islands.map(cat => (
        <CategoryIsland key={cat.id} position={cat.islandPos} color={cat.color || '#aaa'} name={cat.name} />
      ))}

      <ContactShadows position={[0, 0.002, 0]} opacity={0.22} scale={20} blur={2.5} far={1} color="#7788aa" />

      {activeDragId !== null && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
          onPointerMove={handleDragMove}
          onPointerUp={stopDrag}
        >
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {activeDragPersona && activeDragPos && (
        <PersonAvatar
          key={`drag:${activeDragPersona.id}`}
          modelKey={activeDragPersona.modelKey}
          position={activeDragPos}
          name={activeDragPersona.name}
          color={keyColor(activeDragPersona.modelKey)}
          phaseId={99}
          selected
          dragging
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        />
      )}

      {assignedCopies.map(({ persona, catId, assignment, position }, i) => (
        <PersonAvatar
          key={`${catId}:${persona.id}`}
          modelKey={persona.modelKey}
          position={position}
          name={persona.name}
          color={keyColor(persona.modelKey)}
          phaseId={i + personas.length}
          selected={selected === persona.id}
          dragging={dragId === persona.id && dragAssignmentRef.current?.categoryId === catId}
          onPointerDown={e => startAssignmentDrag(assignment, position, e)}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(selected === persona.id ? null : persona.id)
          }}
        />
      ))}

      <OrbitControls
        makeDefault
        enabled={!layoutLocked && activeDragId === null}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={3}
        maxDistance={30}
        target={layoutLocked ? [0, 0, 0] : [0, 0, 0]}
      />
    </>
  )
}

// ── Add Persona panel ─────────────────────────────────────────────────────────
function AddPersonaPanel({ onClose, onCreate }) {
  const [name, setName]         = useState('')
  const [modelKey, setModelKey] = useState('a')
  const [saving, setSaving]     = useState(false)

  const handleSubmit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const persona = await api.createPersona({
        name: name.trim(), model_key: modelKey, pos_x: 0, pos_z: 0,
      })
      onCreate(persona)
      onClose()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.addPanel}>
      <div className={styles.addPanelHeader}>
        <span className={styles.addPanelTitle}>New Persona</span>
        <button className={styles.addPanelClose} onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <label className={styles.addPanelLabel}>Name</label>
      <input
        className={styles.addPanelInput}
        placeholder="Persona name"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        autoFocus
      />

      <label className={styles.addPanelLabel}>Character</label>
      <div className={styles.charGrid}>
        {CHAR_KEYS.map(k => (
          <button
            key={k}
            className={`${styles.charCard} ${modelKey === k ? styles.charCardSelected : ''}`}
            onClick={() => setModelKey(k)}
            title={`Character ${k.toUpperCase()}`}
          >
            <img
              src={`/models/previews/character-${k}.png`}
              alt={`character-${k}`}
              className={styles.charImg}
            />
          </button>
        ))}
      </div>

      <button
        className={styles.addBtn}
        onClick={handleSubmit}
        disabled={!name.trim() || saving}
      >
        {saving ? 'Adding…' : 'Add Persona'}
      </button>
    </div>
  )
}

// ── Edit Persona modal ────────────────────────────────────────────────────────
function EditPersonaModal({ persona, onClose, onSave, onDelete }) {
  const [name, setName] = useState(persona.name)
  const [modelKey, setModelKey] = useState(resolveModelKey(persona.modelKey))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      await onSave(persona.id, { name: name.trim(), modelKey })
      onClose()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await onDelete(persona.id)
      onClose()
    } catch (e) {
      console.error(e)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.editPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.addPanelHeader}>
          <span className={styles.addPanelTitle}>Edit Persona</span>
          <button className={styles.addPanelClose} onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <label className={styles.addPanelLabel}>Name</label>
        <input
          className={styles.addPanelInput}
          placeholder="Persona name"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          autoFocus
        />

        <label className={styles.addPanelLabel}>Character</label>
        <div className={styles.charGrid}>
          {CHAR_KEYS.map(k => (
            <button
              key={k}
              className={`${styles.charCard} ${modelKey === k ? styles.charCardSelected : ''}`}
              onClick={() => setModelKey(k)}
              title={`Character ${k.toUpperCase()}`}
            >
              <img
                src={`/models/previews/character-${k}.png`}
                alt={`character-${k}`}
                className={styles.charImg}
              />
            </button>
          ))}
        </div>

        {confirmDelete ? (
          <div className={styles.deleteConfirmBox}>
            <p>Delete <strong>{persona.name}</strong>?</p>
            <div className={styles.modalActions}>
              <button className={styles.modalCancel} onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </button>
              <button className={styles.modalConfirm} onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.editPanelActions}>
            <button className={styles.editDeleteBtn} onClick={() => setConfirmDelete(true)}>
              Delete Persona
            </button>
            <button
              className={styles.addBtn}
              onClick={handleSave}
              disabled={!name.trim() || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Dimension scroller ────────────────────────────────────────────────────────
function DimensionScroller({ dimensions, index, onChange }) {
  const wheelAtRef = useRef(0)

  const prev = () => onChange((index - 1 + dimensions.length) % dimensions.length)
  const next = () => onChange((index + 1) % dimensions.length)

  const onWheel = e => {
    e.preventDefault()
    const now = Date.now()
    if (now - wheelAtRef.current < 180) return
    wheelAtRef.current = now
    e.deltaY > 0 ? next() : prev()
  }

  if (dimensions.length === 0) return null
  const current = dimensions[index]

  return (
    <div className={styles.dimScroller} onWheel={onWheel}>
      <span className={styles.dimScrollerLabel}>Dimension</span>
      <div className={styles.dimScrollerRow}>
        <button className={styles.dimScrollerArrow} onClick={prev} title="Previous">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span className={styles.dimScrollerName}>{current.name}</span>
        <button className={styles.dimScrollerArrow} onClick={next} title="Next">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
      <div className={styles.dimScrollerDots}>
        {dimensions.map((_, i) => (
          <button
            key={i}
            className={`${styles.dimScrollerDot} ${i === index ? styles.dimScrollerDotActive : ''}`}
            onClick={() => onChange(i)}
          />
        ))}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PeoplePage() {
  const [dimensions, setDimensions]   = useState([])
  const [dimIndex, setDimIndex]       = useState(0)
  const [categories, setCategories]   = useState([])
  const [personas, setPersonas]         = useState([])
  const [personaAssignments, setPersonaAssignments] = useState([])
  const [selected, setSelected]         = useState(null)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [editPersonaId, setEditPersonaId] = useState(null)
  const [layoutLocked, setLayoutLocked] = useState(false)
  const [sourceDragPersonaId, setSourceDragPersonaId] = useState(null)

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getPersonas(), api.getPersonaAssignments()])
      .then(([dims, cats, pers, personaAsns]) => {
        setDimensions(dims)
        setCategories(cats)
        setDimIndex(0)
        setPersonas(pers)
        setPersonaAssignments(personaAsns)
      })
      .catch(console.error)
  }, [])

  const activeDimension = dimensions[dimIndex] ?? null
  const activeCats = activeDimension
    ? categories.filter(c => c.dimensionId === activeDimension.id)
    : []

  const handlePositionUpdate = async (id, x, z) => {
    try {
      await api.updatePersona(id, { pos_x: x, pos_z: z })
    } catch (e) { console.error(e) }
  }

  const handleAssignPersona = async (personaId, dimId, catId) => {
    if (personaAssignments.some(a => a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)) return
    const optimistic = { personaId, dimensionId: dimId, categoryId: catId }
    setPersonaAssignments(prev => [...prev, optimistic])
    try {
      const saved = await api.assignPersona(personaId, dimId, catId)
      setPersonaAssignments(prev => prev.map(a =>
        a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId ? saved : a
      ))
    } catch (e) {
      console.error(e)
      setPersonaAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)))
    }
  }

  const handleUnassignPersona = async (personaId, dimId, catId) => {
    const removed = personaAssignments.find(a => a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)
    setPersonaAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)))
    try {
      await api.unassignPersona(personaId, dimId, catId)
    } catch (e) {
      console.error(e)
      if (removed) setPersonaAssignments(prev => [...prev, removed])
    }
  }

  const handleUpdatePersona = async (id, patch) => {
    const previous = personas.find(p => p.id === id)
    setPersonas(prev => prev.map(p => p.id === id
      ? { ...p, name: patch.name, modelKey: patch.modelKey }
      : p
    ))
    try {
      const saved = await api.updatePersona(id, { name: patch.name, model_key: patch.modelKey })
      setPersonas(prev => prev.map(p => p.id === id ? saved : p))
    } catch (e) {
      if (previous) setPersonas(prev => prev.map(p => p.id === id ? previous : p))
      throw e
    }
  }

  const handleDeletePersona = async (id) => {
    const previousPersonas = personas
    const previousAssignments = personaAssignments
    setPersonas(prev => prev.filter(p => p.id !== id))
    setPersonaAssignments(prev => prev.filter(a => a.personaId !== id))
    setSelected(null)
    setEditPersonaId(null)
    try {
      await api.deletePersona(id)
    } catch (e) {
      setPersonas(previousPersonas)
      setPersonaAssignments(previousAssignments)
      throw e
    }
  }

  const selectedPersona = personas.find(p => p.id === selected) ?? null
  const selectedAssignments = selectedPersona && activeDimension
    ? personaAssignments
      .filter(a => a.personaId === selectedPersona.id && a.dimensionId === activeDimension.id)
      .map(a => ({ ...a, category: categories.find(c => c.id === a.categoryId) }))
      .filter(a => a.category)
    : []

  useEffect(() => {
    if (!sourceDragPersonaId) return
    const stop = () => setSourceDragPersonaId(null)
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [sourceDragPersonaId])

  const startSourceDrag = (personaId, e) => {
    if (e.detail > 1) return
    e.preventDefault()
    setSourceDragPersonaId(personaId)
    setSelected(personaId)
  }

  const openEditPersona = (personaId, e) => {
    e.preventDefault()
    e.stopPropagation()
    setSourceDragPersonaId(null)
    setShowAddPanel(false)
    setSelected(personaId)
    setEditPersonaId(personaId)
  }

  const editPersona = editPersonaId ? personas.find(p => p.id === editPersonaId) : null

  return (
    <div className={styles.page}>
      <Canvas
        shadows
        camera={{ position: [0, 8, 14], fov: 48 }}
        className={styles.canvas}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Scene
          activeDimensionId={activeDimension?.id ?? null}
          activeCats={activeCats}
          personas={personas}
          personaAssignments={personaAssignments}
          layoutLocked={layoutLocked}
          sourceDragPersonaId={sourceDragPersonaId}
          onSourceDragEnd={() => setSourceDragPersonaId(null)}
          onPositionUpdate={handlePositionUpdate}
          onAssign={handleAssignPersona}
          onUnassign={handleUnassignPersona}
          onSelect={setSelected}
          selected={selected}
        />
      </Canvas>

      <DimensionScroller dimensions={dimensions} index={dimIndex} onChange={setDimIndex} />

      <button
        className={`${styles.layoutLockBtn} ${layoutLocked ? styles.layoutLockBtnActive : ''}`}
        onClick={() => setLayoutLocked(v => !v)}
        title={layoutLocked ? 'Unlock camera and free persona placement' : 'Lock camera and fixed persona pool'}
      >
        {layoutLocked ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 7.5-2" />
          </svg>
        )}
      </button>

      {!showAddPanel && (
      <aside className={styles.personaPanel}>
        <div className={styles.personaPanelHeader}>
          <div>
            <div className={styles.personaPanelTitle}>People</div>
            <div className={styles.personaPanelSub}>Drag to a category</div>
          </div>
          <button
            className={styles.personaPanelAdd}
            onClick={() => setShowAddPanel(true)}
            title="Add persona"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div className={styles.personaList}>
          {personas.length === 0 ? (
            <div className={styles.personaEmpty}>No personas yet</div>
          ) : personas.map(persona => (
            <button
              key={persona.id}
              className={`${styles.personaListItem} ${selected === persona.id ? styles.personaListItemActive : ''}`}
              onPointerDown={e => startSourceDrag(persona.id, e)}
              onDoubleClick={e => openEditPersona(persona.id, e)}
              onClick={() => setSelected(selected === persona.id ? null : persona.id)}
              title="Drag to assign. Double-click to edit."
            >
              <img
                src={`/models/previews/character-${resolveModelKey(persona.modelKey)}.png`}
                alt={resolveModelKey(persona.modelKey)}
                className={styles.personaListAvatar}
              />
              <span>{persona.name}</span>
            </button>
          ))}
        </div>
      </aside>
      )}

      {showAddPanel && (
        <AddPersonaPanel
          onClose={() => setShowAddPanel(false)}
          onCreate={(persona) => setPersonas(prev => [...prev, persona])}
        />
      )}

      {editPersona && (
        <EditPersonaModal
          persona={editPersona}
          onClose={() => setEditPersonaId(null)}
          onSave={handleUpdatePersona}
          onDelete={handleDeletePersona}
        />
      )}

      {selectedPersona && (
        <div className={styles.selectionBar}>
          <div className={styles.selectionInfo}>
            <img
              src={`/models/previews/character-${resolveModelKey(selectedPersona.modelKey)}.png`}
              alt={resolveModelKey(selectedPersona.modelKey)}
              className={styles.selectionAvatar}
            />
            <span className={styles.selectionName}>{selectedPersona.name}</span>
          </div>
          {selectedAssignments.length > 0 && (
            <div className={styles.assignmentChips}>
              {selectedAssignments.map(({ category, dimensionId, categoryId }) => (
                <button
                  key={categoryId}
                  className={styles.assignmentChip}
                  style={{ borderColor: category.color, color: category.color }}
                  onClick={() => handleUnassignPersona(selectedPersona.id, dimensionId, categoryId)}
                  title={`Remove from ${category.name}`}
                >
                  {category.name}
                  <span>×</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.hint}>{layoutLocked ? 'Locked view · Drag from panel to assign · Drag off island to unassign' : 'Unlocked · Orbit · Zoom · Drag off island to unassign'}</div>
    </div>
  )
}
