import type { ReactNode } from 'react';

/**
 * The small set of form pieces every identity screen uses.
 *
 * Deliberately plain elements rather than a component library. Section 21 needs
 * WCAG 2.2 AA, and the reliable way to get there on a form is a real `<label>`
 * bound to a real `<input>` with a real validation message: everything a
 * component library adds on top of that is something else to get wrong.
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
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-xs opacity-70">{hint}</span>}
    </label>
  );
}

const INPUT_CLASS =
  'rounded-md border border-black/20 bg-transparent px-3 py-2 text-base ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-current dark:border-white/25';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT_CLASS} ${props.className ?? ''}`} />;
}

export function Button({
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  const base =
    'rounded-md px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';

  const skin =
    variant === 'primary'
      ? 'bg-black text-white dark:bg-white dark:text-black'
      : 'border border-black/20 dark:border-white/25';

  return <button {...props} className={`${base} ${skin} ${props.className ?? ''}`} />;
}

/**
 * A message about the outcome of a submission.
 *
 * `role="status"` rather than `role="alert"`, and polite rather than assertive,
 * because most of these are confirmations. An error still reaches a screen
 * reader; it does not interrupt what is already being read.
 */
export function Notice({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={`rounded-md px-3 py-2 text-sm ${
        tone === 'error'
          ? 'bg-red-500/10 text-red-800 dark:text-red-200'
          : 'bg-black/5 dark:bg-white/10'
      }`}
    >
      {children}
    </p>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-black/10 p-5 dark:border-white/15">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
