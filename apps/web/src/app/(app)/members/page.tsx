import { authorize } from '@eim/authz';
import { invitations } from '@eim/db';
import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import {
  cancelInvitationAction,
  changeRoleAction,
  listMembers,
  removeMemberAction,
  setMembershipStatusAction,
} from '../../actions/members';
import { Button, Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { CSRF_FIELD } from '../../../lib/csrf-field';
import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { InviteForm } from './invite-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Members' };

/**
 * Who can reach this business (sections 5 and 20).
 *
 * The page hides what the caller cannot do, and every action re-checks it
 * server-side anyway. Section 5 is explicit that the UI never filters as a
 * substitute for the server check — hiding a button is a courtesy to the person
 * using the screen, not a control on the person attacking it.
 */
export default async function MembersPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const { memberships: service } = identity();

  const businesses = await service.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Members</h1>
        <Notice tone="info">
          You are not a member of any business, so there is nobody to manage.
        </Notice>
      </main>
    );
  }

  const subject = await service.loadSubject(db, businessId, context.user.id);
  const canManage = subject !== null && authorize(subject, 'manage_members').allowed;

  const [members, outstanding] = await Promise.all([
    listMembers(businessId),
    db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.businessId, businessId),
          isNull(invitations.acceptedAt),
          isNull(invitations.cancelledAt),
        ),
      ),
  ]);

  const token = csrfToken(context.session);
  const business = businesses.find((entry) => entry.businessId === businessId);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Members</h1>
        <p className="text-sm opacity-70">
          Who can reach {business?.name ?? 'this business'}. Access to one business never grants
          access to another.
        </p>
      </header>

      <Card title={`${String(members.length)} ${members.length === 1 ? 'member' : 'members'}`}>
        <ul className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
          {members.map((member) => {
            const isSelf = member.userId === context.user.id;

            return (
              <li key={member.membershipId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">
                    {member.displayName ?? member.email}
                    {isSelf ? <span className="ml-2 text-xs opacity-70">you</span> : null}
                  </span>
                  <span className="text-xs opacity-70">
                    {member.email} · {member.role}
                    {member.status === 'suspended' ? ' · suspended' : ''}
                  </span>
                </div>

                {!canManage || isSelf ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    <form action={changeRoleAction} className="flex items-center gap-1">
                      <input type="hidden" name={CSRF_FIELD} value={token} />
                      <input type="hidden" name="businessId" value={businessId} />
                      <input type="hidden" name="membershipId" value={member.membershipId} />
                      <label htmlFor={`role-${member.membershipId}`} className="sr-only">
                        Role for {member.email}
                      </label>
                      <select
                        id={`role-${member.membershipId}`}
                        name="role"
                        defaultValue={member.role}
                        className="rounded-md border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="operator">Operator</option>
                        <option value="manager">Manager</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button type="submit" className="text-sm underline">
                        Apply
                      </button>
                    </form>

                    <form action={setMembershipStatusAction}>
                      <input type="hidden" name={CSRF_FIELD} value={token} />
                      <input type="hidden" name="businessId" value={businessId} />
                      <input type="hidden" name="membershipId" value={member.membershipId} />
                      <input
                        type="hidden"
                        name="intent"
                        value={member.status === 'suspended' ? 'reinstate' : 'suspend'}
                      />
                      <Button type="submit" variant="secondary">
                        {member.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                      </Button>
                    </form>

                    <form action={removeMemberAction}>
                      <input type="hidden" name={CSRF_FIELD} value={token} />
                      <input type="hidden" name="businessId" value={businessId} />
                      <input type="hidden" name="membershipId" value={member.membershipId} />
                      <Button type="submit" variant="secondary">
                        Remove
                      </Button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {outstanding.length === 0 ? null : (
        <Card title="Outstanding invitations">
          <ul className="flex flex-col divide-y divide-black/10 dark:divide-white/15">
            {outstanding.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{invitation.email}</span>
                  <span className="text-xs opacity-70">
                    {invitation.role} · expires {invitation.expiresAt.toISOString().slice(0, 16)}Z
                  </span>
                </div>

                {!canManage ? null : (
                  <form action={cancelInvitationAction}>
                    <input type="hidden" name={CSRF_FIELD} value={token} />
                    <input type="hidden" name="businessId" value={businessId} />
                    <input type="hidden" name="invitationId" value={invitation.id} />
                    <Button type="submit" variant="secondary">
                      Cancel
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canManage ? (
        <Card title="Invite somebody">
          <InviteForm csrf={token} businessId={businessId} />
        </Card>
      ) : (
        <Notice tone="info">
          You can see who has access but not change it. That needs the manage members permission.
        </Notice>
      )}
    </main>
  );
}
