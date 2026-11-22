import type { sidekickProtocol } from '../protocol';
import type { Handlers } from '../rpc/define';
import { addPairing, findPairing, revokePairing } from './pairings';
import { DIAL_TIMEOUT, isLoopbackHub, openSocket, type Socket } from './transport';

type PairHandlers = Pick<Handlers<(typeof sidekickProtocol)['methods']>, 'mcp.pair' | 'mcp.unpair'>;

export type McpPairResult = Awaited<ReturnType<PairHandlers['mcp.pair']>>;

export type McpUnpairResult = Awaited<ReturnType<PairHandlers['mcp.unpair']>>;

const COMPUTER_LENGTH = 64;

/** The name a computer's pairing gets: its hostname, without control characters, kept short. */
export function computerName(computer: string) {
  const name = computer.replaceAll(/\p{Cc}/gu, ' ').trim();

  return [...name].slice(0, COMPUTER_LENGTH).join('') || 'This computer';
}

function withParam(hub: string, name: string, value: string) {
  const url = new URL(hub);

  url.searchParams.set(name, value);

  return url.href;
}

function isOk(data: unknown) {
  try {
    return (JSON.parse(String(data)) as { type?: unknown }).type === 'sidekick/ok';
  } catch {
    return false;
  }
}

function deliver(socket: Socket, message: object) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), DIAL_TIMEOUT);

    const settle = (error?: Error) => {
      clearTimeout(timer);

      if (error) reject(error);
      else resolve();
    };

    socket.addEventListener('message', (event) => {
      if (isOk(event.data)) settle();
    });

    socket.addEventListener('close', () => settle(new Error('closed')), { once: true });
    socket.send(JSON.stringify(message));
  });
}

/**
 * `mcp.pair` and `mcp.unpair`, for an install command's Approve page. Pairing adds a pairing named
 * after the computer and hands its key to the command's hub, revoking it again unless the hub
 * acknowledges it. Unpairing revokes the pairing a key names, once the hub holding that key answers.
 */
export function pairHandlers(dial: (url: string) => Socket): PairHandlers {
  return {
    'mcp.pair': async ({ hub, pair, computer }) => {
      if (!isLoopbackHub(hub)) return { paired: false, reason: 'not_loopback' };

      const { pairing, token } = await addPairing({
        name: computerName(computer),
        client: 'other',
      });

      const socket = dial(withParam(hub, 'pair', pair));

      try {
        await openSocket(socket);
        await deliver(socket, { type: 'sidekick/paired', key: token, pairingID: pairing.id });
      } catch {
        await revokePairing(pairing.id);

        return { paired: false, reason: 'unreachable' };
      } finally {
        socket.close();
      }

      return { paired: true, name: pairing.name };
    },
    'mcp.unpair': async ({ hub, token }) => {
      if (!isLoopbackHub(hub)) return { unpaired: false, reason: 'not_loopback' };

      const socket = dial(withParam(hub, 'token', token));

      try {
        await openSocket(socket);
      } catch {
        socket.close();

        return { unpaired: false, reason: 'unreachable' };
      }

      const pairing = await findPairing(token);

      if (pairing) await revokePairing(pairing.id);

      await deliver(socket, { type: 'sidekick/unpaired' }).catch(() => undefined);
      socket.close();

      return { unpaired: true };
    },
  };
}
