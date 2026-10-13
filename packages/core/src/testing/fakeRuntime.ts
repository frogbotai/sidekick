type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

export const RUNTIME_ID = 'sidekicktestid';

export const EXTENSION_ORIGIN = `chrome-extension://${RUNTIME_ID}/`;

export interface FakePort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
  readonly sent: unknown[];
}

export interface FakeRuntime {
  connectSender: chrome.runtime.MessageSender;
  messageSender: chrome.runtime.MessageSender;
  readonly clientPorts: FakePort[];
  readonly serverPorts: FakePort[];
  readonly frameMessages: { tabId: number; message: unknown; frameId?: number }[];
  connects: number;
  failConnects: boolean;
  stopWorker: () => void;
}

function events<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();

  return {
    listeners,
    event: {
      addListener: (listener: T) => void listeners.add(listener),
      removeListener: (listener: T) => void listeners.delete(listener),
    },
  };
}

function json(message: unknown): unknown {
  return message === undefined ? undefined : JSON.parse(JSON.stringify(message));
}

interface Side {
  open: boolean;
  onMessage: Set<(message: unknown) => void>;
  onDisconnect: Set<() => void>;
}

function hangUp(side: Side) {
  side.open = false;

  queueMicrotask(() => {
    for (const listener of [...side.onDisconnect]) listener();
  });
}

function portEnd(self: Side, peer: Side, name: string, sender?: chrome.runtime.MessageSender) {
  const sent: unknown[] = [];

  const end: FakePort = {
    name,
    sender,
    sent,
    postMessage: (message) => {
      if (!self.open) throw new Error('Attempting to use a disconnected port object');

      const copy = json(message);

      sent.push(copy);

      queueMicrotask(() => {
        if (peer.open) for (const listener of [...peer.onMessage]) listener(copy);
      });
    },
    disconnect: () => {
      if (!self.open) return;

      self.open = false;

      if (peer.open) hangUp(peer);
    },
    onMessage: { addListener: (listener) => void self.onMessage.add(listener) },
    onDisconnect: { addListener: (listener) => void self.onDisconnect.add(listener) },
  };

  return end;
}

function portPair(name: string, sender: chrome.runtime.MessageSender) {
  const sides = [0, 1].map((): Side => ({
    open: true,
    onMessage: new Set(),
    onDisconnect: new Set(),
  }));

  const [a, b] = sides as [Side, Side];

  return {
    client: portEnd(a, b, name),
    server: portEnd(b, a, name, sender),
    drop: () => {
      for (const side of sides) if (side.open) hangUp(side);
    },
  };
}

export function installFakeRuntime(): FakeRuntime {
  const connectListeners = events<(port: FakePort) => void>();
  const messageListeners = events<MessageListener>();
  const drops: (() => void)[] = [];

  const fake: FakeRuntime = {
    connectSender: { id: RUNTIME_ID, url: `${EXTENSION_ORIGIN}sidepanel.html` },
    messageSender: { id: RUNTIME_ID, url: `${EXTENSION_ORIGIN}background.js` },
    clientPorts: [],
    serverPorts: [],
    frameMessages: [],
    connects: 0,
    failConnects: false,
    stopWorker: () => {
      connectListeners.listeners.clear();

      for (const drop of drops.splice(0)) drop();
    },
  };

  const connect = ({ name = '' }: { name?: string } = {}) => {
    fake.connects++;

    if (fake.failConnects) throw new Error('Could not establish connection');

    const { client, server, drop } = portPair(name, structuredClone(fake.connectSender));

    fake.clientPorts.push(client);
    fake.serverPorts.push(server);
    drops.push(drop);

    queueMicrotask(() => {
      if (connectListeners.listeners.size === 0) server.disconnect();

      for (const listener of [...connectListeners.listeners]) listener(server);
    });

    return client;
  };

  const deliver = (message: unknown) =>
    new Promise((resolve, reject) => {
      let answered = false;
      let waiting = false;

      const sendResponse = (response: unknown) => {
        if (answered) return;

        answered = true;
        resolve(json(response));
      };

      if (messageListeners.listeners.size === 0) {
        reject(new Error('Could not establish connection. Receiving end does not exist.'));

        return;
      }

      for (const listener of [...messageListeners.listeners]) {
        if (listener(json(message), structuredClone(fake.messageSender), sendResponse) === true) {
          waiting = true;
        }
      }

      if (!waiting && !answered) {
        reject(new Error('The message port closed before a response was received.'));
      }
    });

  const sendMessage = (tabId: number, message: unknown, options: { frameId?: number } = {}) => {
    fake.frameMessages.push({ tabId, message, ...options });

    return deliver(message);
  };

  const current = (globalThis as { chrome?: object }).chrome ?? {};

  Object.assign(globalThis, {
    chrome: {
      ...current,
      runtime: {
        id: RUNTIME_ID,
        getURL: (path: string) => `${EXTENSION_ORIGIN}${path.replace(/^\//, '')}`,
        connect,
        onConnect: connectListeners.event,
        onMessage: messageListeners.event,
        sendMessage: deliver,
      },
      tabs: { sendMessage },
    },
  });

  return fake;
}
