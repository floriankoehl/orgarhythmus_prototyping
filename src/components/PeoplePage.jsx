import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import { flushSync } from 'react-dom'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Environment, Text, ContactShadows, useGLTF, useAnimations, RoundedBox } from '@react-three/drei'
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

function peopleColToDate(col) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + Math.max(0, Number(col) || 0))
  return d
}

function formatMilestoneDate(ms) {
  const start = Math.max(0, Number(ms.startCol) || 0)
  const duration = Math.max(1, Number(ms.duration) || 1)
  const startLabel = peopleColToDate(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (duration <= 1) return startLabel
  const endLabel = peopleColToDate(start + duration - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${startLabel} - ${endLabel}`
}

// ── Cursor sync (must live inside Canvas) ────────────────────────────────────
function CursorManager({ dragging }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.domElement.style.cursor = dragging ? 'grabbing' : 'default'
    return () => { gl.domElement.style.cursor = 'default' }
  }, [dragging, gl])
  return null
}

function CameraDirector({ locked, focusTarget, focusLevel = 'category', resetRevision = 0 }) {
  const { camera, controls } = useThree()
  const movingRef = useRef(false)
  const overviewRef = useRef(false)

  useEffect(() => {
    if (focusTarget) {
      movingRef.current = true
      overviewRef.current = false
      return
    }
    if (resetRevision > 0) {
      movingRef.current = true
      overviewRef.current = true
      return
    }
    if (!locked) return
    camera.position.set(0, 32, 56)
    camera.lookAt(0, 0, 0)
    if (controls?.target) controls.target.set(0, 0, 0)
    controls?.update?.()
  }, [camera, controls, focusTarget, focusLevel, locked, resetRevision])

  useFrame(() => {
    if (!movingRef.current) return
    const [x, , z] = focusTarget ?? [0, 0, 0]
    const desiredPosition = overviewRef.current
      ? new THREE.Vector3(0, 32, 56)
      : focusLevel === 'note'
        ? new THREE.Vector3(x + 0.08, 1.9, z + 2.25)
        : new THREE.Vector3(x + 0.5, 17, z + 22)
    const desiredTarget = overviewRef.current
      ? new THREE.Vector3(0, 0, 0)
      : focusLevel === 'note'
        ? new THREE.Vector3(x, ISLAND_H + 0.14, z)
        : new THREE.Vector3(x, ISLAND_H + 0.16, z + 3.8)
    camera.position.lerp(desiredPosition, 0.12)
    if (controls?.target) controls.target.lerp(desiredTarget, 0.12)
    camera.lookAt(controls?.target ?? desiredTarget)
    controls?.update?.()
    if (
      camera.position.distanceTo(desiredPosition) < 0.025 &&
      (!controls?.target || controls.target.distanceTo(desiredTarget) < 0.025)
    ) {
      movingRef.current = false
      overviewRef.current = false
      camera.position.copy(desiredPosition)
      if (controls?.target) controls.target.copy(desiredTarget)
      controls?.update?.()
    }
  })

  return null
}

// ── Kenney character avatar ───────────────────────────────────────────────────
function PersonAvatar({ modelKey = 'a', position, name, color = '#4f8ef7',
                        selected, dragging, phaseId = 0, targetHeight = TARGET_HEIGHT,
                        showName = true,
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
    const s   = targetHeight / h
    return { cloned: c, scale: s, yShift: -box.min.y * s }
  }, [scene, targetHeight])

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
          <ringGeometry args={[0.52, 0.68, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.8} />
        </mesh>
      )}

      {showName && (
        <Text
          position={[0, targetHeight + 0.4, 0]}
          fontSize={0.32}
          color={lit ? color : '#444'}
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.032}
          outlineColor="#fff"
        >
          {name}
        </Text>
      )}
    </group>
  )
}

// ── Category island ──────────────────────────────────────────────────────────
const ISLAND_W     = 20.0
const ISLAND_D     = 28.0
const ISLAND_H     = 0.84
const ISLAND_COLS  = 4
const ISLAND_SLOT_GRID = 20
const TILE_GRID    = 16
const ISLAND_RENDER_W = ISLAND_W * TILE_GRID / ISLAND_SLOT_GRID   // 16.0
const ISLAND_RENDER_D = ISLAND_D * TILE_GRID / ISLAND_SLOT_GRID   // 22.4
const LOCKED_CATEGORY_X = -30
const LOCKED_CATEGORY_Z = -30

function CategoryIsland({ position, color, name, focused = false, onDoubleClick }) {
  const floorTexture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (focused) {
      ctx.strokeStyle = 'rgba(255,255,255,0.42)'
      ctx.lineWidth = 1
      for (let i = 0; i <= 128; i += 16) {
        ctx.beginPath()
        ctx.moveTo(i, 0)
        ctx.lineTo(i, 128)
        ctx.moveTo(0, i)
        ctx.lineTo(128, i)
        ctx.stroke()
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.18)'
      ctx.lineWidth = 2
      for (let i = 0; i <= 128; i += 64) {
        ctx.beginPath()
        ctx.moveTo(i, 0)
        ctx.lineTo(i, 128)
        ctx.moveTo(0, i)
        ctx.lineTo(128, i)
        ctx.stroke()
      }
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.46)'
      ctx.lineWidth = 1.35
      for (let i = -128; i < 256; i += 32) {
        ctx.beginPath()
        ctx.moveTo(i, 0)
        ctx.lineTo(i + 128, 128)
        ctx.stroke()
      }

      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      for (let y = 16; y < 128; y += 32) {
        for (let x = 16; x < 128; x += 32) {
          ctx.beginPath()
          ctx.arc(x, y, 1.4, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(focused ? 4 : 3, focused ? 4 : 3)
    texture.needsUpdate = true
    return texture
  }, [focused])
  const dashSegments = useMemo(() => {
    const dash = 0.68
    const gap = 0.36
    const y = ISLAND_H + 0.024
    const segments = []
    const addHorizontal = (z) => {
      for (let x = -ISLAND_RENDER_W / 2; x < ISLAND_RENDER_W / 2; x += dash + gap) {
        const len = Math.min(dash, ISLAND_RENDER_W / 2 - x)
        if (len > 0.08) segments.push({ pos: [x + len / 2, y, z], size: [len, 0.036], rot: 0 })
      }
    }
    const addVertical = (x) => {
      for (let z = -ISLAND_RENDER_D / 2; z < ISLAND_RENDER_D / 2; z += dash + gap) {
        const len = Math.min(dash, ISLAND_RENDER_D / 2 - z)
        if (len > 0.08) segments.push({ pos: [x, y, z + len / 2], size: [len, 0.036], rot: Math.PI / 2 })
      }
    }
    addHorizontal(ISLAND_RENDER_D / 2 + 0.036)
    addHorizontal(-ISLAND_RENDER_D / 2 - 0.036)
    addVertical(ISLAND_RENDER_W / 2 + 0.036)
    addVertical(-ISLAND_RENDER_W / 2 - 0.036)
    return segments
  }, [])
  const sideLabelY = ISLAND_H / 2
  const sideLabelOffsetX = ISLAND_RENDER_W / 2 + 0.024
  const sideLabelOffsetZ = ISLAND_RENDER_D / 2 + 0.024
  const sideLabelProps = {
    fontSize: 0.72,
    color: '#fff',
    anchorX: 'center',
    anchorY: 'middle',
    outlineWidth: 0.096,
    outlineColor: color,
    outlineOpacity: 1,
  }

  return (
    <group
      position={position}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDoubleClick?.()
      }}
    >
      <RoundedBox
        castShadow
        receiveShadow
        args={[ISLAND_RENDER_W, ISLAND_H, ISLAND_RENDER_D]}
        radius={0.3}
        smoothness={4}
        position={[0, ISLAND_H / 2, 0]}
      >
        <meshStandardMaterial color={color} roughness={0.88} metalness={0} />
      </RoundedBox>
      <mesh
        receiveShadow
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ISLAND_H + 0.006, 0]}
      >
        <planeGeometry args={[ISLAND_RENDER_W - 0.6, ISLAND_RENDER_D - 0.6]} />
        <meshStandardMaterial color={color} roughness={0.86} metalness={0} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ISLAND_H + 0.012, 0]}
      >
        <planeGeometry args={[ISLAND_RENDER_W - 0.6, ISLAND_RENDER_D - 0.6]} />
        <meshBasicMaterial
          map={floorTexture}
          transparent
          opacity={focused ? 0.92 : 0.82}
          depthWrite={false}
        />
      </mesh>
      {focused && dashSegments.map((segment, i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, segment.rot]}
          position={segment.pos}
        >
          <planeGeometry args={segment.size} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthWrite={false} />
        </mesh>
      ))}
      {!focused && (
        <Text
          position={[0, ISLAND_H + 0.56, 0]}
          fontSize={0.92}
          color="#fff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.124}
          outlineColor={color}
          outlineOpacity={1}
        >
          {name}
        </Text>
      )}
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
  // Section lines land at multiples of ISLAND_W (= sectionSize = 10).
  // Cell midpoints are at 10k + 5; startCol/Row picks the leftmost cell index
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

// ── Note card (rendered on focused island floor) ─────────────────────────────
const NOTE_W = 4.05
const NOTE_D = 2.62
const NOTE_H = 0.10
const NOTE_MILESTONE_SIZE = 0.68
const NOTE_MILESTONE_H = 0.026
const NOTE_MILESTONE_GAP = 0.16
const NOTE_MILESTONE_HIT_PAD = 0.12
const NOTE_MILESTONE_SURFACE_Y = NOTE_H + 0.024
const NOTE_MILESTONE_CENTER_Y = NOTE_MILESTONE_SURFACE_Y + NOTE_MILESTONE_H / 2
const NOTE_MILESTONE_TOP_Y = NOTE_MILESTONE_SURFACE_Y + NOTE_MILESTONE_H
const NOTE_SLOT_W = NOTE_W + 0.48
const NOTE_SLOT_D = NOTE_D + 0.62
const MINI_TARGET_HEIGHT = 1.04
const MINI_PERSONA_SPACING = 1.76
const PLATEAU_W = 13.6
const PLATEAU_D = 3.8
const PLATEAU_H = 0.72

function layoutMilestonesOnNote(milestones) {
  const sorted = [...milestones].sort((a, b) => (a.startCol ?? 0) - (b.startCol ?? 0))
  if (sorted.length === 0) return []
  const cols = Math.max(1, Math.floor((NOTE_W - 0.32 + NOTE_MILESTONE_GAP) / (NOTE_MILESTONE_SIZE + NOTE_MILESTONE_GAP)))
  const usedW = (Math.min(cols, sorted.length) - 1) * (NOTE_MILESTONE_SIZE + NOTE_MILESTONE_GAP)
  const rowCount = Math.ceil(sorted.length / cols)
  const usedD = (rowCount - 1) * (NOTE_MILESTONE_SIZE + NOTE_MILESTONE_GAP)
  return sorted.map((ms, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      milestone: ms,
      x: -usedW / 2 + col * (NOTE_MILESTONE_SIZE + NOTE_MILESTONE_GAP),
      z: -usedD / 2 + row * (NOTE_MILESTONE_SIZE + NOTE_MILESTONE_GAP) + 0.22,
      w: NOTE_MILESTONE_SIZE,
      d: NOTE_MILESTONE_SIZE,
    }
  })
}

function LeaderPlateau({ islandPos, color, highlighted = false }) {
  const centerZ = islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D / 2
  return (
    <group position={[islandPos[0], 0, centerZ]}>
      <RoundedBox
        castShadow
        receiveShadow
        args={[PLATEAU_W, PLATEAU_H, PLATEAU_D]}
        radius={0.18}
        smoothness={4}
        position={[0, ISLAND_H + PLATEAU_H / 2, 0]}
      >
        <meshStandardMaterial
          color={color}
          roughness={0.72}
          metalness={0.04}
          emissive={color}
          emissiveIntensity={highlighted ? 0.28 : 0.06}
        />
      </RoundedBox>
      {/* Subtle grid on top surface */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ISLAND_H + PLATEAU_H + 0.004, 0]}>
        <planeGeometry args={[PLATEAU_W, PLATEAU_D]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={highlighted ? 0.22 : 0.10} depthWrite={false} />
      </mesh>
    </group>
  )
}

function computeLeaderPositions(islandPos, leaders) {
  if (leaders.length === 0) return []
  const centerZ = islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D / 2
  const totalW = (leaders.length - 1) * MINI_PERSONA_SPACING
  return leaders.map((persona, i) => ({
    ...persona,
    leaderPos: [
      islandPos[0] - totalW / 2 + i * MINI_PERSONA_SPACING,
      ISLAND_H + PLATEAU_H,
      centerZ,
    ],
  }))
}

function NoteCard({ position, title, color = '#888', highlighted = false, focused = false, dimmed = false, milestones = [], highlightedMilestoneId = null, onDoubleClick }) {
  const [hovered, setHovered] = useState(false)
  const active = highlighted || hovered || focused
  const opacity = dimmed ? 0.38 : 1
  const milestoneLayout = layoutMilestonesOnNote(milestones)
  const handleDoubleClick = e => {
    e.stopPropagation()
    onDoubleClick?.()
  }
  return (
    <group position={position} onDoubleClick={handleDoubleClick}>
      <RoundedBox
        castShadow
        args={[NOTE_W, NOTE_H, NOTE_D]}
        radius={0.03}
        smoothness={4}
        position={[0, NOTE_H / 2, 0]}
        onDoubleClick={handleDoubleClick}
      >
        <meshStandardMaterial
          color={active ? '#eef4ff' : '#ffffff'}
          roughness={0.55}
          metalness={0}
          emissive={focused ? color : highlighted ? '#3366ff' : '#000'}
          emissiveIntensity={focused ? 0.13 : highlighted ? 0.08 : 0}
          transparent={dimmed}
          opacity={opacity}
        />
      </RoundedBox>
      {/* Thin colored accent strip on front face */}
      <mesh position={[0, NOTE_H * 0.5, NOTE_D / 2 + 0.001]} onDoubleClick={handleDoubleClick}>
        <planeGeometry args={[NOTE_W, NOTE_H]} />
        <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.25 : active ? 0.75 : 0.55} depthWrite={false} />
      </mesh>
      <Text
        position={[0, NOTE_H + 0.012, focused ? -NOTE_D * 0.34 : 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={focused ? 0.13 : 0.18}
        color="#111"
        anchorX="center"
        anchorY="middle"
        maxWidth={NOTE_W - 0.20}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onDoubleClick={handleDoubleClick}
        fillOpacity={dimmed ? 0.38 : 1}
      >
        {title}
      </Text>
      {focused && (
        <group position={[0, NOTE_MILESTONE_SURFACE_Y, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
            <planeGeometry args={[NOTE_W - 0.14, NOTE_D - 0.14]} />
            <meshBasicMaterial color={color} transparent opacity={0.08} depthWrite={false} />
          </mesh>
          {milestoneLayout.length === 0 ? (
            <Text
              position={[0, 0.012, NOTE_D * 0.18]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={0.095}
              color="#777"
              anchorX="center"
              anchorY="middle"
              maxWidth={NOTE_W - 0.22}
            >
              No milestones yet
            </Text>
          ) : milestoneLayout.map(({ milestone: ms, x, z, w, d }) => {
            const milestoneHighlighted = highlightedMilestoneId === ms.id
            return (
              <group key={ms.id} position={[x, 0, z]}>
                <RoundedBox args={[w, NOTE_MILESTONE_H, d]} radius={0.035} smoothness={4} position={[0, NOTE_MILESTONE_H / 2, 0]}>
                  <meshStandardMaterial
                    color={milestoneHighlighted ? '#ffffff' : ms.color || color}
                    roughness={0.56}
                    metalness={0}
                    emissive={ms.color || color}
                    emissiveIntensity={milestoneHighlighted ? 0.34 : 0.08}
                  />
                </RoundedBox>
                <Text
                  position={[0, NOTE_MILESTONE_H + 0.012, 0]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  fontSize={0.095}
                  color={milestoneHighlighted ? (ms.color || color) : '#fff'}
                  anchorX="center"
                  anchorY="middle"
                  maxWidth={w - 0.06}
                >
                  {formatMilestoneDate(ms)}
                </Text>
              </group>
            )
          })}
        </group>
      )}
    </group>
  )
}

function computeNotesOnIsland(islandPos, notes, pageIndex = 0) {
  if (notes.length === 0) return { notes: [], pageCount: 1, noteStartZ: 0, maxRows: 0, cols: 0 }
  const availW = ISLAND_RENDER_W - 0.48
  const noteStartZ = islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D + 2.05 + NOTE_D / 2
  const availD = (islandPos[2] + ISLAND_RENDER_D / 2 - 1.00) - noteStartZ
  const cols = Math.max(1, Math.min(notes.length, Math.floor(availW / NOTE_SLOT_W)))
  const maxRows = Math.max(1, Math.floor(availD / NOTE_SLOT_D) + 1)
  const perPage = cols * maxRows
  const pageCount = Math.ceil(notes.length / perPage)
  const page = Math.min(pageIndex, pageCount - 1)
  const start = page * perPage
  const usedW = (cols - 1) * NOTE_SLOT_W
  const displayed = notes.slice(start, start + perPage).map((note, i) => ({
    ...note,
    notePos: [
      islandPos[0] - usedW / 2 + (i % cols) * NOTE_SLOT_W,
      ISLAND_H + 0.006,
      noteStartZ + Math.floor(i / cols) * NOTE_SLOT_D,
    ],
  }))
  return { notes: displayed, pageCount, noteStartZ, maxRows, cols }
}

function NotePagination({ pageIndex, pageCount, islandPos, color, onPrev, onNext, onGo }) {
  if (pageCount <= 1) return null

  const noteStartZ = islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D + 2.05 + NOTE_D / 2
  const availD = (islandPos[2] + ISLAND_RENDER_D / 2 - 1.00) - noteStartZ
  const maxRows = Math.max(1, Math.floor(availD / NOTE_SLOT_D) + 1)
  const paginationZ = noteStartZ + maxRows * NOTE_SLOT_D + 0.7

  const dotSpacing = 0.7
  const dotsWidth = (pageCount - 1) * dotSpacing
  const btnW = 1.4
  const btnH = 0.6
  const btnGap = 0.5

  return (
    <group
      position={[islandPos[0], ISLAND_H + 0.018, paginationZ]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      {/* Prev button */}
      <mesh
        position={[-dotsWidth / 2 - btnW / 2 - btnGap, 0, 0]}
        onClick={(e) => { e.stopPropagation(); if (pageIndex > 0) onPrev() }}
      >
        <planeGeometry args={[btnW, btnH]} />
        <meshBasicMaterial color={pageIndex > 0 ? color : '#bbb'} transparent opacity={pageIndex > 0 ? 1 : 0.35} />
      </mesh>
      <Text
        position={[-dotsWidth / 2 - btnW / 2 - btnGap, 0, 0.004]}
        fontSize={0.36}
        color="#fff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor={color}
      >
        {'‹'}
      </Text>

      {/* Page dots */}
      {Array.from({ length: pageCount }, (_, i) => (
        <mesh
          key={i}
          position={[i * dotSpacing - dotsWidth / 2, 0, 0]}
          onClick={(e) => { e.stopPropagation(); onGo(i) }}
        >
          <circleGeometry args={[i === pageIndex ? 0.22 : 0.16, 24]} />
          <meshBasicMaterial color={i === pageIndex ? color : '#888'} transparent opacity={i === pageIndex ? 1 : 0.6} />
        </mesh>
      ))}

      {/* Next button */}
      <mesh
        position={[dotsWidth / 2 + btnW / 2 + btnGap, 0, 0]}
        onClick={(e) => { e.stopPropagation(); if (pageIndex < pageCount - 1) onNext() }}
      >
        <planeGeometry args={[btnW, btnH]} />
        <meshBasicMaterial color={pageIndex < pageCount - 1 ? color : '#bbb'} transparent opacity={pageIndex < pageCount - 1 ? 1 : 0.35} />
      </mesh>
      <Text
        position={[dotsWidth / 2 + btnW / 2 + btnGap, 0, 0.004]}
        fontSize={0.36}
        color="#fff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.03}
        outlineColor={color}
      >
        {'›'}
      </Text>
    </group>
  )
}

function computeMiniPersonaLine(islandPos, personas) {
  if (personas.length === 0) return []
  const totalW = (personas.length - 1) * MINI_PERSONA_SPACING
  // Members stand just in front of the plateau
  const memberZ = islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D + 1.24
  return personas.map((persona, i) => ({
    ...persona,
    miniPos: [
      islandPos[0] - totalW / 2 + i * MINI_PERSONA_SPACING,
      ISLAND_H,
      memberZ,
    ],
  }))
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function personaSlotPosition(islandPos, idx, total) {
  const cols = Math.min(4, total)
  const rows = Math.ceil(total / cols)
  const col = idx % cols
  const row = Math.floor(idx / cols)
  const spacing = 1.5
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
  assignmentRevision = 0,
  notes = [],
  noteAssignments = [],
  milestones = [],
  personaNoteAssignments = [],
  personaMilestoneAssignments = [],
  categoryLeaders = [],
  focusedCategoryId = null,
  focusedNoteId = null,
  viewResetRevision = 0,
  layoutLocked = true,
  sourceDragPersonaId = null,
  onSourceDragEnd,
  onPositionUpdate,
  onAssign,
  onUnassign,
  onMoveAssignment,
  onFocusCategory,
  onFocusNote,
  onSelect,
  onAssignPersonaToNote,
  onAssignPersonaToMilestone,
  onAssignLeader,
  selected,
}) {
  const [dragId, setDragId]       = useState(null)
  const [posOverrides, setPosOverrides] = useState({})
  const [hoveredNoteId, setHoveredNoteId] = useState(null)
  const [hoveredMilestoneId, setHoveredMilestoneId] = useState(null)
  const [hoveringPlateau, setHoveringPlateau] = useState(false)
  const [notePageIndex, setNotePageIndex] = useState(0)
  const dragIdRef      = useRef(null)
  const dragAssignmentRef = useRef(null)
  const posOverridesRef = useRef({})
  const dragMovedRef   = useRef(false)
  const focusedNotesRef = useRef([])
  const milestoneTargetsRef = useRef([])
  const focusedIslandRef = useRef(null)
  const focusedCategoryIdRef = useRef(focusedCategoryId)
  const focusedNoteIdRef = useRef(focusedNoteId)
  useEffect(() => { focusedCategoryIdRef.current = focusedCategoryId }, [focusedCategoryId])
  useEffect(() => { focusedNoteIdRef.current = focusedNoteId }, [focusedNoteId])
  useEffect(() => { setNotePageIndex(0) }, [focusedCategoryId])

  const islands = computeIslandLayout(activeCats, layoutLocked)
  const focusedIsland = islands.find(cat => cat.id === focusedCategoryId)
  const activeDragId = dragId ?? sourceDragPersonaId
  const activeDragPersona = activeDragId ? personas.find(p => p.id === activeDragId) : null
  const activeDragPos = activeDragId ? posOverrides[activeDragId] : null
  const draggedAssignment = dragAssignmentRef.current

  const stopDrag = useCallback(() => {
    const id = dragIdRef.current ?? sourceDragPersonaId
    if (id !== null) {
      const pos = posOverridesRef.current[id]
      if (pos) {
        if (focusedCategoryIdRef.current) {
          // Check plateau drop first
          const fi = focusedIslandRef.current
          if (fi) {
            if (focusedNoteIdRef.current) {
              const targetMilestone = milestoneTargetsRef.current.find(target =>
                Math.abs(pos[0] - target.x) <= target.w / 2 &&
                Math.abs(pos[2] - target.z) <= target.d / 2
              )
              if (targetMilestone) onAssignPersonaToMilestone?.(id, targetMilestone.id)
            } else {
              const plateauCZ = fi.islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D / 2
              const onPlateau =
                Math.abs(pos[0] - fi.islandPos[0]) <= PLATEAU_W / 2 &&
                Math.abs(pos[2] - plateauCZ) <= PLATEAU_D / 2
              if (onPlateau) {
                onAssignLeader?.(id, focusedCategoryIdRef.current)
              } else {
                // Then check note drop
                const targetNote = focusedNotesRef.current.find(note =>
                  Math.abs(pos[0] - note.notePos[0]) <= NOTE_W / 2 &&
                  Math.abs(pos[2] - note.notePos[2]) <= NOTE_D / 2
                )
                if (targetNote) onAssignPersonaToNote?.(id, targetNote.id)
              }
            }
          }
        } else {
          if (dragIdRef.current && !layoutLocked) onPositionUpdate?.(id, pos[0], pos[2])
          const targetIsland = islands.find(cat =>
            Math.abs(pos[0] - cat.islandPos[0]) <= ISLAND_RENDER_W / 2 &&
            Math.abs(pos[2] - cat.islandPos[2]) <= ISLAND_RENDER_D / 2
          )
          const assignment = dragAssignmentRef.current
          if (targetIsland && activeDimensionId) {
            if (assignment && assignment.categoryId !== targetIsland.id) {
              dragAssignmentRef.current = null
              onMoveAssignment?.(assignment.personaId, assignment.dimensionId, assignment.categoryId, targetIsland.id)
            } else if (!assignment) {
              onAssign?.(id, activeDimensionId, targetIsland.id)
            }
          } else if (assignment) {
            dragAssignmentRef.current = null
            onUnassign?.(assignment.personaId, assignment.dimensionId, assignment.categoryId)
          }
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
    setHoveredNoteId(null)
    setHoveredMilestoneId(null)
    setHoveringPlateau(false)
    setDragId(null)
    onSourceDragEnd?.()
  }, [activeDimensionId, islands, layoutLocked, onAssign, onAssignLeader, onAssignPersonaToMilestone, onAssignPersonaToNote, onMoveAssignment, onPositionUpdate, onSourceDragEnd, onUnassign, sourceDragPersonaId])

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
    const newPos = [e.point.x, focusedNoteIdRef.current ? ISLAND_H + NOTE_H + 0.03 : ISLAND_H, e.point.z]
    posOverridesRef.current = { ...posOverridesRef.current, [id]: newPos }
    setPosOverrides(prev => ({ ...prev, [id]: newPos }))
    if (focusedCategoryIdRef.current) {
      if (focusedNoteIdRef.current) {
        const hm = milestoneTargetsRef.current.find(target =>
          Math.abs(e.point.x - target.x) <= target.w / 2 &&
          Math.abs(e.point.z - target.z) <= target.d / 2
        )
        setHoveredMilestoneId(hm?.id ?? null)
        setHoveredNoteId(null)
        setHoveringPlateau(false)
        return
      }
      const fi = focusedIslandRef.current
      let onPlat = false
      if (fi) {
        const plateauCZ = fi.islandPos[2] - ISLAND_RENDER_D / 2 + PLATEAU_D / 2
        onPlat =
          Math.abs(e.point.x - fi.islandPos[0]) <= PLATEAU_W / 2 &&
          Math.abs(e.point.z - plateauCZ) <= PLATEAU_D / 2
      }
      setHoveringPlateau(onPlat)
      if (!onPlat) {
        const hn = focusedNotesRef.current.find(note =>
          Math.abs(e.point.x - note.notePos[0]) <= NOTE_W / 2 &&
          Math.abs(e.point.z - note.notePos[2]) <= NOTE_D / 2
        )
        setHoveredNoteId(hn?.id ?? null)
      } else {
        setHoveredNoteId(null)
      }
    }
  }

  const assignedCopies = islands.flatMap(cat => {
    // Focused island personas are rendered separately as mini figures
    if (cat.id === focusedCategoryId) return []
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

  const focusedNotes = focusedIsland && activeDimensionId
    ? noteAssignments
        .filter(a => a.dimensionId === activeDimensionId && a.categoryId === focusedCategoryId)
        .map(a => notes.find(n => n.id === a.noteId))
        .filter(Boolean)
    : []
  const { notes: focusedNotesOnIsland, pageCount: notesPageCount } = focusedIsland
    ? computeNotesOnIsland(focusedIsland.islandPos, focusedNotes, notePageIndex)
    : { notes: [], pageCount: 1 }
  const focusedNoteOnIsland = focusedNoteId
    ? focusedNotesOnIsland.find(note => note.id === focusedNoteId) ?? null
    : null
  const focusedNoteMilestones = focusedNoteId
    ? milestones.filter(ms => ms.noteId === focusedNoteId)
    : []
  const focusedMilestoneTargets = focusedNoteOnIsland
    ? layoutMilestonesOnNote(focusedNoteMilestones).map(target => ({
        id: target.milestone.id,
        x: focusedNoteOnIsland.notePos[0] + target.x,
        z: focusedNoteOnIsland.notePos[2] + target.z,
        w: target.w + NOTE_MILESTONE_HIT_PAD,
        d: target.d + NOTE_MILESTONE_HIT_PAD,
      }))
    : []

  const leaderIdsInFocused = new Set(
    categoryLeaders.filter(l => l.categoryId === focusedCategoryId).map(l => l.personaId)
  )
  const focusedPersonas = focusedIsland && activeDimensionId
    ? personaAssignments
        .filter(a => a.dimensionId === activeDimensionId && a.categoryId === focusedCategoryId)
        .filter(a => !leaderIdsInFocused.has(a.personaId))
        .filter(a => !draggedAssignment ||
          a.personaId !== draggedAssignment.personaId ||
          a.dimensionId !== draggedAssignment.dimensionId ||
          a.categoryId !== draggedAssignment.categoryId
        )
        .map(a => personas.find(p => p.id === a.personaId))
        .filter(Boolean)
    : []
  const miniPersonas = computeMiniPersonaLine(focusedIsland?.islandPos ?? [0,0,0], focusedPersonas)

  const leaderPersonas = focusedIsland && focusedCategoryId
    ? categoryLeaders
        .filter(l => l.categoryId === focusedCategoryId)
        .map(l => personas.find(p => p.id === l.personaId))
        .filter(Boolean)
    : []
  const leaderPositions = computeLeaderPositions(focusedIsland?.islandPos ?? [0,0,0], leaderPersonas)

  // Keep refs in sync so stopDrag/handleDragMove always see latest state
  focusedNotesRef.current = focusedNotesOnIsland
  milestoneTargetsRef.current = focusedMilestoneTargets
  focusedIslandRef.current = focusedIsland ?? null

  // Map noteId → [persona, …] for rendering tiny figures on each note
  const notePersonaMap = {}
  personaNoteAssignments.forEach(a => {
    const p = personas.find(px => px.id === a.personaId)
    if (!p) return
    if (!notePersonaMap[a.noteId]) notePersonaMap[a.noteId] = []
    notePersonaMap[a.noteId].push(p)
  })

  const milestonePersonaMap = {}
  personaMilestoneAssignments.forEach(a => {
    const p = personas.find(px => px.id === a.personaId)
    if (!p) return
    if (!milestonePersonaMap[a.milestoneId]) milestonePersonaMap[a.milestoneId] = []
    milestonePersonaMap[a.milestoneId].push(p)
  })

  return (
    <>
      <ambientLight intensity={1.8} />
      <directionalLight position={[6, 10, 4]} intensity={1.0} castShadow />
      <pointLight position={[-4, 6, -4]} intensity={0.3} color="#c8d8ff" />

      <fog attach="fog" args={['#f8f8f6', 55, 140]} />
      <Environment preset="dawn" background={false} />
      <CursorManager dragging={activeDragId !== null} />
      <CameraDirector
        locked={layoutLocked}
        focusTarget={focusedNoteOnIsland?.notePos ?? focusedIsland?.islandPos ?? null}
        focusLevel={focusedNoteOnIsland ? 'note' : 'category'}
        resetRevision={viewResetRevision}
      />

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
        sectionSize={10}
        sectionThickness={1.6}
        sectionColor="#aaaaaa"
        fadeDistance={120}
        fadeStrength={1}
      />

      {islands.map(cat => (
        <CategoryIsland
          key={cat.id}
          position={cat.islandPos}
          color={cat.color || '#aaa'}
          name={cat.name}
          focused={focusedCategoryId === cat.id}
          onDoubleClick={() => onFocusCategory?.(cat.id)}
        />
      ))}

      <ContactShadows position={[0, 0.002, 0]} opacity={0.22} scale={40} blur={2.5} far={1} color="#7788aa" />

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
          targetHeight={focusedNoteId ? 0.38 : focusedCategoryId ? MINI_TARGET_HEIGHT : TARGET_HEIGHT}
          showName={!focusedCategoryId && !focusedNoteId}
          selected
          dragging
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        />
      )}

      {assignedCopies.map(({ persona, catId, assignment, position }, i) => (
        <PersonAvatar
          key={`${assignmentRevision}:${catId}:${persona.id}`}
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

      {focusedNotesOnIsland.map(note => {
        const notePersonas = notePersonaMap[note.id] || []
        const spacing = 0.45
        const noteFocused = focusedNoteId === note.id
        return (
          <group key={note.id}>
            <NoteCard
              position={note.notePos}
              title={note.title}
              color={focusedIsland?.color || '#888'}
              highlighted={hoveredNoteId === note.id}
              focused={noteFocused}
              dimmed={Boolean(focusedNoteId && !noteFocused)}
              milestones={noteFocused ? focusedNoteMilestones : []}
              highlightedMilestoneId={hoveredMilestoneId}
              onDoubleClick={() => onFocusNote?.(note.id)}
            />
            {notePersonas.map((persona, i) => (
              <PersonAvatar
                key={`np:${note.id}:${persona.id}`}
                modelKey={persona.modelKey}
                position={[
                  note.notePos[0] - (notePersonas.length - 1) * spacing / 2 + i * spacing,
                  note.notePos[1] + NOTE_H,
                  note.notePos[2],
                ]}
                name={persona.name}
                color={keyColor(persona.modelKey)}
                phaseId={i + 400}
                targetHeight={0.52}
                showName={false}
                selected={selected === persona.id}
                dragging={false}
                onPointerDown={e => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect?.(selected === persona.id ? null : persona.id)
                }}
              />
            ))}
          </group>
        )
      })}

      {focusedIsland && notesPageCount > 1 && (
        <NotePagination
          pageIndex={notePageIndex}
          pageCount={notesPageCount}
          islandPos={focusedIsland.islandPos}
          color={focusedIsland.color || '#888'}
          onPrev={() => setNotePageIndex(p => Math.max(0, p - 1))}
          onNext={() => setNotePageIndex(p => Math.min(notesPageCount - 1, p + 1))}
          onGo={setNotePageIndex}
        />
      )}

      {focusedNoteOnIsland && focusedMilestoneTargets.flatMap(target => {
        const assigned = milestonePersonaMap[target.id] || []
        const spacing = 0.15
        return assigned.map((persona, i) => (
          <PersonAvatar
            key={`ms:${target.id}:${persona.id}`}
            modelKey={persona.modelKey}
            position={[
              target.x - (assigned.length - 1) * spacing / 2 + i * spacing,
              focusedNoteOnIsland.notePos[1] + NOTE_MILESTONE_TOP_Y + 0.035,
              target.z,
            ]}
            name={persona.name}
            color={keyColor(persona.modelKey)}
            phaseId={i + 520}
            targetHeight={0.24}
            showName={false}
            selected={selected === persona.id}
            dragging={false}
            onPointerDown={e => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.(selected === persona.id ? null : persona.id)
            }}
          />
        ))
      })}

      {focusedIsland && (
        <LeaderPlateau
          islandPos={focusedIsland.islandPos}
          color={focusedIsland.color || '#888'}
          highlighted={hoveringPlateau}
        />
      )}

      {leaderPositions.map((persona, i) => (
        <PersonAvatar
          key={`leader:${persona.id}`}
          modelKey={persona.modelKey}
          position={persona.leaderPos}
          name={persona.name}
          color={keyColor(persona.modelKey)}
          phaseId={i + 300}
          targetHeight={MINI_TARGET_HEIGHT}
          showName={false}
          selected={selected === persona.id}
          dragging={false}
          onPointerDown={e => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onSelect?.(selected === persona.id ? null : persona.id)
          }}
        />
      ))}

      {miniPersonas.map((persona, i) => (
        <PersonAvatar
          key={`mini:${assignmentRevision}:${persona.id}`}
          modelKey={persona.modelKey}
          position={persona.miniPos}
          name={persona.name}
          color={keyColor(persona.modelKey)}
          phaseId={i + 200}
          targetHeight={MINI_TARGET_HEIGHT}
          showName={false}
          selected={selected === persona.id}
          dragging={false}
          onPointerDown={e => e.stopPropagation()}
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
        minDistance={focusedNoteId ? 1.15 : 6}
        maxDistance={60}
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

// ── Protopersona modal ────────────────────────────────────────────────────────
function ProtopersonaModal({ persona, assignments = [], categories = [], dimensions = [], onClose, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(persona.name)
  const [modelKey, setModelKey] = useState(resolveModelKey(persona.modelKey))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const personaAssignments = assignments
    .filter(a => a.personaId === persona.id)
    .map(a => ({
      ...a,
      category: categories.find(c => c.id === a.categoryId),
      dimension: dimensions.find(d => d.id === a.dimensionId),
    }))
    .filter(a => a.category && a.dimension)

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
          <span className={styles.addPanelTitle}>{editing ? 'Edit Protopersona' : 'Protopersona'}</span>
          <button className={styles.addPanelClose} onClick={onClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {!editing ? (
          <>
            <div className={styles.protoHero}>
              <img
                src={`/models/previews/character-${resolveModelKey(persona.modelKey)}.png`}
                alt={resolveModelKey(persona.modelKey)}
                className={styles.protoAvatar}
              />
              <div className={styles.protoInfo}>
                <div className={styles.protoName}>{persona.name}</div>
                <div className={styles.protoMeta}>Character {resolveModelKey(persona.modelKey).toUpperCase()}</div>
              </div>
            </div>

            <div className={styles.protoSection}>
              <div className={styles.addPanelLabel}>Assignments</div>
              {personaAssignments.length === 0 ? (
                <div className={styles.protoEmpty}>No category assignments yet</div>
              ) : (
                <div className={styles.protoAssignments}>
                  {personaAssignments.map(({ category, dimension, categoryId, dimensionId }) => (
                    <span
                      key={`${dimensionId}:${categoryId}`}
                      className={styles.protoAssignment}
                      style={{ borderColor: category.color, color: category.color }}
                    >
                      {dimension.name}: {category.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.editPanelActions}>
              <span />
              <button className={styles.addBtn} onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          </>
        ) : (
          <>
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
                <div className={styles.editPanelButtonGroup}>
                  <button className={styles.modalCancel} onClick={() => setEditing(false)}>
                    Back
                  </button>
                  <button
                    className={styles.addBtn}
                    onClick={handleSave}
                    disabled={!name.trim() || saving}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </>
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
  const [notes, setNotes]               = useState([])
  const [noteAssignments, setNoteAssignments] = useState([])
  const [milestones, setMilestones]     = useState([])
  const [personaNoteAssignments, setPersonaNoteAssignments] = useState([])
  const [personaMilestoneAssignments, setPersonaMilestoneAssignments] = useState([])
  const [categoryLeaders, setCategoryLeaders] = useState([])
  const [personaAssignments, setPersonaAssignments] = useState([])
  const personaAssignmentsRef = useRef([])
  const [assignmentRevision, setAssignmentRevision] = useState(0)
  const [selected, setSelected]         = useState(null)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [editPersonaId, setEditPersonaId] = useState(null)
  const [layoutLocked, setLayoutLocked] = useState(false)
  const [sourceDragPersonaId, setSourceDragPersonaId] = useState(null)
  const [focusedCategoryId, setFocusedCategoryId] = useState(null)
  const [focusedNoteId, setFocusedNoteId] = useState(null)
  const [viewResetRevision, setViewResetRevision] = useState(0)

  const replacePersonaAssignments = useCallback((nextAssignments, { immediate = false, revise = true } = {}) => {
    personaAssignmentsRef.current = nextAssignments
    const apply = () => {
      setPersonaAssignments(nextAssignments)
      if (revise) setAssignmentRevision(v => v + 1)
    }
    if (immediate) flushSync(apply)
    else apply()
  }, [])

  useEffect(() => {
    Promise.all([api.getDimensions(), api.getAllCategories(), api.getPersonas(), api.getPersonaAssignments(), api.getNotes(), api.getAssignments(), api.getMilestones(), api.getPersonaNoteAssignments(), api.getPersonaMilestoneAssignments(), api.getCategoryLeaders()])
      .then(([dims, cats, pers, personaAsns, notesList, noteAsns, ms, pnAsns, pmAsns, leaders]) => {
        setDimensions(dims)
        setCategories(cats)
        setDimIndex(0)
        setPersonas(pers)
        replacePersonaAssignments(personaAsns, { revise: true })
        setNotes(notesList)
        setNoteAssignments(noteAsns)
        setMilestones(ms)
        setPersonaNoteAssignments(pnAsns)
        setPersonaMilestoneAssignments(pmAsns)
        setCategoryLeaders(leaders)
      })
      .catch(console.error)
  }, [replacePersonaAssignments])

  useEffect(() => {
    personaAssignmentsRef.current = personaAssignments
  }, [personaAssignments])

  const activeDimension = dimensions[dimIndex] ?? null
  const activeCats = activeDimension
    ? categories.filter(c => c.dimensionId === activeDimension.id)
    : []
  const focusedCategory = focusedCategoryId
    ? activeCats.find(c => c.id === focusedCategoryId) ?? null
    : null

  useEffect(() => {
    if (!focusedCategoryId) return
    if (!activeCats.some(c => c.id === focusedCategoryId)) {
      setFocusedCategoryId(null)
      setFocusedNoteId(null)
      setViewResetRevision(v => v + 1)
    }
  }, [activeCats, focusedCategoryId])

  useEffect(() => {
    if (!focusedNoteId) return
    if (!focusedCategoryId || !activeDimension) {
      setFocusedNoteId(null)
      return
    }
    const stillInFocusedCategory = noteAssignments.some(a =>
      a.noteId === focusedNoteId &&
      a.dimensionId === activeDimension.id &&
      a.categoryId === focusedCategoryId
    )
    if (!stillInFocusedCategory) setFocusedNoteId(null)
  }, [activeDimension, focusedCategoryId, focusedNoteId, noteAssignments])

  const clearCategoryFocus = () => {
    setFocusedCategoryId(null)
    setFocusedNoteId(null)
    setViewResetRevision(v => v + 1)
  }

  const handleFocusCategory = catId => {
    setFocusedCategoryId(catId)
    setFocusedNoteId(null)
  }

  const clearNoteFocus = () => {
    setFocusedNoteId(null)
  }

  const handlePositionUpdate = async (id, x, z) => {
    try {
      await api.updatePersona(id, { pos_x: x, pos_z: z })
    } catch (e) { console.error(e) }
  }

  const handleAssignPersona = async (personaId, dimId, catId) => {
    const currentAssignments = personaAssignmentsRef.current
    if (currentAssignments.some(a => a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)) return
    const optimistic = { personaId, dimensionId: dimId, categoryId: catId }
    const nextAssignments = [...currentAssignments, optimistic]
    replacePersonaAssignments(nextAssignments, { immediate: true })
    try {
      const saved = await api.assignPersona(personaId, dimId, catId)
      const savedAssignments = personaAssignmentsRef.current.map(a =>
        a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId ? saved : a
      )
      replacePersonaAssignments(savedAssignments, { revise: false })
    } catch (e) {
      console.error(e)
      const revertedAssignments = personaAssignmentsRef.current.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId))
      replacePersonaAssignments(revertedAssignments)
    }
  }

  const handleUnassignPersona = async (personaId, dimId, catId) => {
    const currentAssignments = personaAssignmentsRef.current
    const removed = currentAssignments.find(a => a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId)
    const nextAssignments = currentAssignments.filter(a => !(a.personaId === personaId && a.dimensionId === dimId && a.categoryId === catId))
    replacePersonaAssignments(nextAssignments, { immediate: true })
    try {
      await api.unassignPersona(personaId, dimId, catId)
    } catch (e) {
      console.error(e)
      if (removed) {
        const revertedAssignments = [...personaAssignmentsRef.current, removed]
        replacePersonaAssignments(revertedAssignments)
      }
    }
  }

  const handleMovePersonaAssignment = async (personaId, dimId, fromCatId, toCatId) => {
    if (fromCatId === toCatId) return
    const previousAssignments = personaAssignmentsRef.current
    const nextAssignment = { personaId, dimensionId: dimId, categoryId: toCatId }
    const withoutOld = previousAssignments.filter(a => !(
      a.personaId === personaId &&
      a.dimensionId === dimId &&
      a.categoryId === fromCatId
    ))
    const alreadyTargeted = withoutOld.some(a =>
      a.personaId === personaId &&
      a.dimensionId === dimId &&
      a.categoryId === toCatId
    )
    const nextAssignments = alreadyTargeted ? withoutOld : [...withoutOld, nextAssignment]
    replacePersonaAssignments(nextAssignments, { immediate: true })
    try {
      if (!previousAssignments.some(a => a.personaId === personaId && a.dimensionId === dimId && a.categoryId === toCatId)) {
        await api.assignPersona(personaId, dimId, toCatId)
      }
      await api.unassignPersona(personaId, dimId, fromCatId)
    } catch (e) {
      console.error(e)
      replacePersonaAssignments(previousAssignments)
    }
  }

  const handleAssignLeader = async (personaId, catId) => {
    if (categoryLeaders.some(l => l.personaId === personaId && l.categoryId === catId)) return
    setCategoryLeaders(prev => [...prev, { personaId, categoryId: catId }])
    try {
      await api.addCategoryLeader(catId, personaId)
    } catch (e) {
      console.error(e)
      setCategoryLeaders(prev => prev.filter(l => !(l.personaId === personaId && l.categoryId === catId)))
    }
  }

  const handleRemoveLeader = async (personaId, catId) => {
    setCategoryLeaders(prev => prev.filter(l => !(l.personaId === personaId && l.categoryId === catId)))
    try {
      await api.removeCategoryLeader(catId, personaId)
    } catch (e) {
      console.error(e)
      setCategoryLeaders(prev => [...prev, { personaId, categoryId: catId }])
    }
  }

  const handleAssignPersonaToNote = async (personaId, noteId) => {
    if (personaNoteAssignments.some(a => a.personaId === personaId && a.noteId === noteId)) return
    setPersonaNoteAssignments(prev => [...prev, { personaId, noteId }])
    try {
      await api.assignPersonaToNote(personaId, noteId)
    } catch (e) {
      console.error(e)
      setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)))
    }
  }

  const handleAssignPersonaToMilestone = async (personaId, milestoneId) => {
    if (personaMilestoneAssignments.some(a => a.personaId === personaId && a.milestoneId === milestoneId)) return
    setPersonaMilestoneAssignments(prev => [...prev, { personaId, milestoneId }])
    try {
      await api.assignPersonaToMilestone(personaId, milestoneId)
    } catch (e) {
      console.error(e)
      setPersonaMilestoneAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.milestoneId === milestoneId)))
    }
  }

  const handleUnassignPersonaFromMilestone = async (personaId, milestoneId) => {
    setPersonaMilestoneAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.milestoneId === milestoneId)))
    try {
      await api.unassignPersonaFromMilestone(personaId, milestoneId)
    } catch (e) {
      console.error(e)
      setPersonaMilestoneAssignments(prev => [...prev, { personaId, milestoneId }])
    }
  }

  const handleUnassignPersonaFromNote = async (personaId, noteId) => {
    setPersonaNoteAssignments(prev => prev.filter(a => !(a.personaId === personaId && a.noteId === noteId)))
    try {
      await api.unassignPersonaFromNote(personaId, noteId)
    } catch (e) {
      console.error(e)
      setPersonaNoteAssignments(prev => [...prev, { personaId, noteId }])
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
    const previousNoteAssignments = personaNoteAssignments
    const previousMilestoneAssignments = personaMilestoneAssignments
    setPersonas(prev => prev.filter(p => p.id !== id))
    replacePersonaAssignments(personaAssignmentsRef.current.filter(a => a.personaId !== id))
    setPersonaNoteAssignments(prev => prev.filter(a => a.personaId !== id))
    setPersonaMilestoneAssignments(prev => prev.filter(a => a.personaId !== id))
    setSelected(null)
    setEditPersonaId(null)
    try {
      await api.deletePersona(id)
    } catch (e) {
      setPersonas(previousPersonas)
      replacePersonaAssignments(previousAssignments)
      setPersonaNoteAssignments(previousNoteAssignments)
      setPersonaMilestoneAssignments(previousMilestoneAssignments)
      throw e
    }
  }

  const selectedPersona = personas.find(p => p.id === selected) ?? null
  const focusedNote = focusedNoteId ? notes.find(n => n.id === focusedNoteId) ?? null : null
  const selectedAssignments = selectedPersona && activeDimension
    ? personaAssignments
      .filter(a => a.personaId === selectedPersona.id && a.dimensionId === activeDimension.id)
      .map(a => ({ ...a, category: categories.find(c => c.id === a.categoryId) }))
      .filter(a => a.category)
    : []
  const selectedNoteAssignments = selectedPersona && focusedCategoryId
    ? personaNoteAssignments
      .filter(a => a.personaId === selectedPersona.id)
      .map(a => ({ ...a, note: notes.find(n => n.id === a.noteId) }))
      .filter(a => a.note)
    : []
  const selectedMilestoneAssignments = selectedPersona && focusedNoteId
    ? personaMilestoneAssignments
      .filter(a => a.personaId === selectedPersona.id)
      .map(a => ({ ...a, milestone: milestones.find(m => m.id === a.milestoneId) }))
      .filter(a => a.milestone)
    : []
  const isSelectedLeader = selectedPersona && focusedCategoryId
    ? categoryLeaders.some(l => l.personaId === selectedPersona.id && l.categoryId === focusedCategoryId)
    : false

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

  const openProtopersona = (personaId, e) => {
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
        camera={{ position: [0, 32, 56], fov: 48 }}
        className={styles.canvas}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <Scene
          activeDimensionId={activeDimension?.id ?? null}
          activeCats={activeCats}
          personas={personas}
          personaAssignments={personaAssignments}
          assignmentRevision={assignmentRevision}
          notes={notes}
          noteAssignments={noteAssignments}
          milestones={milestones}
          personaNoteAssignments={personaNoteAssignments}
          personaMilestoneAssignments={personaMilestoneAssignments}
          categoryLeaders={categoryLeaders}
          focusedCategoryId={focusedCategoryId}
          focusedNoteId={focusedNoteId}
          viewResetRevision={viewResetRevision}
          layoutLocked={layoutLocked}
          sourceDragPersonaId={sourceDragPersonaId}
          onSourceDragEnd={() => setSourceDragPersonaId(null)}
          onPositionUpdate={handlePositionUpdate}
          onAssign={handleAssignPersona}
          onUnassign={handleUnassignPersona}
          onMoveAssignment={handleMovePersonaAssignment}
          onFocusCategory={handleFocusCategory}
          onFocusNote={setFocusedNoteId}
          onSelect={setSelected}
          onAssignPersonaToNote={handleAssignPersonaToNote}
          onAssignPersonaToMilestone={handleAssignPersonaToMilestone}
          onAssignLeader={handleAssignLeader}
          selected={selected}
        />
      </Canvas>

      <DimensionScroller dimensions={dimensions} index={dimIndex} onChange={setDimIndex} />

      {focusedCategory && (
        <div className={styles.categoryFocusPanel}>
          <span
            className={styles.categoryFocusSwatch}
            style={{ background: focusedCategory.color || '#aaa' }}
          />
          <span className={styles.categoryFocusName}>
            {focusedNote ? `${focusedCategory.name} / ${focusedNote.title || 'Untitled'}` : focusedCategory.name}
          </span>
          {focusedNote && (
            <button
              className={styles.categoryFocusClear}
              onClick={clearNoteFocus}
              title="Back to category"
            >
              Category
            </button>
          )}
          <button
            className={styles.categoryFocusClear}
            onClick={clearCategoryFocus}
            title="Back to full view"
          >
            Full view
          </button>
        </div>
      )}

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
            <div className={styles.personaPanelSub}>
              {focusedNote ? 'Drag to a milestone' : focusedCategory ? 'Drag to a note' : 'Drag to a category'}
            </div>
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
              onDoubleClick={e => openProtopersona(persona.id, e)}
              onClick={() => setSelected(selected === persona.id ? null : persona.id)}
              title="Drag to assign. Double-click to open."
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
        <ProtopersonaModal
          persona={editPersona}
          assignments={personaAssignments}
          categories={categories}
          dimensions={dimensions}
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
          {(selectedAssignments.length > 0 || selectedNoteAssignments.length > 0 || selectedMilestoneAssignments.length > 0 || isSelectedLeader) && (
            <div className={styles.assignmentChips}>
              {isSelectedLeader && (
                <button
                  className={styles.assignmentChip}
                  style={{ borderColor: focusedCategory?.color || '#888', color: focusedCategory?.color || '#888', fontWeight: 800 }}
                  onClick={() => handleRemoveLeader(selectedPersona.id, focusedCategoryId)}
                  title="Remove as leader"
                >
                  ★ Leader
                  <span>×</span>
                </button>
              )}
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
              {selectedNoteAssignments.map(({ note, noteId }) => (
                <button
                  key={noteId}
                  className={styles.assignmentChip}
                  style={{ borderColor: focusedCategory?.color || '#888', color: focusedCategory?.color || '#888' }}
                  onClick={() => handleUnassignPersonaFromNote(selectedPersona.id, noteId)}
                  title={`Remove from note "${note.title}"`}
                >
                  {note.title || 'Untitled'}
                  <span>×</span>
                </button>
              ))}
              {selectedMilestoneAssignments.map(({ milestone, milestoneId }) => (
                <button
                  key={milestoneId}
                  className={styles.assignmentChip}
                  style={{ borderColor: milestone.color || focusedCategory?.color || '#888', color: milestone.color || focusedCategory?.color || '#888' }}
                  onClick={() => handleUnassignPersonaFromMilestone(selectedPersona.id, milestoneId)}
                  title={`Remove from milestone "${milestone.title || formatMilestoneDate(milestone)}"`}
                >
                  {milestone.title || formatMilestoneDate(milestone)}
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
