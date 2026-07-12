import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { FindReplacePanel, type FindReplaceRequest } from './FindReplacePanel';
import type { SearchDirection } from './searchUtils';

interface FindWindowOpenPayload {
  initialQuery: string;
}

interface FindWindowResultPayload {
  message: string;
}

const FIND_WINDOW_BASE_WIDTH = 900;
const FIND_WINDOW_BASE_HEIGHT = 640;
const FIND_WINDOW_MIN_WIDTH = 600;
const FIND_WINDOW_MIN_HEIGHT = 420;
const FIND_WINDOW_MAX_WIDTH = 1600;
const FIND_WINDOW_MAX_HEIGHT = 1100;
const FIND_WINDOW_ZOOM_MIN = 0.7;
const FIND_WINDOW_ZOOM_MAX = 1;
const FIND_WINDOW_ZOOM_STEP = 0.1;

function clampFindWindowZoom(value: number): number {
  return Math.min(FIND_WINDOW_ZOOM_MAX, Math.max(FIND_WINDOW_ZOOM_MIN, value));
}

export function FindReplaceWindow() {
  const [initialQuery, setInitialQuery] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('q') ?? '';
  });
  const [resultMessage, setResultMessage] = useState('');
  const [findWindowZoom, setFindWindowZoom] = useState(1);
  const [openSequence, setOpenSequence] = useState(0);

  const updateFindWindowZoom = (nextZoom: number) => {
    const clamped = clampFindWindowZoom(Number(nextZoom.toFixed(2)));
    setFindWindowZoom(clamped);
    const nextWidth = Math.min(FIND_WINDOW_MAX_WIDTH, Math.max(FIND_WINDOW_MIN_WIDTH, FIND_WINDOW_BASE_WIDTH * clamped));
    const nextHeight = Math.min(FIND_WINDOW_MAX_HEIGHT, Math.max(FIND_WINDOW_MIN_HEIGHT, FIND_WINDOW_BASE_HEIGHT * clamped));
    void getCurrentWebviewWindow().setSize(new LogicalSize(nextWidth, nextHeight));
  };

  useEffect(() => {
    let unlistenOpen: (() => void) | null = null;
    let unlistenResult: (() => void) | null = null;

    void listen<FindWindowOpenPayload>('cloudpad-find-open', (event) => {
      setInitialQuery(event.payload.initialQuery ?? '');
      setResultMessage('');
      setOpenSequence((current) => current + 1);
    }).then((cleanup) => {
      unlistenOpen = cleanup;
    });

    void listen<FindWindowResultPayload>('cloudpad-find-result', (event) => {
      setResultMessage(event.payload.message ?? '');
    }).then((cleanup) => {
      unlistenResult = cleanup;
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void getCurrentWebviewWindow().close();
    };

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      setFindWindowZoom((current) => {
        const next = Number((current + direction * FIND_WINDOW_ZOOM_STEP).toFixed(2));
        const clamped = clampFindWindowZoom(next);
        const nextWidth = Math.min(FIND_WINDOW_MAX_WIDTH, Math.max(FIND_WINDOW_MIN_WIDTH, FIND_WINDOW_BASE_WIDTH * clamped));
        const nextHeight = Math.min(FIND_WINDOW_MAX_HEIGHT, Math.max(FIND_WINDOW_MIN_HEIGHT, FIND_WINDOW_BASE_HEIGHT * clamped));
        void getCurrentWebviewWindow().setSize(new LogicalSize(nextWidth, nextHeight));
        return clamped;
      });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      unlistenOpen?.();
      unlistenResult?.();
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const sendFindAction = (direction: SearchDirection, request: FindReplaceRequest) => {
    void emitTo('main', 'cloudpad-find-action', { action: 'find', direction, request });
  };

  const sendReplaceAction = (request: FindReplaceRequest) => {
    void emitTo('main', 'cloudpad-find-action', { action: 'replace', request });
  };

  const sendReplaceAllAction = (request: FindReplaceRequest) => {
    void emitTo('main', 'cloudpad-find-action', { action: 'replaceAll', request });
  };

  const sendFormatMatchesAction = (request: FindReplaceRequest) => {
    void emitTo('main', 'cloudpad-find-action', { action: 'formatMatches', request });
  };

  const closeWindow = () => {
    void emitTo('main', 'cloudpad-find-action', { action: 'close' });
    void getCurrentWebviewWindow().close();
  };

  const rootStyle = { '--find-window-zoom': String(findWindowZoom) } as CSSProperties;

  return (
    <main className="find-window-root" style={rootStyle}>
      <FindReplacePanel
        detached
        initialQuery={initialQuery}
        resultMessage={resultMessage}
        zoom={findWindowZoom}
        openSequence={openSequence}
        onZoomChange={updateFindWindowZoom}
        onFind={sendFindAction}
        onReplace={sendReplaceAction}
        onReplaceAll={sendReplaceAllAction}
        onFormatMatches={sendFormatMatchesAction}
        onClose={closeWindow}
      />
    </main>
  );
}
