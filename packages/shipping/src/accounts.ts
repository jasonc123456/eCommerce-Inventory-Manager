import type { AuditRecorder } from '@eim/audit';
import {
  shippingAccounts,
  type Database,
  type ShippingAccount,
  type ShippingProvider,
} from '@eim/db';
import { describeFailure, isSuccess, type ShippingAdapter } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import { secretTypeFor, type ShippingSecretStore } from './credentials';

/**
 * A business's own shipping account (sections 2, 19, 34).
 *
 * Section 2 is specific about whose account this is: "EasyPost and Easyship
 * adapters using credentials supplied by each business". The installation never
 * holds a shipping credential, never resells postage, and never appears between
 * a business and its carrier — a label bought here is bought on the business's
 * account, at the business's negotiated rates, and appears on the business's
 * bill. That is a commercial arrangement as much as a technical one, and it is
 * why there is no installation-level shipping key anywhere in the configuration.
 *
 * Connecting is therefore three things in one transaction-shaped sequence: store
 * the key, ask the provider who it belongs to, and record what the provider says
 * it will do. The third is the one that is easy to skip and expensive to skip:
 * section 2 promises "supported void/refund actions", which means a screen must
 * know before it draws a button whether this account can honour it.
 */

export interface ConnectAccountInput {
  readonly businessId: string;
  readonly provider: ShippingProvider;
  readonly environment: 'sandbox' | 'production';
  readonly displayName: string;
  readonly apiKey: string;
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface ConnectedAccount {
  readonly accountId: string;
  readonly accountLabel: string;
}

export class ShippingAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShippingAccountError';
  }
}

/** Builds an adapter for an account whose key has already been stored. */
export type AdapterForAccount = (accountId: string) => Promise<ShippingAdapter>;

/**
 * Records an account, proves the key, and stores what the provider supports.
 *
 * The order matters. The key is stored first because the adapter is built from
 * stored credentials — the same path production uses, so a key that cannot be
 * read back is discovered here rather than at the first purchase. If the
 * provider then rejects it, the account stays `pending` and the failure is
 * recorded on the row: an account nobody can use should say why, not disappear.
 */
export async function connectAccount(
  db: Database,
  secrets: ShippingSecretStore,
  audit: AuditRecorder,
  adapterFor: AdapterForAccount,
  input: ConnectAccountInput,
): Promise<ConnectedAccount> {
  const now = input.now ?? new Date();

  const inserted = await db
    .insert(shippingAccounts)
    .values({
      businessId: input.businessId,
      provider: input.provider,
      environment: input.environment,
      displayName: input.displayName,
      status: 'pending',
      createdByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: shippingAccounts.id });

  const row = inserted[0];
  if (row === undefined) {
    throw new ShippingAccountError('the shipping account could not be created');
  }

  await secrets.put({
    businessId: input.businessId,
    accountId: row.id,
    secretType: secretTypeFor(input.provider),
    value: input.apiKey,
    now,
  });

  const adapter = await adapterFor(row.id);
  const check = await adapter.checkCredentials();

  if (!isSuccess(check)) {
    const summary = describeFailure(check);
    await db
      .update(shippingAccounts)
      .set({ lastCheckedAt: now, lastFailureSummary: summary, updatedAt: now })
      .where(eq(shippingAccounts.id, row.id));

    throw new ShippingAccountError(`the shipping provider rejected the credentials: ${summary}`);
  }

  await db
    .update(shippingAccounts)
    .set({
      status: 'active',
      accountLabel: check.value.accountLabel,
      // Stored as the provider reported it, so a screen never has to guess
      // whether this account can void a label or track a parcel.
      capabilities: { ...adapter.capabilities },
      lastCheckedAt: now,
      lastFailureSummary: null,
      updatedAt: now,
    })
    .where(eq(shippingAccounts.id, row.id));

  await audit.record(db, {
    action: 'shipping.account.connected',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipping_account',
    targetId: row.id,
    detail: {
      provider: input.provider,
      environment: input.environment,
      accountLabel: check.value.accountLabel,
    },
  });

  return { accountId: row.id, accountLabel: check.value.accountLabel };
}

/**
 * Rechecks a stored key and refreshes what the provider says it supports.
 *
 * Capabilities are re-read rather than trusted from connection time. A provider
 * that withdraws refund support, or an account downgraded to a plan without it,
 * would otherwise leave a button on a screen that fails when somebody presses
 * it — and the failure would arrive after the label was already bought.
 */
export async function testAccount(
  db: Database,
  audit: AuditRecorder,
  adapterFor: AdapterForAccount,
  input: { readonly businessId: string; readonly accountId: string; readonly now?: Date },
): Promise<{ readonly healthy: boolean; readonly summary: string }> {
  const now = input.now ?? new Date();
  const account = await loadAccount(db, input.businessId, input.accountId);

  const adapter = await adapterFor(account.id);
  const check = await adapter.checkCredentials();

  if (!isSuccess(check)) {
    const summary = describeFailure(check);
    await db
      .update(shippingAccounts)
      .set({ lastCheckedAt: now, lastFailureSummary: summary, updatedAt: now })
      .where(eq(shippingAccounts.id, account.id));

    await audit.record(db, {
      action: 'shipping.account.tested',
      result: 'failure',
      businessId: input.businessId,
      targetType: 'shipping_account',
      targetId: account.id,
      detail: { healthy: false, summary },
    });

    return { healthy: false, summary };
  }

  await db
    .update(shippingAccounts)
    .set({
      accountLabel: check.value.accountLabel,
      capabilities: { ...adapter.capabilities },
      lastCheckedAt: now,
      lastFailureSummary: null,
      updatedAt: now,
    })
    .where(eq(shippingAccounts.id, account.id));

  await audit.record(db, {
    action: 'shipping.account.tested',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipping_account',
    targetId: account.id,
    detail: { healthy: true, accountLabel: check.value.accountLabel },
  });

  return { healthy: true, summary: check.value.accountLabel };
}

/**
 * Takes an account out of service and destroys its key.
 *
 * The labels stay. They are a record of money that was spent and parcels that
 * were sent, and section 33 requires the shipping history to survive — what goes
 * is the ability to spend anything more, which is the credential. The account
 * row keeps its identity so an old label can still say which account bought it.
 */
export async function disconnectAccount(
  db: Database,
  secrets: ShippingSecretStore,
  audit: AuditRecorder,
  input: { readonly businessId: string; readonly accountId: string; readonly now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const account = await loadAccount(db, input.businessId, input.accountId);

  await secrets.retire(
    { businessId: account.businessId, accountId: account.id },
    secretTypeFor(account.provider),
  );

  await db
    .update(shippingAccounts)
    .set({ status: 'disconnected', updatedAt: now })
    .where(eq(shippingAccounts.id, account.id));

  await audit.record(db, {
    action: 'shipping.account.disconnected',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipping_account',
    targetId: account.id,
    detail: { provider: account.provider },
  });
}

/** The account, or a clear error. Never a null the caller has to remember. */
export async function loadAccount(
  db: Database,
  businessId: string,
  accountId: string,
): Promise<ShippingAccount> {
  const rows = await db
    .select()
    .from(shippingAccounts)
    .where(and(eq(shippingAccounts.id, accountId), eq(shippingAccounts.businessId, businessId)))
    .limit(1);

  const account = rows[0];
  if (account === undefined) {
    throw new ShippingAccountError('no such shipping account in this business');
  }

  return account;
}

/** The account a business would buy postage on, when it has an active one. */
export async function activeAccount(
  db: Database,
  businessId: string,
): Promise<ShippingAccount | null> {
  const rows = await db
    .select()
    .from(shippingAccounts)
    .where(and(eq(shippingAccounts.businessId, businessId), eq(shippingAccounts.status, 'active')))
    .limit(1);

  return rows[0] ?? null;
}
