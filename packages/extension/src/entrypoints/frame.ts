import { answerFrames, frameProtocol } from '@frogbotai/sidekick-core';
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

export default defineUnlistedScript(() => {
  answerFrames(frameProtocol, { 'frame.ping': () => ({ url: location.href }) });
});
