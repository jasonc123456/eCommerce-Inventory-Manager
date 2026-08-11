import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { loadKeyring } from '@eim/crypto';
import { aiSuggestions, businesses, reviewedOperations, users } from '@eim/db';
import { FakeAiAdapter, type UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureProvider, setProviderEnabled, testProvider } from './providers';
import { createAiSecretStore, type AiSecretStore } from './credentials';
import { markSuggestionApplied, suggest } from './suggest';
import { readCurrentUsage } from './usage';
import type { SubjectText } from './request';

/**
 * Asking for a suggestion, end to end (sections 18, 36).
 *
 * Section 36's exit gate names disabled-default, protected-field,
 * malformed-output, timeout, budget, no-publish, and review tests. The ones that
 * need a database are here; the pure ones are beside the modules they belong to.
 */

let harness: TestDatabase;
let secrets: AiSecretStore;

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createAiSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 11).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const urlPolicy: UrlPolicy = { allowInsecure: false, allowPrivate: false, allowlist: [] };

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly audit: AuditRecorder;
  readonly subject: Subject;
}

async function seed(): Promise<Fixture> {
  const slug = `sug-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Catalogue manager' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  return {
    businessId,
    userId,
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    subject: {
      userId,
      isOwner: true,
      grants: [],
    },
  };
}

const draft: SubjectText = {
  kind: 'draft_fields',
  destination: 'ebay',
  title: 'Blue widget 40mm',
  description: 'A blue widget.',
  imageUrls: ['https://shop.example.invalid/widget.jpg'],
};

/** Configures, tests, and enables an endpoint, which is the only way to get one. */
async function enable(
  fixture: Fixture,
  adapter: FakeAiAdapter,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await configureProvider(harness.db, secrets, fixture.audit, {
    businessId: fixture.businessId,
    kind: 'openai_compatible',
    baseUrl: 'https://models.example.invalid/v1',
    model: 'a-model',
    subject: fixture.subject,
    actorUserId: fixture.userId,
    hasRecentAuthentication: true,
    urlPolicy,
    ...overrides,
  } as never);

  await testProvider(harness.db, fixture.audit, () => Promise.resolve(adapter), {
    businessId: fixture.businessId,
    subject: fixture.subject,
    urlPolicy,
  });

  await setProviderEnabled(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    enabled: true,
    subject: fixture.subject,
  });
}

function ask(fixture: Fixture, adapter: FakeAiAdapter, overrides: Record<string, unknown> = {}) {
  return suggest(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    kind: 'draft_fields',
    subjectText: draft,
    subjectKind: 'canonical_item',
    subjectReference: 'item-1',
    subject: fixture.subject,
    actorUserId: fixture.userId,
    adapterFor: () => Promise.resolve(adapter),
    urlPolicy,
    ...overrides,
  } as never);
}

describe('disabled by default', () => {
  it('refuses when no endpoint is configured, and says so rather than failing', async () => {
    const fixture = await seed();

    const result = await ask(fixture, new FakeAiAdapter());

    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.reason).toBe('disabled');
  });

  it('refuses when an endpoint is configured but not switched on', async () => {
    const fixture = await seed();
    await configureProvider(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      kind: 'openai_compatible',
      baseUrl: 'https://models.example.invalid/v1',
      model: 'a-model',
      subject: fixture.subject,
      actorUserId: fixture.userId,
      hasRecentAuthentication: true,
      urlPolicy,
    });

    const adapter = new FakeAiAdapter();
    const result = await ask(fixture, adapter);

    expect(result.status === 'refused' && result.reason).toBe('disabled');
    // Nothing was sent. That is the whole claim.
    expect(adapter.requests).toHaveLength(0);
  });

  it('records the refusal without charging it to the budget', async () => {
    const fixture = await seed();
    await ask(fixture, new FakeAiAdapter());

    const usage = await readCurrentUsage(harness.db, fixture.businessId);

    expect(usage.requests).toBe(0);
    const rows = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.businessId, fixture.businessId));
    expect(rows[0]?.status).toBe('refused');
  });
});

describe('permissions', () => {
  it('refuses somebody who could not do the work by hand', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter();
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter, {
      subject: { userId: fixture.userId, isOwner: false, grants: [] },
    });

    expect(result.status === 'refused' && result.reason).toBe('not_permitted');
    expect(adapter.requests).toHaveLength(0);
  });

  it('asks a different permission for each kind of question', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ candidates: [{ reference: 'Widget' }] }] });
    await enable(fixture, adapter);

    const mappingOnly: Subject = {
      userId: fixture.userId,
      isOwner: false,
      grants: [{ permission: 'propose_mappings', scope: { kind: 'business' } }],
    };

    const allowed = await ask(fixture, adapter, {
      kind: 'mapping_candidates',
      subjectText: {
        kind: 'mapping_candidates',
        channelEntityTitle: 'BLUE WIDGET',
        candidateItems: ['Widget'],
      },
      subject: mappingOnly,
    });
    const refused = await ask(fixture, adapter, { subject: mappingOnly });

    expect(allowed.status).toBe('suggested');
    expect(refused.status === 'refused' && refused.reason).toBe('not_permitted');
  });
});

describe('a good answer', () => {
  it('is recorded, validated, and handed back without being applied', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [{ title: 'Blue widget, 40mm', tags: ['widget', 'blue'] }],
    });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    expect(result.status).toBe('suggested');
    if (result.status !== 'suggested') {
      throw new Error('expected a suggestion');
    }

    expect(result.suggestion.kind).toBe('draft_fields');

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.status).toBe('succeeded');
    expect(row?.model).toBe('fake-model');
    // Not applied. A suggestion is a suggestion until a person takes it.
    expect(row?.appliedAt).toBeNull();
    expect(row?.appliedByUserId).toBeNull();
  });

  it('sends no image unless the configuration and the request both allow it', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);

    await ask(fixture, adapter, { requestImageAnalysis: true });

    // The request asked, but the configuration has image analysis off, which is
    // its default.
    expect(adapter.requests[0]?.imageUrls).toBeUndefined();

    await configureProvider(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      kind: 'openai_compatible',
      baseUrl: 'https://models.example.invalid/v1',
      model: 'a-model',
      imageAnalysisEnabled: true,
      subject: fixture.subject,
      actorUserId: fixture.userId,
      hasRecentAuthentication: true,
      urlPolicy,
    });
    await testProvider(harness.db, fixture.audit, () => Promise.resolve(adapter), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy,
    });
    await setProviderEnabled(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      enabled: true,
      subject: fixture.subject,
    });

    await ask(fixture, adapter, { requestImageAnalysis: true });

    expect(adapter.requests[1]?.imageUrls).toEqual(['https://shop.example.invalid/widget.jpg']);

    const rows = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.businessId, fixture.businessId));
    expect(rows.map((row) => row.imagesSent).sort()).toEqual([0, 1]);
  });

  it('keeps no prompt or response unless the business asked it to', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.retainedPrompt).toBeNull();
    expect(row?.retainedResponse).toBeNull();
  });

  it('keeps them when it did', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { retainPrompts: true });

    const result = await ask(fixture, adapter);

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.retainedPrompt).toContain('Blue widget 40mm');
    expect(row?.retainedResponse).toContain('Blue widget');
  });
});

describe('a bad answer', () => {
  it('reports prose as unusable rather than throwing', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: ['I think a good title would be Blue Widget.'] });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    expect(result.status === 'unusable' && result.reason).toBe('malformed');

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));
    expect(row?.status).toBe('malformed');
    expect(row?.payload).toBeNull();
  });

  it('says when the answer was cut off rather than blaming the model', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: ['{"title":"Blue wid'], truncated: true });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    expect(result.status === 'unusable' && result.detail).toContain('cut off');
  });

  it('drops a protected fact and keeps the rest, with a warning', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [{ title: 'Blue widget', price: '4.99', sku: 'WID-1' }],
    });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    if (result.status !== 'suggested' || result.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    expect(result.suggestion.title).toBe('Blue widget');
    expect(JSON.stringify(result.suggestion)).not.toContain('4.99');
    expect(result.warnings.join(' ')).toContain('price');

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));
    expect(JSON.stringify(row?.payload)).not.toContain('4.99');
  });

  it('records a timeout as a failure and still costs a row', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ latencyMs: 600_000 });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    expect(result.status === 'unusable' && result.reason).toBe('failed');

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));
    expect(row?.status).toBe('failed');
    expect(row?.failureSummary).toContain('unavailable');
  });
});

describe('budgets', () => {
  it('refuses once the month’s requests are used, and sends nothing', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { monthlyRequestCap: 2 });

    await ask(fixture, adapter);
    await ask(fixture, adapter);
    const third = await ask(fixture, adapter);

    expect(third.status === 'refused' && third.reason).toBe('request_budget_spent');
    expect(adapter.requests).toHaveLength(2);
  });

  it('refuses once the token ceiling is reached', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [{ title: 'Blue widget' }],
      promptTokens: 900,
      completionTokens: 200,
    });
    await enable(fixture, adapter, { monthlyTokenCap: 1_000 });

    await ask(fixture, adapter);
    const second = await ask(fixture, adapter);

    expect(second.status === 'refused' && second.reason).toBe('token_budget_spent');
  });

  it('prices a request when the operator supplied rates', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [{ title: 'Blue widget' }],
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    await enable(fixture, adapter, {
      costCurrency: 'GBP',
      costPerMillionInputTokens: '2.000000',
      costPerMillionOutputTokens: '10.000000',
      // One request costs exactly this, so the first is inside the ceiling and
      // the second is refused. The check runs before the call, so a budget is
      // spent when it is reached rather than when it is exceeded.
      monthlyCostCapAmount: '2.0000',
      // Raised so that money is the ceiling being tested. Whichever ceiling is
      // reached first is the one that refuses, and the default token ceiling
      // would have caught a million-token request before the £3 did.
      monthlyTokenCap: 10_000_000,
    });

    const first = await ask(fixture, adapter);
    const second = await ask(fixture, adapter);

    expect(first.status).toBe('suggested');
    expect(second.status === 'refused' && second.reason).toBe('cost_budget_spent');

    const usage = await readCurrentUsage(harness.db, fixture.businessId);
    expect(usage.costAmount).toBe('2.000000');
  });
});

describe('the trail', () => {
  it('records every request and every refusal', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { monthlyRequestCap: 1 });

    await ask(fixture, adapter);
    await ask(fixture, adapter);

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const actions = events.map((event) => event.action);

    expect(actions).toContain('ai.suggestion.requested');
    expect(actions).toContain('ai.suggestion.refused');
  });
});

describe('review', () => {
  it('records who took a suggestion into a confirmed operation', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);
    const result = await ask(fixture, adapter);

    const now = new Date();
    const [operation] = await harness.db
      .insert(reviewedOperations)
      .values({
        businessId: fixture.businessId,
        kind: 'draft_create',
        subjectKey: 'item-1',
        requiredPermission: 'create_drafts',
        preview: { fields: { title: 'Blue widget' } },
        previewFingerprint: 'fp-1',
        sourceObservedAt: now,
        sourceMaxAgeMs: 600_000,
        expiresAt: new Date(now.getTime() + 600_000),
        idempotencyKey: `draft-${String(counter)}`,
      })
      .returning({ id: reviewedOperations.id });

    await markSuggestionApplied(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      suggestionId: result.suggestionId,
      operationId: operation!.id,
      actorUserId: fixture.userId,
    });

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.appliedOperationId).toBe(operation!.id);
    expect(row?.appliedByUserId).toBe(fixture.userId);
  });

  it('refuses to mark a malformed answer as applied', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: ['not json'] });
    await enable(fixture, adapter);
    const result = await ask(fixture, adapter);

    await expect(
      markSuggestionApplied(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        suggestionId: result.suggestionId,
        operationId: '00000000-0000-0000-0000-000000000000',
        actorUserId: fixture.userId,
      }),
    ).rejects.toThrow();
  });
});
