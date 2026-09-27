import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installLiveInterpretation } from './store/live-interpretation';
import './index.css';

// The live app interprets the runs it loads; the export bundle (main-export.tsx) never does.
installLiveInterpretation();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
