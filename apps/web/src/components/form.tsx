import type { ReactNode } from 'react';

/**
 * The interface primitives every screen is built from.
 *
 * Deliberately plain elements rather than a component library. Section 21 needs
 * WCAG 2.2 AA, and the reliable way to get there on a form is a real `<label>`
 * bound to a real `<input>` with a real validation message: everything a
 * component library adds on top of that is something else to get wrong.
 *
 * Colour comes from the tokens in `globals.css` rather than from Tailwind's
 * palette utilities. That is not tidiness — it is what makes a dark theme
 * something the whole application has rather than something each screen
 * remembers to add, and it keeps every status colour paired with the exact
 * foreground that was contrast-checked against it.
 *
 * Nothing here conveys meaning by colour alone. Every tone that means something
 * — a failing check, an unmet criterion, a paused connection — carries a word
 * beside the tint, because WCAG 1.4.1 and because a screenshot in a bug report
 * is often greyscale.
 */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  // The control is wrapped rather than linked by `htmlFor`. Implicit association
  // is just as valid and has no id to fall out of sync when somebody copies a
  // form, which is the failure mode `htmlFor` actually has in practice.
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-subtle text-xs">{hint}</span>}
    </label>
  );
}

const CONTROL_CLASS =
  'control w-full rounded-lg px-3 py-2 text-sm outline-none ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL_CLASS} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL_CLASS} ${props.className ?? ''}`} />;
}

/**
 * A native select.
 *
 * `color-scheme` is set on the root for both themes, so the popup the operating
 * system draws matches the page instead of being a white rectangle in a dark
 * interface. That is the entire reason not to build a custom listbox here.
 */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL_CLASS} pr-8 ${props.className ?? ''}`} />;
}

export function Button({
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium ' +
    'whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-55 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  const skin =
    variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-secondary';

  return <button {...props} className={`${base} ${skin} ${props.className ?? ''}`} />;
}

/**
 * A message about the outcome of a submission.
 *
 * `role="status"` rather than `role="alert"`, and polite rather than assertive,
 * because most of these are confirmations. An error still reaches a screen
 * reader; it does not interrupt what is already being read.
 */
export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'error' | 'success' | 'warning';
  children: ReactNode;
}) {
  const skin =
    tone === 'error'
      ? 'tone-bad'
      : tone === 'success'
        ? 'tone-ok'
        : tone === 'warning'
          ? 'tone-warn'
          : 'tone-neutral';

  return (
    <p role="status" aria-live="polite" className={`rounded-lg px-3 py-2 text-sm ${skin}`}>
      {children}
    </p>
  );
}

/**
 * A small labelled status.
 *
 * The label is the content, so the tint is decoration on top of a word rather
 * than a substitute for one. A badge with no children would be a coloured dot,
 * which is the thing WCAG 1.4.1 exists to prevent.
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';
  children: ReactNode;
}) {
  const skin =
    tone === 'ok'
      ? 'tone-ok'
      : tone === 'warn'
        ? 'tone-warn'
        : tone === 'bad'
          ? 'tone-bad'
          : tone === 'accent'
            ? 'tone-accent'
            : 'tone-neutral';

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${skin}`}>
      {children}
    </span>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** Controls that belong to the card as a whole, shown beside its heading. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card flex min-w-0 flex-col gap-4 rounded-xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {description === undefined ? null : <p className="text-muted text-sm">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * The heading of a screen.
 *
 * Always an `<h1>`, because a screen with no first-level heading leaves a
 * screen-reader user with no way to tell where they are — WCAG 2.4.6, and the
 * one structural rule the accessibility audit checks on every page.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : (
          <p className="text-muted max-w-2xl text-sm">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/**
 * What a list says when it is empty.
 *
 * Worth a component because the alternative is a blank panel, and a blank panel
 * is indistinguishable from one that failed to load. Every one of these says
 * what would appear here and what to do to make it appear.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="surface-sunken flex flex-col items-start gap-2 rounded-lg px-4 py-6">
      <p className="text-sm font-medium">{title}</p>
      <div className="text-muted text-sm">{children}</div>
      {action}
    </div>
  );
}

/**
 * A labelled figure.
 *
 * The label sits above the value rather than beside it so a row of these lines
 * up regardless of how long each label is, and the value uses tabular figures
 * so two numbers of the same magnitude are the same width.
 */
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-subtle text-xs font-medium uppercase tracking-wide">{label}</span>
      <span className="tabular text-2xl font-semibold">{value}</span>
      {detail === undefined ? null : <span className="text-muted text-xs">{detail}</span>}
    </div>
  );
}

/**
 * A table that scrolls inside itself rather than making the page scroll.
 *
 * Section 21 asks for responsive parity. A wide table on a narrow screen has to
 * go somewhere, and a horizontally scrolling page breaks every other screen's
 * layout at the same time.
 */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="hairline -mx-1 overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">{children}</table>
    </div>
  );
}
