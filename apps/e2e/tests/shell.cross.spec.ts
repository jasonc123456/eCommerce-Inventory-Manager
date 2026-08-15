import { expect, test, type Page } from '@playwright/test';

/**
 * The navigation shell, in every supported engine (section 21).
 *
 * Everything asserted here is a rendered property. `apps/web/src/accessibility.
 * test.ts` reads the same components' source and can tell you a link exists; it
 * cannot tell you the link is reachable, that the drawer covering it is inert,
 * that Escape closes it, or that the page does not scroll sideways on a phone.
 * Those are the failures a redesign actually produces, and this is the only tier
 * that can see them.
 *
 * It runs on all five projects because layout, focus, and inertness are exactly
 * where engines disagree.
 */

const NARROW = { width: 320, height: 640 };

/** True when the document is wider than the window — a sideways-scrolling page. */
async function overflowsHorizontally(page: Page): Promise<boolean> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test('every section of the sidebar is reachable and says where you are', async ({
  page,
  isMobile,
}) => {
  await page.goto('/');

  const navigation = page.getByRole('navigation', { name: 'Sections' });

  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }

  await expect(navigation.getByRole('link', { name: 'Overview' })).toBeVisible();

  await navigation.getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveURL(/\/alerts$/u);

  if (isMobile) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }

  // The announcement and the appearance come from the same attribute, which is
  // the point of hanging the styling off `aria-current` rather than off a class.
  await expect(navigation.getByRole('link', { name: 'Alerts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(navigation.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('the skip link is the first stop and lands on the content', async ({ page, isMobile }) => {
  test.skip(isMobile, 'there is no tab key on a touch device');

  await page.goto('/');
  await page.keyboard.press('Tab');

  const focused = page.locator(':focus');
  await expect(focused).toHaveText('Skip to content');

  await page.keyboard.press('Enter');

  // WCAG 2.4.1. Without this, reaching the content by keyboard means tabbing
  // past fifteen navigation links on every page.
  await expect(page.locator(':focus')).toHaveAttribute('id', 'main');
});

test('nothing on a narrow screen makes the page scroll sideways', async ({ page }) => {
  await page.setViewportSize(NARROW);

  // The screens with the widest content: a table, a set of statistics, and a
  // form. Each has a different way of overflowing.
  for (const path of ['/', '/inventory', '/pilot', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    expect(
      await overflowsHorizontally(page),
      `${path} scrolls horizontally at ${String(NARROW.width)}px`,
    ).toBe(false);
  }
});

test('the drawer keeps its links out of the tab order until it is opened', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto('/');

  const drawer = page.locator('#mobile-navigation');
  const link = drawer.getByRole('link', { name: 'Inventory' });

  await expect(drawer).toHaveAttribute('inert', '');

  // Focusability, not visibility. The drawer is moved off-screen by a transform
  // rather than unmounted, so its links still have a box and Playwright still
  // calls them visible — which is exactly the situation `inert` exists for and
  // exactly why asserting on appearance would prove nothing. What matters is
  // that a keyboard cannot reach them, and the only honest way to ask that is
  // to try.
  const reachableWhenClosed = await link.evaluate((element) => {
    (element as HTMLElement).focus();

    return document.activeElement === element;
  });

  expect(reachableWhenClosed, 'a closed drawer must not be focusable').toBe(false);

  await page.getByRole('button', { name: 'Open navigation' }).click();

  await expect(drawer).not.toHaveAttribute('inert', '');

  const reachableWhenOpen = await link.evaluate((element) => {
    (element as HTMLElement).focus();

    return document.activeElement === element;
  });

  expect(reachableWhenOpen, 'an open drawer must be focusable').toBe(true);
});

test('Escape closes the drawer', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto('/');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('#mobile-navigation')).not.toHaveAttribute('inert', '');

  await page.keyboard.press('Escape');

  await expect(page.locator('#mobile-navigation')).toHaveAttribute('inert', '');
});

test('every screen names itself with a first-level heading', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the same markup, and the desktop projects already cover it');

  const screens = [
    '/',
    '/inventory',
    '/inventory/locations',
    '/mappings',
    '/operations',
    '/shipping',
    '/alerts',
    '/pilot',
    '/connections',
    '/settings',
    '/members',
    '/ai',
    '/account/sessions',
    '/account/security',
  ];

  for (const path of screens) {
    await page.goto(path);

    const headings = page.getByRole('heading', { level: 1 });

    // Exactly one, not at least one. Two first-level headings is the same
    // problem as none: there is no answer to "where am I".
    await expect(headings, `${path} should have exactly one <h1>`).toHaveCount(1);
    await expect(headings).not.toBeEmpty();
  }
});
