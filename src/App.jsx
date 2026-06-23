import { useState } from 'react'
import Toolbar from './components/Toolbar'
import DocumentCanvas from './components/DocumentCanvas'
import ClassificationPage from './components/ClassificationPage'
import styles from './App.module.css'

export default function App() {
  const [view, setView] = useState(0)
  const [goals, setGoals] = useState([])

  return (
    <div className={styles.app}>
      <div className={styles.slider} style={{ transform: `translateX(${-view * 100}vw)` }}>

        {/* View 0 — Goal Definition */}
        <div className={styles.view}>
          <Toolbar />
          <DocumentCanvas onGoalsChange={setGoals} />
          <div className={styles.rightEdge} onClick={() => setView(1)} title="Classification →" />
        </div>

        {/* View 1 — Classification */}
        <div className={styles.view}>
          <ClassificationPage goals={goals} />
          <div className={styles.leftEdge} onClick={() => setView(0)} title="← Goal Definition" />
        </div>

      </div>
    </div>
  )
}
