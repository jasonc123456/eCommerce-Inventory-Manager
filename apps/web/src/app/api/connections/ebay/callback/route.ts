import { redirect } from 'next/navigation';

import { ebay } from '@/lib/connections';
import { runtime as appRuntime } from '@/lib/runtime';

/**
 * Where eBay sends the operator back (section 13).
 *
 * A GET in the operator's browser carrying `code` and `state`. Unlike the
 * WooCommerce callback, which is a server-to-server POST, this one arrives with
 * a session — but the session is deliberately not what authorizes it. The state
 * value is: it was issued to one business for one user, it is stored only as a
 * keyed hash, it expires in fifteen minutes, and it is spent on first use.
 *
 * Leaning on the session instead would be wrong in a specific way. The
 * authorization was started from a particular business, and a user who has since
 * switched their active business would otherwise have the connection created in
 * whichever one they happen to be looking at.
 *
 * eBay's decline path comes back with `error` and no code. That is a person
 * changing their mind, not a fault, and it is reported as such.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (url.searchParams.get('error') !== null) {
    redirect(landing('declined'));
  }

  if (code === null || state === null) {
    redirect(landing('invalid'));
  }

  const outcome = await ebay().oauth.complete({ code, state });

  if (!outcome.ok) {
    redirect(landing(outcome.reason));
  }

  appRuntime().logger.info(
    {
      event: 'connection.completed',
      provider: 'ebay',
      connectionId: outcome.connectionId,
      created: outcome.created,
      impaired: outcome.impairedCapabilities,
    },
    'an eBay connection was completed',
  );

  redirect(
    outcome.impairedCapabilities.length === 0
      ? `${outcome.redirectPath}?connected=ebay`
      : `${outcome.redirectPath}?connected=ebay&impaired=${encodeURIComponent(
          outcome.impairedCapabilities.join(','),
        )}`,
  );
}

/**
 * Where a failed callback lands.
 *
 * The reason is a short, fixed word from this application's own vocabulary,
 * never a provider message. Section 19 keeps provider error bodies out of the
 * interface, and a redirect target is the least private place there is.
 */
function landing(reason: string): string {
  return `/connections?failed=${encodeURIComponent(reason)}`;
}
