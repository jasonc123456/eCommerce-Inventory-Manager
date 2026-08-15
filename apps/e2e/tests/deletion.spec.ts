import { expect, test } from '@playwright/test';

import { environment } from '../src/environment';
import { actionLink, clearMailbox, waitForMessage } from '../src/mailpit';
import { signIn } from '../src/sign-in';

/**
 * Deleting a business, end to end (sections 5, 13, 19; D-056).
 *
 * The assertion this file exists for is the one in the middle: **opening the
 * confirmation link does not delete anything.** A deletion carried out on GET
 * would be carried out by Office 365's Safe Links scanner, in this installation,
 * before the owner had read the message — and the failure would be silent,
 * total, and irreversible, because the same act erases the shop's credentials.
 *
 * The integration tests prove the service refuses the right callers. Only this
 * can prove that the journey through a real browser and a real inbox has no
 * step in it that acts too early.
 *
 * It works on a business it creates for the purpose. Deleting the one the setup
 * project made would leave every later spec with nothing to look at, and a test
 * that destroys its neighbours' fixtures is a test people learn to skip.
 */

test.use({ storageState: { cookies: [], origins: [] } });

// Signing in from scratch costs the sixty-second resend cooldown, and it is not
// optional: section 20 requires a recent authentication before a destructive
// action, so a session restored from the setup project would be refused.
test.setTimeout(180_000);

const DOOMED = 'Business To Delete';

test('an owner deletes a business, and only after being asked twice', async ({ page, request }) => {
  await signIn(page);

  // ------------------------------------------------------------ make a target
  await page.goto('/businesses/new');
  await page.getByLabel('Name').fill(DOOMED);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByLabel('Active business')).toContainText(DOOMED);

  await page.goto('/settings');

  // ------------------------------------------------- the name has to be right
  await page.getByLabel(`Type ${DOOMED} to continue`).fill('something else');
  await page.getByRole('button', { name: 'Email me a confirmation link' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'not the name of this business' }),
  ).toBeVisible();

  // ------------------------------------------------------------- ask properly
  await clearMailbox();

  await page.getByLabel(`Type ${DOOMED} to continue`).fill(DOOMED);
  await page.getByLabel('Why (optional)').fill('created by the browser tier');
  await page.getByRole('button', { name: 'Email me a confirmation link' }).click();

  // The card is replaced by the outstanding-request notice, which is the state
  // that matters: it is what a co-owner sees, and it is what offers the cancel.
  await expect(page.getByText('A deletion was requested at')).toBeVisible();
  await expect(page.getByText('Nothing has been deleted.')).toBeVisible();

  const message = await waitForMessage(environment.adminEmail, {
    subjectContains: 'Confirm deleting',
  });
  const link = actionLink(message);

  expect(link.pathname).toBe('/businesses/delete');

  // ------------------------------------------- the scanner opens it, and stops
  const scanned = await request.get(link.toString());
  expect(scanned.status()).toBe(200);

  // Still there. This is the whole test: a GET on this URL is performed by
  // machines that were never asked to, and it must change nothing.
  await page.goto('/settings');
  await expect(page.getByLabel('Active business')).toContainText(DOOMED);

  // ---------------------------------------------------- and then a person does
  await page.goto(link.toString());
  await expect(page.getByRole('heading', { level: 1 })).toContainText(`Delete ${DOOMED}?`);
  // The page says what is about to happen before offering the button, including
  // the half that cannot be undone.
  await expect(page.getByText('Its credentials are erased and cannot be recovered.')).toBeVisible();

  await page.getByRole('button', { name: 'Delete this business permanently' }).click();

  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByLabel('Active business')).not.toContainText(DOOMED);

  // The link works once. Section 20's reasoning applies here too: it is now a
  // token somebody could still be holding.
  await page.goto(link.toString());
  await expect(page.getByText('This link is not usable')).toBeVisible();
});

test('an outstanding request can be cancelled, and the link then does nothing', async ({
  page,
}) => {
  await signIn(page);

  await page.goto('/businesses/new');
  await page.getByLabel('Name').fill('Business To Keep');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByLabel('Active business')).toContainText('Business To Keep');

  await clearMailbox();
  await page.goto('/settings');
  await page.getByLabel('Type Business To Keep to continue').fill('Business To Keep');
  await page.getByRole('button', { name: 'Email me a confirmation link' }).click();

  const link = actionLink(
    await waitForMessage(environment.adminEmail, { subjectContains: 'Confirm deleting' }),
  );

  await page.reload();
  await expect(page.getByText('A deletion was requested at')).toBeVisible();

  await page.getByRole('button', { name: 'Cancel the deletion' }).click();

  // The card goes back to offering the request form. The action's own
  // "Cancelled" message is never seen, because revalidating the page unmounts
  // the form that would have rendered it — which is fine here: the card
  // changing back says the same thing, and says it about server state rather
  // than about a submission.
  await expect(page.getByText('A deletion was requested at')).toHaveCount(0);
  await expect(page.getByLabel('Type Business To Keep to continue')).toBeVisible();

  // Cancelling has to invalidate the message already sitting in an inbox.
  // Anything less means the owner who stopped it has not actually stopped it.
  await page.goto(link.toString());
  await expect(page.getByText('This link is not usable')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByLabel('Active business')).toContainText('Business To Keep');
});
