import path from 'node:path';

import { defineConfig } from 'wxt';

import {
  CHECKOUT_ENV,
  LINKED_MODE,
  linkedVite,
  resolveCheckout,
  SIDEKICK_ROOT,
  unimportExclude,
} from './scripts/linked.ts';

const STORE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwDBUC+bdAZwnXyO6CRfN75935fUiW92B+Tp+iLYqrFyEJHYL1a4hcS16SsEsHSUqxuutL3e6iP72yAg6PowXWNASsjm0Aj+3NXP1CI0thE3Rgi1ahZSmaIZXmtLv+x5g4LrIrYZ6VWLx96VC7mc5UgyjHc8p7drBWlquEy6fzB+8K4S8WScGTA3j6KegIFApLiXle59XrLSxhCPwm6pnTsXn02R6xihd4ZFcz9D3P1R1XlofulPgD9voFe9FnYBYm+mQpU2nvZNPfQc5J5qJAvFwp9CfB0k0LUeMa6iF909h4gcl8O/hN1Kmg52lY/Cismz15uYJwhhPjBC31oqt4wIDAQAB';

const PERMISSIONS = {
  sidePanel: 'the chat lives in the side panel',
  storage: 'settings and credentials, in storage.local only',
  tabs: 'tab URLs, to re-check the site before each action',
  tabGroups: 'the tab group the agent works in',
  scripting: 'inject the content script into tabs open before install',
  debugger: 'trusted input and scrolling over CDP',
  webNavigation: 'list a tab’s frames, to reach each frame’s content script',
} as const;

const FRAME_SCRIPT = 'frame.js';

const FROGBOT_URL = 'https://app.frogbot.ai';

const MINIMUM_CHROME = 123;

const E2E_ONLY = ['e2e-open'];

const LIVE_ONLY = ['live'];

const live = process.env.SIDEKICK_LIVE === '1';

const e2e = live || process.env.SIDEKICK_E2E === '1';

const outSuffix = live ? '-live' : e2e ? '-e2e' : '';

const checkout = () => resolveCheckout(process.env[CHECKOUT_ENV], SIDEKICK_ROOT);

export default defineConfig({
  srcDir: 'src',
  outDirTemplate: `{{browser}}-mv{{manifestVersion}}${outSuffix}{{modeSuffix}}`,
  imports: false,
  modules: ['@wxt-dev/module-react'],
  vite: ({ mode }) => ({
    define: { 'import.meta.env.SIDEKICK_E2E': JSON.stringify(e2e) },
    build: { cssTarget: `chrome${MINIMUM_CHROME}` },
    resolve: {
      alias: { '@ai-sdk/gateway': path.resolve(import.meta.dirname, 'src/stubs/gateway.ts') },
    },
    ...(mode === LINKED_MODE ? linkedVite(checkout(), SIDEKICK_ROOT) : {}),
  }),
  manifest: {
    name: 'FrogBot Sidekick',
    description: 'Your AI work assistant, right in your browser.',
    key: STORE_KEY,
    minimum_chrome_version: String(MINIMUM_CHROME),
    permissions: Object.keys(PERMISSIONS),
    host_permissions: ['<all_urls>'],
    externally_connectable: { matches: [`${FROGBOT_URL}/*`] },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: [FRAME_SCRIPT],
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
        run_at: 'document_start',
        world: 'ISOLATED',
      },
    ],
    action: { default_title: 'Open FrogBot Sidekick' },
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  hooks: {
    'config:resolved': (wxt) => {
      if (wxt.config.mode !== LINKED_MODE) return;

      Object.assign(wxt.config.imports, { exclude: unimportExclude(checkout()) });
    },
    'entrypoints:resolved': (_wxt, entrypoints) => {
      const dropped = [...(e2e ? [] : E2E_ONLY), ...(live ? [] : LIVE_ONLY)];

      for (const name of dropped) {
        const index = entrypoints.findIndex((entrypoint) => entrypoint.name === name);

        if (index !== -1) entrypoints.splice(index, 1);
      }
    },
    'build:manifestGenerated': (_wxt, manifest) => {
      if (!live) return;

      delete manifest.key;
      manifest.name = 'Sidekick live test (ticket 271)';
      manifest.description = 'Test only: runs Sidekick’s browser tools on a few public sites.';
      manifest.side_panel = { default_path: 'live.html' };
      manifest.action = { default_title: 'Open the Sidekick live test' };
    },
  },
});
