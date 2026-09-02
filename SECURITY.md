# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/mcp-internal-hosts/security/advisories/new).
Do not open a public issue for an unpatched vulnerability.

Only the latest release and the current `main` branch receive security fixes.

## Trust model

**Read this before using it as a defence.** This library is a _classifier_. It
answers a question about a string and connects to nothing. `internalHostKind` is
exact and has no failure mode beyond a wrong answer; the resolving layer is a
different matter.

**`firstInternalAddress` and `internalHostsAmong` are fail-open by design.** A name
that does not resolve, resolves to nothing, or answers slower than the timeout comes
back as routable. Two of those three are switches the other side holds: whoever is
authoritative for a name can answer slowly, or not at all, on purpose. And a DNS
record can change between this answer and the socket that follows it — the classic
rebinding window, which no check-then-connect design closes.

So: **this is a barrier against the easy case, never the boundary.** For blocking at
connect time, after redirects, against the address actually dialled, use a filtering
agent such as
[`request-filtering-agent`](https://www.npmjs.com/package/request-filtering-agent).
A serious deployment wants both layers, and this one is the cheaper, earlier, weaker
of the two.

## What is deliberately not classified as internal

Private LAN ranges — `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`. A self-hosted
service legitimately talks to another machine on its own network, and refusing that
would break the normal case for the people most likely to run it. If your threat
model needs those refused, that is a policy your caller adds on top; it is not a
property of the host.

A resolver answering `0.0.0.0` or `::` is reported as routable, not as loopback.
That is a sinkhole — every ad blocker and corporate DNS filter does it — and it is
the resolver declining to answer rather than the name addressing your machine.

Be clear about what that costs. On Linux and macOS, `connect()` to `0.0.0.0`
reaches the loopback services of the machine that dials it, so a name with an
authoritative `0.0.0.0` record does get past this check. It is skipped anyway,
for the same reason `NXDOMAIN` is: the answer describes _your_ resolver, and in
the deployments this library is written for the fetch happens elsewhere —
deciding on it would refuse sinkholed domains on behalf of a fetcher that would
never have seen the record. The literal `0.0.0.0` is a different question and is
classified as loopback.

If your own process is the one that connects, this is one of the cases a
classifier cannot close for you: use a connect-time filter such as
`request-filtering-agent`, which checks after resolution rather than before it.
