# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

## [0.2.1] - 2026-09-02

### Fixed

- The two metadata endpoints outside `169.254/16` — Alibaba's
  `100.100.100.200` and Oracle's `192.0.0.192` — were held in a set of
  dotted-decimal strings and compared as strings. Every spelling this package
  exists for therefore walked past them: `URL` canonicalises
  `http://[::ffff:100.100.100.200]/` to `[::ffff:6464:64c8]`, the kernel dials
  that as plain IPv4, and the classifier answered `null`. The same address in
  dotted form answered `link-local`.

  They are now compared on the octets inside `ipv4Kind`, so they inherit every
  unwrapping the IPv6 path already does — mapped, IPv4-compatible,
  IPv4-translated and NAT64. The set is gone.

  The tests had both axes and never crossed them: one block covered mapped and
  NAT64 spellings, but only for `127.0.0.1` and `169.254.169.254`; another
  covered these two addresses, but only in dotted decimal. That crossing is now
  a test, along with the neighbouring addresses, so the octet comparison cannot
  quietly widen into a `/24`.

- Trimming the root label used `/\.+$/`, which is quadratic on a host of dots
  with no match: the engine retries from every start position, consumes to the
  end and backtracks. `new URL()` accepts a hostname of any length — IDNA does
  not enforce the DNS limit — and this runs on the first line of every exported
  function, before anything checks a length. A 150k-dot hostname held the event
  loop for 11.8 seconds; Node is single-threaded, so that is the whole server,
  not one call. It now walks back from the end by index: the same input takes
  0.1 ms, and 400k dots stay linear at 0.5 ms.

### Changed

- The comment and `SECURITY.md` no longer claim that nothing is reachable
  through a sinkholed `0.0.0.0`. That was measured and it is false — `connect()`
  to `0.0.0.0` reaches loopback on Linux and macOS. The behaviour is unchanged
  and deliberately so: the answer describes this resolver, not the fetcher, and
  refusing on it would break sinkholed domains for every caller whose fetch
  happens elsewhere. What changed is that the limitation is now written down
  where a caller looks for it, with the pointer to a connect-time filter for
  anyone whose own process does the connecting.

## [0.2.0] - 2026-09-01

### Added

- `stopAtFirst` on `internalHostsAmong`, for the caller whose answer is a
  refusal rather than a report. Found by migrating a server that throws on the
  first internal host and therefore stops resolving: without the option it would
  have traded an immediate refusal for the full ten-second DNS budget on a list
  of a thousand feeds. Off by default — the common question is _which_ of these
  are internal, and a partial answer would be worse than useless there.

  Concurrency is kept, so the batch in flight finishes and the map may hold more
  than one entry; what is guaranteed is that no further batch starts. A literal
  hit short-circuits before any lookup at all.

## [0.1.0] - 2026-09-01

First release. The classifier is lifted verbatim from nine MCP servers where it
was byte-identical; the resolving layer is the union of the three that had
grown one.

### Added

- `internalHostKind` — loopback, link-local and cloud-metadata hostnames,
  decided numerically rather than by string comparison. That is the whole point:
  `URL` rewrites an IPv4-mapped literal into hex before any check sees it, a
  resolver hands the same address back in dotted form with a scope id attached,
  and `localhost.` is the same name as `localhost`.
- The metadata endpoints outside `169.254/16` — Alibaba's `100.100.100.200` and
  Oracle's legacy `192.0.0.192`. Neither is link-local by address; both are by
  purpose.
- `firstInternalAddress` — resolves a name too, because a literal check alone is
  a guard that any attacker-controlled domain walks around by publishing one
  record. Fail-open by design, and documented as such.
- `internalHostsAmong` — the same question for a list, with a shared budget and
  batched lookups. Literals are decided first and without any budget, so a list
  long enough to exhaust the resolver's time cannot let an obvious
  `169.254.169.254` through on the way past.
- A sinkholed answer (`0.0.0.0`, `::`) is not reported as loopback. That is the
  resolver declining to answer, not the name addressing this machine.

<!-- #endregion changelog -->

[0.1.0]: https://github.com/ni-c/mcp-internal-hosts/releases/tag/v0.1.0
