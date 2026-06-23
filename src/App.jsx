import { useState } from 'react'
import Header from './components/Header'
import Toolbar from './components/Toolbar'
import DocumentCanvas from './components/DocumentCanvas'
import ClassificationPage from './components/ClassificationPage'
import SchedulePage from './components/SchedulePage'
import styles from './App.module.css'

export default function App() {
  const [view, setView] = useState(0)
  const [goals, setGoals] = useState([])

  return (
    <div className={styles.app}>
      <Header view={view} onNavigate={setView} />
      <div className={styles.slider} style={{ transform: `translateX(${-view * 100}vw)` }}>

        {/* View 0 — Brainstorming */}
        <div className={styles.view}>
          <Toolbar />
          <DocumentCanvas onGoalsChange={setGoals} />
        </div>

        {/* View 1 — Classification */}
        <div className={styles.view}>
          <ClassificationPage goals={goals} />
        </div>

        {/* View 2 — Schedule */}
        <div className={styles.view}>
          <SchedulePage />
        </div>

      </div>
    </div>
  )
}
