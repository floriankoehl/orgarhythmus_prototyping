import styles from './Toolbar.module.css'

function ToolBtn({ title, onMouseDown, children }) {
  return (
    <button className={styles.toolBtn} title={title} onMouseDown={onMouseDown}>
      {children}
    </button>
  )
}

function Divider() {
  return <div className={styles.divider} />
}

const exec = (cmd) => (e) => {
  e.preventDefault()
  document.execCommand(cmd, false, null)
}

export default function Toolbar() {
  return (
    <div className={styles.toolbar}>
      <ToolBtn title="Bold (Ctrl+B)" onMouseDown={exec('bold')}><BoldIcon /></ToolBtn>
      <ToolBtn title="Italic (Ctrl+I)" onMouseDown={exec('italic')}><ItalicIcon /></ToolBtn>
      <ToolBtn title="Underline (Ctrl+U)" onMouseDown={exec('underline')}><UnderlineIcon /></ToolBtn>
      <Divider />
      <ToolBtn title="Align left" onMouseDown={exec('justifyLeft')}><AlignLeftIcon /></ToolBtn>
      <ToolBtn title="Align center" onMouseDown={exec('justifyCenter')}><AlignCenterIcon /></ToolBtn>
    </div>
  )
}

const BoldIcon = () => <span style={{ fontWeight: 700, fontSize: 13 }}>B</span>
const ItalicIcon = () => <span style={{ fontStyle: 'italic', fontSize: 13 }}>I</span>
const UnderlineIcon = () => <span style={{ textDecoration: 'underline', fontSize: 13 }}>U</span>
const AlignLeftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z"/>
  </svg>
)
const AlignCenterIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z"/>
  </svg>
)
