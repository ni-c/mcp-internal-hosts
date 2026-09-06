import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalHostKind } from '../src/index.js';

/**
 * Properties of the classifier, as opposed to the spellings in
 * `classify.test.ts`.
 *
 * The example tests name the spellings someone thought of. That is exactly the
 * weakness this library exists to cover: its own header says the spellings
 * differ more than they look, and the two bugs its comments record were both a
 * spelling nobody had listed — `[::ffff:6464:64c8]` walking past the Alibaba
 * metadata check, and a `%zone` suffix desynchronising `bareHost` from `isIP`.
 * A property says "every spelling of this address agrees" and lets fast-check
 * look for the one that does not.
 *
 * This matters more here than anywhere else in the fleet: nine servers import
 * this function, and a false `null` is an SSRF hole in all of them at once.
 */

const RUNS = { numRuns: 500 };

/**
 * How an IPv4 address can be carried by an IPv6 literal.
 *
 * `null` is the address itself, unwrapped; the rest are the four prefixes whose
 * whole purpose is to stand in for an IPv4 address, and which `ipv4Kind`
 * therefore has to see through.
 */
const wrappings = [
  null, // plain dotted-quad
  '::ffff:', // IPv4-mapped, RFC 4291
  '::', // IPv4-compatible
  '::ffff:0:', // IPv4-translated, RFC 2765
  '64:ff9b::', // NAT64, RFC 6052
] as const;

/**
 * Every spelling of one host that names the same host.
 *
 * Deliberately only the shapes something actually emits. Brackets are the
 * outermost wrapper and a zone id goes *inside* them, which is what RFC 6874
 * writes and what `URL` hands over; a stray character after the closing bracket
 * is not a spelling of the address, it is a different string. Generating those
 * too found that `bareHost` leaves the bracket on when one follows — true, and
 * reachable from nothing, since the value comes from `URL` or a resolver and
 * neither writes it. Pinning it would have meant hardening a path against an
 * input that does not exist.
 */
const equivalents = (host: string, isIpv6: boolean): string[] => {
  const bare = [host, host.toUpperCase(), `${host}.`, `${host}...`];
  if (!isIpv6) return bare;
  return [...bare, `${host}%eth0`, `[${host}]`, `[${host}%eth0]`];
};

/** The spellings of one IPv4 address, through one wrapping. */
const spellings = (address: string, prefix: string | null): string[] =>
  prefix === null
    ? equivalents(address, false)
    : equivalents(`${prefix}${address}`, true);

const octet = fc.integer({ min: 0, max: 255 });

const loopbackV4 = fc
  .tuple(fc.constantFrom(0, 127), octet, octet, octet)
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const linkLocalV4 = fc.tuple(octet, octet).map(([c, d]) => `169.254.${c}.${d}`);

/** Addresses that are routable, and must never come back as internal. */
const routableV4 = fc
  .tuple(
    fc.integer({ min: 1, max: 223 }).filter((a) => a !== 127 && a !== 169),
    octet,
    octet,
    octet
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

describe('the classifier is total', () => {
  /**
   * No input throws, and the answer is always one of the three the type names.
   *
   * Every caller runs this on a hostname taken from configuration or from a
   * tool argument, on the first line and before any length or shape check. An
   * exception here is not a wrong answer, it is the server falling over on a
   * string somebody chose.
   */
  it('any string classifies without throwing', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (host) => {
        const kind = internalHostKind(host);
        expect(
          kind === null || kind === 'loopback' || kind === 'link-local'
        ).toBe(true);
      }),
      RUNS
    );
  });

  /**
   * The trailing-dot walk stays linear.
   *
   * `bareHost` used to strip trailing dots with `/\.+$/`, which backtracks
   * quadratically: the comment in `index.ts` records 11.8 seconds for a
   * hostname of 150k dots, which `new URL()` accepts because IDNA does not
   * enforce the DNS length limit. Node is single-threaded, so that was the
   * whole server. The loop that replaced it is what this pins.
   */
  it('a hostname of many dots is classified in linear time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 10_000, max: 150_000 }), (count) => {
        const started = performance.now();
        expect(internalHostKind('.'.repeat(count))).toBeNull();
        expect(performance.now() - started).toBeLessThan(250);
      }),
      { numRuns: 20 }
    );
  });
});

describe('every spelling of an address agrees', () => {
  /**
   * The property the library is named for.
   *
   * An IPv4 loopback address stays loopback through all four IPv6 wrappings,
   * in brackets or without, upper case, with a root label, with a scope id.
   * `[::ffff:6464:64c8]` — the Alibaba metadata endpoint written the way `URL`
   * canonicalises a mapped literal — is the case that was once missed, and it
   * is one draw of this generator rather than a line someone remembered to add.
   */
  it('a loopback address is loopback however it is written', () => {
    fc.assert(
      fc.property(
        loopbackV4,
        fc.constantFrom(...wrappings),
        (address, prefix) => {
          for (const spelling of spellings(address, prefix)) {
            expect(internalHostKind(spelling)).toBe('loopback');
          }
        }
      ),
      RUNS
    );
  });

  it('a link-local address is link-local however it is written', () => {
    fc.assert(
      fc.property(
        linkLocalV4,
        fc.constantFrom(...wrappings),
        (address, prefix) => {
          for (const spelling of spellings(address, prefix)) {
            expect(internalHostKind(spelling)).toBe('link-local');
          }
        }
      ),
      RUNS
    );
  });

  /**
   * The metadata endpoints that sit outside 169.254/16 inherit every unwrapping.
   *
   * Held as octets rather than as a set of dotted strings precisely so that
   * they do. A set only ever matched one spelling, which is how the mapped form
   * got past the single check that existed for it.
   */
  it('the metadata endpoints outside 169.254/16 survive every wrapping', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('100.100.100.200', '192.0.0.192'),
        fc.constantFrom(...wrappings),
        (address, prefix) => {
          for (const spelling of spellings(address, prefix)) {
            expect(internalHostKind(spelling)).toBe('link-local');
          }
        }
      ),
      RUNS
    );
  });

  it('localhost and its subdomains are loopback however they are written', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,10}$/), (label) => {
        for (const spelling of equivalents(`${label}.localhost`, false)) {
          expect(internalHostKind(spelling)).toBe('loopback');
        }
      }),
      RUNS
    );
  });
});

describe('routable addresses stay routable', () => {
  /**
   * The other direction, which matters just as much.
   *
   * A classifier that answered `loopback` too eagerly would make every caller
   * refuse hosts it should reach — and the fix for that is usually to loosen
   * the check, which is how a hole gets opened. Stating both directions means
   * neither can be traded for the other unnoticed.
   */
  it('a routable IPv4 address is never internal, in any wrapping', () => {
    fc.assert(
      fc.property(
        routableV4,
        fc.constantFrom(...wrappings),
        (address, prefix) => {
          for (const spelling of spellings(address, prefix)) {
            expect(internalHostKind(spelling)).toBeNull();
          }
        }
      ),
      RUNS
    );
  });

  it('a public hostname is never internal', () => {
    fc.assert(
      fc.property(fc.domain(), (domain) => {
        fc.pre(!domain.endsWith('.localhost'));
        expect(internalHostKind(domain)).toBeNull();
      }),
      RUNS
    );
  });
});
