import { answerFrames, createContent, frameProtocol } from '@frogbotai/sidekick-core';
import glowCss from '@frogbotai/ui/glow.css?inline';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

declare global {
  var sidekickFrame: true | undefined;
}

export default defineUnlistedScript(() => {
  if (globalThis.sidekickFrame) return;

  globalThis.sidekickFrame = true;

  const { handlers } = createContent({ indicatorCss: glowCss });

  answerFrames(frameProtocol, { 'frame.ping': () => ({ url: location.href }), ...handlers });
});
