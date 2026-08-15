import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { businesses, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFORMANCE, EXPECTED_CONFORMANCE_IDS } from './conformance';
import { assessPilot, PILOT_DURATION_DAYS } from './criteria';
import { classifyIncident, fileIncident, listIncidents, recordDrill } from './incidents';
import { openSample } from './samples';
import { measureSlo } from './slo';
import { enroll, mayWrite, setStage } from './stages';

/**
 * The M9 exit gate (section 36).
 *
 * "Every section 1 pilot criterion and AC-01 through AC-20 pass with retained
 * evidence."
 *
 * That sentence asks for two different things, and this file proves them
 * differently.
 *
 * The twenty acceptance criteria are properties of the build. What can be
 * checked here is that each one is bound to an artifact a reader can open, and
 * that the artifact is still there — a citation that has rotted is worse than no
 * citation, because it reads like one that works.
 *
 * Section 1's eight pilot criteria are measurements over live data, and a test
 * cannot manufacture thirty days of a real seller account. What it can prove is
 * that the machinery is honest: that the bar cannot be passed early, that
 * evidence nobody has looked at does not count as evidence, that exclusions stay
 * visible, and that the staged gate actually withholds. Those are the properties
 * that decide whether the pilot, when it runs, will mean anything.
 *
 * What this deliberately does not assert is that any pilot has passed. That is
 * what the thirty days are for, and a test that could assert it would be a way
 * of skipping them.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seedBusiness(): Promise<{ businessId: string; userId: string }> {
  const slug = `gate-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  return { businessId: business!.id, userId: user!.id };
}

// ---------------------------------------------------------------------------
// AC-01 through AC-20: the citations
// ---------------------------------------------------------------------------

describe('the acceptance criteria are bound to evidence', () => {
  it('covers all twenty, with nothing missing and nothing invented', () => {
    expect(CONFORMANCE.map((entry) => entry.id)).toEqual(EXPECTED_CONFORMANCE_IDS);
  });

  it.each(CONFORMANCE.map((entry) => [entry.id, entry] as const))(
    '%s cites artifacts that exist',
    (_id, entry) => {
      // The whole point of a machine-checked matrix. A rename that orphans a
      // proof fails here rather than leaving a document describing a file
      // nobody has.
      for (const path of entry.evidence) {
        expect({ path, exists: existsSync(join(REPO, path)) }).toEqual({ path, exists: true });
      }
    },
  );

  it.each(CONFORMANCE.map((entry) => [entry.id, entry] as const))(
    '%s cites at least one artifact',
    (_id, entry) => {
      expect(entry.evidence.length).toBeGreaterThan(0);
    },
  );

  it('never claims a qualified criterion is unqualified', () => {
    // `proven_against_contract` exists precisely so that AC-10 and AC-11 do not
    // have to be described as proven against providers they have never called.
    // A qualified status with no caveat would defeat the distinction.
    for (const entry of CONFORMANCE) {
      if (entry.status === 'proven_against_contract') {
        expect(entry.caveat ?? '').not.toBe('');
      }
    }
  });

  it('names the two criteria that are still qualified, and only those', () => {
    const qualified = CONFORMANCE.filter((entry) => entry.status === 'proven_against_contract').map(
      (entry) => entry.id,
    );

    // The order copy waits on V-03 and shipping waits on V-04, both deferred by
    // the owner until after version 1. If a third criterion ever becomes
    // qualified, that is a decision somebody should have to make here.
    expect(qualified).toEqual(['AC-10', 'AC-11']);
  });

  it('is published as a document that names every criterion', () => {
    const doc = readFileSync(join(REPO, 'docs/release/acceptance.md'), 'utf8');

    for (const entry of CONFORMANCE) {
      expect(doc).toContain(entry.id);
    }

    // And says which two are qualified, in the prose rather than only in a
    // table cell somebody can skim past.
    expect(doc).toContain('V-03');
    expect(doc).toContain('V-04');
  });
});

// ---------------------------------------------------------------------------
// The deliverables that are documents rather than behaviour
// ---------------------------------------------------------------------------

describe('the M9 documents say what they must', () => {
  it('the pilot runbook covers all four stages and all three drills', () => {
    const doc = readFileSync(join(REPO, 'docs/operations/pilot.md'), 'utf8');

    for (const stage of ['Observe', 'Single', 'Cohort', 'Full']) {
      expect(doc).toContain(stage);
    }

    for (const drill of ['24-hour outage', 'Restoring a backup', 'Installing cleanly']) {
      expect(doc).toContain(drill);
    }

    // The surprising rule, written down where an operator meets it rather than
    // only in a migration comment.
    expect(doc).toContain('not written even to reduce a quantity');
  });

  it('the release checklist gates on the pilot rather than on an opinion', () => {
    const doc = readFileSync(join(REPO, 'docs/release/checklist.md'), 'utf8');

    expect(doc).toContain('Thirty days have elapsed');
    expect(doc).toContain('undemonstrated');
    // Section 23: never a mutable tag as the documented upgrade target.
    expect(doc).toContain('Pin the **digest**');
  });

  it('the release workflow still builds both architectures and signs', () => {
    const workflow = readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8');

    expect(workflow).toContain('linux/amd64,linux/arm64');
    expect(workflow).toContain('cosign sign');
    expect(workflow).toMatch(/tags:\s*\["v\*"\]/u);
  });
});

// ---------------------------------------------------------------------------
// Section 1's bar cannot be cleared early, or by accident
// ---------------------------------------------------------------------------

describe('the pilot bar is honest', () => {
  it('does not pass on day one, however good the evidence', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });

    const report = await assessPilot(harness.db, { businessId });

    expect(report.durationMet).toBe(false);
    expect(report.passes).toBe(false);
    expect(PILOT_DURATION_DAYS).toBe(30);
  });

  it('does not pass even after thirty days while a criterion is undemonstrated', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });

    // Pretend the clock started five weeks ago. Nothing else about the pilot
    // has happened: no drills, no traffic, no incidents.
    await harness.db.execute(sql`
      update business_pilot_stages
         set pilot_started_at = now() - interval '35 days'
       where business_id = ${businessId}::uuid
    `);

    const report = await assessPilot(harness.db, { businessId });

    expect(report.durationMet).toBe(true);
    expect(report.passes).toBe(false);

    // And says so per criterion rather than as one opaque failure.
    const undemonstrated = report.criteria.filter(
      (criterion) => criterion.verdict === 'undemonstrated',
    );
    expect(undemonstrated.length).toBeGreaterThan(0);
    for (const criterion of undemonstrated) {
      expect(criterion.nextStep).not.toBe('');
    }
  });

  it('treats an unreviewed oversale as no evidence, not as good news', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });
    await fileIncident(harness.db, {
      businessId,
      kind: 'oversale',
      summary: 'three units short',
    });

    const before = await assessPilot(harness.db, { businessId });
    expect(before.criteria.find((entry) => entry.id === 'no_oversale')?.verdict).toBe(
      'undemonstrated',
    );

    const [incident] = await listIncidents(harness.db, { businessId });
    await classifyIncident(harness.db, {
      businessId,
      incidentId: incident!.id,
      classification: 'defect',
      finding: 'the target sat unwritten for an hour behind a stalled job',
      actorUserId: userId,
    });

    const after = await assessPilot(harness.db, { businessId });

    // A classified defect is worse than an unclassified incident, and the
    // verdict moves accordingly rather than being satisfied by the review.
    expect(after.criteria.find((entry) => entry.id === 'no_oversale')?.verdict).toBe('not_met');
  });

  it('counts a failed drill as failed rather than as not attempted', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });
    await recordDrill(harness.db, {
      kind: 'outage_recovery',
      succeeded: false,
      summary: 'cursors did not resume and the ledger needed a manual correction',
      actorUserId: userId,
    });

    const report = await assessPilot(harness.db, { businessId });

    expect(report.criteria.find((entry) => entry.id === 'outage_recovery')?.verdict).toBe(
      'not_met',
    );
  });
});

// ---------------------------------------------------------------------------
// The measurement cannot be tuned into passing
// ---------------------------------------------------------------------------

describe('the service objective cannot be flattered', () => {
  it('shows every exclusion beside the figure it was excluded from', async () => {
    const { businessId, userId } = await seedBusiness();
    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });

    // Ten changes, all of them excluded for one reason or another.
    for (let index = 0; index < 10; index += 1) {
      const mappingId = crypto.randomUUID();

      await openSample(harness.db, {
        businessId,
        mappingId,
        connectionId: crypto.randomUUID(),
        targetVersion: 1,
        quantity: 1,
        origin: { kind: 'order', noticedAt: new Date(Date.now() - 60_000) },
      });

      await harness.db.execute(sql`
        update convergence_samples
           set excluded_reason = ${index % 2 === 0 ? 'the provider was unavailable' : 'withheld by the pilot stage'},
               outcome = 'converged',
               converged_at = noticed_at + interval '3 hours'
         where mapping_id = ${mappingId}::uuid
      `);
    }

    const report = await measureSlo(harness.db, {
      businessId,
      window: { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 1000) },
    });

    // Nothing measured, everything excluded, and the report says both — rather
    // than reporting 100% of an empty set.
    expect(report.met + report.missed).toBe(0);
    expect(report.excluded).toBe(10);
    expect(report.attainment).toBeNull();
    expect(report.meetsTarget).toBe(false);

    const named = report.exclusions.reduce((total, entry) => total + entry.samples, 0);
    expect(named).toBe(10);
  });

  it('will not certify the objective from a handful of samples', async () => {
    const { businessId, userId } = await seedBusiness();
    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });

    // Five changes, all instant. A hundred percent that means nothing.
    for (let index = 0; index < 5; index += 1) {
      const mappingId = crypto.randomUUID();

      await openSample(harness.db, {
        businessId,
        mappingId,
        connectionId: crypto.randomUUID(),
        targetVersion: 1,
        quantity: 1,
        origin: { kind: 'order', noticedAt: new Date(Date.now() - 60_000) },
      });
      await harness.db.execute(sql`
        update convergence_samples
           set outcome = 'converged', converged_at = noticed_at + interval '1 second'
         where mapping_id = ${mappingId}::uuid
      `);
    }

    const report = await assessPilot(harness.db, { businessId });
    const objective = report.criteria.find((entry) => entry.id === 'service_objective');

    expect(objective?.verdict).toBe('undemonstrated');
  });
});

// ---------------------------------------------------------------------------
// Staged connections
// ---------------------------------------------------------------------------

describe('the staged gate', () => {
  it('sends nothing at all while observing, and starts no clock', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'observe', actorUserId: userId });

    const decision = await mayWrite(harness.db, { businessId, mappingId: crypto.randomUUID() });
    expect(decision.allowed).toBe(false);

    const report = await assessPilot(harness.db, { businessId });
    expect(report.elapsedDays).toBeNull();
  });

  it('has no override, including for a mapping the operator has not enrolled', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, {
      businessId,
      stage: 'cohort',
      cohortLimit: 3,
      actorUserId: userId,
    });

    // There is deliberately no argument to `mayWrite` that says "but this one is
    // protective". A boundary a flag can cross is not a boundary.
    const decision = await mayWrite(harness.db, { businessId, mappingId: crypto.randomUUID() });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? '' : decision.reason).toContain('not enrolled');
  });

  it('enforces the ceiling where the decision is made rather than where the race is', async () => {
    const { businessId, userId } = await seedBusiness();

    await setStage(harness.db, { businessId, stage: 'full', actorUserId: userId });

    // A full business has no ceiling and nothing to enrol into; the refusal is
    // explicit rather than a silent success that would imply staging was on.
    const result = await enroll(harness.db, {
      businessId,
      mappingId: crypto.randomUUID(),
      actorUserId: userId,
    });

    expect(result.enrolled).toBe(false);
  });
});
