import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import { App } from './App';
import { migrateLegacyStorageKeys } from './lib/storage';

// Must run before first render — components read their prefs during initial state setup.
migrateLegacyStorageKeys();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
