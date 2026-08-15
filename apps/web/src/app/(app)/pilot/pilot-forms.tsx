'use client';

import { useActionState } from 'react';

import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import {
  classifyIncidentAction,
  enrollAction,
  recordDrillAction,
  setStageAction,
  unenrollAction,
  type PilotFormState,
} from '../../actions/pilot';

/**
 * The controls on the pilot screen (sections 1, 21, 36).
 *
 * There is no button here that declares the pilot passed, and its absence is
 * the design. The verdict is computed from evidence; a control that overrode it
 * would make the thirty-day bar a formality.
 *
 * The stage list is fixed and ordered, and moving between stages is a single
 * choice rather than a wizard, because the operator making it already knows
 * which one they want — they have been reading the withheld-write log to decide.
 */

const IDLE: PilotFormState = { status: 'idle' };

const SELECT_CLASS = 'rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20';

function Message({ state }: { state: PilotFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

const STAGES = [
  { value: 'observe', label: 'Observe — compute everything, send nothing' },
  { value: 'single', label: 'Single — write one enrolled mapping' },
  { value: 'cohort', label: 'Cohort — write up to a ceiling' },
  { value: 'full', label: 'Full — write everything' },
] as const;

export function StageForm({
  csrf,
  businessId,
  stage,
  cohortLimit,
}: {
  csrf: string;
  businessId: string;
  stage: string;
  cohortLimit: number | null;
}) {
  const [state, submit, pending] = useActionState(setStageAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Stage">
          <select name="stage" defaultValue={stage} className={SELECT_CLASS}>
            {STAGES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Cohort ceiling">
          <TextInput
            name="cohortLimit"
            inputMode="numeric"
            defaultValue={cohortLimit === null ? '' : String(cohortLimit)}
            placeholder="mappings"
          />
        </Field>

        <Field label="Why (optional)">
          <TextInput name="note" maxLength={200} placeholder="what this stage is testing" />
        </Field>

        <Button type="submit" disabled={pending}>
          Change stage
        </Button>
      </div>
    </form>
  );
}

export function EnrollmentControls({
  csrf,
  businessId,
  mappingId,
  enrolled,
}: {
  csrf: string;
  businessId: string;
  mappingId: string;
  enrolled: boolean;
}) {
  const [enrollState, addOne, addPending] = useActionState(enrollAction, IDLE);
  const [removeState, removeOne, removePending] = useActionState(unenrollAction, IDLE);

  return (
    <div className="flex flex-col gap-2">
      <Message state={enrollState} />
      <Message state={removeState} />

      <form action={enrolled ? removeOne : addOne}>
        <input type="hidden" name={CSRF_FIELD} value={csrf} />
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="mappingId" value={mappingId} />
        <Button
          type="submit"
          variant={enrolled ? 'secondary' : 'primary'}
          disabled={addPending || removePending}
        >
          {enrolled ? 'Remove from pilot' : 'Add to pilot'}
        </Button>
      </form>
    </div>
  );
}

const CLASSIFICATIONS = [
  { value: 'not_a_defect', label: 'Not a defect — no interval would have prevented it' },
  { value: 'defect', label: 'A defect — this application caused it' },
  { value: 'external', label: 'The provider’s — it sold against a quantity it had been told' },
] as const;

export function ClassifyForm({
  csrf,
  businessId,
  incidentId,
}: {
  csrf: string;
  businessId: string;
  incidentId: string;
}) {
  const [state, submit, pending] = useActionState(classifyIncidentAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="incidentId" value={incidentId} />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="What kind was it">
          <select name="classification" defaultValue="not_a_defect" className={SELECT_CLASS}>
            {CLASSIFICATIONS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Required, here and in the database. A classification with no finding
            is an opinion, and section 36 asks for closure. */}
        <Field label="What you found">
          <TextInput name="finding" required maxLength={500} placeholder="why you decided that" />
        </Field>

        <Field label="What was done (optional)">
          <TextInput name="resolution" maxLength={500} />
        </Field>

        <Button type="submit" disabled={pending}>
          Close it
        </Button>
      </div>
    </form>
  );
}

const DRILLS = [
  { value: 'outage_recovery', label: 'Recovered from a 24-hour outage' },
  { value: 'clean_install', label: 'Installed cleanly from the documentation' },
  { value: 'server_migration', label: 'Migrated to another server' },
] as const;

export function DrillForm({ csrf }: { csrf: string }) {
  const [state, submit, pending] = useActionState(recordDrillAction, IDLE);

  return (
    <form action={submit} className="flex flex-col gap-3">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Drill">
          <select name="kind" defaultValue="outage_recovery" className={SELECT_CLASS}>
            {DRILLS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Did it work">
          <select name="succeeded" defaultValue="yes" className={SELECT_CLASS}>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>

        <Field label="What happened">
          <TextInput
            name="summary"
            required
            maxLength={500}
            placeholder="what you did, and what you saw"
          />
        </Field>

        <Field label="Evidence (optional)">
          <TextInput name="evidenceRef" maxLength={200} placeholder="a log, an issue, a commit" />
        </Field>

        <Button type="submit" disabled={pending}>
          Record it
        </Button>
      </div>
    </form>
  );
}
