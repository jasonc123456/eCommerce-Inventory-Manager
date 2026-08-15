import { expect, test } from '@playwright/test';

import { environment } from '../src/environment';
import { actionLink, clearMailbox, waitForMessage } from '../src/mailpit';
import { requestSignInLink, SESSION_COOKIE } from '../src/sign-in';

/**
 * Authentication, from a signed-out browser (section 20).
 *
 * The property this file exists for is the first one: **the initial GET must
 * not authenticate or consume the token.** Every other tier can assert that the
 * POST works. Only a browser can demonstrate that fetching the link the way a
 * mail security product fetches it leaves the link usable afterwards — and this
 * installation is behind Office 365, whose Safe Links fetches every URL in every
 * message before the recipient sees it.
 *
 * A regression here would not look like a failure. It would look like sign-in
 * links that stopped working for one customer, on one mail provider,
 * intermittently.
 */

test.use({ storageState: { cookies: [], origins: [] } });

// Every test here may have to serve the sixty-second resend cooldown.
test.setTimeout(150_000);

test('a scanner following the link does not spend it', async ({ page, request }) => {
  await clearMailbox();
  await page.goto('/sign-in');
  await requestSignInLink(page);

  const message = await waitForMessage(environment.adminEmail, { subjectContains: 'Sign in' });
  const link = actionLink(message);

  // The scanner. A plain GET, no cookies, no JavaScript — which is exactly what
  // a link-rewriting gateway does to every URL in a message.
  const scanned = await request.get(link.toString());

  expect(scanned.status()).toBe(200);
  // Nothing came back that would let the scanner act as the recipient.
  expect(scanned.headers()['set-cookie'] ?? '').not.toContain(SESSION_COOKIE);

  // And the recipient, arriving second, still gets in.
  await page.goto(link.toString());
  await page.getByRole('button', { name: 'Confirm sign-in' }).click();

  await expect(page.getByLabel('Active business')).toBeVisible();
});

test('a used link cannot be used again', async ({ page }) => {
  await clearMailbox();
  await page.goto('/sign-in');
  await requestSignInLink(page);

  const link = actionLink(
    await waitForMessage(environment.adminEmail, { subjectContains: 'Sign in' }),
  );

  await page.goto(link.toString());
  await page.getByRole('button', { name: 'Confirm sign-in' }).click();
  await expect(page.getByLabel('Active business')).toBeVisible();

  // The same link, a second time, from a browser with no session. The words are
  // the generic ones on purpose: section 20 gives used, expired, invalid, and
  // unknown tokens one screen between them, because four different messages
  // would answer "does this address have an account".
  await page.context().clearCookies();
  await page.goto(link.toString());
  await page.getByRole('button', { name: 'Confirm sign-in' }).click();

  await expect(page.getByRole('status').first()).toContainText('no longer usable');
});

test('a second request inside the cooldown is refused', async ({ page }) => {
  await page.goto('/sign-in');
  await requestSignInLink(page);

  await page.getByLabel('Email address').fill(environment.adminEmail);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

  await expect(page.getByRole('status').first()).toContainText('Too many attempts');
});

test('the sign-in screen says nothing about whether an address is known', async ({ page }) => {
  await page.goto('/sign-in');

  await page.getByLabel('Email address').fill('nobody-here@example.invalid');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

  // The same sentence a real address gets. An enumeration oracle is usually
  // introduced by somebody improving an error message.
  await expect(page.getByRole('status').first()).toContainText('If that address has an account');
});
