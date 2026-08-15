'use server';

import { authorize } from '@eim/authz';
import type { PilotClassification, PilotDrillKind, PilotStage } from '@eim/db';
import { classifyIncident, enroll, recordDrill, setStage, unenroll } from '@eim/pilot';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { field, trimmedField } from '../../lib/forms';
import { loadInstallationSubject } from '../../lib/health';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * Running a controlled pilot from a browser (sections 1, 36).
 *
 * Five actions, and what is missing again says the most.
 *
 * Nothing here declares the pilot passed. `assessPilot` computes that from
 * evidence, and a button that overrode it would make the thirty-day bar a
 * formality — which is precisely what a bar exists not to be.
 *
 * Nothing here backdates a pilot's start. `pilot_started_at` is stamped by the
 * first transition out of `observe`, and a start date somebody can type is a
 * thirty-day pilot that can be declared over on day three.
 *
 * And nothing here classifies an incident without a finding. The database
 * refuses one, this refuses one, and the reason is the same in both places: an
 * unattributed verdict on whether the product oversold somebody is worse than no
 * verdict at all.
 */

export interface PilotFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
}

const NOT_A_MEMBER: PilotFormState = {
  status: 'error',
  message: 'You are not a member of that business.',
};

const FORBIDDEN: PilotFormState = {
  status: 'error',
  message: 'You do not have permission to do that.',
};

/** Resolves the caller and checks one business permission. */
async function authorizedFor(
  form: FormData,
  permission: 'manage_integrations' | 'resolve_inventory_conflicts',
): Promise<
  | { readonly ok: true; readonly businessId: string; readonly userId: string }
  | { readonly ok: false; readonly state: PilotFormState }
> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { ok: false, state: NOT_A_MEMBER };
  }

  if (!authorize(subject, permission).allowed) {
    return { ok: false, state: FORBIDDEN };
  }

  assertCsrf(form, context.session);

  return { ok: true, businessId, userId: context.user.id };
}

const STAGES: readonly PilotStage[] = ['observe', 'single', 'cohort', 'full'];

export async function setStageAction(
  _previous: PilotFormState,
  form: FormData,
): Promise<PilotFormState> {
  const caller = await authorizedFor(form, 'manage_integrations');

  if (!caller.ok) {
    return caller.state;
  }

  const stage = field(form, 'stage') as PilotStage;

  if (!STAGES.includes(stage)) {
    return { status: 'error', message: 'That is not a stage.' };
  }

  const rawLimit = trimmedField(form, 'cohortLimit');
  const cohortLimit = rawLimit === '' ? undefined : Number(rawLimit);

  if (cohortLimit !== undefined && (!Number.isInteger(cohortLimit) || cohortLimit < 1)) {
    return { status: 'error', message: 'A cohort ceiling is a whole number of mappings.' };
  }

  const { db } = runtime();
  const result = await setStage(db, {
    businessId: caller.businessId,
    stage,
    actorUserId: caller.userId,
    ...(cohortLimit === undefined ? {} : { cohortLimit }),
    ...(trimmedField(form, 'note') === '' ? {} : { note: trimmedField(form, 'note') }),
  });

  revalidatePath('/pilot');

  return result.changed
    ? {
        status: 'done',
        message:
          stage === 'observe'
            ? 'Observing. Targets are computed and nothing is sent.'
            : `Now at ${stage}.`,
      }
    : { status: 'error', message: result.reason };
}

export async function enrollAction(
  _previous: PilotFormState,
  form: FormData,
): Promise<PilotFormState> {
  const caller = await authorizedFor(form, 'manage_integrations');

  if (!caller.ok) {
    return caller.state;
  }

  const { db } = runtime();
  const result = await enroll(db, {
    businessId: caller.businessId,
    mappingId: field(form, 'mappingId'),
    actorUserId: caller.userId,
  });

  revalidatePath('/pilot');

  return result.enrolled
    ? { status: 'done', message: `Enrolled. ${String(result.total)} mapping(s) will be written.` }
    : { status: 'error', message: result.reason };
}

export async function unenrollAction(
  _previous: PilotFormState,
  form: FormData,
): Promise<PilotFormState> {
  const caller = await authorizedFor(form, 'manage_integrations');

  if (!caller.ok) {
    return caller.state;
  }

  const { db } = runtime();
  const removed = await unenroll(db, {
    businessId: caller.businessId,
    mappingId: field(form, 'mappingId'),
  });

  revalidatePath('/pilot');

  return removed
    ? { status: 'done', message: 'Removed. Writes to it will be withheld and recorded.' }
    : { status: 'error', message: 'It was not enrolled.' };
}

const CLASSIFICATIONS: readonly PilotClassification[] = ['defect', 'not_a_defect', 'external'];

export async function classifyIncidentAction(
  _previous: PilotFormState,
  form: FormData,
): Promise<PilotFormState> {
  const caller = await authorizedFor(form, 'resolve_inventory_conflicts');

  if (!caller.ok) {
    return caller.state;
  }

  const classification = field(form, 'classification') as Exclude<
    PilotClassification,
    'unreviewed'
  >;

  if (!CLASSIFICATIONS.includes(classification)) {
    return { status: 'error', message: 'Choose what kind of incident this was.' };
  }

  const { db } = runtime();
  const result = await classifyIncident(db, {
    businessId: caller.businessId,
    incidentId: field(form, 'incidentId'),
    classification,
    finding: trimmedField(form, 'finding'),
    ...(trimmedField(form, 'resolution') === ''
      ? {}
      : { resolution: trimmedField(form, 'resolution') }),
    actorUserId: caller.userId,
  });

  revalidatePath('/pilot');

  return result.classified
    ? { status: 'done', message: 'Closed.' }
    : { status: 'error', message: result.reason };
}

const DRILL_KINDS: readonly PilotDrillKind[] = [
  'outage_recovery',
  'clean_install',
  'server_migration',
];

/**
 * Records a drill.
 *
 * Installation-scoped, and gated on installation administration rather than on
 * any business permission. An outage drill and a clean install are things done
 * to the machine; a business owner who could record one would be attesting to
 * something they did not do on a host they do not administer.
 */
export async function recordDrillAction(
  _previous: PilotFormState,
  form: FormData,
): Promise<PilotFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const subject = await loadInstallationSubject(db, context.user.id);

  if (subject?.permissions.has('manage_installation_settings') !== true) {
    return {
      status: 'error',
      message: 'Recording a drill is an installation-administration task.',
    };
  }

  assertCsrf(form, context.session);

  const kind = field(form, 'kind') as PilotDrillKind;

  if (!DRILL_KINDS.includes(kind)) {
    return { status: 'error', message: 'That is not a drill this pilot records.' };
  }

  const summary = trimmedField(form, 'summary');

  if (summary.length === 0) {
    return { status: 'error', message: 'Say what was done and what happened.' };
  }

  await recordDrill(db, {
    kind,
    // A failed drill is evidence too, and the most useful kind: it is the
    // failure that happened while somebody was watching.
    succeeded: field(form, 'succeeded') === 'yes',
    summary,
    ...(trimmedField(form, 'evidenceRef') === ''
      ? {}
      : { evidenceRef: trimmedField(form, 'evidenceRef') }),
    actorUserId: context.user.id,
  });

  revalidatePath('/pilot');
  return { status: 'done', message: 'Recorded.' };
}
