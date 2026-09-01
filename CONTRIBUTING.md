# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mcp-internal-hosts.git && cd mcp-internal-hosts
npm install
npm test          # no external service is involved; everything runs in-process
npm run build
```

## Expectations

- **Tests.** A behaviour change comes with a test that fails without it. Say so in
  the pull request: "control run with the change reverted — this fails" is worth
  more than a green tick, because a test that cannot fail proves nothing. CI runs
  on Node 22 and 24, plus oxlint, prettier, `npm audit` and CodeQL.
- **Coverage gates are not lowered.** Answer a drop with tests. If a line genuinely
  cannot be reached, say why in `vitest.config.ts` rather than chasing the number
  with a cast.
- **Comments explain constraints the code cannot show** — the reason a thing is
  written the awkward way, not what the next line does.
- **Security-sensitive areas** — the classifier and the resolving layer — both of them, always — please describe the attack you are
  defending against, or the one your change might open, in the pull request text.
- **No new runtime dependencies** without a very good reason. The small tree is a
  feature, and for a library other people depend on it is most of the offer.
- Run `npm run lint` before pushing: it covers both oxlint and prettier, and
  prettier also validates the YAML, JSON and Markdown.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/mcp-internal-hosts/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mcp-internal-hosts/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mcp-internal-hosts/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
