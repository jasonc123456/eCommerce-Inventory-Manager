'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { CSRF_FIELD } from '../lib/csrf-field';
import {
  AiIcon,
  AlertsIcon,
  CloseIcon,
  ConnectionsIcon,
  DevicesIcon,
  HealthIcon,
  InventoryIcon,
  LocationsIcon,
  MappingsIcon,
  MembersIcon,
  MenuIcon,
  OperationsIcon,
  OverviewIcon,
  PilotIcon,
  PlusIcon,
  SecurityIcon,
  SettingsIcon,
  ShippingIcon,
  SignOutIcon,
} from './icons';

/**
 * The navigation shell (section 21).
 *
 * A sidebar rather than a row of links, for a reason that is about the product
 * rather than about fashion: there are fifteen destinations, they fall into four
 * unrelated groups, and a wrapping row of underlined text gives no hint which
 * group a screen belongs to or which one you are looking at. Grouped vertical
 * navigation answers both without being read.
 *
 * Three accessibility decisions worth stating.
 *
 * Every link is in the document in source order and none carries a positive
 * `tabIndex`, so keyboard order is reading order — WCAG 2.4.3.
 *
 * The current page is marked with `aria-current="page"`, and the styling hangs
 * off that attribute rather than off a class the component computes. The
 * announcement and the appearance therefore cannot disagree, which is the usual
 * way an "active" state ends up lying to a screen reader.
 *
 * Nothing is hidden from the sidebar based on permission. Health is an
 * installation screen and most operators cannot open it, but the screen itself
 * refuses them; hiding the link would mean deciding who may see it in two
 * places, and only one of those is the server.
 */

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly Icon: (props: { className?: string }) => ReactNode;
  /** Also active for child routes. False where a prefix would over-match. */
  readonly exact?: boolean;
}

interface NavSection {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

const SECTIONS: readonly NavSection[] = [
  {
    heading: 'Stock',
    items: [
      { href: '/', label: 'Overview', Icon: OverviewIcon, exact: true },
      { href: '/inventory', label: 'Inventory', Icon: InventoryIcon },
      { href: '/inventory/locations', label: 'Locations', Icon: LocationsIcon, exact: true },
      { href: '/mappings', label: 'Mappings', Icon: MappingsIcon },
    ],
  },
  {
    heading: 'Selling',
    items: [
      { href: '/operations', label: 'Drafts and prices', Icon: OperationsIcon },
      { href: '/shipping', label: 'Shipping', Icon: ShippingIcon },
    ],
  },
  {
    heading: 'Running it',
    items: [
      { href: '/alerts', label: 'Alerts', Icon: AlertsIcon },
      { href: '/pilot', label: 'Pilot', Icon: PilotIcon },
      { href: '/connections', label: 'Connections', Icon: ConnectionsIcon },
      { href: '/health', label: 'Health', Icon: HealthIcon },
    ],
  },
  {
    heading: 'Settings',
    items: [
      { href: '/settings', label: 'Business', Icon: SettingsIcon },
      { href: '/members', label: 'Members', Icon: MembersIcon },
      { href: '/ai', label: 'AI', Icon: AiIcon },
      { href: '/account/sessions', label: 'Devices', Icon: DevicesIcon },
      { href: '/account/security', label: 'Security', Icon: SecurityIcon },
    ],
  },
];

export interface BusinessOption {
  readonly businessId: string;
  readonly name: string;
  readonly role: string;
}

export interface SidebarProps {
  readonly businesses: readonly BusinessOption[];
  readonly activeBusinessId: string | null;
  readonly userEmail: string;
  readonly csrf: string;
  readonly switchAction: (form: FormData) => Promise<void>;
  readonly signOutAction: (form: FormData) => Promise<void>;
}

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact === true ? pathname === item.href : pathname.startsWith(item.href);
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="tone-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
        aria-hidden="true"
      >
        IM
      </span>
      <span className="truncate text-sm font-semibold tracking-tight">Inventory Manager</span>
    </div>
  );
}

function BusinessPicker({
  businesses,
  activeBusinessId,
  csrf,
  switchAction,
  onNavigate,
}: Pick<SidebarProps, 'businesses' | 'activeBusinessId' | 'csrf' | 'switchAction'> & {
  onNavigate?: () => void;
}) {
  if (businesses.length === 0) {
    return (
      <Link
        href="/businesses/new"
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
        className="btn-primary flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <PlusIcon className="h-4 w-4" />
        Create a business
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <form action={switchAction} className="flex items-center gap-2">
        <input type="hidden" name={CSRF_FIELD} value={csrf} />
        <label htmlFor="business-switcher" className="sr-only">
          Active business
        </label>
        {/* Submits with the button beside it rather than on change: section 21
            wants this usable without JavaScript, and an onChange submit is
            invisible to somebody arrowing through the options with a keyboard. */}
        <select
          id="business-switcher"
          name="businessId"
          defaultValue={activeBusinessId ?? businesses[0]?.businessId}
          className="control min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {businesses.map((business) => (
            <option key={business.businessId} value={business.businessId}>
              {business.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="btn-secondary shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Switch
        </button>
      </form>

      <Link
        href="/businesses/new"
        {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
        className="text-muted inline-flex items-center gap-1.5 text-xs hover:underline"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        New business
      </Link>
    </div>
  );
}

function SidebarBody({
  businesses,
  activeBusinessId,
  userEmail,
  csrf,
  switchAction,
  signOutAction,
  onNavigate,
}: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hairline flex flex-col gap-3 border-b px-4 py-4">
        <BrandMark />
        <BusinessPicker
          businesses={businesses}
          activeBusinessId={activeBusinessId}
          csrf={csrf}
          switchAction={switchAction}
          {...(onNavigate === undefined ? {} : { onNavigate })}
        />
      </div>

      <nav aria-label="Sections" className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {SECTIONS.map((section) => (
          <div key={section.heading} className="mb-4 last:mb-0">
            <h2 className="app-nav-section px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider">
              {section.heading}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active = isActive(pathname, item);

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                      {...(active ? { 'aria-current': 'page' as const } : {})}
                      className="app-nav-link relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <item.Icon className="h-[1.125rem] w-[1.125rem] shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="hairline flex flex-col gap-2 border-t px-4 py-3">
        <p className="text-subtle truncate text-xs" title={userEmail}>
          {userEmail}
        </p>
        <form action={signOutAction}>
          <input type="hidden" name={CSRF_FIELD} value={csrf} />
          <button
            type="submit"
            className="app-nav-link flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <SignOutIcon className="h-[1.125rem] w-[1.125rem] shrink-0" />
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

/** The persistent panel, from the medium breakpoint up. */
export function AppSidebar(props: SidebarProps) {
  return (
    <aside className="app-sidebar hidden w-64 shrink-0 border-r md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
      <SidebarBody {...props} />
    </aside>
  );
}

/**
 * The narrow-screen bar and its drawer.
 *
 * The drawer is rendered in the document at all times and moved off-screen
 * rather than unmounted, so opening it does not re-run the layout's data
 * loading. It is marked `inert` when closed, which takes its links out of the
 * tab order — a transform alone would leave them focusable behind the page,
 * which is the classic way a mobile menu traps a keyboard user.
 */
export function AppTopBar(props: SidebarProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <header className="app-sidebar hairline sticky top-0 z-30 flex items-center justify-between border-b px-3 py-2.5 md:hidden">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          aria-expanded={open}
          aria-controls="mobile-navigation"
          className="app-nav-link flex h-10 w-10 items-center justify-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <MenuIcon className="h-5 w-5" />
          <span className="sr-only">Open navigation</span>
        </button>

        <BrandMark />

        <span className="h-10 w-10" aria-hidden="true" />
      </header>

      <div
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-200 md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
        onClick={() => {
          setOpen(false);
        }}
      />

      <div
        id="mobile-navigation"
        inert={open ? undefined : true}
        className={`app-sidebar fixed inset-y-0 left-0 z-50 flex w-[min(85vw,17rem)] flex-col border-r shadow-xl transition-transform duration-200 ease-out md:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="hairline flex items-center justify-end border-b px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="app-nav-link flex h-10 w-10 items-center justify-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <CloseIcon className="h-5 w-5" />
            <span className="sr-only">Close navigation</span>
          </button>
        </div>

        <SidebarBody
          {...props}
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </div>
    </>
  );
}
