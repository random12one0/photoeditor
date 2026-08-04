interface Props {
  onClose: () => void
}

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['→', 'Enter', 'Y'], action: 'Confirm this pair' },
  { keys: ['←', 'X'], action: 'Not a pair' },
  { keys: ['S'], action: 'Swap before and after' },
  { keys: ['Space'], action: 'Skip for now' },
  { keys: ['P'], action: 'Toggle finished preview' },
  { keys: ['↑', '↓'], action: 'Previous / next car' },
  { keys: ['Ctrl', 'Z'], action: 'Undo' },
  { keys: ['?'], action: 'This list' },
]

export default function ShortcutSheet({ onClose }: Props) {
  return (
    <div
      className="sheet-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>Keyboard shortcuts</h3>
        <p className="tiny muted" style={{ marginBottom: 12 }}>
          On a phone every one of these is a button — you never need a keyboard.
        </p>
        {SHORTCUTS.map((s) => (
          <div className="shortcut-row" key={s.action}>
            <span>{s.action}</span>
            <span className="shortcut-keys">
              {s.keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
        <button className="btn block" style={{ marginTop: 20 }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
