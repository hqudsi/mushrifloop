/**
 * Access to the preload bridge.
 *
 * The renderer has no other way out: if the bridge (`window[APP_BRIDGE]`) is missing, the preload script
 * failed to load and we say so loudly rather than silently degrading.
 */

import { APP_BRIDGE, APP_NAME } from '../../../shared/app-config';
import type { AppApi } from '../../../shared/ipc';

function bridge(): AppApi | undefined {
  return (window as unknown as Record<string, AppApi | undefined>)[APP_BRIDGE];
}

export function api(): AppApi {
  const found = bridge();
  if (!found) {
    throw new Error(`The ${APP_NAME} IPC bridge is unavailable — the preload script did not load.`);
  }
  return found;
}

export function isBridgeAvailable(): boolean {
  return bridge() !== undefined;
}
