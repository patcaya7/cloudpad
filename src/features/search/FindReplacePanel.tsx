import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { SearchDirection, SearchMode } from './searchUtils';
import { DEFAULT_FONT_FAMILY, type FontWeight, withEmojiFontFallback } from '../../types/note';

export interface SearchTextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: FontWeight;
  color: string;
}

export interface FindReplaceRequest {
  query: string;
  replacement: string;
  mode: SearchMode;
  matchCase: boolean;
  wrapAround: boolean;
  backward: boolean;
  inSelection: boolean;
  wholeWord: boolean;
  textStyle: SearchTextStyle;
}

interface FindReplacePanelProps {
  detached?: boolean;
  initialQuery: string;
  resultMessage: string;
  zoom?: number;
  openSequence?: number;
  onZoomChange?: (zoom: number) => void;
  onFind: (direction: SearchDirection, request: FindReplaceRequest) => void;
  onReplace: (request: FindReplaceRequest) => void;
  onReplaceAll: (request: FindReplaceRequest) => void;
  onFormatMatches: (request: FindReplaceRequest) => void;
  onClose: () => void;
}

interface DialogPosition {
  x: number;
  y: number;
}

interface DragState {
  pointerX: number;
  pointerY: number;
  originX: number;
  originY: number;
}

const SEARCH_MODES: Array<{ value: SearchMode; label: string; hint: string }> = [
  { value: 'normal', label: 'ปกติ', hint: 'ค้นหาข้อความตรงตัว' },
  { value: 'extended', label: 'ขยาย', hint: 'รองรับ \\n, \\r, \\t, \\0, \\xHH' },
  { value: 'regex', label: 'นิพจน์ปกติ', hint: 'รองรับรูปแบบนิพจน์ค้นหา' }
];

const SEARCH_FONT_OPTIONS = [
  { label: 'Google Sans Text', value: DEFAULT_FONT_FAMILY },
  { label: 'Inter', value: withEmojiFontFallback('Inter, ui-sans-serif, system-ui') },
  { label: 'Segoe UI', value: withEmojiFontFallback('"Segoe UI", Tahoma, Geneva, Verdana, sans-serif') },
  { label: 'Tahoma', value: withEmojiFontFallback('Tahoma, Geneva, Verdana, sans-serif') },
  { label: 'Georgia', value: withEmojiFontFallback('Georgia, "Times New Roman", serif') },
  { label: 'Times New Roman', value: withEmojiFontFallback('"Times New Roman", Times, serif') },
  { label: 'Courier New', value: withEmojiFontFallback('"Courier New", Courier, monospace') },
  { label: 'Kanit', value: withEmojiFontFallback('Kanit, "Segoe UI", sans-serif') },
  { label: 'Sarabun', value: withEmojiFontFallback('Sarabun, "Segoe UI", sans-serif') }
];

const SEARCH_WEIGHT_OPTIONS: Array<{ label: string; value: FontWeight }> = [
  { label: 'บาง', value: '300' },
  { label: 'ปกติ', value: '400' },
  { label: 'กึ่งหนา', value: '600' },
  { label: 'หนา', value: '700' },
  { label: 'หนามาก', value: '800' }
];

type FindUiIconName =
  | 'search'
  | 'options'
  | 'mode'
  | 'format'
  | 'next'
  | 'previous'
  | 'replace'
  | 'replaceAll'
  | 'close'
  | 'info';

function FindUiIcon({ name }: { name: FindUiIconName }) {
  const commonProps = {
    className: 'find-ui-icon',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };

  if (name === 'search') {
    return <svg {...commonProps}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>;
  }
  if (name === 'options') {
    return <svg {...commonProps}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>;
  }
  if (name === 'mode') {
    return <svg {...commonProps}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /></svg>;
  }
  if (name === 'format') {
    return <svg {...commonProps}><path d="M7 20h10M9 16l3-11 3 11M10 12h4" /></svg>;
  }
  if (name === 'next') {
    return <svg {...commonProps}><path d="M5 12h14M14 7l5 5-5 5" /></svg>;
  }
  if (name === 'previous') {
    return <svg {...commonProps}><path d="M19 12H5M10 7l-5 5 5 5" /></svg>;
  }
  if (name === 'replace') {
    return <svg {...commonProps}><path d="M5 7h12l-3-3M19 17H7l3 3M17 7l-3 3M7 17l3-3" /></svg>;
  }
  if (name === 'replaceAll') {
    return <svg {...commonProps}><path d="M4 7h12l-3-3M18 17H6l3 3M16 7l-3 3M6 17l3-3" /><path d="M20 5v4M20 15v4" /></svg>;
  }
  if (name === 'info') {
    return <svg {...commonProps}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>;
  }
  return <svg {...commonProps}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function getInitialPosition(): DialogPosition {
  if (typeof window === 'undefined') return { x: 24, y: 34 };
  const initialWidth = Math.min(780, window.innerWidth - 32);
  // Dock to the top-right (like a browser find bar) so the editor area on the
  // left stays visible and the highlighted match is not hidden behind the panel.
  return {
    x: Math.max(16, window.innerWidth - initialWidth - 24),
    y: 34
  };
}

function clampDialogPosition(x: number, y: number, width: number, height: number): DialogPosition {
  const minVisibleWidth = 140;
  const minVisibleHeight = 70;
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - minVisibleWidth)),
    y: Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - Math.min(height, minVisibleHeight)))
  };
}

export function FindReplacePanel({
  detached = false,
  initialQuery,
  resultMessage,
  zoom = 1,
  openSequence = 0,
  onZoomChange,
  onFind,
  onReplace,
  onReplaceAll,
  onFormatMatches,
  onClose
}: FindReplacePanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState('');
  const [mode, setMode] = useState<SearchMode>('normal');
  const [matchCase, setMatchCase] = useState(false);
  const [wrapAround, setWrapAround] = useState(true);
  const [backward, setBackward] = useState(false);
  const [inSelection, setInSelection] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [formatFontFamily, setFormatFontFamily] = useState(DEFAULT_FONT_FAMILY);
  const [formatFontSize, setFormatFontSize] = useState(20);
  const [formatFontWeight, setFormatFontWeight] = useState<FontWeight>('400');
  const [formatColor, setFormatColor] = useState('#dc2626');
  const [position, setPosition] = useState<DialogPosition>(() => getInitialPosition());
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    window.setTimeout(() => {
      queryInputRef.current?.focus();
      queryInputRef.current?.select();
    }, 0);
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      const dialog = dialogRef.current;
      if (!dragState || !dialog) return;

      const rect = dialog.getBoundingClientRect();
      const nextX = dragState.originX + event.clientX - dragState.pointerX;
      const nextY = dragState.originY + event.clientY - dragState.pointerY;
      setPosition(clampDialogPosition(nextX, nextY, rect.width, rect.height));
    };

    const handleStop = () => {
      dragStateRef.current = null;
      document.body.classList.remove('is-dragging-find-dialog');
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleStop);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleStop);
      document.body.classList.remove('is-dragging-find-dialog');
    };
  }, []);

  const buildRequest = (): FindReplaceRequest => ({
    query,
    replacement,
    mode,
    matchCase,
    wrapAround,
    backward,
    inSelection,
    wholeWord,
    textStyle: {
      fontFamily: formatFontFamily,
      fontSize: Math.min(100, Math.max(10, Math.round(formatFontSize || 20))),
      fontWeight: formatFontWeight,
      color: formatColor
    }
  });

  const startDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (detached || event.button !== 0) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const rect = dialog.getBoundingClientRect();
    dragStateRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: rect.left,
      originY: rect.top
    };
    document.body.classList.add('is-dragging-find-dialog');
  };

  const startDetachedWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (!detached || event.button !== 0) return;

    const target = event.target as HTMLElement;
    // Inputs and action controls must remain clickable. Every other empty area
    // of the detached window becomes a native Windows drag surface.
    if (target.closest('button, input, select, textarea, label, a, [contenteditable="true"]')) return;

    void getCurrentWebviewWindow().startDragging().catch(() => {
      // The in-page browser preview has no Tauri window; dragging there uses
      // the existing in-page handler instead.
    });
  };

  const findByCurrentDirection = () => {
    onFind(backward ? 'previous' : 'next', buildRequest());
  };

  const dialogStyle: CSSProperties | undefined = detached
    ? undefined
    : {
        left: `${position.x}px`,
        top: `${position.y}px`
      };

  return (
    <div className="find-dialog-layer">
      <section
        key={detached ? `find-window-${openSequence}` : undefined}
        ref={dialogRef}
        className={`find-dialog find-dialog-movable ${detached ? 'find-dialog-window-mode' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="find-dialog-title"
        style={dialogStyle}
        onMouseDown={detached ? startDetachedWindowDrag : undefined}
      >
        <header className="find-dialog-header find-dialog-drag-handle" onMouseDown={detached ? undefined : startDrag}>
          <div className="find-dialog-title-group">
            {detached && <FindUiIcon name="search" />}
            <h2 id="find-dialog-title">ค้นหา / แทนที่</h2>
            <span>Ctrl+F</span>
          </div>
          {detached && onZoomChange && (
            <div className="find-dialog-zoom-controls" onMouseDown={(event) => event.stopPropagation()}>
              <label htmlFor="find-dialog-zoom">ซูม</label>
              <select
                id="find-dialog-zoom"
                value={String(Math.round(zoom * 100))}
                onChange={(event) => onZoomChange(Number(event.target.value) / 100)}
              >
                <option value="70">70%</option>
                <option value="80">80%</option>
                <option value="90">90%</option>
                <option value="100">100%</option>
              </select>
            </div>
          )}
          <button
            type="button"
            className="find-dialog-close"
            aria-label="ปิดหน้าต่างค้นหา"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <FindUiIcon name="close" />
          </button>
        </header>

        <form
          className="find-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            findByCurrentDirection();
          }}
        >
          <div className="find-replace-fields">
            <label className="find-query-field">
              <span>สิ่งที่ค้นหา:</span>
              <input
                ref={queryInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  onFind(event.shiftKey ? 'previous' : backward ? 'previous' : 'next', buildRequest());
                }}
                autoComplete="off"
              />
            </label>

            <label className="find-query-field">
              <span>แทนที่ด้วย:</span>
              <input
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onReplace(buildRequest());
                  }
                }}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="find-dialog-body">
            <div className="find-dialog-options">
              <fieldset className="find-options">
                <legend>{detached && <FindUiIcon name="options" />}ตัวเลือกการค้นหา</legend>
                <div className="find-option-checks">
                  <label>
                    <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />
                    ตรงตัวพิมพ์เล็ก/ใหญ่
                  </label>
                  <label>
                    <input type="checkbox" checked={wrapAround} onChange={(event) => setWrapAround(event.target.checked)} />
                    วนค้นหาตั้งแต่ต้น
                  </label>
                  <label>
                    <input type="checkbox" checked={backward} onChange={(event) => setBackward(event.target.checked)} />
                    ค้นหาย้อนหลัง
                  </label>
                  <label>
                    <input type="checkbox" checked={inSelection} onChange={(event) => setInSelection(event.target.checked)} />
                    เฉพาะส่วนที่เลือก
                  </label>
                  <label>
                    <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} />
                    ทั้งคำ
                  </label>
                </div>
              </fieldset>

              <fieldset className="find-options search-mode-options">
                <legend>{detached && <FindUiIcon name="mode" />}รูปแบบการค้นหา</legend>
                {SEARCH_MODES.map((searchMode) => (
                  <label key={searchMode.value} className="search-mode-choice">
                    <input
                      type="radio"
                      name="cloudpad-search-mode"
                      value={searchMode.value}
                      checked={mode === searchMode.value}
                      onChange={() => setMode(searchMode.value)}
                    />
                    <span>
                      <strong>{searchMode.label}</strong>
                      <small>{searchMode.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>

              <fieldset className="find-options find-format-options">
                <legend>{detached && <FindUiIcon name="format" />}ปรับแต่งคำที่ค้นหา</legend>
                <div className="find-format-grid">
                  <label>
                    <span>ฟอนต์</span>
                    <select value={formatFontFamily} onChange={(event) => setFormatFontFamily(event.target.value)}>
                      {SEARCH_FONT_OPTIONS.map((font) => (
                        <option value={font.value} key={font.value}>{font.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>ขนาด</span>
                    <input
                      type="number"
                      min="10"
                      max="100"
                      value={formatFontSize}
                      onChange={(event) => setFormatFontSize(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>น้ำหนัก</span>
                    <select
                      value={formatFontWeight}
                      onChange={(event) => setFormatFontWeight(event.target.value as FontWeight)}
                    >
                      {SEARCH_WEIGHT_OPTIONS.map((weight) => (
                        <option value={weight.value} key={weight.value}>{weight.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="find-format-color-field">
                    <span>สี</span>
                    <span className="find-format-color">
                      <input
                        type="color"
                        value={formatColor}
                        onChange={(event) => setFormatColor(event.target.value)}
                        aria-label="เลือกสีคำที่ค้นหา"
                      />
                      <strong>{formatColor.toUpperCase()}</strong>
                    </span>
                  </label>
                </div>
              </fieldset>
            </div>

            <div className="find-dialog-actions">
              <button type="submit" className="primary-button">{detached && <FindUiIcon name="next" />}ค้นหาถัดไป</button>
              <button type="button" className="secondary-button" onClick={() => onFind('previous', buildRequest())}>
                {detached && <FindUiIcon name="previous" />}ค้นหาก่อนหน้า
              </button>
              <button type="button" className="secondary-button" onClick={() => onReplace(buildRequest())}>
                {detached && <FindUiIcon name="replace" />}แทนที่
              </button>
              <button type="button" className="secondary-button" onClick={() => onReplaceAll(buildRequest())}>
                {detached && <FindUiIcon name="replaceAll" />}แทนที่ทั้งหมด
              </button>
              <button type="button" className="secondary-button find-format-apply" onClick={() => onFormatMatches(buildRequest())}>
                {detached && <FindUiIcon name="format" />}ใช้รูปแบบกับคำที่พบ
              </button>
              <button type="button" className="secondary-button" onClick={onClose}>
                {detached && <FindUiIcon name="close" />}ปิด
              </button>
            </div>
          </div>

          <div className={`find-result ${resultMessage ? 'visible' : ''}`} aria-live="polite">
            {detached && <FindUiIcon name="info" />}
            <span>{resultMessage || 'Enter = ค้นหาถัดไป · Shift+Enter = ค้นหาก่อนหน้า · Esc = ปิด'}</span>
          </div>
        </form>
      </section>
    </div>
  );
}
