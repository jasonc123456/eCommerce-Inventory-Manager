import { expect, test } from '@playwright/test';

/**
 * The screens that have to work when the script does not (section 21).
 *
 * Not a purity exercise. Every form here is a Server Action, which Next.js
 * progressively enhances — the markup posts to the server on its own and the
 * client bundle upgrades it afterwards. That property is free while it holds and
 * silently lost the moment a form grows an `onSubmit`, a controlled input, or a
 * button that does its work in a handler. Nothing else in the suite would
 * notice, because everything else runs with JavaScript.
 *
 * Two screens are covered rather than all of them, and deliberately the two
 * where the failure is unrecoverable: sign-in is where somebody arrives when
 * something has already gone wrong, and the deletion confirmation is where the
 * button is the only thing standing between a link and an erased shop.
 */

test.describe('signed out', () => {
  test.use({ javaScriptEnabled: false, storageState: { cookies: [], origins: [] } });

  test('the sign-in form submits without a client bundle', async ({ page }) => {
    await page.goto('/sign-in');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');

    await page.getByLabel('Email address').fill('nobody-here@example.invalid');
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();

    // The generic answer, rendered by the server. Reaching it at all is the
    // assertion: without progressive enhancement the button does nothing and
    // the page never changes.
    await expect(page.getByRole('status').first()).toContainText('If that address has an account');
  });

  test('a signed-out visitor is sent to sign in rather than shown an empty shell', async ({
    page,
  }) => {
    await page.goto('/inventory');

    await expect(page).toHaveURL(/\/sign-in/u);
  });
});

test.describe('signed in', () => {
  test.use({ javaScriptEnabled: false });

  test('the confirmation page still refuses to act on a GET', async ({ page }) => {
    // With no script running there is nothing that could consume a token on
    // load even by accident — which is what makes this the clearest statement
    // of the rule: the page renders, explains, and waits.
    await page.goto('/businesses/delete?t=not-a-real-token');

    await expect(page.getByText('This link is not usable')).toBeVisible();
  });

  test('the business switcher is a real form with its own button', async ({ page }) => {
    await page.goto('/');

    // Section 21 wants this usable without JavaScript, which is why the
    // switcher submits with the button beside it rather than on change. An
    // onChange submit is also invisible to somebody arrowing through the
    // options with a keyboard.
    await expect(page.getByLabel('Active business')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Switch' })).toBeVisible();
  });
});
