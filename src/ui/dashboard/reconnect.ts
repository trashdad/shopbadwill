import type { PortName, PortTick } from '../../messaging/protocol';
import type { ConnectWithDisconnect } from '../../messaging/client';
import type { MessagingClient } from '../../ports/messaging';

/** Wait before reconnect attempt n (0-based); the last value repeats. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10_000];

/**
 * Opens a stream port and re-opens it when the other end goes away (an MV3
 * worker restart), with bounded backoff. `onReconnect` runs after each
 * re-open so the caller can re-fetch whatever it missed. The attempt counter
 * resets when a tick arrives, so a worker that is still down keeps backing off.
 * Returns a function that stops everything.
 */
export function connectResilient<P extends PortName>(
  client: MessagingClient,
  name: P,
  onTick: (t: PortTick<P>) => void,
  onReconnect: () => void,
): () => void {
  // Real client and fake accept a third `onDisconnect` argument that the frozen port type omits.
  const connect: ConnectWithDisconnect = client.connect.bind(client);
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let close: (() => void) | undefined;

  const open = (): void => {
    try {
      close = connect(
        name,
        (t) => {
          attempt = 0;
          onTick(t);
        },
        schedule,
      );
    } catch {
      schedule();
    }
  };

  function schedule(): void {
    if (stopped || timer !== undefined) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      open();
      onReconnect();
    }, delay);
  }

  open();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    close?.();
  };
}
