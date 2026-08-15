/**
 * The icon set, inline.
 *
 * No icon dependency. Section 19's content-security policy is nonce-based and
 * section 24 counts every dependency as intake surface; a dozen paths copied
 * into this file cost nothing at runtime and add nothing to audit.
 *
 * Every icon is decorative. Each is `aria-hidden` and always sits beside a text
 * label, so nothing here is the only way to understand a control — which is
 * what lets them be drawn from one stroke weight without captions.
 */

interface IconProps {
  className?: string;
}

function Glyph({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </Glyph>
  );
}

export function InventoryIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M21 8v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8" />
      <path d="M2 8h20l-2-4H4L2 8z" />
      <path d="M10 12h4" />
    </Glyph>
  );
}

export function MappingsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M5 8.5V16a2 2 0 0 0 2 2h9.5" />
      <path d="M12 6h4.5" />
    </Glyph>
  );
}

export function LocationsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </Glyph>
  );
}

export function OperationsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15h6" />
      <path d="M9 11h3" />
    </Glyph>
  );
}

export function ShippingIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7h10v9H3z" />
      <path d="M13 10h4l4 3.5V16h-8z" />
      <circle cx="7" cy="18.5" r="1.75" />
      <circle cx="17.5" cy="18.5" r="1.75" />
    </Glyph>
  );
}

export function AlertsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </Glyph>
  );
}

export function PilotIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v3.5" />
      <path d="M12 17.5V21" />
      <path d="M3 12h3.5" />
      <path d="M17.5 12H21" />
    </Glyph>
  );
}

export function ConnectionsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9.5 14.5 6.7 17.3a3.8 3.8 0 0 1-5.4-5.4l2.9-2.9" />
      <path d="M14.5 9.5l2.8-2.8a3.8 3.8 0 0 1 5.4 5.4l-2.9 2.9" />
      <path d="M9 15l6-6" />
    </Glyph>
  );
}

export function AiIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3l1.9 4.4 4.6.6-3.4 3.2.9 4.6L12 13.6 7.9 15.8l.9-4.6L5.4 8l4.6-.6z" />
      <path d="M6 19h12" />
    </Glyph>
  );
}

export function MembersIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 18.5V20" />
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
      <path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8" />
    </Glyph>
  );
}

export function HealthIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </Glyph>
  );
}

export function DevicesIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2" y="4" width="14" height="10" rx="2" />
      <path d="M6 19h7" />
      <rect x="17" y="11" width="5" height="9" rx="1.5" />
    </Glyph>
  );
}

export function SecurityIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8.3-7.5 9.5-4.4-1.2-7.5-4.9-7.5-9.5V6z" />
      <path d="M9.5 12l1.8 1.8 3.4-3.6" />
    </Glyph>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.1 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.47V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47.97H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.46.97z" />
    </Glyph>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Glyph>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </Glyph>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Glyph>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Glyph>
  );
}
