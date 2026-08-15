'use client';

import { useActionState } from 'react';

import { Button, Field, Notice, Select, TextInput } from '../../../../components/form';
import { CSRF_FIELD } from '../../../../lib/csrf-field';
import { createBusinessAction, type BusinessFormState } from '../../../actions/businesses';

/**
 * The form that creates a workspace.
 *
 * Two fields, and the second one matters more than it looks. Quiet hours and the
 * nightly reconciliation window are computed in the shop's own zone (D-136), so
 * a business created with the wrong one sends alerts in the middle of somebody's
 * night and runs its sweep during trading. It is asked for here rather than
 * defaulted quietly and corrected later in a settings screen nobody visits.
 *
 * The zone list is short and regional rather than the full IANA database: a
 * self-hosted shop is somewhere, and six hundred options is a worse question
 * than twenty. Anything the platform recognizes is still accepted by the
 * service, so a deployment outside this list is a one-line change and not a
 * refusal.
 */

const IDLE: BusinessFormState = { status: 'idle' };

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

export function CreateBusinessForm({ csrf, guess }: { csrf: string; guess: string }) {
  const [state, submit, pending] = useActionState(createBusinessAction, IDLE);

  return (
    <form action={submit} className="flex max-w-md flex-col gap-4">
      {state.message === undefined ? null : <Notice tone="error">{state.message}</Notice>}

      <input type="hidden" name={CSRF_FIELD} value={csrf} />

      <Field label="Name" hint="What you call this shop. You can change it later.">
        <TextInput name="name" required maxLength={120} placeholder="Widgets Ltd" />
      </Field>

      <Field label="Time zone" hint="Quiet hours and the nightly reconciliation run on this clock.">
        <Select name="timezone" defaultValue={guess}>
          {ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace('_', ' ')}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create business'}
        </Button>
      </div>
    </form>
  );
}
