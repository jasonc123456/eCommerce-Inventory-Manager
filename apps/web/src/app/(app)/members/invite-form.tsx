'use client';

import { useActionState } from 'react';

import { inviteMemberAction, type MemberFormState } from '../../actions/members';
import { Button, Field, Notice, TextInput } from '../../../components/form';
import { CSRF_FIELD } from '../../../lib/csrf-field';

/**
 * Inviting somebody.
 *
 * The role is chosen here rather than after acceptance, because section 20's
 * invitation carries the proposed role and permissions with it: acceptance then
 * grants what the owner chose, not what a template happens to say later.
 */
export function InviteForm({ csrf, businessId }: { csrf: string; businessId: string }) {
  const [state, action, pending] = useActionState<MemberFormState, FormData>(inviteMemberAction, {
    status: 'idle',
  });

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name={CSRF_FIELD} value={csrf} />
      <input type="hidden" name="businessId" value={businessId} />

      <Field label="Email address">
        <TextInput
          name="email"
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </Field>

      <Field label="Role" hint="A starting set of permissions. It can be changed afterwards.">
        <select
          name="role"
          defaultValue="viewer"
          className="rounded-md border border-[var(--border-strong)] bg-transparent px-3 py-2 text-base"
        >
          <option value="viewer">Viewer</option>
          <option value="operator">Operator</option>
          <option value="manager">Manager</option>
          <option value="owner">Owner</option>
        </select>
      </Field>

      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
      )}

      <Button type="submit" disabled={pending}>
        Send invitation
      </Button>
    </form>
  );
}
