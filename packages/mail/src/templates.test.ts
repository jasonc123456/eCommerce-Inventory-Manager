import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  renderAlertNotice,
  renderEmailCode,
  renderInvitation,
  renderMagicLink,
  renderSecurityNotice,
} from './templates';

const brand = { productName: 'Inventory Manager', publicUrl: 'https://inventory.example' };

describe('renderMagicLink', () => {
  const message = renderMagicLink({ ...brand, token: 'tok-en_value', expiresInMinutes: 15 });

  it('puts the token in the fragment, never the path or the query', () => {
    // Section 19: a fragment is not sent in the HTTP request, so the token does
    // not reach an access log, a proxy log, or a Referer header.
    const url = message.text.split('\n').find((line) => line.startsWith('https://'))!;
    const parsed = new URL(url);

    expect(parsed.hash).toBe('#tok-en_value');
    expect(parsed.search).toBe('');
    expect(parsed.pathname).not.toContain('tok-en_value');
  });

  it('can carry the token in the query for a rewriting mail gateway', () => {
    // D-182. Microsoft Defender Safe Links and its equivalents rewrite every URL
    // in a message, and a rewrite that drops the fragment delivers a
    // confirmation page with nothing in it. Opt-in, because the query is logged
    // where the fragment is not.
    const carried = renderMagicLink({
      ...brand,
      token: 'tok-en_value',
      expiresInMinutes: 15,
      tokenCarrier: 'query',
    });
    const url = carried.text.split('\n').find((line) => line.startsWith('https://'))!;
    const parsed = new URL(url);

    expect(parsed.searchParams.get('t')).toBe('tok-en_value');
    expect(parsed.hash).toBe('');
  });

  it('appends the token to a destination that already has a query', () => {
    // Installation setup points at `/setup?step=complete`. A second `?` would
    // make the first parameter's value read "complete?t=…", so the page would
    // decide it was on step one and show the form that asks for a link again —
    // an installation that cannot be claimed, but only on this carrier.
    const carried = renderMagicLink({
      ...brand,
      token: 'tok-en_value',
      expiresInMinutes: 15,
      path: '/setup?step=complete',
      tokenCarrier: 'query',
    });
    const url = carried.text.split('\n').find((line) => line.startsWith('https://'))!;
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/setup');
    expect(parsed.searchParams.get('step')).toBe('complete');
    expect(parsed.searchParams.get('t')).toBe('tok-en_value');
  });

  it('points at the configured origin and nowhere else', () => {
    for (const url of extractUrls(message.text)) {
      expect(new URL(url).origin).toBe('https://inventory.example');
    }
  });

  it('says how long the link lasts and that it works once', () => {
    expect(message.text).toContain('15 minutes');
    expect(message.text).toContain('once');
  });

  it('tells a recipient who did not ask that ignoring it is safe', () => {
    expect(message.text).toMatch(/did not ask/);
  });

  it('carries no business or order data', () => {
    // Section 20: a sign-in message goes to an address that has not proved
    // anything yet.
    expect(message.text).not.toMatch(/order|invoice|sku|stock/i);
  });

  it('loads nothing from anywhere', () => {
    // No tracking pixel, no remote stylesheet, no web font. A message that
    // fetched a resource would report when it was opened.
    expect(message.html).not.toMatch(/<img|<link|<script|url\(/i);
  });

  it('handles a public URL with a trailing slash', () => {
    const trailing = renderMagicLink({
      ...brand,
      publicUrl: 'https://inventory.example/',
      token: 'abc',
      expiresInMinutes: 15,
    });

    expect(trailing.text).toContain('https://inventory.example/sign-in/link#abc');
    expect(trailing.text).not.toContain('example//sign-in');
  });

  it('percent-encodes a token so it cannot break out of the fragment', () => {
    const message = renderMagicLink({ ...brand, token: 'a#b&c', expiresInMinutes: 15 });

    expect(message.text).toContain('#a%23b%26c');
  });

  it('names the requesting device when one is known', () => {
    const withDevice = renderMagicLink({
      ...brand,
      token: 'abc',
      expiresInMinutes: 15,
      requestedFrom: 'Firefox on Linux',
    });

    expect(withDevice.text).toContain('Firefox on Linux');
    expect(withDevice.html).toContain('Firefox on Linux');
  });
});

describe('renderEmailCode', () => {
  const message = renderEmailCode({ ...brand, code: '00481502', expiresInMinutes: 10 });

  it('shows the code grouped for reading and typing', () => {
    expect(message.text).toContain('0048 1502');
    expect(message.subject).toContain('0048 1502');
  });

  it('keeps the leading zero', () => {
    expect(message.text).toContain('0048');
    expect(message.text).not.toMatch(/\b481502\b/);
  });

  it('never puts the code in a URL', () => {
    // Section 19 keeps codes out of URLs entirely.
    for (const url of extractUrls(message.text + message.html)) {
      expect(url).not.toContain('481502');
      expect(url).not.toContain('00481502');
    }
  });

  it('says how long the code lasts', () => {
    expect(message.text).toContain('10 minutes');
  });
});

describe('renderInvitation', () => {
  const message = renderInvitation({
    ...brand,
    token: 'inv-token',
    businessName: 'Acme Supplies',
    invitedByName: 'Dana',
    expiresInHours: 72,
  });

  it('names the business and the person, so the recipient can recognise it', () => {
    expect(message.text).toContain('Acme Supplies');
    expect(message.text).toContain('Dana');
    expect(message.subject).toContain('Acme Supplies');
  });

  it('puts the token in the fragment', () => {
    const url = extractUrls(message.text)[0]!;

    expect(new URL(url).hash).toBe('#inv-token');
  });

  it('states the seventy-two hour expiry', () => {
    expect(message.text).toContain('72 hours');
  });

  it('works without a named inviter', () => {
    const anonymous = renderInvitation({
      ...brand,
      token: 'x',
      businessName: 'Acme Supplies',
      expiresInHours: 72,
    });

    expect(anonymous.text).toContain('You have been invited to join Acme Supplies');
  });

  it('escapes a business name that contains markup', () => {
    const hostile = renderInvitation({
      ...brand,
      token: 'x',
      businessName: '<img src=x onerror=alert(1)>',
      expiresInHours: 72,
    });

    expect(hostile.html).not.toContain('<img');
    expect(hostile.html).toContain('&lt;img');
  });
});

describe('renderSecurityNotice', () => {
  const message = renderSecurityNotice({
    ...brand,
    summary: 'A new passkey was added to your account.',
    occurredAt: new Date('2026-08-05T12:00:00.000Z'),
    requestedFrom: 'Chrome on macOS',
  });

  it('says what happened, when, and where', () => {
    expect(message.text).toContain('A new passkey was added');
    expect(message.text).toContain('2026-08-05T12:00:00.000Z');
    expect(message.text).toContain('Chrome on macOS');
  });

  it('offers no one-click undo', () => {
    // A revocation link in a message is a credential of its own, sent to the
    // inbox that may be the thing that was compromised.
    const urls = extractUrls(message.text);

    expect(urls).toEqual(['https://inventory.example/account/security']);
    expect(message.text).not.toMatch(/revoke|undo|disable/i);
  });
});

describe('overrides', () => {
  it('replaces the wording but not the link', () => {
    // An operator editing a template must not be able to produce a message with
    // no way to sign in, or one that points somewhere else.
    const message = renderMagicLink(
      { ...brand, token: 'abc', expiresInMinutes: 15 },
      { signInIntro: 'Willkommen. Bitte melden Sie sich an.', footer: 'Acme IT' },
    );

    expect(message.text).toContain('Willkommen');
    expect(message.text).toContain('https://inventory.example/sign-in/link#abc');
    expect(message.text).toContain('Acme IT');
  });

  it('escapes an override, which is operator-supplied text', () => {
    const message = renderMagicLink(
      { ...brand, token: 'abc', expiresInMinutes: 15 },
      { footer: '<script>alert(1)</script>' },
    );

    expect(message.html).not.toContain('<script>');
  });
});

describe('renderAlertNotice', () => {
  const message = renderAlertNotice({
    ...brand,
    businessName: 'Wheelbarrow & Sons',
    severity: 'Critical',
    summary: 'an order could not be filled in full: 2 units short',
    recommendedAction: 'Check the item for uncounted stock, then adjust the order.',
    occurrences: 3,
    firstSeenAt: new Date('2026-08-05T12:00:00.000Z'),
    lastSeenAt: new Date('2026-08-05T14:00:00.000Z'),
    path: '/alerts',
  });

  it('names the shop and the severity in the subject', () => {
    expect(message.subject).toBe(
      '[Critical] Wheelbarrow & Sons: an order could not be filled in full: 2 units short',
    );
  });

  it('keeps the repetition count out of the subject, so an inbox can thread it', () => {
    // Deduplication does this job in the application; threading does it in a
    // mail client, and a subject that changed every time would defeat it.
    expect(message.subject).not.toContain('3 times');
    expect(message.text).toContain('Seen 3 times');
  });

  it('says it once when it has only happened once', () => {
    const first = renderAlertNotice({
      ...brand,
      severity: 'Error',
      summary: 'the store is not answering',
      occurrences: 1,
      firstSeenAt: new Date('2026-08-05T12:00:00.000Z'),
      lastSeenAt: new Date('2026-08-05T12:00:00.000Z'),
      path: '/alerts',
    });

    expect(first.text).toContain('First seen 2026-08-05T12:00:00.000Z');
    expect(first.text).not.toContain('times');
  });

  it('offers a screen rather than a way to acknowledge from the inbox', () => {
    // Acknowledgement records who did it. A link would let anybody who could
    // read the mailbox silence an oversell alert without signing in.
    const urls = extractUrls(message.text);

    expect(urls).toEqual(['https://inventory.example/alerts']);
    expect(message.text.toLowerCase()).not.toContain('unsubscribe');
  });

  it('escapes a shop name that contains markup', () => {
    const hostile = renderAlertNotice({
      ...brand,
      businessName: '<script>alert(1)</script>',
      severity: 'Warning',
      summary: 'waiting to go back on sale',
      occurrences: 1,
      firstSeenAt: new Date('2026-08-05T12:00:00.000Z'),
      lastSeenAt: new Date('2026-08-05T12:00:00.000Z'),
      path: '/alerts',
    });

    expect(hostile.html).not.toContain('<script>');
  });
});

describe('escapeHtml', () => {
  it('escapes every character that changes markup', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes the ampersand first, so an entity is not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
}
