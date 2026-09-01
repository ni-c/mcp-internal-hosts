# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/mcp-internal-hosts.git && cd mcp-internal-hosts
npm install
npm test          # the suite runs against a stubbed fetch, so no wg-easy instance is needed
npm run build
```

A minimal dev environment:

```sh
# Point the server at a throwaway wg-easy instance, never a production one.
docker run -d --name wg-easy-dev -p 51821:51821 \
  --cap-add NET_ADMIN --cap-add SYS_MODULE ghcr.io/wg-easy/wg-easy:15
# Complete the setup wizard at http://localhost:51821, leaving 2FA disabled,
# then run the server against it:
WG_EASY_URL=http://localhost:51821 \
WG_EASY_USERNAME=admin WG_EASY_PASSWORD=... node dist/index.js
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs on Node 22 and 24, plus oxlint, prettier, `npm audit`, CodeQL and a Trivy scan of the container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/mcp-internal-hosts/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/mcp-internal-hosts/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/mcp-internal-hosts/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
