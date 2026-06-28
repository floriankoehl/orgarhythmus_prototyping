import { useState, useEffect } from 'react'

const CHAR_KEYS = 'abcdefghijklmnopqr'.split('')
const RETRO_KEY_FALLBACKS = { humanFemaleA: 'a', humanMaleA: 'b', zombieFemaleA: 'c', zombieMaleA: 'd' }
const resolveModelKey = key => CHAR_KEYS.includes(key) ? key : (RETRO_KEY_FALLBACKS[key] ?? 'a')

function makeCircularCursor(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => {
      const size = 36
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      // clip to circle
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(img, 0, 0, size, size)
      // white ring
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2
      ctx.stroke()
      resolve(`url("${canvas.toDataURL()}") ${size / 2} ${size / 2}, crosshair`)
    }
    img.onerror = () => resolve('crosshair')
    img.src = src
  })
}

export function usePersonaCursor(persona) {
  const [cursor, setCursor] = useState('crosshair')

  useEffect(() => {
    if (!persona) {
      setCursor('crosshair')
      return
    }
    const src = `/models/previews/character-${resolveModelKey(persona.modelKey)}.png`
    let cancelled = false
    makeCircularCursor(src).then(c => { if (!cancelled) setCursor(c) })
    return () => { cancelled = true }
  }, [persona?.id, persona?.modelKey])

  return persona ? cursor : null
}
