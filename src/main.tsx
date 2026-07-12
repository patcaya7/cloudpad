import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { FindReplaceWindow } from './features/search/FindReplaceWindow';
import './styles/main.css';

const params = new URLSearchParams(window.location.search);
const isFindReplaceWindow = params.get('window') === 'find-replace';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isFindReplaceWindow ? <FindReplaceWindow /> : <App />}
  </React.StrictMode>
);
