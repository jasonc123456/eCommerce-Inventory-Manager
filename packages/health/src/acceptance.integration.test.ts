import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  alertStateAt,
  backupRuns,
  businesses,
  memberships,
  notificationDeliveries,
  operatorAlerts,
  users,
} from '@eim/db';
import type { DeliveryOutcome, Mailer, OutboundMessage } from '@eim/mail';
import {
  acknowledgeAlert,
  announceNewAlerts,
  openInstallationAlerts,
  raiseAlert,
  resolveAlertsAbout,
  saveBusinessSettings,
  sendPendingEmail,
  snoozeAlert,
  type SweepPorts,
} from '@eim/notifications';
import { cutoffFor, sweepBusiness, DEFAULT_POLICY } from '@eim/retention';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assessHealth } from './report';
import { watchInstallation } from './watch';

/**
 * The milestone 8 exit gate (section 36).
 *
 * Section 36 asks for "release quality gates, restore/migration drills,
 * accessibility, dependency/license/security scans, and documentation
 * clean-install pass" over "observability, health, notifications,
 * retention/deletion, backup/restore, upgrade/rollback, docs/runbooks,
 * multi-architecture images, security hardening".
 *
 * Several of those are not behaviours, and this file does not pretend they are.
 * A multi-architecture image is a property of a workflow; a documentation
 * clean-install pass is a property of a document; a scan is a property of CI.
 * Where the deliverable is a file rather than a behaviour, this asserts the
 * file says what it must — because the alternative is a milestone whose exit
 * gate quietly covers only the half that was easy to test.
 *
 * The behavioural half is proven against a real database, and the properties
 * chosen are the ones whose absence would be discovered on a bad day:
 *
 *   Nothing resolves an alert except evidence that the problem is gone.
 *   Nothing tells somebody about a problem their permissions do not cover.
 *   Nothing sends the same notification twice.
 *   Nothing deletes an outstanding alert, however old.
 *   Nothing keeps a buyer's raw data past the window that can be erased.
 *   Nothing reports healthy when it could not tell.
 */

let harness: TestDatabase;

const REPO = join(import.meta.dirname, '..', '..', '..');

class SilentMailer implements Mailer {
  public readonly sent: OutboundMessage[] = [];

  send(message: OutboundMessage): Promise<DeliveryOutcome> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, messageId: 'gate' });
  }

  verify(): Promise<DeliveryOutcome> {
    return Promise.resolve({ delivered: true, messageId: 'gate' });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

let mailer: SilentMailer;

function ports(): SweepPorts {
  return {
    db: harness.db,
    mailer,
    productName: 'Inventory Manager',
    publicUrl: 'https://inventory.example',
  };
}

beforeAll(async () => {
  harness = await createTestDatabase();
  mailer = new SilentMailer();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function shop(role: 'owner' | 'operator' = 'owner'): Promise<{
  businessId: string;
  userId: string;
  email: string;
}> {
  const slug = `gate-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role, status: 'active' });

  return { businessId: business!.id, userId: user!.id, email: `${slug}@example.invalid` };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('an alert is never closed by an opinion', () => {
  it('survives an acknowledgement, and ends only on evidence', async () => {
    const { businessId, userId } = await shop();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:gate',
      summary: 'an order could not be filled in full',
    });

    await acknowledgeAlert(harness.db, { businessId, alertId: alert.alertId, actorUserId: userId });

    const [acknowledged] = await harness.db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, alert.alertId));

    // Still outstanding. Acknowledgement suppresses repeats; it does not hide
    // ongoing state (section 22).
    expect(alertStateAt(acknowledged!, new Date())).toBe('acknowledged');
    expect(acknowledged?.resolvedAt).toBeNull();

    await resolveAlertsAbout(harness.db, {
      businessId,
      kind: 'oversold',
      subjectKey: 'item:gate',
      evidence: { rechecked: true, shortage: 0 },
    });

    const [resolved] = await harness.db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, alert.alertId));

    expect(alertStateAt(resolved!, new Date())).toBe('resolved');
    expect(resolved?.resolvedEvidence).not.toBeNull();
  });

  it('cannot be resolved without the evidence that proved it', async () => {
    const { businessId } = await shop();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'mapping_blocked',
      subjectKey: 'mapping:gate',
      summary: 'stopped synchronizing',
    });

    await expect(
      harness.db
        .update(operatorAlerts)
        .set({ resolvedAt: new Date() })
        .where(eq(operatorAlerts.id, alert.alertId)),
    ).rejects.toThrow();
  });

  it('comes back by itself after a snooze lapses', async () => {
    const { businessId, userId } = await shop();
    const now = new Date();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'restock_pending',
      subjectKey: 'item:gate-snooze',
      summary: 'waiting to go back on sale',
    });

    await snoozeAlert(harness.db, {
      businessId,
      alertId: alert.alertId,
      actorUserId: userId,
      until: new Date(now.getTime() + 3_600_000),
      now,
    });

    const [row] = await harness.db
      .select()
      .from(operatorAlerts)
      .where(eq(operatorAlerts.id, alert.alertId));

    expect(alertStateAt(row!, now)).toBe('snoozed');
    // Nobody has to remember to undo it.
    expect(alertStateAt(row!, new Date(now.getTime() + 7_200_000))).toBe('open');
  });
});

describe('nobody is told something their permissions do not cover', () => {
  it('routes an oversell to an owner and not to an ungranted operator', async () => {
    const permitted = await shop('owner');
    const refused = await shop('operator');

    for (const { businessId } of [permitted, refused]) {
      await raiseAlert(harness.db, {
        businessId,
        kind: 'oversold',
        severity: 'critical',
        subjectKey: 'item:routing',
        summary: 'short',
      });
    }

    await announceNewAlerts(ports());

    const told = async (businessId: string) =>
      harness.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.businessId, businessId));

    expect((await told(permitted.businessId)).length).toBeGreaterThan(0);
    expect(await told(refused.businessId)).toHaveLength(0);
  });
});

describe('the same notification is never sent twice', () => {
  it('holds across repeated sweeps', async () => {
    const { businessId, email } = await shop();
    await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:once',
      summary: 'short',
    });

    for (let pass = 0; pass < 4; pass += 1) {
      await announceNewAlerts(ports());
      await sendPendingEmail(ports());
    }

    expect(mailer.sent.filter((message) => message.to === email)).toHaveLength(1);
  });
});

describe('quiet hours hold the ordinary and not the dangerous', () => {
  it('defers a dead-lettered job and does not defer an oversell', async () => {
    const { businessId } = await shop();
    await saveBusinessSettings(harness.db, businessId, {
      quietHoursStart: '00:00',
      quietHoursEnd: '23:59',
    });

    const ordinary = await raiseAlert(harness.db, {
      businessId,
      kind: 'job_dead_lettered',
      severity: 'error',
      subjectKey: 'job:quiet',
      summary: 'gave up',
    });
    const dangerous = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:quiet',
      summary: 'short',
    });

    await announceNewAlerts(ports());

    const statusOf = async (alertId: string) => {
      const rows = await harness.db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.alertId, alertId));
      return rows.find((row) => row.channel === 'email')?.status;
    };

    expect(await statusOf(ordinary.alertId)).toBe('deferred');
    expect(await statusOf(dangerous.alertId)).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('health reports what it could not tell', () => {
  it('never reports a volume it could not measure as healthy', async () => {
    const storage = (
      await assessHealth({ db: harness.db, pool: harness.pool, dataRoot: '/nowhere-at-all' })
    ).checks.find((check) => check.name === 'storage');

    expect(storage?.status).toBe('degraded');
  });

  it('files an installation alert and withdraws it on recovery', async () => {
    const failing = {
      status: 'failing' as const,
      observedAt: new Date(),
      checks: [{ name: 'queue', status: 'failing' as const, detail: 'oldest 2h' }],
    };

    await watchInstallation(harness.db, failing);
    const raised = await openInstallationAlerts(harness.db);
    expect(raised.some((alert) => alert.kind === 'queue_stalled')).toBe(true);

    await watchInstallation(harness.db, {
      ...failing,
      status: 'ok',
      checks: [{ name: 'queue', status: 'ok', detail: 'nothing is waiting' }],
    });

    const after = await openInstallationAlerts(harness.db);
    expect(after.some((alert) => alert.kind === 'queue_stalled')).toBe(false);
  });

  it('notices that no backup has ever been taken', async () => {
    await harness.db.delete(backupRuns);

    const backups = (await assessHealth({ db: harness.db, pool: harness.pool })).checks.find(
      (check) => check.name === 'backups',
    );

    expect(backups?.status).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('retention keeps evidence and drops what may be erased', () => {
  it('never deletes an outstanding alert, however old', async () => {
    const { businessId } = await shop();

    await harness.db.insert(operatorAlerts).values({
      businessId,
      kind: 'oversold',
      subjectKey: 'item:ancient',
      summary: 'nobody dealt with this',
      firstSeenAt: new Date(Date.now() - 1000 * 86_400_000),
      lastSeenAt: new Date(Date.now() - 1000 * 86_400_000),
    });

    await sweepBusiness(harness.db, businessId);

    expect(
      await harness.db
        .select()
        .from(operatorAlerts)
        .where(eq(operatorAlerts.businessId, businessId)),
    ).toHaveLength(1);
  });

  it('will not keep a raw provider body indefinitely whatever is configured', () => {
    // Section 13's erasure obligations cannot reach a body that was kept
    // forever, so "keep everything" is refused for raw classes even when the
    // history policy allows it.
    const forever = { historyDays: 0, rawEventDays: 0 };

    expect(cutoffFor('notification_deliveries', forever, new Date())).toBeNull();
    expect(cutoffFor('webhook_deliveries', forever, new Date())).not.toBeNull();
    expect(cutoffFor('processed_events', DEFAULT_POLICY, new Date())).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The deliverables that are files rather than behaviours
// ---------------------------------------------------------------------------

function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8');
}

describe('the operations deliverables exist and say what they must', () => {
  it('ships a production image that carries no package manager and no source', () => {
    const dockerfile = read('Dockerfile');

    // The runtime stage deletes npm and corepack. Not tidiness: npm's own
    // vendored tree is where every image-scan finding came from, for code that
    // never executes here.
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/node_modules\/npm/u);
    expect(dockerfile).toMatch(/USER \$\{APP_UID\}:\$\{APP_GID\}/u);
    // One image for web, worker, and migrations, with distinct commands.
    expect(dockerfile).toMatch(/apps\/web\/server\.js/u);
    expect(dockerfile).toMatch(/apps\/worker\/dist/u);
    expect(dockerfile).toMatch(/packages\/db\/migrations/u);
  });

  it('never lets the build context sweep up a real .env or Compose file', () => {
    const ignored = read('.dockerignore');

    expect(ignored).toMatch(/^\.env$/mu);
    expect(ignored).toMatch(/^docker-compose\.yml$/mu);
    expect(ignored).toMatch(/^data\/$/mu);
  });

  it('publishes for both architectures, signed, with provenance and an SBOM', () => {
    const release = read('.github', 'workflows', 'release.yml');

    expect(release).toMatch(/platforms: linux\/amd64,linux\/arm64/u);
    expect(release).toMatch(/cosign sign/u);
    expect(release).toMatch(/sbom: true/u);
    expect(release).toMatch(/provenance: mode=max/u);
    // Only on a tag or a deliberate dispatch: no path from a merge to a
    // published image.
    expect(release).not.toMatch(/on:\s*\n\s*push:\s*\n\s*branches/u);
  });

  it('scans dependencies and the image, on a schedule as well as on push', () => {
    const security = read('.github', 'workflows', 'security.yml');

    expect(security).toMatch(/pnpm audit --audit-level=high/u);
    expect(security).toMatch(/trivy/u);
    expect(security).toMatch(/schedule:/u);
  });

  it('keeps the database off the host network and the application unprivileged', () => {
    const compose = read('deploy', 'docker-compose.example.yml');

    expect(compose).toMatch(/no-new-privileges:true/u);
    expect(compose).toMatch(/cap_drop: \["ALL"\]/u);
    // Web publishes to loopback; nothing else publishes at all.
    expect(compose).toMatch(/127\.0\.0\.1:3000:3000/u);
    expect(compose.match(/^\s+ports:/gmu) ?? []).toHaveLength(2); // web, and the optional Caddy
    // Migrations are a one-shot service the application waits for.
    expect(compose).toMatch(/service_completed_successfully/u);
  });

  it('refuses to back up without a key held off this host', () => {
    const backup = read('scripts', 'backup.sh');

    expect(backup).toMatch(/EIM_BACKUP_PUBLIC_KEY/u);
    // The dump is encrypted in the same pipeline, so no plaintext reaches disk.
    expect(backup).toMatch(/pg_dump[\s\S]{0,400}\|\s*[\s\S]{0,200}age/u);
    expect(backup).toMatch(/sha256sum/u);
  });

  it('refuses to restore over a live database without a way back', () => {
    const restore = read('scripts', 'restore.sh');

    expect(restore).toMatch(/--i-mean-it/u);
    expect(restore).toMatch(/No successful backup in the last hour/u);
    // The checksum is checked before anything is decrypted.
    expect(restore.indexOf('does not match its manifest')).toBeLessThan(
      restore.indexOf('drop database if exists'),
    );
  });

  it('checks before it upgrades, and keeps the previous release', () => {
    const upgrade = read('scripts', 'upgrade.sh');

    expect(upgrade).toMatch(/--preflight-only/u);
    expect(upgrade).toMatch(/--rollback/u);
    expect(upgrade).toMatch(/backup\.sh"? --kind pre_upgrade/u);
    // Readiness, not liveness.
    expect(upgrade).toMatch(/api\/ready/u);
    expect(upgrade).not.toMatch(/api\/health/u);
  });

  it('documents every runbook section 27 names as tested', () => {
    for (const page of [
      'install.md',
      'upgrade.md',
      'backup-and-restore.md',
      'server-migration.md',
      'health-and-alerts.md',
    ]) {
      expect(existsSync(join(REPO, 'docs', 'operations', page))).toBe(true);
    }

    expect(existsSync(join(REPO, 'docs', 'security', 'threat-model.md'))).toBe(true);

    // Section 27: a command that mutates or restores states its prerequisites,
    // its irreversible effects, and its rollback.
    const restore = read('docs', 'operations', 'backup-and-restore.md');
    expect(restore).toMatch(/Prerequisites/u);
    expect(restore).toMatch(/Irreversible/u);
    expect(restore).toMatch(/Rollback/u);
  });

  it('generates its configuration reference from the schema', () => {
    // A setting added without documentation is a setting no self-hoster can
    // discover, so the two are the same artifact rather than two.
    const example = read('.env.example');

    expect(example).toMatch(/EIM_METRICS_TOKEN=/u);
    expect(example).toMatch(/EIM_DATA_ROOT=/u);
    expect(example).not.toMatch(/^EIM_SESSION_SECRET=[A-Za-z0-9+/]{20,}$/mu);
  });

  it('has an accessibility audit that runs on every change', () => {
    expect(existsSync(join(REPO, 'apps', 'web', 'src', 'accessibility.test.ts'))).toBe(true);
  });

  it('has a migration for every schema change this milestone made', () => {
    const migrations = readdirSync(join(REPO, 'packages', 'db', 'migrations'));

    for (const expected of [
      '0025_alert_lifecycle.sql',
      '0026_notification_routing.sql',
      '0027_notification_deliveries.sql',
      '0028_alert_destinations.sql',
      '0029_retention.sql',
      '0030_backup_runs.sql',
    ]) {
      expect(migrations).toContain(expected);
    }
  });
});
