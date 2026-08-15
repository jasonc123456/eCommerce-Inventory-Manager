import { businesses, connections, providerItems, users } from '@eim/db';
import { createCanonicalItem, createLocation, proposeMapping } from '@eim/inventory';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assessPilot } from './criteria';
import { classifyIncident, fileIncident, listIncidents, recordDrill } from './incidents';
import { excludeSample, markSuperseded, openSample } from './samples';
import { measureSlo, SLO_TARGET_MS } from './slo';
import { enroll, mayWrite, readStage, recordWithheld, setStage, unenroll } from './stages';

/**
 * The pilot's own measurements, against a real database (sections 1, 36).
 *
 * Almost everything here is a claim about SQL — a generated column, a check
 * constraint, a percentile over a window — so a fake would be testing a
 * reimplementation of the thing under test.
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
  readonly connectionId: string;
  readonly userId: string;
  readonly mappingId: string;
}

async function seed(): Promise<Fixture> {
  const slug = `pilot-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });
  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `acct-${slug}`,
      displayName: 'Test seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  // A mapping is needed only so enrollment has something real to point at; it is
  // left in `draft` because nothing here exercises the mapping itself, and an
  // activated one would imply an eligibility this test never checks.
  const businessId = business!.id;
  const connectionId = connection!.id;
  const userId = user!.id;

  const location = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });

  const [providerItem] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId: `listing-${slug}`,
      title: 'Widget',
      kind: 'listing',
      inventoryEligible: true,
      quantity: 0,
    })
    .returning({ id: providerItems.id });

  const proposed = await proposeMapping(harness.db, {
    businessId,
    connectionId,
    canonicalItemId: item.outcome === 'created' ? item.canonicalItemId : '',
    providerItemId: providerItem!.id,
    locationIds: [location.outcome === 'created' ? location.locationId : ''],
    createdByUserId: userId,
  });

  return {
    businessId,
    connectionId,
    userId,
    mappingId: proposed.outcome === 'proposed' ? proposed.mappingId : '',
  };
}

/** Opens a sample whose clock started `agoMs` in the past. */
async function sampleAt(
  fixture: Fixture,
  input: {
    readonly version: number;
    readonly agoMs: number;
    readonly kind?: 'order' | 'reconciliation';
    readonly mappingId?: string;
  },
): Promise<void> {
  await openSample(harness.db, {
    businessId: fixture.businessId,
    mappingId: input.mappingId ?? fixture.mappingId,
    connectionId: fixture.connectionId,
    targetVersion: input.version,
    quantity: 5,
    origin: {
      kind: input.kind ?? 'order',
      noticedAt: new Date(Date.now() - input.agoMs),
    },
  });
}

/** Settles it as converged `latencyMs` after it was noticed. */
async function convergeAfter(mappingId: string, version: number, latencyMs: number): Promise<void> {
  await harness.db.execute(sql`
    update convergence_samples
       set outcome = 'converged',
           converged_at = noticed_at + make_interval(secs => ${latencyMs / 1000})
     where mapping_id = ${mappingId}::uuid and target_version = ${version}
  `);
}

const WINDOW = () => ({
  from: new Date(Date.now() - 60 * 60 * 1000),
  to: new Date(Date.now() + 1000),
});

describe('the sample record', () => {
  it('computes latency from when the change was noticed, not when it was computed', async () => {
    const fixture = await seed();

    // Noticed ten minutes ago, converged ninety seconds after that. If the clock
    // started at computation the latency would read as ten minutes.
    await sampleAt(fixture, { version: 1, agoMs: 10 * 60 * 1000 });
    await convergeAfter(fixture.mappingId, 1, 90_000);

    const rows = await harness.db.execute<{ latency_ms: string | number }>(sql`
      select latency_ms from convergence_samples where mapping_id = ${fixture.mappingId}::uuid
    `);

    expect(Number(rows.rows[0]?.latency_ms)).toBe(90_000);
  });

  it('keeps the earliest notice when the same version is recorded twice', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 10 * 60 * 1000 });
    await sampleAt(fixture, { version: 1, agoMs: 1000 });

    const rows = await harness.db.execute<{ noticed_at: Date }>(sql`
      select noticed_at from convergence_samples where mapping_id = ${fixture.mappingId}::uuid
    `);

    // A change still outstanding must not have its clock restarted by a retry.
    expect(Date.now() - new Date(rows.rows[0]!.noticed_at).getTime()).toBeGreaterThan(60_000);
  });

  it('refuses a resolution with no time attached', async () => {
    const fixture = await seed();
    await sampleAt(fixture, { version: 1, agoMs: 1000 });

    const message = await refuses(async () =>
      harness.db.execute(sql`
        update convergence_samples set outcome = 'converged'
         where mapping_id = ${fixture.mappingId}::uuid
      `),
    );

    expect(message).toMatch(/convergence_samples_converged_has_a_time/u);
  });

  it('refuses a convergence that precedes the change', async () => {
    const fixture = await seed();
    await sampleAt(fixture, { version: 1, agoMs: 1000 });

    const message = await refuses(async () =>
      harness.db.execute(sql`
        update convergence_samples
           set outcome = 'converged', converged_at = noticed_at - interval '1 second'
         where mapping_id = ${fixture.mappingId}::uuid
      `),
    );

    expect(message).toMatch(/convergence_samples_time_moves_forward/u);
  });

  it('classifies scope from the origin, and nothing can override it', async () => {
    const fixture = await seed();
    await sampleAt(fixture, { version: 1, agoMs: 1000, kind: 'reconciliation' });

    const message = await refuses(async () =>
      harness.db.execute(sql`
        update convergence_samples set in_slo_scope = true
         where mapping_id = ${fixture.mappingId}::uuid
      `),
    );

    // A generated column cannot be written at all, which is the point: the rule
    // is section 1's, not an operator's, and not a value somebody can set on the
    // rows they would prefer to have counted.
    expect(message).toMatch(/can only be updated to DEFAULT/u);
  });
});

describe('the service objective', () => {
  it('counts a change that arrived late as missed, and one on time as met', async () => {
    const fixture = await seed();
    const second = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000 });
    await convergeAfter(fixture.mappingId, 1, SLO_TARGET_MS - 1000);

    await sampleAt(fixture, { version: 2, agoMs: 30 * 60 * 1000, mappingId: second.mappingId });
    await convergeAfter(second.mappingId, 2, SLO_TARGET_MS + 1000);

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    expect(report.met).toBe(1);
    expect(report.missed).toBe(1);
    expect(report.attainment).toBe(0.5);
    expect(report.meetsTarget).toBe(false);
  });

  it('shows an exclusion rather than hiding it', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000 });
    await excludeSample(harness.db, {
      mappingId: fixture.mappingId,
      targetVersion: 1,
      reason: 'the provider was unavailable',
    });
    await convergeAfter(fixture.mappingId, 1, SLO_TARGET_MS * 10);

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    // Out of the numerator and the denominator, but present in the report and
    // named. A reader can disagree with the exclusion; they cannot miss it.
    expect(report.met).toBe(0);
    expect(report.missed).toBe(0);
    expect(report.excluded).toBe(1);
    expect(report.exclusions).toEqual([{ reason: 'the provider was unavailable', samples: 1 }]);
  });

  it('leaves reconciliation and imports out of scope entirely', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000, kind: 'reconciliation' });
    await convergeAfter(fixture.mappingId, 1, SLO_TARGET_MS * 20);

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    expect(report.outOfScope).toBe(1);
    expect(report.met + report.missed).toBe(0);
  });

  it('does not count a superseded change against the objective', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000 });
    await markSuperseded(harness.db, { mappingId: fixture.mappingId, targetVersion: 1 });

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    expect(report.superseded).toBe(1);
    expect(report.missed).toBe(0);
  });

  it('widens the allowance by a deliberately slower configured interval', async () => {
    const fixture = await seed();

    // The owner asked to poll every ten minutes, so section 1 adds the extra
    // nine and a half minutes to the objective.
    await harness.db.execute(sql`
      insert into connection_sync_settings
        (connection_id, business_id, target_interval_seconds, effective_interval_seconds)
      values (${fixture.connectionId}::uuid, ${fixture.businessId}::uuid, 600, 600)
    `);

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000 });
    await convergeAfter(fixture.mappingId, 1, 8 * 60 * 1000);

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    // Eight minutes would miss a two-minute objective and meets this one.
    expect(report.met).toBe(1);
    expect(report.missed).toBe(0);
  });

  it('counts an abandoned change as a miss', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 30 * 60 * 1000 });
    await harness.db.execute(sql`
      update convergence_samples set outcome = 'abandoned'
       where mapping_id = ${fixture.mappingId}::uuid
    `);

    const report = await measureSlo(harness.db, {
      businessId: fixture.businessId,
      window: WINDOW(),
    });

    // A change accepted and never delivered is the worst outcome available, and
    // dropping it would improve the percentage every time one happened.
    expect(report.missed).toBe(1);
  });
});

describe('the staged-connection gate', () => {
  it('writes nothing at all while observing', async () => {
    const fixture = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'observe',
      actorUserId: fixture.userId,
    });

    const decision = await mayWrite(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
    });

    expect(decision.allowed).toBe(false);
  });

  it('starts the pilot clock on the first transition out of observing, and only then', async () => {
    const fixture = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'observe',
      actorUserId: fixture.userId,
    });
    expect((await readStage(harness.db, fixture.businessId)).pilotStartedAt).toBeNull();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'single',
      actorUserId: fixture.userId,
    });
    const started = (await readStage(harness.db, fixture.businessId)).pilotStartedAt;
    expect(started).not.toBeNull();

    // Going back to observing and forward again must not reset it: thirty days
    // measured from a date that can be moved is not thirty days.
    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'observe',
      actorUserId: fixture.userId,
    });
    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'full',
      actorUserId: fixture.userId,
    });

    expect((await readStage(harness.db, fixture.businessId)).pilotStartedAt).toEqual(started);
  });

  it('refuses to enroll past the ceiling', async () => {
    const fixture = await seed();
    const other = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'single',
      actorUserId: fixture.userId,
    });

    const first = await enroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      actorUserId: fixture.userId,
    });
    expect(first.enrolled).toBe(true);

    const second = await enroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: other.mappingId,
      actorUserId: fixture.userId,
    });

    // The ceiling is enforced here rather than at write time, so which mapping
    // the pilot exercises is a decision rather than a race.
    expect(second.enrolled).toBe(false);
  });

  it('refuses to narrow a stage below what is already enrolled', async () => {
    const fixture = await seed();
    const other = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'cohort',
      cohortLimit: 2,
      actorUserId: fixture.userId,
    });
    await enroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      actorUserId: fixture.userId,
    });
    await enroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: other.mappingId,
      actorUserId: fixture.userId,
    });

    const narrowed = await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'single',
      actorUserId: fixture.userId,
    });

    expect(narrowed.changed).toBe(false);

    await unenroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: other.mappingId,
    });

    const retried = await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'single',
      actorUserId: fixture.userId,
    });
    expect(retried.changed).toBe(true);
  });

  it('lets an enrolled mapping through and records what it withheld from the others', async () => {
    const fixture = await seed();
    const other = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'single',
      actorUserId: fixture.userId,
    });
    await enroll(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      actorUserId: fixture.userId,
    });

    expect(
      (
        await mayWrite(harness.db, {
          businessId: fixture.businessId,
          mappingId: fixture.mappingId,
        })
      ).allowed,
    ).toBe(true);

    const blocked = await mayWrite(harness.db, {
      businessId: fixture.businessId,
      mappingId: other.mappingId,
    });
    expect(blocked.allowed).toBe(false);

    await recordWithheld(harness.db, {
      businessId: fixture.businessId,
      mappingId: other.mappingId,
      connectionId: fixture.connectionId,
      intendedQuantity: 3,
      observedQuantity: 9,
      stage: 'single',
      reason: 'not enrolled',
    });

    const rows = await harness.db.execute<{ intended_quantity: number }>(sql`
      select intended_quantity from pilot_withheld_writes
       where business_id = ${fixture.businessId}::uuid
    `);

    // The withheld log is what an operator reads to decide whether to widen the
    // stage: the system's proposed action against live data, with no consequences.
    expect(rows.rows[0]?.intended_quantity).toBe(3);
  });

  it('leaves a business that never ran a pilot writing everything', async () => {
    const fixture = await seed();

    const decision = await mayWrite(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
    });

    expect(decision.allowed).toBe(true);
  });
});

describe('incidents', () => {
  it('files one incident per alert however many times it is raised', async () => {
    const fixture = await seed();
    const alertId = crypto.randomUUID();

    await harness.db.execute(sql`
      insert into operator_alerts (id, business_id, kind, severity, subject_key, summary)
      values (${alertId}::uuid, ${fixture.businessId}::uuid, 'oversold', 'critical',
              'item:x', 'two short')
    `);

    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'two short',
      alertId,
    });
    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'two short',
      alertId,
    });

    expect(await listIncidents(harness.db, { businessId: fixture.businessId })).toHaveLength(1);
  });

  it('refuses a classification with no author or finding', async () => {
    const fixture = await seed();
    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'one short',
    });

    const message = await refuses(async () =>
      harness.db.execute(sql`
        update pilot_incidents set classification = 'not_a_defect'
         where business_id = ${fixture.businessId}::uuid
      `),
    );

    expect(message).toMatch(/pilot_incidents_review_is_attributed/u);
  });

  it('will not accept an empty finding through the service either', async () => {
    const fixture = await seed();
    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'one short',
    });

    const [incident] = await listIncidents(harness.db, { businessId: fixture.businessId });

    const result = await classifyIncident(harness.db, {
      businessId: fixture.businessId,
      incidentId: incident!.id,
      classification: 'not_a_defect',
      finding: '   ',
      actorUserId: fixture.userId,
    });

    expect(result.classified).toBe(false);
  });
});

describe('the version 1 bar', () => {
  it('reports an unreviewed oversale as undemonstrated, not as met', async () => {
    const fixture = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'full',
      actorUserId: fixture.userId,
    });
    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'one short',
    });

    const report = await assessPilot(harness.db, { businessId: fixture.businessId });
    const criterion = report.criteria.find((entry) => entry.id === 'no_oversale');

    expect(criterion?.verdict).toBe('undemonstrated');
    expect(report.passes).toBe(false);
  });

  it('turns met once a person has said it was not a defect', async () => {
    const fixture = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'full',
      actorUserId: fixture.userId,
    });
    await fileIncident(harness.db, {
      businessId: fixture.businessId,
      kind: 'oversale',
      summary: 'one short',
    });

    const [incident] = await listIncidents(harness.db, { businessId: fixture.businessId });
    await classifyIncident(harness.db, {
      businessId: fixture.businessId,
      incidentId: incident!.id,
      classification: 'external',
      finding: 'the marketplace accepted an order against a quantity it had been told was zero',
      actorUserId: fixture.userId,
    });

    const report = await assessPilot(harness.db, { businessId: fixture.businessId });

    expect(report.criteria.find((entry) => entry.id === 'no_oversale')?.verdict).toBe('met');
  });

  it('holds the objective undemonstrated until enough changes have settled', async () => {
    const fixture = await seed();

    await sampleAt(fixture, { version: 1, agoMs: 60_000 });
    await convergeAfter(fixture.mappingId, 1, 1000);

    const report = await assessPilot(harness.db, { businessId: fixture.businessId });
    const criterion = report.criteria.find((entry) => entry.id === 'service_objective');

    // One sample at 100% is not evidence of 95%.
    expect(criterion?.verdict).toBe('undemonstrated');
  });

  it('records a failed drill as evidence rather than hiding it', async () => {
    const fixture = await seed();

    await recordDrill(harness.db, {
      kind: 'clean_install',
      succeeded: false,
      summary: 'the documented Compose file referenced a volume that does not exist',
      actorUserId: fixture.userId,
    });

    const report = await assessPilot(harness.db, { businessId: fixture.businessId });
    const criterion = report.criteria.find((entry) => entry.id === 'clean_install');

    expect(criterion?.verdict).toBe('not_met');
  });

  it('never passes before the thirty days are up', async () => {
    const fixture = await seed();

    await setStage(harness.db, {
      businessId: fixture.businessId,
      stage: 'full',
      actorUserId: fixture.userId,
    });

    const report = await assessPilot(harness.db, { businessId: fixture.businessId });

    expect(report.durationMet).toBe(false);
    expect(report.passes).toBe(false);
  });
});
