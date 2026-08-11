import type { AuditRecorder } from '@eim/audit';
import { authorize, type Subject } from '@eim/authz';
import { aiProviders, type AiProvider, type AiProviderKind, type Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  validateIntegrationUrl,
  type AiAdapter,
  type UrlPolicy,
} from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import type { AiSecretStore } from './credentials';

/**
 * Configuring a business's model endpoint (sections 5, 18, 19, 20).
 *
 * Three switches, and they are separate because they fail differently.
 *
 * *Configured* means an address and a model are recorded. It implies nothing
 * about whether the address answers, and nothing at all about whether the
 * feature is on.
 *
 * *Ready* is an observation: the endpoint answered when it was last asked. It
 * is written by `testProvider` and by nothing else, so it can never be set by
 * somebody's intention.
 *
 * *Enabled* is a decision, and it is the one section 18 opens with: "AI is
 * optional and disabled until configured per business". It cannot be turned on
 * for an endpoint that has never answered, which is not bureaucracy — an
 * enabled endpoint that has never been reached is a feature that appears
 * available on every screen and fails the first time anybody uses it, and the
 * failure lands on whoever pressed the button rather than on whoever typed the
 * address.
 *
 * The address itself goes through the section 19 SSRF policy before it is stored
 * and again before every request. Local Ollama is the documented private-host
 * exception, and it is an installation-level opt-in rather than something a
 * business can grant itself: a business owner who could name a private address
 * could aim this application's outbound requests at the host's own network.
 */

export class AiConfigurationError extends Error {
  readonly reason: AiConfigurationRefusal;

  constructor(reason: AiConfigurationRefusal, message: string) {
    super(message);
    this.name = 'AiConfigurationError';
    this.reason = reason;
  }
}

export type AiConfigurationRefusal =
  | 'not_permitted'
  | 'recent_authentication_required'
  | 'destination_refused'
  | 'not_configured'
  | 'never_answered'
  | 'endpoint_refused';

export interface ConfigureProviderInput {
  readonly businessId: string;
  readonly kind: AiProviderKind;
  /** As typed. Canonicalized and validated before anything is stored. */
  readonly baseUrl: string;
  readonly model: string;
  /** Absent for a local endpoint that needs none; a string replaces whatever is stored. */
  readonly apiKey?: string;
  readonly requestTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  readonly imageAnalysisEnabled?: boolean;
  readonly retainPrompts?: boolean;
  readonly monthlyRequestCap?: number;
  readonly monthlyTokenCap?: number;
  readonly costCurrency?: string | null;
  readonly costPerMillionInputTokens?: string | null;
  readonly costPerMillionOutputTokens?: string | null;
  readonly monthlyCostCapAmount?: string | null;
  readonly subject: Subject;
  readonly actorUserId: string;
  /** Section 20: configuration secrets need a recent authentication. */
  readonly hasRecentAuthentication: boolean;
  readonly urlPolicy: UrlPolicy;
  readonly now?: Date;
}

/** Builds an adapter for a configuration whose row already exists. */
export type AdapterForProvider = (providerId: string) => Promise<AiAdapter>;

/**
 * Records or replaces the endpoint, and never turns it on.
 *
 * Editing an existing configuration is an update rather than a second row: one
 * per business, so "which model wrote this" never depends on a routing rule.
 * The row keeps its identity across an edit, which is what lets a suggestion
 * from March still point at the configuration that produced it.
 */
export async function configureProvider(
  db: Database,
  secrets: AiSecretStore,
  audit: AuditRecorder,
  input: ConfigureProviderInput,
): Promise<AiProvider> {
  requirePermission(input.subject, 'manage_ai');

  if (!input.hasRecentAuthentication) {
    throw new AiConfigurationError(
      'recent_authentication_required',
      'configuring an AI endpoint requires authentication within the step-up window',
    );
  }

  const verdict = validateIntegrationUrl(input.baseUrl, input.urlPolicy);
  if (!verdict.ok) {
    throw new AiConfigurationError(
      'destination_refused',
      `that address cannot be used: ${verdict.reason}`,
    );
  }

  const now = input.now ?? new Date();
  const baseUrl = verdict.url.toString();
  const existing = await loadProvider(db, input.businessId);

  // Every edit resets the observation, because an address or a model that has
  // changed has not been checked. Leaving `ready` in place across an edit is how
  // a working endpoint's verdict gets inherited by a broken one.
  const settings = {
    kind: input.kind,
    baseUrl,
    model: input.model,
    status: 'unchecked' as const,
    lastFailureSummary: null,
    updatedAt: now,
    ...optional('requestTimeoutMs', input.requestTimeoutMs),
    ...optional('maxOutputTokens', input.maxOutputTokens),
    ...optional('imageAnalysisEnabled', input.imageAnalysisEnabled),
    ...optional('retainPrompts', input.retainPrompts),
    ...optional('monthlyRequestCap', input.monthlyRequestCap),
    ...optional('monthlyTokenCap', input.monthlyTokenCap),
    ...optional('costCurrency', input.costCurrency),
    ...optional('costPerMillionInputTokens', input.costPerMillionInputTokens),
    ...optional('costPerMillionOutputTokens', input.costPerMillionOutputTokens),
    ...optional('monthlyCostCapAmount', input.monthlyCostCapAmount),
  };

  const [row] =
    existing === null
      ? await db
          .insert(aiProviders)
          .values({
            businessId: input.businessId,
            createdByUserId: input.actorUserId,
            createdAt: now,
            ...settings,
          })
          .returning()
      : await db
          .update(aiProviders)
          .set(settings)
          .where(eq(aiProviders.id, existing.id))
          .returning();

  if (row === undefined) {
    throw new AiConfigurationError('not_configured', 'the AI configuration could not be stored');
  }

  if (input.apiKey !== undefined) {
    await secrets.put({
      businessId: input.businessId,
      providerId: row.id,
      value: input.apiKey,
      now,
    });
  }

  await audit.record(db, {
    action: 'ai.provider.configured',
    result: 'success',
    businessId: input.businessId,
    targetType: 'ai_provider',
    targetId: row.id,
    detail: {
      kind: input.kind,
      // The address, which is the point of the record. Never the credential:
      // `@eim/audit` would redact a key by name, and this never sends one.
      baseUrl,
      model: input.model,
      credentialReplaced: input.apiKey !== undefined,
      imageAnalysisEnabled: row.imageAnalysisEnabled,
      retainPrompts: row.retainPrompts,
    },
  });

  return row;
}

/**
 * Asks the endpoint whether it is there, and records the answer.
 *
 * Revalidates the stored address first. Section 19 requires the check "before
 * storage and again before every connection", and this is a connection: a name
 * that resolved to a public host in March may resolve to a private one now, and
 * the stored string is not evidence about today.
 */
export async function testProvider(
  db: Database,
  audit: AuditRecorder,
  adapterFor: AdapterForProvider,
  input: {
    readonly businessId: string;
    readonly subject: Subject;
    readonly urlPolicy: UrlPolicy;
    readonly now?: Date;
  },
): Promise<{ readonly ready: boolean; readonly summary: string }> {
  requirePermission(input.subject, 'manage_ai');

  const now = input.now ?? new Date();
  const provider = await requireProvider(db, input.businessId);

  const verdict = validateIntegrationUrl(provider.baseUrl, input.urlPolicy);
  if (!verdict.ok) {
    const summary = `the stored address is no longer permitted: ${verdict.reason}`;
    await markFailing(db, provider.id, summary, now);
    await recordTest(db, audit, input.businessId, provider.id, false, summary);

    return { ready: false, summary };
  }

  const adapter = await adapterFor(provider.id);
  const check = await adapter.checkEndpoint();

  if (!isSuccess(check)) {
    const summary = describeFailure(check);
    await markFailing(db, provider.id, summary, now);
    await recordTest(db, audit, input.businessId, provider.id, false, summary);

    return { ready: false, summary };
  }

  await db
    .update(aiProviders)
    .set({ status: 'ready', lastCheckedAt: now, lastFailureSummary: null, updatedAt: now })
    .where(eq(aiProviders.id, provider.id));

  await recordTest(db, audit, input.businessId, provider.id, true, check.value.model);

  return { ready: true, summary: check.value.model };
}

/**
 * Turns the feature on, or off.
 *
 * On is refused for an endpoint that has never answered. Off is never refused:
 * a business that wants to stop sending its catalogue text to a model should not
 * have to make anything work first.
 */
export async function setProviderEnabled(
  db: Database,
  audit: AuditRecorder,
  input: {
    readonly businessId: string;
    readonly enabled: boolean;
    readonly subject: Subject;
    readonly now?: Date;
  },
): Promise<AiProvider> {
  requirePermission(input.subject, 'manage_ai');

  const now = input.now ?? new Date();
  const provider = await requireProvider(db, input.businessId);

  if (input.enabled && provider.status !== 'ready') {
    throw new AiConfigurationError(
      'never_answered',
      'test the endpoint before enabling it; an endpoint that has never answered cannot be relied on',
    );
  }

  const [row] = await db
    .update(aiProviders)
    .set({ enabled: input.enabled, updatedAt: now })
    .where(eq(aiProviders.id, provider.id))
    .returning();

  await audit.record(db, {
    action: input.enabled ? 'ai.provider.enabled' : 'ai.provider.disabled',
    result: 'success',
    businessId: input.businessId,
    targetType: 'ai_provider',
    targetId: provider.id,
    detail: { kind: provider.kind, model: provider.model },
  });

  return row ?? provider;
}

/**
 * Removes the configuration and destroys the credential.
 *
 * The suggestions stay. They are the record of what a model was asked and what
 * it answered, and section 18's provenance requirement is worth nothing if it
 * evaporates when somebody changes their mind about a provider. The rows lose
 * their pointer to a configuration that no longer exists and keep the snapshot
 * columns that say which kind and which model answered.
 */
export async function removeProvider(
  db: Database,
  secrets: AiSecretStore,
  audit: AuditRecorder,
  input: { readonly businessId: string; readonly subject: Subject },
): Promise<void> {
  requirePermission(input.subject, 'manage_ai');

  const provider = await requireProvider(db, input.businessId);

  await secrets.retire({ businessId: input.businessId, providerId: provider.id });
  await db.delete(aiProviders).where(eq(aiProviders.id, provider.id));

  await audit.record(db, {
    action: 'ai.provider.removed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'ai_provider',
    targetId: provider.id,
    detail: { kind: provider.kind, model: provider.model },
  });
}

/** The configuration, or null. A business with none is the ordinary case. */
export async function loadProvider(db: Database, businessId: string): Promise<AiProvider | null> {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.businessId, businessId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The configuration a suggestion would actually use, when there is one.
 *
 * Both switches, together, in one query. A caller that asked only whether a
 * configuration exists would offer the feature to a business that had turned it
 * off, and a caller that asked only whether it is enabled would offer it against
 * an endpoint nobody has ever reached.
 */
export async function usableProvider(db: Database, businessId: string): Promise<AiProvider | null> {
  const rows = await db
    .select()
    .from(aiProviders)
    .where(
      and(
        eq(aiProviders.businessId, businessId),
        eq(aiProviders.enabled, true),
        eq(aiProviders.status, 'ready'),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

function requirePermission(subject: Subject, permission: 'manage_ai'): void {
  const decision = authorize(subject, permission);

  if (!decision.allowed) {
    throw new AiConfigurationError(
      'not_permitted',
      `${permission} was refused: ${decision.reason}`,
    );
  }
}

async function requireProvider(db: Database, businessId: string): Promise<AiProvider> {
  const provider = await loadProvider(db, businessId);

  if (provider === null) {
    throw new AiConfigurationError('not_configured', 'this business has no AI endpoint configured');
  }

  return provider;
}

async function markFailing(
  db: Database,
  providerId: string,
  summary: string,
  now: Date,
): Promise<void> {
  await db
    .update(aiProviders)
    .set({
      status: 'failing',
      // An endpoint that stopped answering is switched off as well as marked, so
      // the next screen offers nothing rather than offering something that will
      // fail. Turning it back on is a decision somebody makes after fixing it,
      // and `setProviderEnabled` will refuse until a test has succeeded.
      enabled: false,
      lastCheckedAt: now,
      lastFailureSummary: summary,
      updatedAt: now,
    })
    .where(eq(aiProviders.id, providerId));
}

async function recordTest(
  db: Database,
  audit: AuditRecorder,
  businessId: string,
  providerId: string,
  ready: boolean,
  summary: string,
): Promise<void> {
  await audit.record(db, {
    action: 'ai.provider.tested',
    result: ready ? 'success' : 'failure',
    businessId,
    targetType: 'ai_provider',
    targetId: providerId,
    detail: { ready, summary },
  });
}

/**
 * A field, when the caller supplied one.
 *
 * `exactOptionalPropertyTypes` means an explicit `undefined` is not the same as
 * an absent key, and an update built with the first would overwrite a stored
 * setting with nothing every time a form left it alone.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
