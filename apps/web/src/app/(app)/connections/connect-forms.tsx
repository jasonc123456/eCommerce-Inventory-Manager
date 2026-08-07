'use client';

import { useActionState } from 'react';

import {
  connectEbayAction,
  connectStoreAction,
  connectStoreManuallyAction,
  disconnectConnectionAction,
  previewDisconnectAction,
  type ConnectionFormState,
} from '../../actions/connections';
import { Button, Card, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * Adding a provider, and taking one away (sections 13, 14, 21).
 *
 * Three separate forms rather than one with a provider selector, because the
 * three flows genuinely differ: eBay sends the operator to eBay and comes back
 * through a redirect, WooCommerce sends them to their own store and comes back
 * through a server-to-server callback, and the manual path never leaves this
 * page at all. A single form would have to hide two thirds of itself.
 *
 * Disconnection is two steps by design. Section 14 requires an impact preview,
 * and a preview that is a line of small print above a button is not one — the
 * counts have to be on the screen before the button that acts on them exists.
 */

const IDLE: ConnectionFormState = { status: 'idle' };

export function ConnectForms({
  csrf,
  businessId,
  ebayEnvironments,
}: {
  csrf: string;
  businessId: string;
  ebayEnvironments: string[];
}) {
  return (
    <div className="flex flex-col gap-6">
      {ebayEnvironments.length === 0 ? (
        <Card title="Connect an eBay account">
          <p className="text-sm opacity-70">
            This installation has no eBay keyset configured, so there is nothing to authorize
            against. An administrator sets the client id, client secret, and RuName in the
            environment file and restarts.
          </p>
        </Card>
      ) : (
        <Card title="Connect an eBay account">
          <EbayForm csrf={csrf} businessId={businessId} environments={ebayEnvironments} />
        </Card>
      )}

      <Card title="Connect a WooCommerce store">
        <StoreForm csrf={csrf} businessId={businessId} />
      </Card>

      <Card title="Connect a store with a key you made yourself">
        <ManualStoreForm csrf={csrf} businessId={businessId} />
      </Card>
    </div>
  );
}

function EbayForm({
  csrf,
  businessId,
  environments,
}: {
  csrf: string;
  businessId: string;
  environments: string[];
}) {
  const [state, action, pending] = useActionState<ConnectionFormState, FormData>(
    connectEbayAction,
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      {environments.length === 1 ? (
        <input type="hidden" name="environment" value={environments[0]} />
      ) : (
        <Field
          label="Environment"
          hint="Sandbox and production are separate eBay accounts. A connection never moves between them."
        >
          <select
            name="environment"
            defaultValue={environments.includes('production') ? 'production' : environments[0]}
            className="rounded-md border border-black/20 bg-transparent px-3 py-2 text-base dark:border-white/25"
          >
            {environments.map((environment) => (
              <option key={environment} value={environment}>
                {environment}
              </option>
            ))}
          </select>
        </Field>
      )}

      <p className="text-sm opacity-70">
        You will be sent to eBay to sign in and approve this application. eBay asks which account
        every time, so check you are signing into the right seller.
      </p>

      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
      )}

      <Button type="submit" disabled={pending}>
        Continue to eBay
      </Button>
    </form>
  );
}

function StoreForm({ csrf, businessId }: { csrf: string; businessId: string }) {
  const [state, action, pending] = useActionState<ConnectionFormState, FormData>(
    connectStoreAction,
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field
        label="Store address"
        hint="The address customers use, such as https://shop.example. Not the wp-admin address."
      >
        <TextInput
          name="storeUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://shop.example"
          required
        />
      </Field>

      <p className="text-sm opacity-70">
        You will be sent to your own store to approve this application, and WooCommerce will issue a
        key. Sign in as a user with product, order, webhook, and refund access rather than as a
        general administrator.
      </p>

      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
      )}

      <Button type="submit" disabled={pending}>
        Continue to the store
      </Button>
    </form>
  );
}

/**
 * Section 14's documented fallback.
 *
 * Offered because the authorization flow genuinely fails on some hosts —
 * security plugins block `/wc-auth/`, and reverse proxies drop the callback. The
 * key is proven against the store before it is kept either way, so this path is
 * no weaker than the other; it is only more work for the operator.
 */
function ManualStoreForm({ csrf, businessId }: { csrf: string; businessId: string }) {
  const [state, action, pending] = useActionState<ConnectionFormState, FormData>(
    connectStoreManuallyAction,
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <p className="text-sm opacity-70">
        Use this when the approval screen does not appear — some security plugins block it. In
        WooCommerce, go to Settings, Advanced, REST API, and add a key with read and write access.
      </p>

      <Field label="Store address">
        <TextInput
          name="storeUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://shop.example"
          required
        />
      </Field>

      <Field label="Consumer key">
        <TextInput
          name="consumerKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>

      <Field
        label="Consumer secret"
        hint="Stored encrypted and never shown again. WooCommerce also shows it only once."
      >
        <TextInput
          name="consumerSecret"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>

      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
      )}

      <Button type="submit" disabled={pending}>
        Connect the store
      </Button>
    </form>
  );
}

export function DisconnectForm({
  csrf,
  businessId,
  connectionId,
}: {
  csrf: string;
  businessId: string;
  connectionId: string;
}) {
  const [preview, previewAction, previewPending] = useActionState<ConnectionFormState, FormData>(
    previewDisconnectAction,
    IDLE,
  );
  const [outcome, disconnectAction, disconnectPending] = useActionState<
    ConnectionFormState,
    FormData
  >(disconnectConnectionAction, IDLE);

  const impact = preview.preview;

  return (
    <div className="flex flex-col gap-3">
      {outcome.message === undefined ? (
        <form action={previewAction}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="connectionId" value={connectionId} />
          <Button type="submit" variant="secondary" disabled={previewPending}>
            Disconnect
          </Button>
        </form>
      ) : null}

      {preview.message === undefined ? null : (
        <Notice tone={preview.status === 'error' ? 'error' : 'info'}>{preview.message}</Notice>
      )}

      {impact === undefined || outcome.message !== undefined ? null : (
        <div className="flex flex-col gap-2 rounded-md border border-black/20 p-3 dark:border-white/25">
          <p className="text-sm font-medium">Disconnecting {impact.displayName} will:</p>
          <ul className="list-disc pl-5 text-sm opacity-80">
            <li>
              discard {impact.credentials} stored credential{impact.credentials === 1 ? '' : 's'}
            </li>
            <li>
              delete {impact.webhooksToDelete} webhook registration
              {impact.webhooksToDelete === 1 ? '' : 's'} it created at the provider
            </li>
            <li>
              forget {impact.cursors} import position{impact.cursors === 1 ? '' : 's'}
            </li>
            <li>
              keep {impact.retained.items} imported record
              {impact.retained.items === 1 ? '' : 's'} and {impact.retained.orders} order
              {impact.retained.orders === 1 ? '' : 's'} for reference
            </li>
          </ul>

          {impact.webhooksToLeave.length === 0 ? null : (
            <p className="text-sm opacity-80">
              These registrations were not created by this application and will be left in place for
              you to remove: {impact.webhooksToLeave.map((entry) => entry.topic).join(', ')}.
            </p>
          )}

          <form action={disconnectAction}>
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="connectionId" value={connectionId} />
            <Button type="submit" disabled={disconnectPending}>
              Disconnect for good
            </Button>
          </form>
        </div>
      )}

      {outcome.message === undefined ? null : (
        <Notice tone={outcome.status === 'error' ? 'error' : 'info'}>{outcome.message}</Notice>
      )}
    </div>
  );
}
