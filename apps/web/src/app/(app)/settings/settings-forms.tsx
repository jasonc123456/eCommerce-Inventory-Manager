'use client';

import { useActionState } from 'react';

import { Button, Field, Notice, Select, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import {
  saveBusinessDetailsAction,
  saveRetentionAction,
  type SettingsFormState,
} from '../../actions/settings';

const IDLE: SettingsFormState = { status: 'idle' };

function Message({ state }: { state: SettingsFormState }) {
  if (state.message === undefined) {
    return null;
  }

  return <Notice tone={state.status === 'error' ? 'error' : 'success'}>{state.message}</Notice>;
}

const ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Brisbane',
  'Pacific/Auckland',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
] as const;

export function BusinessDetailsForm({
  csrf,
  businessId,
  name,
  timezone,
}: {
  csrf: string;
  businessId: string;
  name: string;
  timezone: string;
}) {
  const [state, submit, pending] = useActionState(saveBusinessDetailsAction, IDLE);

  return (
    <form action={submit} className="flex max-w-md flex-col gap-4">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field label="Name">
        <TextInput name="name" required maxLength={120} defaultValue={name} />
      </Field>

      <Field
        label="Time zone"
        hint="Quiet hours and the nightly reconciliation run on this clock, not the server's."
      >
        {/* The stored zone is included even when it is outside the short list,
            so opening this screen cannot silently change a setting somebody
            chose deliberately. */}
        <Select name="timezone" defaultValue={timezone}>
          {(ZONES as readonly string[]).includes(timezone) ? null : (
            <option value={timezone}>{timezone}</option>
          )}
          {ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace('_', ' ')}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function RetentionForm({
  csrf,
  businessId,
  historyDays,
  rawEventDays,
}: {
  csrf: string;
  businessId: string;
  historyDays: number;
  rawEventDays: number;
}) {
  const [state, submit, pending] = useActionState(saveRetentionAction, IDLE);

  return (
    <form action={submit} className="flex max-w-md flex-col gap-4">
      <Message state={state} />
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field
        label="Keep history for"
        hint="Days. Alerts, deliveries, suggestions, and pilot measurements. Zero keeps them forever."
      >
        <TextInput
          name="historyDays"
          inputMode="numeric"
          required
          defaultValue={String(historyDays)}
        />
      </Field>

      <Field
        label="Keep raw provider bodies for"
        hint="Days, 1 to 90. These hold buyer data, so they always expire — this one cannot be zero."
      >
        <TextInput
          name="rawEventDays"
          inputMode="numeric"
          required
          defaultValue={String(rawEventDays)}
        />
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
