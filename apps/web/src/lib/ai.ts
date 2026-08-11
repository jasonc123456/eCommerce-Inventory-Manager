import {
  assessBudget,
  createAiAdapter,
  createAiSecretStore,
  loadProvider,
  monthWindow,
  readUsage,
  type AdapterForProvider,
  type AiSecretStore,
  type BudgetUsage,
  type BudgetVerdict,
} from '@eim/ai';
import { authorize } from '@eim/authz';
import { aiSuggestions, type AiProvider, type AiSuggestion } from '@eim/db';
import { createHttpClient } from '@eim/providers';
import { and, desc, eq } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';
import { integrationUrlPolicy } from './woocommerce';

/**
 * The web tier's wiring for optional AI (sections 18, 19).
 *
 * Unlike shipping, this tier does hold an adapter factory. The difference is not
 * a change of mind about where provider calls belong — it is that an AI endpoint
 * needs a URL and, at most, one key, both of which this tier already reads for
 * WooCommerce. Shipping's absence is verification V-04, not a boundary.
 *
 * The one rule this file exists to keep is that the credential is decrypted per
 * request and never cached. A model endpoint is asked a question a few times a
 * day; holding a decrypted key in a process for weeks to save a database read
 * would be a poor trade.
 */

const AI_KEY = Symbol.for('eim.web.ai');

interface Wiring {
  readonly secrets: AiSecretStore;
  readonly adapterFor: (businessId: string) => AdapterForProvider;
}

type GlobalWithAi = Record<symbol, Wiring | undefined>;

export function ai(): Wiring {
  const container = globalThis as unknown as GlobalWithAi;
  const existing = container[AI_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const { config, db } = runtime();
  const { keyring } = identity();
  const secrets = createAiSecretStore({ db, keyring });

  const http = createHttpClient({
    policy: integrationUrlPolicy(),
    userAgent: `eCommerce-Inventory-Manager/${config.EIM_APP_VERSION ?? 'unknown'}`,
  });

  const built: Wiring = {
    secrets,
    adapterFor: (businessId) => async (providerId) => {
      const provider = await loadProvider(db, businessId);

      if (provider?.id !== providerId) {
        throw new Error('no such AI configuration in this business');
      }

      return createAiAdapter({
        provider,
        apiKey: await secrets.read({ businessId, providerId }),
        http,
      });
    },
  };

  container[AI_KEY] = built;
  return built;
}

export interface AiSettingsView {
  readonly provider: AiProvider | null;
  /** Whether a credential is stored, never what it is. */
  readonly hasCredential: boolean;
  readonly usage: BudgetUsage;
  readonly budget: BudgetVerdict | null;
  readonly recent: readonly AiSuggestion[];
  readonly mayManage: boolean;
  readonly privateHostsAllowed: boolean;
}

/**
 * Everything the settings screen shows.
 *
 * The month's usage is read even when the feature is off, because the question
 * "what did this cost us" outlives the decision to stop using it.
 */
export async function loadAiSettings(businessId: string, userId: string): Promise<AiSettingsView> {
  const { config, db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);
  const provider = await loadProvider(db, businessId);
  const usage = await readUsage(db, businessId, monthWindow(new Date()));

  const recent = await db
    .select()
    .from(aiSuggestions)
    .where(eq(aiSuggestions.businessId, businessId))
    .orderBy(desc(aiSuggestions.requestedAt))
    .limit(20);

  return {
    provider,
    hasCredential:
      provider === null
        ? false
        : (await ai().secrets.describe({ businessId, providerId: provider.id })) !== null,
    usage,
    budget: provider === null ? null : assessBudget(provider, usage),
    recent,
    mayManage: subject === null ? false : authorize(subject, 'manage_ai').allowed,
    privateHostsAllowed: config.EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
  };
}

/** One suggestion, for a screen that wants to explain where a value came from. */
export async function loadSuggestion(
  businessId: string,
  suggestionId: string,
): Promise<AiSuggestion | null> {
  const { db } = runtime();

  const rows = await db
    .select()
    .from(aiSuggestions)
    .where(and(eq(aiSuggestions.businessId, businessId), eq(aiSuggestions.id, suggestionId)))
    .limit(1);

  return rows[0] ?? null;
}
