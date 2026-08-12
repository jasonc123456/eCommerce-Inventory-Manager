import type { InstallationPermission } from '@eim/authz';
import {
  installationAdministratorPermissions,
  installationAdministrators,
  type Database,
} from '@eim/db';
import { assessHealth, type HealthReport } from '@eim/health';
import { openInstallationAlerts } from '@eim/notifications';
import { and, eq } from 'drizzle-orm';

import { runtime } from './runtime';

/**
 * The health surface, wired for the web tier (section 22).
 *
 * Section 22 calls this an "authenticated detailed health UI/API", and the
 * authentication is installation administration rather than business
 * membership. That is not a convenience: a stalled queue and a filling disk
 * belong to the installation, and showing them to whoever happens to own a
 * business would tell one tenant about the machine every other tenant is also
 * running on.
 */

export interface InstallationSubject {
  readonly userId: string;
  readonly permissions: ReadonlySet<InstallationPermission>;
}

/**
 * Who this user is at the installation level, or null.
 *
 * Null for the overwhelming majority of users, including every business owner
 * who was never made an administrator. Section 5 is explicit that installation
 * administration "is a separate authority from business ownership" and that
 * "holding one of these never confers business membership" — this is the other
 * direction of the same rule.
 */
export async function loadInstallationSubject(
  db: Database,
  userId: string,
): Promise<InstallationSubject | null> {
  const rows = await db
    .select({ status: installationAdministrators.status })
    .from(installationAdministrators)
    .where(
      and(
        eq(installationAdministrators.userId, userId),
        eq(installationAdministrators.status, 'active'),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const granted = await db
    .select({ permission: installationAdministratorPermissions.permission })
    .from(installationAdministratorPermissions)
    .where(eq(installationAdministratorPermissions.userId, userId));

  return {
    userId,
    permissions: new Set(granted.map((row) => row.permission)),
  };
}

export interface HealthView {
  readonly report: HealthReport;
  /** Installation problems nobody has resolved. */
  readonly alerts: Awaited<ReturnType<typeof openInstallationAlerts>>;
}

/**
 * Everything the health screen shows.
 *
 * The data root comes from configuration rather than being discovered, because
 * the thing worth watching is the volume section 23 puts durable data on, and
 * a process that measured its own working directory would report the container
 * filesystem — which is ephemeral, always roomy, and never the problem.
 */
export async function loadHealth(): Promise<HealthView> {
  const { config, db, pool } = runtime();

  const report = await assessHealth({
    db,
    pool,
    ...(config.EIM_APP_VERSION === undefined ? {} : { appVersion: config.EIM_APP_VERSION }),
    ...(config.EIM_DATA_ROOT === undefined ? {} : { dataRoot: config.EIM_DATA_ROOT }),
  });

  return { report, alerts: await openInstallationAlerts(db) };
}
