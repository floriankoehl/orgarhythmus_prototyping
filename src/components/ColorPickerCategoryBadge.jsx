export default function ColorPickerCategoryBadge({ children }) {
  return (
    <span style={{
      marginLeft: 'auto',
      padding: '2px 5px',
      color: '#7c3aed',
      background: '#ede9fe',
      borderRadius: 999,
      font: '900 9px Arial, sans-serif',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  )
}
