import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { FindReplaceWindow } from './features/search/FindReplaceWindow';
import './styles/main.css';

const params = new URLSearchParams(window.location.search);
const windowKind = params.get('window');
const isFindReplaceWindow = windowKind === 'find-replace';
const detachedNoteId = windowKind === 'note' ? params.get('noteId') : null;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isFindReplaceWindow ? <FindReplaceWindow /> : <App detachedNoteId={detachedNoteId} />}
  </React.StrictMode>
);
