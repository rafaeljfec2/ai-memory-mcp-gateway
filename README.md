# AI Memory MCP Gateway

This Cloudflare Worker exposes read-only AI Memory discovery and retrieval to
ChatGPT through OAuth authorization code + PKCE. It lists projects, pages, and
sessions; searches globally or within an explicitly named project; and reads
complete pages, briefings, and paginated session observations.

Project-scoped calls require both `workspace` and `project`. Global search uses
`global: true` and rejects project scope. The Worker calls only read-only
`/api/v1` endpoints and never forwards a client-selected upstream tool name.
OAuth continues to grant only `mcp:read`; reads follow the configured AI Memory
credential's project grants and session-ownership rules.

## Identity and authorization

The gateway remains single-user at the OAuth layer. Set `OAUTH_ALLOWED_USER_ID`
to the Cloudflare Access `user_uuid` authorized to use this Worker. The empty
Wrangler value is a fail-closed placeholder; consent is unavailable until it is
replaced. Every protected MCP request must present a provider-validated token
whose stored identity and subject match that UUID.

`AI_MEMORY_BEARER` must be the dedicated native `aim_` API key for
`chatgpt-review`. The Worker rejects other bearer formats, including the static
root bearer. It forwards this key unchanged; AI Memory remains responsible for
project grants and owner-filtered session visibility. The Worker stores only
the dedicated key and optional Cloudflare Access service-token secrets.

## Staging

The deployment configuration targets the staging Worker. Validation and
publication for this change are restricted to staging; production resources,
DNS, and credentials must not be changed.

## Local checks

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm audit
```

`npm run build` uses Wrangler's dry-run deploy mode. `wrangler dev` requires a
host-compatible `workerd` binary; this environment may not provide a compatible
glibc runtime.

## Configuration overview

- `wrangler.jsonc` identifies the staging Worker and OAuth KV binding.
- `AI_MEMORY_ORIGIN_URL` accepts
  `https://memory-origin.connexto.com.br/mcp` or a Cloudflare Quick Tunnel
  `https://<tunnel>.trycloudflare.com/mcp`. The Worker uses the same origin for
  the read-only `/api/v1` endpoints.
- Set `AI_MEMORY_BEARER` to the dedicated native `aim_` key for `chatgpt-review`.
- Set `AI_MEMORY_ACCESS_CLIENT_ID` and
  `AI_MEMORY_ACCESS_CLIENT_SECRET` to the Cloudflare Access service token for
  the AI Memory origin.
- Set `OAUTH_ALLOWED_USER_ID` to the authorized Cloudflare Access `user_uuid`;
  email is not an identity fallback.
- Keep the origin hostname protected by a Cloudflare Access Service Auth policy.
  The Worker supplies service-token headers; do not expose the origin publicly.

Tunnel credentials and bearer values are secrets and must not be committed.
