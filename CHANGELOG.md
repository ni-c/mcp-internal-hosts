# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

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
