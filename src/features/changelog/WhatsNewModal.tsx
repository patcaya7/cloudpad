import { useEffect } from 'react';
import type { ChangelogEntry } from './changelog-data';

interface WhatsNewModalProps {
  entries: ChangelogEntry[];
  onClose: () => void;
}

export function WhatsNewModal({ entries, onClose }: WhatsNewModalProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" onClick={onClose}>
      <div className="whats-new-card" onClick={(event) => event.stopPropagation()}>
        <header className="whats-new-header">
          <h2 id="whats-new-title">มีอะไรใหม่</h2>
          <button type="button" className="whats-new-close" aria-label="ปิด" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="whats-new-body">
          {entries.map((entry, index) => (
            <section className={`whats-new-entry ${index === 0 ? 'whats-new-entry-latest' : ''}`} key={entry.version}>
              <h3>V {entry.version}</h3>
              <ul>
                {entry.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
