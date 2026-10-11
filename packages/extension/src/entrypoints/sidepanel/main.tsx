import '@frogbotai/ui/styles.css';
import './panel.css';

import { connectWorker, sidekickProtocol, theme } from '@frogbotai/sidekick-core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

const worker = connectWorker(sidekickProtocol);

if (import.meta.env.SIDEKICK_E2E) Object.assign(window, { sidekick: { worker } });

const initialMode = await theme.get();

createRoot(root).render(
  <StrictMode>
    <App initialMode={initialMode} worker={worker} />
  </StrictMode>,
);
