import styles from './Header.module.css'

const PAGES = ['Brainstorming', 'Classification', 'Schedule']

export default function Header({ view, onNavigate }) {
  return (
    <header className={styles.header}>
      <nav className={styles.nav}>
        {PAGES.map((name, i) => (
          <button
            key={i}
            className={`${styles.navItem} ${view === i ? styles.active : ''}`}
            onClick={() => onNavigate(i)}
          >
            {name}
          </button>
        ))}
      </nav>
    </header>
  )
}
