import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { aiProviders, aiSuggestions, businesses, users } from './index';

/**
 * Proof that the AI tables enforce what section 18 says.
 *
 * The rules under test are the ones whose violation would be invisible. A
 * configuration that arrives enabled is a feature that turned itself on. A
 * refusal that recorded token usage inflates the very budget it was protecting.
 * A money cap with no prices behind it reads on a screen as a limit and is not
 * one. A suggestion marked applied with nobody attached is section 18's human
 * review with the human missing.
 *
 * Runs against real PostgreSQL 18 only. There is no fake.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly providerId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `ai-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  const businessId = business!.id;

  const [provider] = await db
    .insert(aiProviders)
    .values({
      businessId,
      kind: 'ollama',
      baseUrl: 'http://ollama.internal:11434',
      model: 'llama3.2',
      createdByUserId: user!.id,
    })
    .returning({ id: aiProviders.id });

  return { businessId, userId: user!.id, providerId: provider!.id };
}

describe('configuration', () => {
  it('arrives disabled, unchecked, and without image analysis', async () => {
    const fixture = await seed();

    const [provider] = await harness.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, fixture.providerId))
      .limit(1);

    expect(provider?.enabled).toBe(false);
    expect(provider?.status).toBe('unchecked');
    expect(provider?.imageAnalysisEnabled).toBe(false);
    expect(provider?.retainPrompts).toBe(false);
  });

  it('always has a ceiling, because there is no way to express none', async () => {
    const fixture = await seed();

    const [provider] = await harness.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.id, fixture.providerId))
      .limit(1);

    expect(provider?.monthlyRequestCap).toBeGreaterThan(0);
    expect(provider?.monthlyTokenCap).toBeGreaterThan(0);
  });

  it('refuses a money cap with no prices behind it', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db
        .update(aiProviders)
        .set({ monthlyCostCapAmount: '20.00' })
        .where(eq(aiProviders.id, fixture.providerId)),
    );

    expect(message).toContain('ai_providers_cost_cap_is_computable');
  });

  it('accepts a money cap once the rates and currency are there', async () => {
    const fixture = await seed();

    await expect(
      harness.db
        .update(aiProviders)
        .set({
          monthlyCostCapAmount: '20.00',
          costCurrency: 'GBP',
          costPerMillionInputTokens: '0.150000',
          costPerMillionOutputTokens: '0.600000',
        })
        .where(eq(aiProviders.id, fixture.providerId)),
    ).resolves.toBeDefined();
  });

  it('refuses a second configuration for one business', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db.insert(aiProviders).values({
        businessId: fixture.businessId,
        kind: 'openai_compatible',
        baseUrl: 'https://api.example.invalid/v1',
        model: 'gpt-4o-mini',
      }),
    );

    expect(message).toContain('ai_providers_one_per_business');
  });

  it('refuses a timeout long enough to hold a request open', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      harness.db
        .update(aiProviders)
        .set({ requestTimeoutMs: 600_000 })
        .where(eq(aiProviders.id, fixture.providerId)),
    );

    expect(message).toContain('ai_providers_timeout_bounded');
  });
});

describe('suggestions', () => {
  async function record(fixture: Fixture, values: Record<string, unknown>) {
    return harness.db.insert(aiSuggestions).values({
      businessId: fixture.businessId,
      providerId: fixture.providerId,
      kind: 'draft_fields',
      subjectKind: 'canonical_item',
      subjectReference: 'item-1',
      status: 'succeeded',
      payload: { kind: 'draft_fields', title: 'Blue widget' },
      requestedByUserId: fixture.userId,
      ...values,
    } as never);
  }

  it('refuses a successful suggestion with nothing in it', async () => {
    const fixture = await seed();

    const message = await refuses(() => record(fixture, { payload: null }));

    expect(message).toContain('ai_suggestions_payload_matches_status');
  });

  it('refuses a failed attempt that left a payload behind', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      record(fixture, { status: 'failed', failureSummary: 'the endpoint is unavailable' }),
    );

    expect(message).toContain('ai_suggestions_payload_matches_status');
  });

  it('refuses a refusal that does not say why', async () => {
    const fixture = await seed();

    const message = await refuses(() => record(fixture, { status: 'refused', payload: null }));

    expect(message).toContain('ai_suggestions_refusal_is_explained');
  });

  it('refuses a refusal that claims to have spent tokens', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      record(fixture, {
        status: 'refused',
        payload: null,
        refusalReason: 'token_budget_spent',
        promptTokens: 400,
      }),
    );

    expect(message).toContain('ai_suggestions_refusal_costs_nothing');
  });

  it('refuses an application with nobody attached to it', async () => {
    const fixture = await seed();

    const message = await refuses(() => record(fixture, { appliedAt: new Date() }));

    expect(message).toContain('ai_suggestions_application_is_complete');
  });

  it('refuses applying something that was never valid', async () => {
    const fixture = await seed();

    const message = await refuses(() =>
      record(fixture, {
        status: 'malformed',
        payload: null,
        appliedAt: new Date(),
        appliedByUserId: fixture.userId,
      }),
    );

    expect(message).toContain('ai_suggestions_only_valid_applies');
  });

  it('refuses a cost with no currency naming it', async () => {
    const fixture = await seed();

    const message = await refuses(() => record(fixture, { estimatedCostAmount: '0.004000' }));

    expect(message).toContain('ai_suggestions_cost_has_currency');
  });

  it('keeps the evidence when the configuration is deleted', async () => {
    const fixture = await seed();
    await record(fixture, {});

    await harness.db.delete(aiProviders).where(eq(aiProviders.id, fixture.providerId));

    const rows = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.businessId, fixture.businessId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBeNull();
    // The snapshot columns are what make the orphaned row still mean something.
    expect(rows[0]?.subjectReference).toBe('item-1');
  });
});
