# mcp-internal-hosts

[![npm version](https://img.shields.io/npm/v/mcp-internal-hosts)](https://www.npmjs.com/package/mcp-internal-hosts)
[![node](https://img.shields.io/node/v/mcp-internal-hosts)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/mcp-internal-hosts)](LICENSE)

Is this host only reachable from where you stand? Classifies loopback,
link-local and cloud-metadata hostnames — numerically, in every spelling.

```ts
import { internalHostKind } from 'mcp-internal-hosts';

internalHostKind('169.254.169.254'); // 'link-local'
internalHostKind('[::ffff:127.0.0.1]'); // 'loopback'
internalHostKind('localhost.'); // 'loopback'
internalHostKind('metadata.google.internal'); // 'link-local'
internalHostKind('example.com'); // null
```

No dependencies.

## This is a classifier, not a request guard

It answers a question about a string and fetches nothing. It is for the moment a
URL is **configured** or accepted as an argument, so the answer can be a refusal
or a startup warning rather than a connection that mysteriously succeeds against
the wrong machine:

```
warning: SERVICE_URL points at 127.0.0.1. Inside a container that is the
container itself, not the host — you probably want the host's name here.
```

For blocking at **connect** time — after redirects, against a record that
changed between the check and the socket — use a filtering agent such as
[`request-filtering-agent`](https://www.npmjs.com/package/request-filtering-agent).
The two are different layers, and a serious deployment wants both. This package
does not try to be that one.

## Why not a regular expression

Because the spellings differ more than they look, and every one of these is a
real thing something hands you:

| Written                       | Arrives as        | Because                                                |
| ----------------------------- | ----------------- | ------------------------------------------------------ |
| `http://[::ffff:127.0.0.1]/`  | `[::ffff:7f00:1]` | `URL` canonicalises IPv4-mapped literals into hex      |
| `localhost.`                  | `localhost.`      | the root label makes it fully qualified, not different |
| `::ffff:169.254.169.254%eth0` | as written        | a resolver returns dotted form, with a scope id        |
| `http://2130706433/`          | `127.0.0.1`       | `URL` normalises decimal, octal and hex                |
| `0.0.0.0`                     | as written        | RFC 1122 "this host" — reaches the machine itself      |

So each literal is reduced to the address it carries and compared numerically;
only real names are matched as text. A string comparison misses the first three
rows, which is what this replaced.

Also covered: the metadata endpoints no range check reaches. Alibaba Cloud
answers on `100.100.100.200` (carrier-grade NAT space) and Oracle's legacy
endpoint is `192.0.0.192` (IETF protocol assignments). Neither is link-local by
address; both are by purpose.

## What is deliberately _not_ internal

Private LAN ranges — `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`. A
self-hosted service legitimately talks to another box on its own network, and
calling that internal would break the normal case for the people most likely to
be running it. If you want those refused too, that is a policy your caller
adds; it is not a property of the host.

## Resolving a name

A literal check alone is a guard that any attacker-controlled domain walks
around by publishing one record. So there is a second layer:

```ts
import { firstInternalAddress, internalHostsAmong } from 'mcp-internal-hosts';

await firstInternalAddress('sneaky.example.com');
// → { address: '127.0.0.1', kind: 'loopback' }   (it published an A record)

await internalHostsAmong(
  everyUrlInThatOpmlFile.map((u) => new URL(u).hostname)
);
// → Map of only the ones that came out internal
```

**This half is fail-open, and you have to know it.** A name that does not
resolve here, resolves to nothing, or answers too slowly is reported as
routable. The first case is a real setup — your server may sit in a different
network with its own resolver. The last one is a switch the other side holds,
because whoever is authoritative for a name can simply answer slowly. And a
record can change between this answer and the socket that follows it.

A resolver that **sinkholes** a name — `0.0.0.0` or `::`, which is what every ad
blocker and corporate DNS filter answers — is not treated as loopback. That is
the resolver declining to answer, not the name addressing your machine; calling
it loopback would misdescribe it and make every blocklisted domain unusable.

`internalHostsAmong` decides every literal first and without any budget, so a
list long enough to exhaust the resolver's time cannot let an obvious
`169.254.169.254` through on the way past.

If your answer is a yes/no that ends in a refusal rather than a report, pass
`stopAtFirst` — the map is then whatever was found when the first hit came in,
and no further batch is started:

```ts
const found = await internalHostsAmong(hostnames, { stopAtFirst: true });
if (found.size > 0) throw new Error(`refusing ${[...found.keys()][0]}`);
```

For a thousand feeds whose first entry points at `127.0.0.1`, that is the
difference between immediate and the whole ten-second budget. Concurrency is
kept either way, so the batch already in flight finishes and the map may hold
more than one entry.

| Option        | Default |                                            |
| ------------- | ------- | ------------------------------------------ |
| `timeoutMs`   | `3000`  | per name                                   |
| `concurrency` | `8`     | names resolved at once                     |
| `budgetMs`    | `10000` | total across one `internalHostsAmong` call |
| `stopAtFirst` | `false` | stop once one internal host is found       |

## API

```ts
type InternalHostKind = 'loopback' | 'link-local';

function internalHostKind(hostname: string): InternalHostKind | null;

function firstInternalAddress(
  hostname: string,
  options?: ResolveOptions
): Promise<{ address: string; kind: InternalHostKind } | null>;

function internalHostsAmong(
  hostnames: readonly string[],
  options?: ResolveOptions
): Promise<Map<string, { address: string; kind: InternalHostKind }>>;
```

Nothing throws. What to do with the answer — refuse, warn, drop the entry — is
your decision, not this library's.

`internalHostKind` takes a hostname from anywhere, not only from `URL`: brackets
around an IPv6 literal, a `%zone` suffix and a trailing root label are all
handled rather than assumed away.

## Licence

MIT © Willi Thiel
