import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The accessibility rules a linter cannot see (section 21, D-083).
 *
 * `eslint-plugin-jsx-a11y` already catches the per-element mistakes: an image
 * without alt text, a click handler on a div, a label with nothing in it. What
 * it cannot see is anything about a *screen* — whether a page has a
 * first-level heading, whether status is conveyed by more than colour, whether
 * a form control has a label somewhere else in the file.
 *
 * So this reads the source of every screen and asserts the properties WCAG 2.2
 * AA needs at that level. It is a static check and it does not replace a real
 * assistive-technology pass; what it does is stop the regressions that happen
 * between such passes, which is most of them.
 *
 * A browser-driven axe run over the same screens is the other half and needs a
 * running application, a database, and a browser — the tier section 25 calls
 * "browser" and this repository does not yet have. This test is deliberately
 * written so that adding one later replaces nothing here: the two answer
 * different questions.
 */

const SCREENS = join(import.meta.dirname, 'app');

function filesUnder(directory: string, suffix: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, suffix));
    } else if (entry.endsWith(suffix)) {
      found.push(path);
    }
  }

  return found;
}

const pages = filesUnder(SCREENS, 'page.tsx');
const components = filesUnder(SCREENS, '.tsx');

describe('every screen', () => {
  it('exists to be tested', () => {
    // A guard against this whole file passing because it found nothing, which
    // is what happens the day somebody moves the app directory.
    expect(pages.length).toBeGreaterThan(8);
  });

  it.each(pages.map((path) => [path.slice(SCREENS.length + 1), path]))(
    '%s names itself with a first-level heading',
    (_name, path) => {
      // A screen with no <h1> leaves a screen-reader user with no way to tell
      // where they are. WCAG 2.4.6 and 1.3.1 both depend on it.
      //
      // At least one rather than exactly one, because every screen here has
      // mutually exclusive early returns — "you are not a member of any
      // business yet" is a different render of the same page — and counting
      // occurrences in source counts branches, not what a browser shows.
      const source = readFileSync(path, 'utf8');
      const headings = source.match(/<h1[\s>]/gu) ?? [];

      expect(headings.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(components.map((path) => [path.slice(SCREENS.length + 1), path]))(
    '%s never conveys meaning by colour alone',
    (_name, path) => {
      // WCAG 1.4.1. Everywhere this application colours something to mean
      // "wrong" or "urgent", it also says so in words — the severity beside the
      // tint, the status beside the colour.
      //
      // What that forbids in practice is a self-closing element carrying an
      // alarming colour, because a self-closing element has no text in it by
      // definition. A coloured dot beside a row is the classic version, and it
      // is invisible to somebody who cannot distinguish the colour.
      const source = readFileSync(path, 'utf8');

      for (const tag of source.match(/<[a-zA-Z][^>]*\/>/gu) ?? []) {
        expect(tag).not.toMatch(/text-(red|amber|green)-\d{3}/u);
      }
    },
  );

  it.each(components.map((path) => [path.slice(SCREENS.length + 1), path]))(
    '%s has no positive tabindex',
    (_name, path) => {
      // WCAG 2.4.3. A positive tabIndex takes an element out of document order
      // and puts it in front of everything, which reorders the whole page for
      // keyboard users and nobody else — so the person who wrote it never sees
      // what they did.
      const source = readFileSync(path, 'utf8');

      expect(source).not.toMatch(/tabIndex=\{?["']?[1-9]/u);
    },
  );

  it.each(components.map((path) => [path.slice(SCREENS.length + 1), path]))(
    '%s announces what changed, where it says anything',
    (_name, path) => {
      // Section 21 and WCAG 4.1.3. Every message this application shows after
      // an action goes through `Notice`, which carries role="status" and
      // aria-live. A raw paragraph used as a result message would be invisible
      // to a screen reader, so the check is that error text is not rendered
      // outside that component.
      const source = readFileSync(path, 'utf8');
      const rawErrors =
        source.match(/<p[^>]*>\s*\{?\s*(state\.message|error|state\.reason)\s*\}?/gu) ?? [];

      expect(rawErrors).toEqual([]);
    },
  );
});

describe('the shared form components', () => {
  const form = readFileSync(join(import.meta.dirname, 'components', 'form.tsx'), 'utf8');

  it('ties every label to its control', () => {
    // WCAG 1.3.1 and 3.3.2. `Field` wraps the control in a real `<label>`,
    // which is implicit association — as valid as `htmlFor`, and immune to the
    // failure mode `htmlFor` has, which is an id that stops matching after
    // somebody copies a form.
    //
    // What is asserted is that it is a real label element. A `<span>` styled to
    // look like one is the regression this catches, and it is a regression that
    // looks identical in a screenshot.
    expect(form).toMatch(/<label\b/u);
    expect(form).toMatch(/export function Field\(/u);
  });

  it('announces a notice without stealing focus', () => {
    // `role="status"` with `aria-live="polite"` is announced at the next
    // opportunity. `alert` and `assertive` interrupt whatever is being read,
    // which is right for a fire alarm and wrong for "Saved."
    expect(form).toMatch(/role="status"/u);
    expect(form).toMatch(/aria-live="polite"/u);
    expect(form).not.toMatch(/aria-live="assertive"/u);
  });

  it('keeps a visible focus ring', () => {
    // WCAG 2.4.7. Removing the outline is the single most common accessibility
    // regression in a codebase that uses a utility CSS framework, because
    // `outline-none` looks tidy in a screenshot.
    expect(form).toMatch(/focus-visible:outline/u);
    expect(form).not.toMatch(/focus:outline-none(?![\s\S]{0,80}focus-visible:outline)/u);
  });
});
