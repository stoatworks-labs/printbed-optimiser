import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// The shared Stoatworks theme first. Vendored from stoatworks-backend/theme by scripts/sync-theme.sh.
import './stoatworks-theme.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
