'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { TOKEN_FIELD } from '../lib/token-field';

/**
 * Reads the URL fragment once, then clears it.
 *
 * Section 19 puts the magic-link and setup tokens in the fragment because a
 * fragment is never sent in an HTTP request, so it cannot reach an access log, a
 * proxy log, or a Referer header. That only holds while it stays in the browser,
 * which is why it is removed from the address bar as soon as it has been read:
 * otherwise it survives in history, in a shared screenshot, and in whatever the
 * next navigation reports.
 *
 * Built on `useSyncExternalStore`, which is the hook for state React does not
 * own. It also solves the hydration problem for free: the server has no address
 * bar to read, so it renders "checking", and the client swaps in the real value
 * after hydration without a mismatch.
 *
 * The snapshot is captured on first read and never recomputed, which is what
 * lets the effect clear the address bar without the value disappearing from
 * under the form. The store is created per component instance rather than at
 * module scope, so a client-side navigation from one of these screens to
 * another cannot carry a stale secret across.
 *
 * Returns `undefined` before the browser has been consulted and a string,
 * possibly empty, afterwards. The three states are distinguishable on purpose:
 * "still looking" and "there was nothing there" call for different words.
 */
export function useFragmentSecret(fallback?: string): string | undefined {
  const [store] = useState(createFragmentStore);

  const fromFragment = useSyncExternalStore(store.subscribe, store.read, store.readOnServer);
  // The fallback is the query carrier (D-182), used by installations whose mail
  // gateway rewrites links and drops the fragment. The fragment still wins where
  // it survived, so a rewritten and an unrewritten copy of the same message both
  // work, and the address bar is cleared either way.
  const secret =
    fromFragment === undefined || fromFragment.length > 0 ? fromFragment : (fallback ?? '');

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    // Both carriers are stripped from the address bar for the same reason: a
    // token left there survives in history, in a shared screenshot, and in
    // whatever the next navigation reports.
    const carriedInQuery = query.has(TOKEN_FIELD);

    if (window.location.hash.length > 0 || carriedInQuery) {
      query.delete(TOKEN_FIELD);

      const search = query.size === 0 ? '' : `?${query.toString()}`;

      // replaceState rather than assigning to `location.hash`, which would add
      // a history entry containing the value rather than removing it.
      window.history.replaceState(null, '', window.location.pathname + search);
    }
  }, []);

  return secret;
}

interface FragmentStore {
  subscribe: (onChange: () => void) => () => void;
  read: () => string;
  readOnServer: () => undefined;
}

function createFragmentStore(): FragmentStore {
  let captured: string | undefined;

  return {
    // Nothing to subscribe to: the value is read once and then deliberately
    // stops changing. The callback is still required by the hook's contract.
    subscribe: () => () => undefined,

    read: () => {
      captured ??= window.location.hash.startsWith('#')
        ? decodeURIComponent(window.location.hash.slice(1))
        : '';

      return captured;
    },

    readOnServer: () => undefined,
  };
}
