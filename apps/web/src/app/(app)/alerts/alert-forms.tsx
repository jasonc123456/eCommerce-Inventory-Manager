'use client';

import { useActionState } from 'react';

import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import {
  acknowledgeAlertAction,
  savePreferenceAction,
  saveQuietHoursAction,
  snoozeAlertAction,
  type AlertFormState,
} from '../../actions/alerts';

/**
 * The controls on the alerts screen (sections 21, 22).
 *
 * There is no "resolve" button anywhere in this file, and its absence is the
 * design rather than an omission. Section 22 auto-resolves an alert "only when
 * a fresh check proves recovery" — a resolution is something the world does and
 * a check observes. A button that closed an oversell alert would let somebody
 * make the shop look healthy while it was still selling stock it did not have.
 *
 * The snooze durations are a fixed list rather than a date field for the same
 * reason at a smaller scale: a free instant would let somebody snooze a
 * critical alert until next year, which is a resolution wearing a snooze's
 * clothes.
 */

const IDLE: AlertFormState = { status: 'idle' };

const SNOOZE_CHOICES = [1, 4, 8, 24] as const;

function Message({ state }: { state: AlertFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>;
}

export function AlertControls({
  csrf,
  businessId,
  alertId,
  acknowledged,
}: {
  csrf: string;
  businessId: string;
  alertId: string;
  acknowledged: boolean;
}) {
  const [ackState, acknowledge, ackPending] = useActionState(acknowledgeAlertAction, IDLE);
  const [snoozeState, snooze, snoozePending] = useActionState(snoozeAlertAction, IDLE);

  return (
    <div className="flex flex-col gap-3">
      <Message state={ackState} />
      <Message state={snoozeState} />

      <div className="flex flex-wrap items-end gap-3">
        {acknowledged ? null : (
          <form action={acknowledge} className="flex items-end gap-2">
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="alertId" value={alertId} />
            <Field label="Note (optional)">
              <TextInput name="note" maxLength={200} placeholder="what you did about it" />
            </Field>
            <Button type="submit" disabled={ackPending}>
              I have seen this
            </Button>
          </form>
        )}

        <form action={snooze} className="flex items-end gap-2">
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="alertId" value={alertId} />
          <Field label="Quiet for">
            <select
              name="hours"
              defaultValue="4"
              className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
            >
              {SNOOZE_CHOICES.map((hours) => (
                <option key={hours} value={hours}>
                  {hours} hour{hours === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary" disabled={snoozePending}>
            Not now
          </Button>
        </form>
      </div>
    </div>
  );
}

const FLOORS = [
  { value: 'none', label: 'Never email me' },
  { value: 'critical', label: 'Only critical' },
  { value: 'error', label: 'Errors and critical (default)' },
  { value: 'warning', label: 'Warnings and above' },
  { value: 'info', label: 'Everything' },
] as const;

export function PreferenceForm({
  csrf,
  businessId,
  emailMinSeverity,
  optedInKinds,
  mutedKinds,
  kinds,
}: {
  csrf: string;
  businessId: string;
  emailMinSeverity: string;
  optedInKinds: readonly string[];
  mutedKinds: readonly string[];
  kinds: readonly string[];
}) {
  const [state, save, pending] = useActionState(savePreferenceAction, IDLE);

  return (
    <form action={save} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <Message state={state} />

      <Field
        label="Email me about"
        hint="Whatever you choose, everything still appears on this screen. Critical alerts are always emailed unless you switch email off entirely."
      >
        <select
          name="emailMinSeverity"
          defaultValue={emailMinSeverity}
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        >
          {FLOORS.map((floor) => (
            <option key={floor.value} value={floor.value}>
              {floor.label}
            </option>
          ))}
        </select>
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Exceptions</legend>
        <p className="text-sm text-slate-500">
          Always email me about these, even below the level above; or never, even above it. A kind
          cannot be both.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {kinds.map((kind) => (
            <li key={kind} className="flex flex-wrap items-center gap-4">
              <span className="min-w-56">{kind.replace(/_/gu, ' ')}</span>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="optIn"
                  value={kind}
                  defaultChecked={optedInKinds.includes(kind)}
                />
                always
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="mute"
                  value={kind}
                  defaultChecked={mutedKinds.includes(kind)}
                />
                never
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div>
        <Button type="submit" disabled={pending}>
          Save my preferences
        </Button>
      </div>
    </form>
  );
}

export function QuietHoursForm({
  csrf,
  businessId,
  start,
  end,
  timezone,
}: {
  csrf: string;
  businessId: string;
  start: string;
  end: string;
  timezone: string;
}) {
  const [state, save, pending] = useActionState(saveQuietHoursAction, IDLE);

  return (
    <form action={save} className="flex flex-col gap-4">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />
      <Message state={state} />

      <p className="text-sm text-slate-500">
        Times are read in this business’s own timezone, {timezone}. Email waits until the window
        ends; oversells and unsafe drift do not wait. Leave both blank for no quiet hours.
      </p>

      <div className="flex flex-wrap gap-4">
        <Field label="Quiet from">
          <TextInput type="time" name="quietHoursStart" defaultValue={start} />
        </Field>
        <Field label="Until">
          <TextInput type="time" name="quietHoursEnd" defaultValue={end} />
        </Field>
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          Save quiet hours
        </Button>
      </div>
    </form>
  );
}
