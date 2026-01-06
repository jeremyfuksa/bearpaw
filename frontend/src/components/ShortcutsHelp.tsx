interface ShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsHelp({ isOpen, onClose }: ShortcutsHelpProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-content" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h3>Keyboard Shortcuts</h3>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            ×
          </button>
        </header>
        <dl className="shortcut-list">
          <div>
            <dt>Ctrl/Cmd + S</dt>
            <dd>Start scanning</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + H</dt>
            <dd>Hold current frequency</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + F</dt>
            <dd>Open direct tune</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + M</dt>
            <dd>Browse memory</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + B</dt>
            <dd>Jump to current bank view</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + C</dt>
            <dd>Copy current frequency</dd>
          </div>
          <div>
            <dt>Ctrl/Cmd + ↑/↓</dt>
            <dd>Channel up/down</dd>
          </div>
          <div>
            <dt>Escape</dt>
            <dd>Close overlays</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
