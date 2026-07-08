import * as LucideIcons from 'lucide-react'

export const DEFAULT_TYPE_ICONS = {
  thought: 'cloudy',
  task: 'square',
  project: 'layers',
}

export const ICON_OPTIONS = [
  { key: 'image', label: 'Image', icon: 'Image', group: 'Core' },
  { key: 'cloudy', label: 'Thought', icon: 'Cloudy', group: 'Core' },
  { key: 'layers', label: 'Project', icon: 'Layers', group: 'Core' },
  { key: 'square', label: 'Task', icon: 'Square', group: 'Core' },
  { key: 'check-square', label: 'Done', icon: 'CheckSquare', group: 'Core' },
  { key: 'circle-minus', label: 'Unassigned', icon: 'CircleMinus', group: 'Core' },
  { key: 'star', label: 'Star', icon: 'Star', group: 'Signals' },
  { key: 'flag', label: 'Flag', icon: 'Flag', group: 'Signals' },
  { key: 'target', label: 'Target', icon: 'Target', group: 'Signals' },
  { key: 'alert', label: 'Alert', icon: 'AlertTriangle', group: 'Signals' },
  { key: 'flame', label: 'Flame', icon: 'Flame', group: 'Signals' },
  { key: 'zap', label: 'Energy', icon: 'Zap', group: 'Signals' },
  { key: 'heart', label: 'Heart', icon: 'Heart', group: 'Signals' },
  { key: 'lightbulb', label: 'Idea', icon: 'Lightbulb', group: 'Thinking' },
  { key: 'brain', label: 'Brain', icon: 'Brain', group: 'Thinking' },
  { key: 'message', label: 'Message', icon: 'MessageCircle', group: 'Thinking' },
  { key: 'book', label: 'Book', icon: 'BookOpen', group: 'Thinking' },
  { key: 'search', label: 'Search', icon: 'Search', group: 'Thinking' },
  { key: 'info', label: 'Info', icon: 'Info', group: 'Thinking' },
  { key: 'help', label: 'Question', icon: 'HelpCircle', group: 'Thinking' },
  { key: 'pin', label: 'Pin', icon: 'Pin', group: 'Planning' },
  { key: 'map-pin', label: 'Place', icon: 'MapPin', group: 'Planning' },
  { key: 'calendar', label: 'Calendar', icon: 'Calendar', group: 'Planning' },
  { key: 'clock', label: 'Time', icon: 'Clock', group: 'Planning' },
  { key: 'bookmark', label: 'Bookmark', icon: 'Bookmark', group: 'Planning' },
  { key: 'bell', label: 'Notify', icon: 'Bell', group: 'Planning' },
  { key: 'cat', label: 'Cat', icon: 'Cat', group: 'Animals' },
  { key: 'dog', label: 'Dog', icon: 'Dog', group: 'Animals' },
  { key: 'bird', label: 'Bird', icon: 'Bird', group: 'Animals' },
  { key: 'fish', label: 'Fish', icon: 'Fish', group: 'Animals' },
  { key: 'rabbit', label: 'Rabbit', icon: 'Rabbit', group: 'Animals' },
  { key: 'turtle', label: 'Turtle', icon: 'Turtle', group: 'Animals' },
  { key: 'snail', label: 'Snail', icon: 'Snail', group: 'Animals' },
  { key: 'worm', label: 'Worm', icon: 'Worm', group: 'Animals' },
  { key: 'rat', label: 'Rat', icon: 'Rat', group: 'Animals' },
  { key: 'squirrel', label: 'Squirrel', icon: 'Squirrel', group: 'Animals' },
  { key: 'paw-print', label: 'Paw', icon: 'PawPrint', group: 'Animals' },
  { key: 'bone', label: 'Bone', icon: 'Bone', group: 'Animals' },
  { key: 'sun', label: 'Sun', icon: 'Sun', group: 'Nature' },
  { key: 'moon', label: 'Moon', icon: 'Moon', group: 'Nature' },
  { key: 'cloud', label: 'Cloud', icon: 'Cloud', group: 'Nature' },
  { key: 'cloud-sun', label: 'Cloud sun', icon: 'CloudSun', group: 'Nature' },
  { key: 'cloud-rain', label: 'Rain', icon: 'CloudRain', group: 'Nature' },
  { key: 'snowflake', label: 'Snow', icon: 'Snowflake', group: 'Nature' },
  { key: 'umbrella', label: 'Umbrella', icon: 'Umbrella', group: 'Nature' },
  { key: 'leaf', label: 'Leaf', icon: 'Leaf', group: 'Nature' },
  { key: 'sprout', label: 'Sprout', icon: 'Sprout', group: 'Nature' },
  { key: 'flower', label: 'Flower', icon: 'Flower', group: 'Nature' },
  { key: 'trees', label: 'Trees', icon: 'Trees', group: 'Nature' },
  { key: 'tree-pine', label: 'Pine', icon: 'TreePine', group: 'Nature' },
  { key: 'tree-palm', label: 'Palm', icon: 'TreePalm', group: 'Nature' },
  { key: 'shrub', label: 'Shrub', icon: 'Shrub', group: 'Nature' },
  { key: 'shell', label: 'Shell', icon: 'Shell', group: 'Nature' },
  { key: 'car', label: 'Car', icon: 'Car', group: 'Transport' },
  { key: 'bus', label: 'Bus', icon: 'Bus', group: 'Transport' },
  { key: 'train', label: 'Train', icon: 'Train', group: 'Transport' },
  { key: 'truck', label: 'Truck', icon: 'Truck', group: 'Transport' },
  { key: 'bike', label: 'Bike', icon: 'Bike', group: 'Transport' },
  { key: 'plane', label: 'Plane', icon: 'Plane', group: 'Transport' },
  { key: 'ship', label: 'Ship', icon: 'Ship', group: 'Transport' },
  { key: 'sailboat', label: 'Sailboat', icon: 'Sailboat', group: 'Transport' },
  { key: 'ambulance', label: 'Ambulance', icon: 'Ambulance', group: 'Transport' },
  { key: 'apple', label: 'Apple', icon: 'Apple', group: 'Food' },
  { key: 'banana', label: 'Banana', icon: 'Banana', group: 'Food' },
  { key: 'cherry', label: 'Cherry', icon: 'Cherry', group: 'Food' },
  { key: 'grape', label: 'Grape', icon: 'Grape', group: 'Food' },
  { key: 'carrot', label: 'Carrot', icon: 'Carrot', group: 'Food' },
  { key: 'egg', label: 'Egg', icon: 'Egg', group: 'Food' },
  { key: 'pizza', label: 'Pizza', icon: 'Pizza', group: 'Food' },
  { key: 'cake', label: 'Cake', icon: 'Cake', group: 'Food' },
  { key: 'cookie', label: 'Cookie', icon: 'Cookie', group: 'Food' },
  { key: 'croissant', label: 'Croissant', icon: 'Croissant', group: 'Food' },
  { key: 'popcorn', label: 'Popcorn', icon: 'Popcorn', group: 'Food' },
  { key: 'ice-cream-bowl', label: 'Ice cream', icon: 'IceCreamBowl', group: 'Food' },
  { key: 'utensils', label: 'Utensils', icon: 'Utensils', group: 'Food' },
  { key: 'file', label: 'File', icon: 'FileText', group: 'Objects' },
  { key: 'folder', label: 'Folder', icon: 'Folder', group: 'Objects' },
  { key: 'archive', label: 'Archive', icon: 'Archive', group: 'Objects' },
  { key: 'key', label: 'Key', icon: 'Key', group: 'Objects' },
  { key: 'gift', label: 'Gift', icon: 'Gift', group: 'Objects' },
  { key: 'shopping-cart', label: 'Shopping', icon: 'ShoppingCart', group: 'Objects' },
  { key: 'notebook', label: 'Notebook', icon: 'Notebook', group: 'Documents' },
  { key: 'clipboard', label: 'Clipboard', icon: 'Clipboard', group: 'Documents' },
  { key: 'clipboard-check', label: 'Checklist', icon: 'ClipboardCheck', group: 'Documents' },
  { key: 'newspaper', label: 'Newspaper', icon: 'Newspaper', group: 'Documents' },
  { key: 'receipt', label: 'Receipt', icon: 'Receipt', group: 'Documents' },
  { key: 'chart-line', label: 'Line chart', icon: 'ChartLine', group: 'Documents' },
  { key: 'chart-pie', label: 'Pie chart', icon: 'ChartPie', group: 'Documents' },
  { key: 'coins', label: 'Coins', icon: 'Coins', group: 'Money' },
  { key: 'wallet', label: 'Wallet', icon: 'Wallet', group: 'Money' },
  { key: 'credit-card', label: 'Card', icon: 'CreditCard', group: 'Money' },
  { key: 'banknote', label: 'Banknote', icon: 'Banknote', group: 'Money' },
  { key: 'landmark', label: 'Landmark', icon: 'Landmark', group: 'Money' },
  { key: 'hand-coins', label: 'Payment', icon: 'HandCoins', group: 'Money' },
  { key: 'user', label: 'Person', icon: 'User', group: 'People' },
  { key: 'users', label: 'Team', icon: 'Users', group: 'People' },
  { key: 'briefcase', label: 'Work', icon: 'Briefcase', group: 'People' },
  { key: 'home', label: 'Home', icon: 'Home', group: 'People' },
  { key: 'mail', label: 'Mail', icon: 'Mail', group: 'People' },
  { key: 'phone', label: 'Phone', icon: 'Phone', group: 'People' },
  { key: 'wrench', label: 'Tool', icon: 'Wrench', group: 'Systems' },
  { key: 'settings', label: 'Settings', icon: 'Settings', group: 'Systems' },
  { key: 'shield', label: 'Shield', icon: 'Shield', group: 'Systems' },
  { key: 'eye', label: 'Watch', icon: 'Eye', group: 'Systems' },
  { key: 'lock', label: 'Locked', icon: 'Lock', group: 'Systems' },
  { key: 'bug', label: 'Bug', icon: 'Bug', group: 'Systems' },
  { key: 'code', label: 'Code', icon: 'Code', group: 'Systems' },
  { key: 'database', label: 'Data', icon: 'Database', group: 'Systems' },
  { key: 'cpu', label: 'System', icon: 'Cpu', group: 'Systems' },
  { key: 'rocket', label: 'Launch', icon: 'Rocket', group: 'Creative' },
  { key: 'sparkles', label: 'Sparkles', icon: 'Sparkles', group: 'Creative' },
  { key: 'coffee', label: 'Break', icon: 'Coffee', group: 'Creative' },
  { key: 'music', label: 'Music', icon: 'Music', group: 'Creative' },
  { key: 'camera', label: 'Camera', icon: 'Camera', group: 'Creative' },
  { key: 'palette', label: 'Creative', icon: 'Palette', group: 'Creative' },
  { key: 'trophy', label: 'Win', icon: 'Trophy', group: 'Creative' },
  { key: 'crown', label: 'Crown', icon: 'Crown', group: 'Creative' },
  { key: 'gem', label: 'Gem', icon: 'Gem', group: 'Creative' },
  { key: 'dices', label: 'Dice', icon: 'Dices', group: 'Creative' },
  { key: 'gamepad', label: 'Gamepad', icon: 'Gamepad2', group: 'Creative' },
  { key: 'dumbbell', label: 'Fitness', icon: 'Dumbbell', group: 'Creative' },
  { key: 'tv', label: 'TV', icon: 'Tv', group: 'Media' },
  { key: 'radio', label: 'Radio', icon: 'Radio', group: 'Media' },
  { key: 'podcast', label: 'Podcast', icon: 'Podcast', group: 'Media' },
  { key: 'headphones', label: 'Headphones', icon: 'Headphones', group: 'Media' },
  { key: 'mic', label: 'Mic', icon: 'Mic', group: 'Media' },
  { key: 'video', label: 'Video', icon: 'Video', group: 'Media' },
  { key: 'monitor', label: 'Monitor', icon: 'Monitor', group: 'Media' },
  { key: 'laptop', label: 'Laptop', icon: 'Laptop', group: 'Media' },
  { key: 'smartphone', label: 'Phone', icon: 'Smartphone', group: 'Media' },
  { key: 'globe', label: 'World', icon: 'Globe', group: 'Creative' },
  { key: 'compass', label: 'Explore', icon: 'Compass', group: 'Creative' },
]

export const ICON_GROUPS = ['Core', 'Signals', 'Thinking', 'Planning', 'Animals', 'Nature', 'Transport', 'Food', 'Objects', 'Documents', 'Money', 'People', 'Systems', 'Creative', 'Media']

const ICON_BY_KEY = new Map(ICON_OPTIONS.map(option => [option.key, option]))

export function normalizeIconKey(icon) {
  return ICON_BY_KEY.has(icon) ? icon : ''
}

export function iconForCategory(category) {
  if (normalizeIconKey(category?.icon)) return category.icon
  const name = String(category?.name || '').toLowerCase()
  if (!name) return 'circle-minus'
  if (name.includes('done') || name.includes('complete')) return 'check-square'
  if (name.includes('progress') || name.includes('doing')) return 'clock'
  if (name.includes('schedule') || name.includes('time')) return 'calendar'
  if (name.includes('unscheduled') || name.includes('unassigned') || name.includes('none')) return 'circle-minus'
  if (name.includes('project') || name.includes('goal')) return 'layers'
  if (name.includes('task')) return 'square'
  if (name.includes('thought') || name.includes('idea')) return 'cloudy'
  if (name.includes('urgent') || name.includes('high') || name.includes('warn')) return 'alert'
  if (name.includes('medium')) return 'flag'
  if (name.includes('low')) return 'circle-minus'
  if (name.includes('bug')) return 'bug'
  if (name.includes('person') || name.includes('people') || name.includes('team')) return 'users'
  if (name.includes('work')) return 'briefcase'
  if (name.includes('home')) return 'home'
  if (name.includes('research') || name.includes('read')) return 'book'
  return 'star'
}

export function CategoryIconGlyph({ icon, size = 18, strokeWidth = 2.3, ...props }) {
  const option = ICON_BY_KEY.get(icon) || ICON_BY_KEY.get('help')
  const Icon = LucideIcons[option.icon] || LucideIcons.HelpCircle
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" {...props} />
}
