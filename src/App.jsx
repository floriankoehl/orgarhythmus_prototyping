import Toolbar from './components/Toolbar'
import DocumentCanvas from './components/DocumentCanvas'
import styles from './App.module.css'

export default function App() {
  return (
    <div className={styles.app}>
      <Toolbar />
      <DocumentCanvas />
    </div>
  )
}
