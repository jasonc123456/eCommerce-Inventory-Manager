import { expect, test } from '@playwright/test';

import { BUSINESS_NAME, environment, OWNER_STATE_PATH } from '../src/environment';
import { actionLink, clearMailbox, waitForMessage } from '../src/mailpit';

/**
 * A clean install, claimed and made usable through the interface.
 *
 * This is the setup project every other spec depends on, and it is deliberately
 * the real journey rather than rows inserted into a database. Three things it
 * proves that nothing else in the test suite can.
 *
 * The installation can be claimed at all. Bootstrap needs a link that arrives by
 * mail and a secret from the deployment host, and the link is built by one
 * package, carried by another, and read by a third; a mistake anywhere in that
 * chain leaves an installation nobody can get into, and every unit test still
 * passes.
 *
 * The link works in *this installation's* carrier. `EIM_MAGIC_LINK_TOKEN_CARRIER`
 * is `query` here because it is `query` in production, where Office 365 Safe
 * Links drops the fragment. That is the setting the deployment actually runs and
 * the one with no coverage anywhere else.
 *
 * A signed-in owner has somewhere to go. Bootstrap creates an account and stops;
 * until a business exists, every screen says you are not a member of anything.
 * That gap shipped once already, which is what makes it worth a test that would
 * have caught it.
 */

test('a fresh installation can be claimed, signed in to, and given a business', async ({
  page,
  context,
}) => {
  await clearMailbox();

  // ---------------------------------------------------------------- claim it
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Set up this installation');

  await page.getByLabel('Administrator email').fill(environment.adminEmail);
  await page.getByRole('button', { name: 'Send the setup link' }).click();

  const setupMail = await waitForMessage(environment.adminEmail, { subjectContains: 'Sign in' });
  const setupLink = actionLink(setupMail);

  // The bug this catches is silent on the default carrier: a destination that
  // already has a query would otherwise be handed a second `?`, and `step`
  // would arrive as "complete?t=…".
  expect(setupLink.pathname).toBe('/setup');
  expect(setupLink.searchParams.get('step')).toBe('complete');
  expect(setupLink.searchParams.get('t')).not.toBeNull();

  await page.goto(setupLink.toString());

  await page.getByLabel('Setup secret').fill(environment.setupSecret);
  await page.getByLabel('Your name').fill('Pilot Owner');
  await page.getByRole('button', { name: 'Create the first administrator' }).click();

  // Bootstrap does not sign anybody in on purpose: the first session on the
  // installation is created the same way every later one will be.
  await expect(page).toHaveURL(/\/sign-in\?setup=complete$/u);

  // --------------------------------------------------------------- sign in
  await clearMailbox();

  await page.getByLabel('Email address').fill(environment.adminEmail);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

  const signInMail = await waitForMessage(environment.adminEmail, { subjectContains: 'Sign in' });
  const signInLink = actionLink(signInMail);

  expect(signInLink.pathname).toBe('/sign-in/link');

  await page.goto(signInLink.toString());
  await page.getByRole('button', { name: 'Confirm sign-in' }).click();

  // ------------------------------------------------------- give it a business
  await expect(page).toHaveURL(/\/businesses\/new$|\/$/u);

  await page.goto('/businesses/new');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Create your first business');

  await page.getByLabel('Name').fill(BUSINESS_NAME);
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByRole('button', { name: 'Create business' }).click();

  // The switcher is the proof: the business exists, the caller is a member of
  // it, and the shell can see both.
  await expect(page.getByLabel('Active business')).toContainText(BUSINESS_NAME);

  await context.storageState({ path: OWNER_STATE_PATH });
});
