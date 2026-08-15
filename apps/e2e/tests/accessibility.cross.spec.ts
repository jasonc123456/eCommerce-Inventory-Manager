import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * WCAG 2.2 AA, measured against the rendered page (section 21, D-083).
 *
 * This is the half of the accessibility commitment that could not be checked
 * before. `apps/web/src/accessibility.test.ts` is a static audit: it reads every
 * screen's source and asserts structural properties — a first-level heading, no
 * status carried by colour alone, no positive `tabIndex`, no error text outside
 * `Notice`. Those are real rules and it enforces them cheaply on every commit.
 *
 * What it cannot do is compute a contrast ratio, because contrast is a property
 * of two resolved colours and the colours here come from custom properties that
 * only exist once a browser has cascaded them. It cannot see a label that is
 * present but associated with nothing, an ARIA attribute pointing at an id that
 * no longer renders, or a control that ends up hidden behind an overlay. All of
 * those are what a rule engine sees, and only in a browser.
 *
 * The two are kept, not merged. The static audit catches a whole class of
 * mistake at the moment it is written, and axe catches what only exists at
 * render time.
 */

/** Section 21 commits to WCAG 2.2 AA. Nothing above that level is asserted. */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const SCREENS = [
  { path: '/', name: 'overview' },
  { path: '/inventory', name: 'inventory' },
  { path: '/mappings', name: 'mappings' },
  { path: '/alerts', name: 'alerts' },
  { path: '/pilot', name: 'pilot' },
  { path: '/connections', name: 'connections' },
  { path: '/settings', name: 'business settings' },
  { path: '/members', name: 'members' },
  { path: '/businesses/new', name: 'new business' },
] as const;

for (const screen of SCREENS) {
  test(`${screen.name} has no accessibility violations`, async ({ page }) => {
    await page.goto(screen.path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();

    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    ).toEqual([]);
  });
}

test('the signed-out screens are accessible too', async ({ browser }) => {
  // Section 25 asks for "authentication accessibility workflows" by name, and
  // the sign-in screen is the one somebody reaches when something else has
  // already gone wrong — the worst place to meet an unlabelled control.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();

  try {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('the open drawer is accessible', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('#mobile-navigation')).not.toHaveAttribute('inert', '');

  // Scanned while open, because an overlay that is correct when closed can put
  // every link behind a low-contrast scrim when it is not.
  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze();

  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});
