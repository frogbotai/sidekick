import '@frogbotai/ui/styles.css';
import '../sidepanel/panel.css';

import { theme } from '@frogbotai/sidekick-core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Options } from './Options';

const root = document.getElementById('root');

if (!root) throw new Error('Missing #root');

const initialMode = await theme.get();

createRoot(root).render(
  <StrictMode>
    <Options initialMode={initialMode} />
  </StrictMode>,
);
