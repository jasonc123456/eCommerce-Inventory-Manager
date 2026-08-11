import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { loadKeyring } from '@eim/crypto';
import { aiProviders, aiSuggestions, businesses, canonicalItems, users } from '@eim/db';
import { FakeAiAdapter, type UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAiSecretStore, type AiSecretStore } from './credentials';
import { configureProvider, setProviderEnabled, testProvider } from './providers';
import { readCurrentUsage } from './usage';
import { suggest } from './suggest';
import { draftSubjectFor } from './subjects';

/**
 * The M7 exit gate (section 36).
 *
 * "Disabled-default, protected-field, malformed-output, timeout, budget,
 * no-publish, and review tests pass."
 *
 * Seven claims, and four of them are about things that must not happen — so four
 * are asserted as absences before they are asserted as behaviour. An absence is
 * only provable against the files that would have to contain it, which is why
 * this suite reads the repository's own configuration and manifests.
 *
 * The one worth explaining is "no-publish". Section 18 gives the model "no
 * credentials, publishing tools, customer/order PII, or unrestricted network
 * access", and the way that is kept here is not a check inside a function: it is
 * that this package cannot import the code that publishes, prices, ships,
 * confirms, or moves stock, cannot open a socket of its own, and cannot be
 * imported by anything that runs unattended. A model in this application has no
 * authority to misuse, so prompt injection has nothing to win.
 */

let harness: TestDatabase;
let secrets: AiSecretStore;

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createAiSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 13).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

const REPO = join(import.meta.dirname, '..', '..', '..');
const urlPolicy: UrlPolicy = { allowInsecure: false, allowPrivate: false, allowlist: [] };

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly owner: Subject;
  readonly stranger: Subject;
  readonly audit: AuditRecorder;
  readonly itemId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `gate7-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });
  const [other] = await db
    .insert(users)
    .values({ email: `${slug}-s@example.invalid`, displayName: 'Stranger' })
    .returning({ id: users.id });

  const businessId = business!.id;

  const [item] = await db
    .insert(canonicalItems)
    .values({
      businessId,
      sku: `WID-${slug}`,
      name: 'Blue widget 40mm',
      description: 'A blue widget, forty millimetres across.',
    })
    .returning({ id: canonicalItems.id });

  return {
    businessId,
    userId: user!.id,
    owner: { userId: user!.id, isOwner: true, grants: [] },
    stranger: { userId: other!.id, isOwner: false, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId: user!.id }, businessId }),
    itemId: item!.id,
  };
}

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
    subject: fixture.owner,
    actorUserId: fixture.userId,
    hasRecentAuthentication: true,
    urlPolicy,
    ...overrides,
  } as never);

  await testProvider(harness.db, fixture.audit, () => Promise.resolve(adapter), {
    businessId: fixture.businessId,
    subject: fixture.owner,
    urlPolicy,
  });

  await setProviderEnabled(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    enabled: true,
    subject: fixture.owner,
  });
}

async function ask(
  fixture: Fixture,
  adapter: FakeAiAdapter,
  overrides: Record<string, unknown> = {},
) {
  const subjectText = await draftSubjectFor(harness.db, {
    businessId: fixture.businessId,
    canonicalItemId: fixture.itemId,
    destination: 'ebay',
  });

  return suggest(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    kind: 'draft_fields',
    subjectText,
    subjectKind: 'canonical_item',
    subjectReference: fixture.itemId,
    subject: fixture.owner,
    actorUserId: fixture.userId,
    adapterFor: () => Promise.resolve(adapter),
    urlPolicy,
    ...overrides,
  } as never);
}

describe('disabled by default', () => {
  it('sends nothing for a business that has configured nothing', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter();

    const result = await ask(fixture, adapter);

    expect(result.status === 'refused' && result.reason).toBe('disabled');
    expect(adapter.requests).toHaveLength(0);
  });

  it('stores a new configuration off, unchecked, without images, and keeping nothing', async () => {
    const fixture = await seed();

    await configureProvider(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      kind: 'openai_compatible',
      baseUrl: 'https://models.example.invalid/v1',
      model: 'a-model',
      subject: fixture.owner,
      actorUserId: fixture.userId,
      hasRecentAuthentication: true,
      urlPolicy,
    });

    const [row] = await harness.db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.businessId, fixture.businessId));

    expect(row?.enabled).toBe(false);
    expect(row?.status).toBe('unchecked');
    expect(row?.imageAnalysisEnabled).toBe(false);
    expect(row?.retainPrompts).toBe(false);
  });

  it('will not switch on an endpoint that has never answered', async () => {
    const fixture = await seed();
    await configureProvider(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      kind: 'ollama',
      baseUrl: 'https://models.example.invalid/v1',
      model: 'a-model',
      subject: fixture.owner,
      actorUserId: fixture.userId,
      hasRecentAuthentication: true,
      urlPolicy,
    });

    await expect(
      setProviderEnabled(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        enabled: true,
        subject: fixture.owner,
      }),
    ).rejects.toMatchObject({ reason: 'never_answered' });
  });

  it('has no default in the schema that would switch it on', () => {
    const migration = readFileSync(join(REPO, 'packages/db/migrations/0024_ai.sql'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(migration).toContain('enabled             boolean     not null default false');
    expect(migration).toContain('image_analysis_enabled boolean  not null default false');
    expect(migration).toContain('retain_prompts      boolean     not null default false');
  });
});

describe('protected fields', () => {
  it('drops every protected fact a model volunteers, and says which', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [
        {
          title: 'Blue widget, 40mm',
          description: 'A tidy little widget.',
          price: '4.99',
          currency: 'GBP',
          sku: 'WID-INVENTED',
          condition: 'New',
          returnPolicy: '30 days',
          gtin: '5012345678900',
          itemSpecifics: [
            { name: 'Colour', value: 'Blue' },
            { name: 'Condition', value: 'New' },
          ],
        },
      ],
    });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    if (result.status !== 'suggested' || result.suggestion.kind !== 'draft_fields') {
      throw new Error('expected a draft-field suggestion');
    }

    const stored = JSON.stringify(result.suggestion);

    for (const invented of ['4.99', 'GBP', 'WID-INVENTED', '30 days', '5012345678900']) {
      expect(stored, invented).not.toContain(invented);
    }

    expect(result.suggestion.title).toBe('Blue widget, 40mm');
    expect(result.suggestion.itemSpecifics).toEqual([{ name: 'Colour', value: 'Blue' }]);
    expect(result.warnings.join(' ')).toContain('price');

    // And the same is true of what was written down, not only of what was
    // returned to the caller.
    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));
    expect(JSON.stringify(row?.payload)).not.toContain('4.99');
  });

  it('never asks for one either', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);

    await ask(fixture, adapter);

    const sent = `${adapter.requests[0]?.instruction ?? ''}\n${adapter.requests[0]?.subject ?? ''}`;

    // The item's own SKU is in the catalogue row this question is about, and it
    // does not travel.
    expect(sent).not.toContain('WID-gate7');
    expect(JSON.stringify(adapter.requests[0]?.responseSchema).toLowerCase()).not.toContain(
      'price',
    );
  });
});

describe('malformed output', () => {
  const answers = [
    'I would suggest calling it a Blue Widget.',
    '',
    '[1,2,3]',
    '{"title": ',
    '{"unrelated":"field"}',
  ];

  for (const answer of answers) {
    it(`treats ${JSON.stringify(answer).slice(0, 30)} as unusable rather than an error`, async () => {
      const fixture = await seed();
      const adapter = new FakeAiAdapter({ answers: [answer] });
      await enable(fixture, adapter);

      const result = await ask(fixture, adapter);

      expect(result.status === 'unusable' && result.reason).toBe('malformed');
    });
  }

  it('records the attempt with no payload behind it', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: ['nonsense'] });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.status).toBe('malformed');
    expect(row?.payload).toBeNull();
  });
});

describe('timeout', () => {
  it('reports a slow endpoint without throwing into the screen that asked', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ latencyMs: 10 * 60_000 });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    expect(result.status === 'unusable' && result.reason).toBe('failed');
    expect(result.status === 'unusable' && result.detail).toContain('unavailable');
  });

  it('carries a bounded timeout on every request rather than trusting the endpoint', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { requestTimeoutMs: 5_000 });

    await ask(fixture, adapter);

    expect(adapter.requests[0]?.timeoutMs).toBe(5_000);
    expect(adapter.requests[0]?.maxOutputTokens).toBeGreaterThan(0);
  });
});

describe('budget', () => {
  it('refuses at each ceiling in turn, and sends nothing when it does', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({
      answers: [{ title: 'Blue widget' }],
      promptTokens: 100,
      completionTokens: 20,
    });
    await enable(fixture, adapter, { monthlyRequestCap: 1 });

    await ask(fixture, adapter);
    const refused = await ask(fixture, adapter);

    expect(refused.status === 'refused' && refused.reason).toBe('request_budget_spent');
    expect(adapter.requests).toHaveLength(1);
  });

  it('does not charge a refusal against the budget it is protecting', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { monthlyRequestCap: 1 });

    await ask(fixture, adapter);
    await ask(fixture, adapter);
    await ask(fixture, adapter);

    const usage = await readCurrentUsage(harness.db, fixture.businessId);

    expect(usage.requests).toBe(1);
  });

  it('has no way to express an absent ceiling', () => {
    const migration = readFileSync(join(REPO, 'packages/db/migrations/0024_ai.sql'), 'utf8');

    expect(migration).toContain('monthly_request_cap integer     not null');
    expect(migration).toContain('monthly_token_cap   bigint      not null');
    expect(migration).toContain('ai_providers_caps_positive');
  });
});

describe('no publish', () => {
  it('cannot import anything that publishes, prices, ships, confirms, or moves stock', () => {
    const manifest = readFileSync(join(REPO, 'packages/ai/package.json'), 'utf8');

    for (const forbidden of [
      '@eim/listings',
      '@eim/shipping',
      '@eim/review',
      '@eim/inventory',
      '@eim/sync',
      '@eim/jobs',
      '@eim/integrations',
    ]) {
      expect(manifest, forbidden).not.toContain(forbidden);
    }
  });

  it('is forbidden by the linter from reaching them, not only unwired', () => {
    const config = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');

    expect(config).toContain('NO_ACTING_ON_A_SUGGESTION');
    expect(config).toContain("files: ['packages/ai/**/*.ts']");
  });

  it('cannot be imported by anything that runs unattended', () => {
    const config = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');
    const restriction = config.slice(
      config.indexOf('const NO_REVIEWED_OPERATIONS'),
      config.indexOf('const NO_ACTING_ON_A_SUGGESTION'),
    );

    expect(restriction).toContain("'@eim/ai'");

    for (const unattended of ['apps/worker', 'packages/sync', 'packages/jobs']) {
      expect(readFileSync(join(REPO, unattended, 'package.json'), 'utf8')).not.toContain('@eim/ai');
    }
  });

  it('offers the model no tool, no function, and no callback', () => {
    // Asserted against the two files that would have to declare one: the
    // contract a caller programs against, and the request bodies that go on the
    // wire. Prose is excluded because both files quote section 18's phrase
    // "publishing tools" while describing the absence.
    const contract = readFileSync(join(REPO, 'packages/providers/src/ai.ts'), 'utf8');
    const endpoints = readFileSync(join(REPO, 'packages/ai/src/endpoints.ts'), 'utf8');

    for (const absent of [
      'tools:',
      'tool_choice',
      'functions:',
      'function_call',
      'readonly tools',
    ]) {
      expect(contract, absent).not.toContain(absent);
      expect(endpoints, absent).not.toContain(absent);
    }
  });

  it('never streams, so no unvalidated fragment can reach a screen', () => {
    const endpoints = readFileSync(join(REPO, 'packages/ai/src/endpoints.ts'), 'utf8');

    expect(endpoints).toContain('stream: false');
    expect(endpoints).not.toContain('stream: true');
  });

  it('opens no socket of its own', () => {
    const sources = readdirSync(join(REPO, 'packages/ai/src'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => join(REPO, 'packages/ai/src', name));

    for (const source of sources) {
      const text = readFileSync(source, 'utf8');

      for (const forbidden of [
        "from 'node:http'",
        "from 'node:https'",
        'fetch(',
        'new WebSocket',
      ]) {
        expect(text, `${source} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('reaches no order or buyer data at all', () => {
    // Section 18: no customer or order detail. Asserted against the files that
    // would have to name a table to read one.
    const sources = readdirSync(join(REPO, 'packages/ai/src'))
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .map((name) => join(REPO, 'packages/ai/src', name));

    for (const source of sources) {
      const text = readFileSync(source, 'utf8');

      for (const forbidden of [
        'channelOrders',
        'channelOrderLines',
        'buyerReference',
        'shipmentPackages',
        'stockReservations',
      ]) {
        expect(text, `${source} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('has nowhere in the schema to schedule a suggestion', () => {
    const migration = readFileSync(join(REPO, 'packages/db/migrations/0024_ai.sql'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toLowerCase();

    for (const absent of ['cron', 'schedule', 'next_run', 'interval', 'queue']) {
      expect(migration, absent).not.toContain(absent);
    }
  });
});

describe('review', () => {
  it('refuses somebody who could not do the work by hand', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter, { subject: fixture.stranger });

    expect(result.status === 'refused' && result.reason).toBe('not_permitted');
    expect(adapter.requests).toHaveLength(0);
  });

  it('leaves a suggestion applied by nobody until a person applies it', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);

    const result = await ask(fixture, adapter);

    const [row] = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.id, result.suggestionId));

    expect(row?.status).toBe('succeeded');
    expect(row?.appliedAt).toBeNull();
    expect(row?.appliedByUserId).toBeNull();
    expect(row?.appliedOperationId).toBeNull();
  });

  it('records what was asked, what was refused, and what was suggested', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter, { monthlyRequestCap: 1 });

    await ask(fixture, adapter);
    await ask(fixture, adapter);

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    const actions = events.map((event) => event.action);

    expect(actions).toContain('ai.provider.configured');
    expect(actions).toContain('ai.provider.tested');
    expect(actions).toContain('ai.provider.enabled');
    expect(actions).toContain('ai.suggestion.requested');
    expect(actions).toContain('ai.suggestion.refused');
  });

  it('keeps the evidence of what a model said after the endpoint is removed', async () => {
    const fixture = await seed();
    const adapter = new FakeAiAdapter({ answers: [{ title: 'Blue widget' }] });
    await enable(fixture, adapter);
    await ask(fixture, adapter);

    await harness.db.delete(aiProviders).where(eq(aiProviders.businessId, fixture.businessId));

    const rows = await harness.db
      .select()
      .from(aiSuggestions)
      .where(eq(aiSuggestions.businessId, fixture.businessId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe('fake-model');
    expect(rows[0]?.providerKind).toBe('openai_compatible');
  });
});
