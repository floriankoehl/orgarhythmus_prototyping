import styles from './StatusBar.module.css'

export default function StatusBar({ editor }) {
  const { wordCount, charCount, zoom } = editor

  return (
    <div className={styles.statusBar}>
      <span>{wordCount} word{wordCount !== 1 ? 's' : ''}</span>
      <span className={styles.sep}>·</span>
      <span>{charCount} character{charCount !== 1 ? 's' : ''}</span>
      <div className={styles.spacer} />
      <span>{zoom}%</span>
    </div>
  )
}
