/**
 * The authentication and security message templates (section 20).
 *
 * Pure functions returning subject, plain text, and HTML. Nothing here touches
 * SMTP, which means every template can be asserted on directly and the tests
 * that matter — that a template does not carry more than it needs, and that a
 * value is escaped before it reaches the HTML — do not need a mail server.
 *
 * Two rules apply to all of them.
 *
 * Section 20: "templates never include unnecessary order or business data". A
 * sign-in message goes to an address that has not yet proved anything, so it
 * carries the least that still makes the message actionable and recognisable.
 *
 * Section 19: the magic-link token goes in the URL fragment. A fragment is not
 * sent in the HTTP request, so the token does not reach the server's access log,
 * a reverse proxy's log, or a Referer header on the way to a later page. The
 * page at that address posts it back same-origin and clears the fragment.
 *
 * An installation whose mail passes through a rewriting security gateway may
 * have to move the token to the query instead (D-182). Microsoft Defender Safe
 * Links and its equivalents rewrite every URL in a message, and a rewrite that
 * drops the fragment delivers the recipient a confirmation page with nothing in
 * it — a link that fails for the owner while remaining perfectly safe from the
 * scanner. The carrier is therefore a setting, defaulting to the fragment.
 *
 * Neither carrier authenticates on GET. That is the property that actually stops
 * a scanner spending the link, and it does not depend on this choice.
 */

export interface RenderedMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface BrandContext {
  /** What the installation calls itself in mail. Never a business name: a
   * sign-in message is sent before the recipient has proved who they are. */
  readonly productName: string;
  /** Canonical public origin, used to build every link. */
  readonly publicUrl: string;
}

/**
 * Installation-configurable overrides (section 20).
 *
 * Section 20 requires authentication templates to be installation-configurable.
 * An override replaces the body a template would have produced; the subject and
 * the security-critical parts of the message — the link, the code, the expiry —
 * are still assembled here, because an operator editing a template must not be
 * able to produce a message with no way to sign in, or one that quietly points
 * somewhere else.
 */
export interface TemplateOverrides {
  readonly signInIntro?: string;
  readonly invitationIntro?: string;
  readonly footer?: string;
}

export interface MagicLinkContext extends BrandContext {
  readonly token: string;
  readonly expiresInMinutes: number;
  /** Shown so a recipient who did not ask can recognise an unfamiliar device. */
  readonly requestedFrom?: string;
  /**
   * The local path the link points at, without the fragment.
   *
   * Defaults to the sign-in confirmation. Installation setup uses the same
   * template with a different destination, and giving it a parameter is better
   * than a second near-identical template that would drift from this one.
   */
  readonly path?: string;
  /**
   * Where the token rides. Defaults to the fragment; see the file header for
   * why an installation behind a link-rewriting mail gateway may need `query`.
   */
  readonly tokenCarrier?: TokenCarrier;
}

export type TokenCarrier = 'fragment' | 'query';

/** The query parameter used when the fragment cannot survive the journey. */
export const TOKEN_QUERY_PARAMETER = 't';

export function magicLinkUrl(context: {
  readonly publicUrl: string;
  readonly token: string;
  readonly path?: string;
  readonly tokenCarrier?: TokenCarrier;
}): string {
  const base = `${trimTrailingSlash(context.publicUrl)}${context.path ?? '/sign-in/link'}`;
  const token = encodeURIComponent(context.token);

  // Section 19 prefers the fragment, which is not sent in the HTTP request and
  // so is logged by nothing in the way.
  return context.tokenCarrier === 'query'
    ? `${base}?${TOKEN_QUERY_PARAMETER}=${token}`
    : `${base}#${token}`;
}

export function renderMagicLink(
  context: MagicLinkContext,
  overrides: TemplateOverrides = {},
): RenderedMessage {
  const url = magicLinkUrl(context);

  const intro =
    overrides.signInIntro ??
    `Use the link below to sign in to ${context.productName}. It works once and expires in ${String(context.expiresInMinutes)} minutes.`;

  const lines = [
    intro,
    '',
    url,
    '',
    ...(context.requestedFrom === undefined
      ? []
      : [`Requested from ${context.requestedFrom}.`, '']),
    'If you did not ask to sign in, you can ignore this message. Nobody can use',
    'the link without opening it, and it will expire on its own.',
    ...footerLines(overrides),
  ];

  return {
    subject: `Sign in to ${context.productName}`,
    text: lines.join('\n'),
    html: wrapHtml(context.productName, [
      paragraph(intro),
      `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>`,
      paragraph('Or paste this address into your browser:'),
      `<p style="word-break:break-all;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(url)}</p>`,
      ...(context.requestedFrom === undefined
        ? []
        : [paragraph(`Requested from ${context.requestedFrom}.`)]),
      paragraph(
        'If you did not ask to sign in, you can ignore this message. It will expire on its own.',
      ),
      ...footerHtml(overrides),
    ]),
  };
}

export interface EmailCodeContext extends BrandContext {
  readonly code: string;
  readonly expiresInMinutes: number;
  readonly requestedFrom?: string;
}

export function renderEmailCode(
  context: EmailCodeContext,
  overrides: TemplateOverrides = {},
): RenderedMessage {
  const intro =
    overrides.signInIntro ??
    `Enter this code to sign in to ${context.productName}. It expires in ${String(context.expiresInMinutes)} minutes.`;

  // Grouped for reading aloud and typing, and never as a link: section 19 keeps
  // codes out of URLs entirely.
  const grouped = `${context.code.slice(0, 4)} ${context.code.slice(4)}`;

  const lines = [
    intro,
    '',
    grouped,
    '',
    ...(context.requestedFrom === undefined
      ? []
      : [`Requested from ${context.requestedFrom}.`, '']),
    'If you did not ask to sign in, you can ignore this message.',
    ...footerLines(overrides),
  ];

  return {
    subject: `${grouped} is your ${context.productName} sign-in code`,
    text: lines.join('\n'),
    html: wrapHtml(context.productName, [
      paragraph(intro),
      `<p style="font-family:ui-monospace,monospace;font-size:32px;letter-spacing:0.15em;margin:24px 0">${escapeHtml(grouped)}</p>`,
      ...(context.requestedFrom === undefined
        ? []
        : [paragraph(`Requested from ${context.requestedFrom}.`)]),
      paragraph('If you did not ask to sign in, you can ignore this message.'),
      ...footerHtml(overrides),
    ]),
  };
}

export interface InvitationContext extends BrandContext {
  readonly token: string;
  /** The business the recipient is being invited to, which they may not know. */
  readonly businessName: string;
  readonly invitedByName?: string;
  readonly expiresInHours: number;
}

export function renderInvitation(
  context: InvitationContext,
  overrides: TemplateOverrides = {},
): RenderedMessage {
  const url = `${trimTrailingSlash(context.publicUrl)}/invitations/accept#${encodeURIComponent(context.token)}`;

  const invitedBy = context.invitedByName === undefined ? '' : ` by ${context.invitedByName}`;

  const intro =
    overrides.invitationIntro ??
    `You have been invited${invitedBy} to join ${context.businessName} on ${context.productName}. The invitation expires in ${String(context.expiresInHours)} hours.`;

  return {
    subject: `You have been invited to ${context.businessName}`,
    text: [
      intro,
      '',
      url,
      '',
      'If you were not expecting this, you can ignore the message and the',
      'invitation will expire.',
      ...footerLines(overrides),
    ].join('\n'),
    html: wrapHtml(context.productName, [
      paragraph(intro),
      `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>`,
      `<p style="word-break:break-all;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(url)}</p>`,
      paragraph('If you were not expecting this, you can ignore the message.'),
      ...footerHtml(overrides),
    ]),
  };
}

export interface SecurityNoticeContext extends BrandContext {
  /** One plain sentence describing what changed. Never a secret or a token. */
  readonly summary: string;
  readonly occurredAt: Date;
  readonly requestedFrom?: string;
}

/**
 * The notification sent for a security-relevant change (section 20).
 *
 * Deliberately says what happened and not how to undo it: a message that
 * carried a one-click revocation link would be a credential of its own, sent to
 * an inbox that may be the thing that was compromised. The recipient is pointed
 * at the security screen, which requires signing in.
 */
export function renderSecurityNotice(
  context: SecurityNoticeContext,
  overrides: TemplateOverrides = {},
): RenderedMessage {
  const url = `${trimTrailingSlash(context.publicUrl)}/account/security`;
  const when = context.occurredAt.toISOString();

  return {
    subject: `Security change on your ${context.productName} account`,
    text: [
      context.summary,
      '',
      `When: ${when}`,
      ...(context.requestedFrom === undefined ? [] : [`Where: ${context.requestedFrom}`]),
      '',
      'If this was you, nothing further is needed. If it was not, sign in and',
      'review your security settings:',
      '',
      url,
      ...footerLines(overrides),
    ].join('\n'),
    html: wrapHtml(context.productName, [
      paragraph(context.summary),
      paragraph(`When: ${when}`),
      ...(context.requestedFrom === undefined
        ? []
        : [paragraph(`Where: ${context.requestedFrom}`)]),
      paragraph('If this was not you, sign in and review your security settings.'),
      `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      ...footerHtml(overrides),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/**
 * Escapes a value for HTML.
 *
 * Every interpolation in this file goes through here. A business name and a
 * display name are user-supplied, and a mail client that renders HTML is as
 * capable of executing an injected attribute as a browser is.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function footerLines(overrides: TemplateOverrides): readonly string[] {
  return overrides.footer === undefined ? [] : ['', overrides.footer];
}

function footerHtml(overrides: TemplateOverrides): readonly string[] {
  return overrides.footer === undefined
    ? []
    : [`<p style="color:#666;font-size:13px">${escapeHtml(overrides.footer)}</p>`];
}

/**
 * The HTML shell.
 *
 * Inline styles and a table-free layout, because mail clients are not browsers:
 * a stylesheet is stripped by most of them and a media query by many. No
 * external resource of any kind, which section 19 requires of authentication
 * surfaces and which also stops the message from reporting when it was opened.
 */
function wrapHtml(productName: string, blocks: readonly string[]): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px;margin:0 auto;padding:24px">',
    `<p style="font-weight:600;margin-bottom:24px">${escapeHtml(productName)}</p>`,
    ...blocks,
    '</div>',
  ].join('\n');
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
