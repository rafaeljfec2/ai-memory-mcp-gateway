# AI Memory MCP Gateway

A read-only Model Context Protocol (MCP) gateway that lets ChatGPT-compatible
clients discover and query an AI Memory instance through its native REST API.
It runs as a Cloudflare Worker and uses OAuth authorization code with PKCE.

The gateway exposes seven tools for project discovery, page reading, search,
briefings, sessions, and paginated observations. It forwards only `GET`
requests to AI Memory. AI Memory remains responsible for credential grants and
session-owner filtering; the gateway does not use a root credential.

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [MCP tools and arguments](docs/tools.md)
- [Local development and checks](docs/development.md)
- [Cloudflare deployment](docs/deployment.md)
- [Named tunnel operations](docs/operations.md)
- [Agent playbooks and session prompts](docs/agent-playbooks.md)
- [Security model and verification](SECURITY_AUDIT.md)

## Quick start

Requirements: Node.js 22 or newer, npm, a Cloudflare account, an AI Memory
instance reachable over HTTPS, and a dedicated native AI Memory user API key.

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

`npm run build` is a Wrangler dry run; it does not publish the Worker. See the
[development guide](docs/development.md) before running the optional real
upstream integration test. Never put API keys or tunnel tokens in Git.

## Maintainer deployment

The checked-in `wrangler.jsonc` currently targets the maintainer's staging
Worker, `ai-memory-mcp-gateway-staging`. It is not a production configuration
or a reusable account template. A fork must replace its Worker and KV
configuration, OAuth allowlist, origin URL, and the origin/Worker URLs used by
the source before deployment. Follow the [deployment guide](docs/deployment.md).

The maintained staging MCP URL is configured in `wrangler.jsonc` and
`src/index.ts`. Do not rely on that shared staging service for your own data.

## License

No license is currently declared. Obtain permission from the repository owner
before redistributing or incorporating this project into another product.
