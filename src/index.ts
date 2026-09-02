import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Is this host only reachable from where the caller stands?
 *
 * A classifier, not a request guard. It answers a question about a string and
 * fetches nothing; it is meant for the moment a URL is *configured* or accepted
 * as an argument, so the answer can be a clear refusal or a startup warning
 * rather than a connection that mysteriously succeeds against the wrong
 * machine. For blocking at connect time — after redirects, against a record
 * that changed between the check and the socket — use a filtering agent such as
 * `request-filtering-agent`. The two are different layers and a serious
 * deployment wants both.
 */

/**
 * Why a host is only reachable from the machine it is named on: `loopback`
 * addresses that machine itself, `link-local` covers 169.254/16, fe80::/10 and
 * the handful of addresses cloud providers put their metadata service on.
 */
export type InternalHostKind = 'loopback' | 'link-local';

/**
 * Names for the cloud metadata service, which resolve on an instance and
 * nowhere else.
 */
const METADATA_NAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Classifies a hostname that addresses the machine itself, its link-local
 * range, or a cloud metadata service — or returns null for anything routable.
 *
 * It does the job numerically rather than by comparing strings, because the
 * spellings differ more than they look. `URL` canonicalises an IPv4-mapped IPv6
 * literal into hex — `http://[::ffff:127.0.0.1]/` arrives here as
 * `[::ffff:7f00:1]` — while every dual-stack client dials it as plain
 * 127.0.0.1, and `localhost.` with its root label is the same name as
 * `localhost`. String comparison misses both.
 *
 * Takes a hostname from anywhere, not only from `URL`: a resolver hands back
 * `::ffff:127.0.0.1` in dotted form and may attach a `%zone` suffix, so both
 * are handled here rather than assumed away.
 */
export function internalHostKind(hostname: string): InternalHostKind | null {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (METADATA_NAMES.has(host)) return 'link-local';

  const version = isIP(host);
  if (version === 4) return ipv4Kind(host.split('.').map(Number));
  if (version !== 6) return null;

  const groups = expandIpv6(host);
  if (groups === null) return null;
  const explicit = ipv6Kind(groups);
  if (explicit !== null) return explicit;
  const embedded = embeddedIpv4(groups);
  return embedded === null ? null : ipv4Kind(embedded);
}

function bareHost(hostname: string): string {
  const host = hostname
    .toLowerCase()
    // URL.hostname keeps the brackets around an IPv6 literal, so a bare '::1'
    // would never match.
    .replace(/^\[|]$/g, '')
    // A scope id belongs to the interface, not to the address. `isIP` accepts
    // it, so leaving it on would desynchronise every check below from what
    // `isIP` just agreed was an address.
    .replace(/%.*$/, '');

  // 'localhost.' is the same name as 'localhost' — the root label is what makes
  // it fully qualified, not a different host.
  //
  // Walked back from the end rather than matched with /\.+$/, which is
  // quadratic: on a host that is all dots the engine tries every start
  // position, consumes to the end, fails the anchor and backtracks. A hostname
  // of 150k dots — which `new URL()` accepts, because IDNA does not enforce the
  // DNS length limit — spent 11.8 seconds here, and this runs before any
  // length check, on the first line of every exported function. Node is
  // single-threaded, so that is the whole server, not one call.
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end--;
  return host.slice(0, end);
}

/**
 * How long one name gets to resolve before the check gives up on it.
 *
 * Override per call. The default is short on purpose: whoever is authoritative
 * for a name decides how slowly it answers.
 */
const DNS_TIMEOUT_MS = 3000;

/** Names resolved at once, so a long list does not open one lookup per entry. */
const DNS_CONCURRENCY = 8;

/**
 * How long the resolving half may take in total, across every name in one call.
 *
 * A list may hold thousands of hosts, and against a resolver that black-holes
 * queries the lookups alone would outlast any sane tool call — so once the
 * budget is spent the remaining names are treated like names that did not
 * resolve.
 */
const DNS_BUDGET_MS = 10_000;

export interface ResolveOptions {
  /** Per-name timeout in milliseconds. Default 3000. */
  timeoutMs?: number;
  /** Names resolved at once. Default 8. */
  concurrency?: number;
  /** Total budget across every name in one call, in milliseconds. Default 10000. */
  budgetMs?: number;
  /**
   * Stop as soon as one internal host is found. Only for
   * {@link internalHostsAmong}.
   *
   * Default false, because the common question is "which of these are internal"
   * and a partial answer would be worse than useless there. Set it when the
   * answer is a yes/no that ends in a refusal: a caller that throws on the first
   * hit has no use for the rest, and resolving them can cost the whole budget.
   * A list of a thousand feeds whose first entry points at 127.0.0.1 is the case
   * this exists for — it is the difference between immediate and ten seconds.
   *
   * Concurrency is kept either way: the batch already in flight finishes, so the
   * returned map may hold more than one entry. What is guaranteed is that no
   * *further* batch is started.
   */
  stopAtFirst?: boolean;
}

/**
 * The first address behind a hostname that is not routable, or null.
 *
 * A literal is decided outright. A name is additionally resolved, because
 * nothing stops a DNS record from pointing at 127.0.0.1 or 169.254.169.254 — a
 * literal check alone is a guard that any attacker-controlled domain walks
 * around by publishing one record.
 *
 * **This half is deliberately fail-open, and a caller has to know it.** A name
 * that does not resolve here, resolves to nothing, or takes longer than the
 * timeout is reported as routable. The first case is a real setup — the
 * fetching server may sit in a different network with its own resolver — but
 * the last one is a switch the other side holds, since whoever is authoritative
 * for a name can simply answer slowly. And a record can change between this
 * answer and the socket that follows it. Treat this as a barrier against the
 * easy case, never as the boundary.
 */
export async function firstInternalAddress(
  hostname: string,
  options: ResolveOptions = {}
): Promise<{ address: string; kind: InternalHostKind } | null> {
  const host = bareHost(hostname);
  const literal = internalHostKind(host);
  if (literal !== null) return { address: host, kind: literal };
  if (isIP(host) !== 0 || host === '') return null;

  for (const address of await resolveQuietly(
    host,
    options.timeoutMs ?? DNS_TIMEOUT_MS
  )) {
    // A resolver that sinkholes a name answers 0.0.0.0 or ::, and that is what
    // every ad blocker and every corporate DNS filter does. It is the resolver
    // declining to answer, not the name addressing this machine — reporting it
    // as loopback would misdescribe it and make every blocklisted domain
    // unusable.
    //
    // Note what this does *not* claim. On Linux and macOS, connect() to
    // 0.0.0.0 reaches this machine's loopback services, so a name with an
    // authoritative 0.0.0.0 record is a real way past this check — measured,
    // not theorised. It is skipped anyway, for the same reason NXDOMAIN is:
    // this answer describes *our* resolver, and in every caller of this library
    // the fetch happens somewhere else. Deciding on it would refuse sinkholed
    // domains for a fetcher that would never have seen the record. Whoever
    // fetches in-process needs a connect-time filter, not this classifier —
    // see SECURITY.md.
    if (isUnspecified(address)) continue;
    const kind = internalHostKind(address);
    if (kind !== null) return { address, kind };
  }
  return null;
}

/**
 * The same question for a list, with a shared budget.
 *
 * Returns only the hosts that came out internal, so an empty map means the
 * whole list is fine. Nothing is thrown: what a caller does with the answer —
 * refuse, warn, drop the entry — is not this library's decision.
 */
export async function internalHostsAmong(
  hostnames: readonly string[],
  options: ResolveOptions = {}
): Promise<Map<string, { address: string; kind: InternalHostKind }>> {
  const found = new Map<string, { address: string; kind: InternalHostKind }>();
  const concurrency = Math.max(1, options.concurrency ?? DNS_CONCURRENCY);
  const deadline = Date.now() + (options.budgetMs ?? DNS_BUDGET_MS);

  // Literals first and without any budget: they cost nothing and must never be
  // the entries a slow resolver squeezes out.
  const names: string[] = [];
  for (const hostname of hostnames) {
    const host = bareHost(hostname);
    const literal = internalHostKind(host);
    if (literal !== null) found.set(hostname, { address: host, kind: literal });
    else if (isIP(host) === 0 && host !== '') names.push(hostname);
  }

  // A literal hit already answers the yes/no question, and it cost no lookup —
  // so under `stopAtFirst` there is nothing left to resolve.
  if (options.stopAtFirst === true && found.size > 0) return found;

  for (let i = 0; i < names.length; i += concurrency) {
    if (Date.now() >= deadline) break;
    const batch = names.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(
        async (hostname) =>
          [hostname, await firstInternalAddress(hostname, options)] as const
      )
    );
    for (const [hostname, hit] of results)
      if (hit !== null) found.set(hostname, hit);
    if (options.stopAtFirst === true && found.size > 0) break;
  }
  return found;
}

/** True for `0.0.0.0` and `::`, in any spelling a resolver might return. */
function isUnspecified(address: string): boolean {
  const host = bareHost(address);
  if (isIP(host) === 4) return host.split('.').every((part) => part === '0');
  const groups = expandIpv6(host);
  return groups !== null && groups.every((group) => group === 0);
}

async function resolveQuietly(
  name: string,
  timeoutMs: number
): Promise<string[]> {
  try {
    const entries = await Promise.race([
      lookup(name, { all: true, verbatim: true }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref();
      }),
    ]);
    return entries === null ? [] : entries.map((entry) => entry.address);
  } catch {
    return [];
  }
}

/** Expands an IPv6 literal into its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  // A literal may end in dotted-quad notation (::ffff:127.0.0.1). Fold that tail
  // into the two hex groups it stands for so the rest of this is uniform.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = (dotted[1] ?? '')
      .split('.')
      .map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }

  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined ? null : tail === '' ? [] : tail.split(':');
  if (right === null) return toGroups(left);
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return toGroups([...left, ...Array<string>(missing).fill('0'), ...right]);
}

function toGroups(groups: string[]): number[] | null {
  if (groups.length !== 8) return null;
  // Tested rather than left to `parseInt`, which stops at the first character it
  // does not like and returns a number for '7f00xyz' just as happily.
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Extracts the IPv4 address an IPv6 literal carries, for the prefixes whose
 * whole purpose is to stand in for one.
 */
function embeddedIpv4(groups: number[]): number[] | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  const carriesIpv4 =
    // ::a.b.c.d (IPv4-compatible) and ::ffff:a.b.c.d (IPv4-mapped, RFC 4291).
    ((a | b | c | d | e) === 0 && (f === 0 || f === 0xffff)) ||
    // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765).
    ((a | b | c | d) === 0 && e === 0xffff && f === 0) ||
    // 64:ff9b::a.b.c.d — the well-known NAT64 prefix (RFC 6052).
    (a === 0x64 && b === 0xff9b && (c | d | e | f) === 0);
  return carriesIpv4 ? [g >> 8, g & 0xff, h >> 8, h & 0xff] : null;
}

function ipv4Kind(octets: number[]): InternalHostKind | null {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  // 0.0.0.0/8 ('this host', RFC 1122) and 127/8 both reach the machine itself.
  if (a === 0 || a === 127) return 'loopback';
  // 169.254/16, which holds 169.254.169.254 — the AWS/GCP/Azure metadata service.
  if (a === 169 && b === 254) return 'link-local';
  // The two metadata endpoints that sit outside 169.254/16: Alibaba Cloud
  // answers on 100.100.100.200, which is carrier-grade NAT space, and Oracle's
  // legacy endpoint is 192.0.0.192, which is IETF protocol assignments. Neither
  // is link-local by address, but both are the same thing by purpose.
  //
  // Compared on the octets, not held in a set of strings. A set only ever
  // matched dotted-decimal, so `[::ffff:6464:64c8]` — which is this address,
  // written the way `URL` canonicalises an IPv4-mapped literal — walked past
  // the one check that exists for it, in the one library whose whole point is
  // that spellings differ more than they look. Here the two inherit every
  // unwrapping above: mapped, compatible, translated and NAT64.
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'link-local';
  if (a === 192 && b === 0 && c === 0 && d === 192) return 'link-local';
  return null;
}

function ipv6Kind(groups: number[]): InternalHostKind | null {
  // `::` and `::1` are also caught by the IPv4-compatible unwrapping below, but
  // they are named here so that removing that unwrapping cannot silently take
  // the two most obvious loopback literals with it.
  if (groups.every((group) => group === 0)) return 'loopback'; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return 'loopback'; // ::1
  }
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return null;
}
