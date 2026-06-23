import styles from './Ruler.module.css'

const PAGE_H = 1056
const MAJOR = 96  // every inch
const MINOR = 24  // quarter inch

const ticks = []
for (let y = MINOR; y < PAGE_H; y += MINOR) {
  ticks.push({ y, major: y % MAJOR === 0 })
}

export default function Ruler({ hoverY, onMouseMove, onMouseLeave, onClick }) {
  return (
    <div
      className={styles.ruler}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {ticks.map(t => (
        <div
          key={t.y}
          className={t.major ? styles.majorTick : styles.minorTick}
          style={{ top: t.y }}
        />
      ))}
      {hoverY !== null && (
        <div className={styles.indicator} style={{ top: hoverY }} />
      )}
    </div>
  )
}
