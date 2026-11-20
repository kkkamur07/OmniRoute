/**
 * Same-origin handoff so the /callback tab can name the provider it is finishing.
 *
 * The provider redirect (directly, or rewritten by the Sign-in Helper extension) only carries
 * code/state, never the provider. Right before opening the provider's page the Connect dialog
 * stores `{provider, providerName}` under the attempt's `state`; /callback reads it back by the
 * `state` in its own query. Only non-secret display data is stored, and entries expire.
 */

export const SIGN_IN_ATTEMPT_PREFIX = "omniroute_sign_in_attempt:";
export const SIGN_IN_ATTEMPT_MAX_AGE_MS = 15 * 60 * 1000;

export type SignInAttempt = { provider: string; providerName: string };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Drops expired entries so abandoned attempts do not pile up. */
function prune(store: Storage, now: number) {
  for (let i = store.length - 1; i >= 0; i -= 1) {
    const key = store.key(i);
    if (!key?.startsWith(SIGN_IN_ATTEMPT_PREFIX)) continue;
    try {
      const ts = JSON.parse(store.getItem(key) || "{}")?.ts;
      if (typeof ts !== "number" || now - ts > SIGN_IN_ATTEMPT_MAX_AGE_MS) store.removeItem(key);
    } catch {
      store.removeItem(key);
    }
  }
}

export function rememberSignInAttempt(
  state: unknown,
  provider: string | undefined,
  providerName: string | undefined,
  now: number = Date.now()
): void {
  const store = storage();
  if (!store || typeof state !== "string" || !state || !provider) return;
  try {
    prune(store, now);
    store.setItem(
      SIGN_IN_ATTEMPT_PREFIX + state,
      JSON.stringify({ provider, providerName: providerName || provider, ts: now })
    );
  } catch {
    // Storage full or blocked: the callback tab falls back to a generic provider label.
  }
}

/** Reads and removes the attempt stored for `state`; null when absent, stale or malformed. */
export function takeSignInAttempt(
  state: string | null | undefined,
  now: number = Date.now()
): SignInAttempt | null {
  const store = storage();
  if (!store || !state) return null;
  try {
    const key = SIGN_IN_ATTEMPT_PREFIX + state;
    const raw = store.getItem(key);
    store.removeItem(key);
    const data = raw ? JSON.parse(raw) : null;
    if (!data || typeof data.provider !== "string" || !data.provider) return null;
    if (typeof data.ts !== "number" || now - data.ts > SIGN_IN_ATTEMPT_MAX_AGE_MS) return null;
    return {
      provider: data.provider,
      providerName:
        typeof data.providerName === "string" && data.providerName
          ? data.providerName
          : data.provider,
    };
  } catch {
    return null;
  }
}
