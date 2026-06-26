import { useRef, useState, useEffect, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Text, ContactShadows, useGLTF, useAnimations } from '@react-three/drei'
import * as THREE from 'three'
import { api } from '../api'
import styles from './PeoplePage.module.css'

// Preload the variants we'll actually render
;['a', 'd', 'g'].forEach(k => useGLTF.preload(`/models/character-${k}.glb`))

const TARGET_HEIGHT = 1.15  // normalize every character to this height in scene units

// ── Kenney character avatar ───────────────────────────────────────────────────
function PersonAvatar({ modelKey = 'a', position, name, color = '#4f8ef7', selected, onClick }) {
  const groupRef = useRef()
  const [hovered, setHovered] = useState(false)
  const lit = hovered || selected

  const { scene, animations } = useGLTF(`/models/character-${modelKey}.glb`)

  // Deep-clone scene + materials once per model so instances don't share state
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
    const yOff = -box.min.y * s  // shift so feet land at y=0 in group space
    return { cloned: c, scale: s, yShift: yOff }
  }, [scene])

  // Play first animation if the GLB has any (idle walk cycle etc.)
  const { actions } = useAnimations(animations, cloned)
  useEffect(() => {
    const action = Object.values(actions)[0]
    if (!action) return
    action.reset().fadeIn(0.3).play()
    return () => { action.fadeOut(0.3) }
  }, [actions])

  // Gentle float
  useFrame(({ clock }) => {
    if (!groupRef.current) return
    groupRef.current.position.y = position[1] + Math.sin(clock.elapsedTime * 0.7 + position[0]) * 0.05
  })

  // Emissive highlight on hover / select
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

  return (
    <group
      ref={groupRef}
      position={position}
      onClick={onClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <primitive object={cloned} scale={scale} position={[0, yShift, 0]} />

      {/* Selection ring at feet level */}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[0.26, 0.34, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.8} />
        </mesh>
      )}

      {/* Name label just above the character's head */}
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

// ── Category island ───────────────────────────────────────────────────────────
const ISLAND_W    = 3.5
const ISLAND_D    = 3.5
const ISLAND_H    = 0.08
const ISLAND_GAP_X = 1.5
const ISLAND_GAP_Z = 1.8
const ISLAND_COLS  = 4

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

function CategoryIsland({ position, color, name }) {
  return (
    <group position={position}>
      <mesh receiveShadow position={[0, ISLAND_H / 2, 0]}>
        <boxGeometry args={[ISLAND_W, ISLAND_H, ISLAND_D]} />
        <meshStandardMaterial color={color} roughness={0.68} metalness={0.04} />
      </mesh>
      <Text
        position={[0, ISLAND_H + 0.22, 0]}
        fontSize={0.21}
        color="#222"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.026}
        outlineColor="#fff"
      >
        {name}
      </Text>
    </group>
  )
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function Scene({ activeCats = [] }) {
  const [selected, setSelected] = useState(null)

  const people = [
    { id: 1, name: 'Alice',   color: '#4f8ef7', modelKey: 'a', position: [-2.5, ISLAND_H, 0.5] },
    { id: 2, name: 'Bob',     color: '#f77b4f', modelKey: 'd', position: [ 0,   ISLAND_H, 0  ] },
    { id: 3, name: 'Charlie', color: '#4fc97f', modelKey: 'g', position: [ 2.5, ISLAND_H, -0.5] },
  ]

  const islands = computeIslandLayout(activeCats)

  return (
    <>
      <ambientLight intensity={1.8} />
      <directionalLight position={[6, 10, 4]} intensity={1.0} castShadow />
      <pointLight position={[-4, 6, -4]} intensity={0.3} color="#c8d8ff" />

      <Environment preset="dawn" background={false} />

      {/* Base floor */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} onClick={() => setSelected(null)}>
        <planeGeometry args={[30, 22]} />
        <meshStandardMaterial color="#e8e6e0" roughness={0.88} metalness={0} />
      </mesh>

      {/* Grid on base floor */}
      <Grid
        position={[0, 0.001, 0]}
        args={[30, 22]}
        cellSize={1}
        cellThickness={0.4}
        cellColor="#d8d6cf"
        sectionSize={5}
        sectionThickness={0.9}
        sectionColor="#cccac3"
        fadeDistance={26}
        fadeStrength={0}
      />

      {/* Category islands */}
      {islands.map(cat => (
        <CategoryIsland key={cat.id} position={cat.islandPos} color={cat.color || '#aaa'} name={cat.name} />
      ))}

      <ContactShadows position={[0, 0.002, 0]} opacity={0.22} scale={20} blur={2.5} far={1} color="#7788aa" />

      {people.map(p => (
        <PersonAvatar
          key={p.id}
          modelKey={p.modelKey}
          position={p.position}
          name={p.name}
          color={p.color}
          selected={selected === p.id}
          onClick={(e) => { e.stopPropagation(); setSelected(s => s === p.id ? null : p.id) }}
        />
      ))}

      <OrbitControls
        makeDefault
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={3}
        maxDistance={30}
        target={[0, 0, 0]}
      />
    </>
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
  const [dimensions, setDimensions] = useState([])
  const [dimIndex, setDimIndex]     = useState(0)
  const [categories, setCategories] = useState([])

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories()])
      .then(([dims, cats]) => { setDimensions(dims); setCategories(cats); setDimIndex(0) })
      .catch(console.error)
  }, [])

  const activeDimension = dimensions[dimIndex] ?? null
  const activeCats = activeDimension
    ? categories.filter(c => c.dimensionId === activeDimension.id)
    : []

  return (
    <div className={styles.page}>
      <Canvas
        shadows
        camera={{ position: [0, 6, 11], fov: 50 }}
        className={styles.canvas}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Scene activeCats={activeCats} />
      </Canvas>

      <DimensionScroller dimensions={dimensions} index={dimIndex} onChange={setDimIndex} />

      <div className={styles.hint}>Orbit · Zoom · Click to select</div>
    </div>
  )
}
