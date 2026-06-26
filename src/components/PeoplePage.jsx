import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Text, ContactShadows, useGLTF, useAnimations } from '@react-three/drei'
import * as THREE from 'three'
import { api } from '../api'
import styles from './PeoplePage.module.css'

const CHAR_KEYS = 'abcdefghijklmnopqr'.split('')

// Derive a consistent highlight color per character so avatars look distinct when selected
const KEY_COLORS = ['#4f8ef7','#f77b4f','#4fc97f','#f7d44f','#b44ff7','#f74f8e',
                    '#4fe0f7','#f7944f','#7f4ff7','#4ff7d4','#f74f4f','#4fa8f7',
                    '#a0c44f','#f74fc9','#4fc9f7','#f7c44f','#c44ff7','#4ff7a0']
const keyColor = (k) => KEY_COLORS[CHAR_KEYS.indexOf(k)] ?? '#4f8ef7'

CHAR_KEYS.forEach(k => useGLTF.preload(`/models/character-${k}.glb`))
useGLTF.preload('/models/bricks/bevel-hq-plate-2x2.glb')

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

// ── Kenney character avatar ───────────────────────────────────────────────────
function PersonAvatar({ modelKey = 'a', position, name, color = '#4f8ef7',
                        selected, dragging, phaseId = 0,
                        onPointerDown, onClick }) {
  const groupRef = useRef()
  const [hovered, setHovered] = useState(false)
  const lit = hovered || selected
  const { gl } = useThree()

  const { scene, animations } = useGLTF(`/models/character-${modelKey}.glb`)

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

// ── Brick island ─────────────────────────────────────────────────────────────
const ISLAND_W     = 5.0
const ISLAND_D     = 5.0
const ISLAND_H     = 0.22
const ISLAND_GAP_X = 2.0
const ISLAND_GAP_Z = 2.0
const ISLAND_COLS  = 4
const TILE_GRID    = 10

function darkenColor(hexColor, factor = 0.76) {
  return new THREE.Color(hexColor).multiplyScalar(factor)
}

function coloredClone(sourceScene, color, roughness = 0.52) {
  const c = sourceScene.clone(true)
  const col = new THREE.Color(color)
  c.traverse(child => {
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
    child.material = child.material.clone()
    child.material.color.copy(col)
    child.material.roughness = roughness
    child.material.metalness = 0.0
  })
  return c
}

function BrickIsland({ position, color, name }) {
  const { scene: plateScene } = useGLTF('/models/bricks/bevel-hq-plate-2x2.glb')

  const parts = useMemo(() => {
    const plateBox = new THREE.Box3().setFromObject(plateScene)
    const pW = plateBox.max.x - plateBox.min.x
    const pD = plateBox.max.z - plateBox.min.z

    const tW = ISLAND_W / TILE_GRID
    const tD = ISLAND_D / TILE_GRID
    const sx = tW / pW
    const sz = tD / pD
    const sy = sx
    const yShift = -plateBox.min.y * sy
    const plateTop = plateBox.max.y * sy + yShift

    const dark = darkenColor(color, 0.76)
    const floorTiles = []
    for (let row = 0; row < TILE_GRID; row++) {
      for (let col = 0; col < TILE_GRID; col++) {
        const tileColor = (row + col) % 2 === 0 ? color : `#${dark.getHexString()}`
        floorTiles.push({
          scene: coloredClone(plateScene, tileColor),
          pos: [(col - (TILE_GRID - 1) / 2) * tW, yShift, (row - (TILE_GRID - 1) / 2) * tD],
          scale: [sx, sy, sz],
        })
      }
    }

    return { floorTiles, labelY: plateTop + 0.3 }
  }, [plateScene, color])

  return (
    <group position={position}>
      {parts.floorTiles.map((t, i) => (
        <primitive key={i} object={t.scene} position={t.pos} scale={t.scale} />
      ))}
      <Text
        position={[0, parts.labelY, 0]}
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
    </group>
  )
}

function computeIslandLayout(cats) {
  if (cats.length === 0) return []
  const cols   = Math.min(cats.length, ISLAND_COLS)
  const rows   = Math.ceil(cats.length / cols)
  const totalW = cols * ISLAND_W + (cols - 1) * ISLAND_GAP_X
  const totalD = rows * ISLAND_D + (rows - 1) * ISLAND_GAP_Z
  return cats.map((cat, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x   = col * (ISLAND_W + ISLAND_GAP_X) - totalW / 2 + ISLAND_W / 2
    const z   = row * (ISLAND_D + ISLAND_GAP_Z) - totalD / 2 + ISLAND_D / 2
    return { ...cat, islandPos: [x, 0, z] }
  })
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function Scene({ activeCats = [], personas = [], onPositionUpdate, onSelect, selected }) {
  const [dragId, setDragId]       = useState(null)
  const [posOverrides, setPosOverrides] = useState({})
  const dragIdRef      = useRef(null)
  const posOverridesRef = useRef({})
  const dragMovedRef   = useRef(false)

  const getPos = useCallback((p) => {
    return posOverrides[p.id] ?? [p.posX ?? 0, ISLAND_H, p.posZ ?? 0]
  }, [posOverrides])

  const stopDrag = useCallback(() => {
    const id = dragIdRef.current
    if (id !== null) {
      const pos = posOverridesRef.current[id]
      if (pos) onPositionUpdate?.(id, pos[0], pos[2])
    }
    dragIdRef.current = null
    setDragId(null)
  }, [onPositionUpdate])

  useEffect(() => {
    window.addEventListener('pointerup', stopDrag)
    return () => window.removeEventListener('pointerup', stopDrag)
  }, [stopDrag])

  const startDrag = (id, e) => {
    e.stopPropagation()
    dragMovedRef.current = false
    dragIdRef.current = id
    setDragId(id)
    onSelect?.(id)
  }

  const handleDragMove = (e) => {
    if (dragIdRef.current === null) return
    e.stopPropagation()
    dragMovedRef.current = true
    const id = dragIdRef.current
    const newPos = [e.point.x, ISLAND_H, e.point.z]
    posOverridesRef.current = { ...posOverridesRef.current, [id]: newPos }
    setPosOverrides(prev => ({ ...prev, [id]: newPos }))
  }

  const islands = computeIslandLayout(activeCats)

  return (
    <>
      <ambientLight intensity={1.8} />
      <directionalLight position={[6, 10, 4]} intensity={1.0} castShadow />
      <pointLight position={[-4, 6, -4]} intensity={0.3} color="#c8d8ff" />

      <fog attach="fog" args={['#f8f8f6', 28, 70]} />
      <Environment preset="dawn" background={false} />
      <CursorManager dragging={dragId !== null} />

      {/* Infinite white floor — large enough that it disappears into fog */}
      <mesh
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        onClick={dragId === null ? () => onSelect?.(null) : undefined}
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
        fadeDistance={40}
        fadeStrength={1.4}
      />

      {islands.map(cat => (
        <BrickIsland key={cat.id} position={cat.islandPos} color={cat.color || '#aaa'} name={cat.name} />
      ))}

      <ContactShadows position={[0, 0.002, 0]} opacity={0.22} scale={20} blur={2.5} far={1} color="#7788aa" />

      {dragId !== null && (
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

      {personas.map((p, i) => (
        <PersonAvatar
          key={p.id}
          modelKey={p.modelKey}
          position={getPos(p)}
          name={p.name}
          color={keyColor(p.modelKey)}
          phaseId={i}
          selected={selected === p.id}
          dragging={dragId === p.id}
          onPointerDown={(e) => startDrag(p.id, e)}
          onClick={(e) => {
            e.stopPropagation()
            if (dragMovedRef.current) return
            onSelect?.(selected === p.id ? null : p.id)
          }}
        />
      ))}

      <OrbitControls
        makeDefault
        enabled={dragId === null}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={3}
        maxDistance={30}
        target={[0, 0, 0]}
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

// ── Confirm delete modal ──────────────────────────────────────────────────────
function ConfirmModal({ name, onConfirm, onCancel }) {
  return (
    <div className={styles.modalOverlay} onClick={onCancel}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <p className={styles.modalText}>
          Delete <strong>{name}</strong>? This cannot be undone.
        </p>
        <div className={styles.modalActions}>
          <button className={styles.modalCancel} onClick={onCancel}>Cancel</button>
          <button className={styles.modalConfirm} onClick={onConfirm}>Delete</button>
        </div>
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
  const [selected, setSelected]         = useState(null)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [confirmId, setConfirmId]       = useState(null)

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getPersonas()])
      .then(([dims, cats, pers]) => {
        setDimensions(dims)
        setCategories(cats)
        setDimIndex(0)
        setPersonas(pers)
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

  const confirmPersona = confirmId ? personas.find(p => p.id === confirmId) : null

  const handleDeleteConfirmed = async () => {
    const id = confirmId
    setConfirmId(null)
    // Optimistic: remove immediately
    setPersonas(prev => prev.filter(p => p.id !== id))
    setSelected(null)
    try {
      await api.deletePersona(id)
    } catch (e) {
      console.error(e)
      // Restore on failure
      api.getPersonas().then(setPersonas).catch(console.error)
    }
  }

  const selectedPersona = personas.find(p => p.id === selected) ?? null

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
          activeCats={activeCats}
          personas={personas}
          onPositionUpdate={handlePositionUpdate}
          onSelect={setSelected}
          selected={selected}
        />
      </Canvas>

      <DimensionScroller dimensions={dimensions} index={dimIndex} onChange={setDimIndex} />

      {showAddPanel && (
        <AddPersonaPanel
          onClose={() => setShowAddPanel(false)}
          onCreate={(persona) => setPersonas(prev => [...prev, persona])}
        />
      )}

      {!showAddPanel && (
        <button
          className={styles.fab}
          onClick={() => setShowAddPanel(true)}
          title="Add persona"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
      )}

      {selectedPersona && (
        <div className={styles.selectionBar}>
          <div className={styles.selectionInfo}>
            <img
              src={`/models/previews/character-${selectedPersona.modelKey}.png`}
              alt={selectedPersona.modelKey}
              className={styles.selectionAvatar}
            />
            <span className={styles.selectionName}>{selectedPersona.name}</span>
          </div>
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirmId(selectedPersona.id)}
            title="Delete persona"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            Delete
          </button>
        </div>
      )}

      {confirmPersona && (
        <ConfirmModal
          name={confirmPersona.name}
          onConfirm={handleDeleteConfirmed}
          onCancel={() => setConfirmId(null)}
        />
      )}

      <div className={styles.hint}>Orbit · Zoom · Drag to move</div>
    </div>
  )
}
