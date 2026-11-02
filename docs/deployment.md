# Cloudflare deployment

## Deployment model

This repository currently contains one Worker configuration named
`ai-memory-mcp-gateway-staging`. It has no production environment. Review every
account-specific value before deploying a fork or publishing a release.

## Configure a new Cloudflare account

1. Install dependencies with `npm ci` and authenticate Wrangler with
   `npx wrangler login`.
2. Create a KV namespace for OAuth state:

   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```

   Put the returned namespace ID in `kv_namespaces[0].id` in `wrangler.jsonc`.
3. Choose a Worker name and set the origin URL and the Cloudflare Access
   `user_uuid` allowed to authorize. The identity is single-user; email is not
   used as a fallback.
4. If the Worker URL differs from the maintained staging URL, update the
   `resource` and `authorization_servers` values in `src/index.ts`. Update the
   origin hostname allowlist in `src/mcp-gateway.ts` for your own named tunnel
   hostname. The allowlist is an SSRF protection; do not remove it or accept a
   client-supplied URL.
5. Create a dedicated native AI Memory user API key with only the required read
   grants. Configure it as a Worker secret:

   ```sh
   npx wrangler secret put AI_MEMORY_BEARER
   ```

   Paste the value only into Wrangler's hidden prompt. Never use the AI Memory
   root bearer.
6. If the AI Memory origin is protected by a Cloudflare Access Service Auth
   policy, also set both service-token secrets:

   ```sh
   npx wrangler secret put AI_MEMORY_ACCESS_CLIENT_ID
   npx wrangler secret put AI_MEMORY_ACCESS_CLIENT_SECRET
   ```

   The gateway sends these headers only when both values are configured. If the
   origin is not protected by a service-token policy, omit both.
7. Check the effective configuration, then deploy:

   ```sh
   npm run build
   npx wrangler deploy
   ```

   `npm run build` is a dry run. `npx wrangler deploy` publishes the Worker
   named in `wrangler.jsonc`; confirm that name before running it. For the
   maintainer checkout, that name is the staging Worker.

Wrangler variables are configuration, not secrets. The current config includes
maintainer-specific values; replace them in a fork. Keep bearer keys, Access
service tokens, and tunnel tokens outside tracked files. `.dev.vars` and
`.env*` are ignored by Git.

## OAuth and client setup

The authorization consent endpoint requires a Cloudflare Access identity whose
`user_uuid` exactly matches `OAUTH_ALLOWED_USER_ID`. Configure Cloudflare Access
so the authorized user reaches `/authorize` with a verified identity. Scope
that browser-facing Access policy to consent; do not put a login-only Access
wall in front of `/mcp`, `/oauth/token`, or `/oauth/register`, which MCP clients
must reach directly. The provider issues `mcp:read` grants only and enforces
PKCE S256.

Use the deployed MCP resource URL:

```text
https://<your-worker-host>/mcp
```

For Codex CLI, register and authorize the remote MCP server:

```sh
codex mcp add ai-memory --url https://<your-worker-host>/mcp
codex mcp login ai-memory
```

For ChatGPT, add the same URL as a custom MCP connector and complete OAuth
consent in the browser. Clients discover the OAuth endpoints from the Worker;
do not hard-code a token or bypass PKCE. A deployment to a new hostname requires
the resource metadata update described above.

The maintainer staging configuration is single-user. Another developer must
deploy a fork with their own `OAUTH_ALLOWED_USER_ID`, Worker URL, KV namespace,
and AI Memory user key. The shared staging allowlist does not automatically
authorize other developers.

## Configuration reference

| Name | Wrangler setting | Secret | Description |
| --- | --- | --- | --- |
| `OAUTH_KV` | KV binding | No | Stores OAuth provider state and grants. |
| `OAUTH_ALLOWED_USER_ID` | `vars` | No | The one allowed Cloudflare Access `user_uuid`. |
| `AI_MEMORY_ORIGIN_URL` | `vars` | No | HTTPS base URL for the AI Memory origin, ending in `/mcp`. |
| `AI_MEMORY_BEARER` | Worker secret | Yes | Dedicated native `aim_` AI Memory user key. |
| `AI_MEMORY_ACCESS_CLIENT_ID` | Worker secret, optional | Yes | Cloudflare Access service-token ID for the origin. |
| `AI_MEMORY_ACCESS_CLIENT_SECRET` | Worker secret, optional | Yes | Matching Cloudflare Access service-token secret. |

The current staging configuration has a dedicated `AI_MEMORY_BEARER` secret.
The Access service-token pair is optional and must be configured only when an
Access Service Auth policy is enabled for the origin.

## Before opening a public repository

- Review `wrangler.jsonc`: it currently contains the maintainer's staging
  Worker/KV identifiers, origin URL, and single-user allowlist UUID. These are
  account-specific values, not reusable defaults. Replace them for a fork and
  decide whether the maintainer's UUID should remain public.
- Scan the full Git history for previously committed credentials. `.gitignore`
  prevents new local secret files from being added, but does not remove values
  already committed. Revoke any credential found in history.
- This checkout's local history was rewritten to remove an old `.env` blob from
  all refs, and the remaining Git objects were scanned for the old credential
  pattern. The credential has not been rotated. This checkout had no remote
  before publication, so publish only the rewritten refs. Do not publish an
  old clone or backup; rotate the key if any such copy was shared or cannot be
  trusted.
- This repository currently has no `LICENSE`. Public visibility alone does not
  grant reuse rights; add a license if reuse or redistribution is intended.
