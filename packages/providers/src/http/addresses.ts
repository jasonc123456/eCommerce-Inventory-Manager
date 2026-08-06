/**
 * Which network addresses an integration is allowed to reach (section 19).
 *
 * Every destination in this application is ultimately chosen by a person typing
 * a store URL into a form. That makes each outbound request a request an
 * attacker can aim, and the interesting targets are not on the internet: they
 * are the database on the internal network, the proxy's admin port, and the
 * cloud metadata service that will hand out credentials to anything that asks.
 *
 * So the rule is an allowlist of the public internet rather than a blocklist of
 * known-bad hosts. A blocklist has to be complete to work; this only has to be
 * correct about what a public address is.
 *
 * Self-hosters do legitimately run WooCommerce on their own network, which
 * section 19 permits through an installation-level exception. The exception
 * widens the private ranges and never widens the metadata ones — an operator
 * who allows `10.0.0.0/8` for their store has not agreed to expose their cloud
 * credentials, and the two are not distinguishable to them at the point where
 * they type the CIDR.
 */

export interface AddressPolicy {
  /** Whether the installation has opted into private-network destinations. */
  readonly allowPrivate: boolean;
  /**
   * Exact hosts or CIDRs the operator allowed, checked only when `allowPrivate`
   * is set. An empty list with the flag on means "any private address", which
   * is what a development installation on an unpredictable Docker network
   * needs.
   */
  readonly allowlist: readonly string[];
}

export type AddressVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOWED = { allowed: true } as const;

/**
 * Addresses that hand out credentials to whoever connects.
 *
 * Refused unconditionally. These are link-local or private addresses, so the
 * general rules already cover them when the exception is off; they are named
 * separately because the exception must not cover them when it is on.
 */
const METADATA_ADDRESSES: readonly string[] = [
  // AWS, Azure, Google, and everything that copied the convention.
  '169.254.169.254',
  // Google's alternate metadata name resolves here.
  '169.254.169.253',
  // Oracle Cloud.
  '192.0.0.192',
  // Alibaba Cloud.
  '100.100.100.200',
  // The IPv6 forms AWS and Google publish.
  'fd00:ec2::254',
  'fe80::a9fe:a9fe',
];

/** Whether this is one of the credential-serving addresses. Never allowed. */
export function isMetadataAddress(address: string): boolean {
  const normalized = normalize(address);

  return normalized !== null && METADATA_ADDRESSES.some((entry) => normalize(entry) === normalized);
}

/**
 * Decides whether a resolved address may be connected to.
 *
 * Takes an address, never a hostname: by the time this is asked, DNS has
 * already happened and the answer is about the thing we would actually open a
 * socket to. Asking about a name would leave the gap between the check and the
 * connection that DNS rebinding exists to exploit.
 */
export function classifyAddress(address: string, policy: AddressPolicy): AddressVerdict {
  const normalized = normalize(address);

  if (normalized === null) {
    return { allowed: false, reason: 'the address could not be parsed' };
  }

  if (isMetadataAddress(normalized)) {
    // Before the exception, deliberately. This is the one refusal an operator
    // cannot opt out of.
    return { allowed: false, reason: 'cloud metadata addresses are never permitted' };
  }

  const category = categorize(normalized);

  if (category === 'public') {
    return ALLOWED;
  }

  if (!policy.allowPrivate) {
    return {
      allowed: false,
      reason: `${category} addresses are not permitted; enable private integration hosts to allow them`,
    };
  }

  if (policy.allowlist.length === 0) {
    return ALLOWED;
  }

  const permitted = policy.allowlist.some((entry) => matches(normalized, entry));

  return permitted
    ? ALLOWED
    : { allowed: false, reason: 'the address is not in the private host allowlist' };
}

type Category =
  'public' | 'loopback' | 'private' | 'link-local' | 'multicast' | 'unspecified' | 'reserved';

/**
 * What kind of address this is.
 *
 * Written out rather than delegated to a library because the categories are the
 * security boundary, and a dependency that reclassified one of them in a patch
 * release would move that boundary without anybody reviewing it.
 */
export function categorize(address: string): Category {
  const v4 = parseIPv4(address);

  if (v4 !== null) {
    return categorizeIPv4(v4);
  }

  const v6 = parseIPv6(address);

  if (v6 === null) {
    return 'reserved';
  }

  // An IPv4-mapped address is an IPv4 destination wearing IPv6 notation, and
  // `::ffff:127.0.0.1` reaches the loopback exactly as `127.0.0.1` does.
  const mapped = mappedIPv4(v6);

  if (mapped !== null) {
    return categorizeIPv4(mapped);
  }

  return categorizeIPv6(v6);
}

function categorizeIPv4(octets: readonly number[]): Category {
  const [a = 0, b = 0, c = 0, d = 0] = octets;

  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT. Not routable on the public internet, and on a hosted
  // machine it is as internal as the private ranges.
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 are documentation ranges and
  // 192.0.0.0/24 is IETF protocol assignments. None of them host a real store.
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'reserved';
  if (a === 198 && b === 51 && c === 100) return 'reserved';
  if (a === 203 && b === 0 && c === 113) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'reserved';

  return 'public';
}

function categorizeIPv6(groups: readonly number[]): Category {
  const [first = 0] = groups;

  if (groups.every((group) => group === 0)) return 'unspecified';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback';
  // fe80::/10.
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  // fc00::/7, unique local.
  if ((first & 0xfe00) === 0xfc00) return 'private';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  // 2001:db8::/32, documentation.
  if (first === 0x2001 && groups[1] === 0x0db8) return 'reserved';
  // 64:ff9b::/96 and friends translate to IPv4 and would smuggle a private
  // destination past an IPv6-shaped check.
  if (first === 0x0064 && groups[1] === 0xff9b) return 'reserved';

  return 'public';
}

/** Whether an address falls inside a CIDR, or equals a bare address. */
export function matches(address: string, entry: string): boolean {
  const slash = entry.indexOf('/');

  if (slash === -1) {
    const normalizedEntry = normalize(entry);

    return normalizedEntry !== null && normalizedEntry === normalize(address);
  }

  const network = entry.slice(0, slash);
  const prefix = Number.parseInt(entry.slice(slash + 1), 10);

  if (!Number.isInteger(prefix) || prefix < 0) {
    return false;
  }

  const addressBits = toBits(address);
  const networkBits = toBits(network);

  if (addressBits === null || networkBits === null) {
    return false;
  }

  // Different families never match, which is not an error: an operator may
  // legitimately list both an IPv4 and an IPv6 range for the same store.
  if (addressBits.length !== networkBits.length || prefix > networkBits.length) {
    return false;
  }

  return addressBits.slice(0, prefix) === networkBits.slice(0, prefix);
}

/**
 * Canonical form, so two spellings of one address compare equal.
 *
 * Returns null for anything that is not an address at all, which callers treat
 * as a refusal rather than as a pass.
 */
export function normalize(address: string): string | null {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');

  const v4 = parseIPv4(trimmed);

  if (v4 !== null) {
    return v4.join('.');
  }

  const v6 = parseIPv6(trimmed);

  if (v6 === null) {
    return null;
  }

  const mapped = mappedIPv4(v6);

  if (mapped !== null) {
    return mapped.join('.');
  }

  return v6.map((group) => group.toString(16)).join(':');
}

function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');

  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];

  for (const part of parts) {
    // Rejecting leading zeros deliberately: `010` is octal to some resolvers
    // and decimal to others, and an address that means two things is a way past
    // a check that only sees one of them.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return null;
    }

    const octet = Number.parseInt(part, 10);

    if (octet > 255) {
      return null;
    }

    octets.push(octet);
  }

  return octets;
}

function parseIPv6(value: string): number[] | null {
  const withoutZone = value.split('%')[0] ?? '';

  if (!withoutZone.includes(':')) {
    return null;
  }

  const halves = withoutZone.split('::');

  if (halves.length > 2) {
    return null;
  }

  const expand = (part: string): number[] | null => {
    if (part === '') {
      return [];
    }

    const groups: number[] = [];

    for (const piece of part.split(':')) {
      // A trailing IPv4 form, as in `::ffff:203.0.113.4`.
      if (piece.includes('.')) {
        const octets = parseIPv4(piece);

        if (octets === null) {
          return null;
        }

        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
        continue;
      }

      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        return null;
      }

      groups.push(Number.parseInt(piece, 16));
    }

    return groups;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];

  if (head === null || tail === null) {
    return null;
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }

  const missing = 8 - head.length - tail.length;

  if (missing < 1) {
    return null;
  }

  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function mappedIPv4(groups: readonly number[]): number[] | null {
  const isMapped =
    groups.slice(0, 5).every((group) => group === 0) &&
    (groups[5] === 0xffff || (groups[5] === 0 && (groups[6] ?? 0) !== 0));

  if (!isMapped) {
    return null;
  }

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;

  // `::1` is the loopback, not `0.0.0.1`. Treating it as IPv4-compatible would
  // reclassify the one address most worth refusing.
  if (groups[5] === 0 && high === 0 && low <= 1) {
    return null;
  }

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function toBits(address: string): string | null {
  const v4 = parseIPv4(address);

  if (v4 !== null) {
    return v4.map((octet) => octet.toString(2).padStart(8, '0')).join('');
  }

  const v6 = parseIPv6(address);

  return v6 === null ? null : v6.map((group) => group.toString(2).padStart(16, '0')).join('');
}
