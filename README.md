# AI Memory MCP OAuth Gateway

This Cloudflare Worker exposes the current project's AI Memory MCP through
OAuth authorization code + PKCE. It grants only `mcp:read`, filters the
upstream tool list to an explicit allowlist, and fixes project arguments to
`default/rafaeljfec2-connexto-aihub`.

The only exposed upstream tool is `memory_read_session_observations`. The
gateway does not modify AI Memory or expose any upstream write operation.

## Identity and authorization

This deployment is single-user because the upstream AI Memory bearer is shared
by all gateway requests. Set `OAUTH_ALLOWED_USER_ID` to the one Cloudflare
Access `user_uuid` authorized to use this gateway. The empty Wrangler value is
a fail-closed placeholder; consent is unavailable until it is replaced.

The consent handler accepts only that exact Access UUID and stores it in
OAuth-bound application properties and as the OAuth subject. Every protected
MCP request must present a provider-validated token whose stored identity and
subject both match the configured UUID. Identity supplied in MCP arguments is
never used for authorization. Do not add a second allowed identity or derive
an upstream AI Memory identity from OAuth input: the upstream supports a
dedicated least-privilege bearer, not safe per-user impersonation here. Keep
Cloudflare Access restricted to the same person as defense in depth.

The gateway does not use a root AI Memory credential. `AI_MEMORY_BEARER` must
remain a dedicated, read-only AI Memory key; its actual owner and grants must
be verified out of band without exposing its value.

The Worker is not deployed or publicly exposed by this repository. DNS,
Cloudflare resources, Tunnel startup, secret provisioning, and deployment
require separate approval.

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

`npm run build` uses Wrangler's dry-run deploy mode and does not publish the
Worker. `wrangler dev` requires a host-compatible `workerd` binary; this
environment may not provide a compatible glibc runtime.

## Configuration overview

- `wrangler.jsonc` keeps `workers_dev` disabled and has a placeholder KV
  namespace ID. Replace it with a real OAuth KV namespace only after deployment
  is approved.
- `AI_MEMORY_ORIGIN_URL` accepts the configured origin
  `https://memory-origin.connexto.com.br/mcp` or a Cloudflare Quick Tunnel
  `https://<tunnel>.trycloudflare.com/mcp`; upstream calls always require the
  dedicated `AI_MEMORY_BEARER`.
- Set `AI_MEMORY_BEARER` to a dedicated AI Memory read-only grant, and set
  `AI_MEMORY_ACCESS_CLIENT_ID` and `AI_MEMORY_ACCESS_CLIENT_SECRET` to the
  Cloudflare Access service token for the origin. Do not use the AI Memory root
  bearer. Review existing grants before creating a dedicated identity.
- The gateway's Cloudflare Access application should protect only
  `memory.connexto.com.br/authorize`. OAuth discovery, registration, token, and
  MCP routes must remain reachable for the OAuth client flow.
- Before deployment, replace the empty `OAUTH_ALLOWED_USER_ID` placeholder
  with the authorized user's Cloudflare Access `user_uuid`; do not use an
  email fallback.
- Protect the origin hostname with a Cloudflare Access Service Auth policy.
  The Worker supplies the service-token headers; do not make the origin
  otherwise publicly accessible.

The secret and resource configuration steps above are deployment-only and must
not be run before separate approval.

## Origin Tunnel template

[`cloudflared/config.example.yml`](./cloudflared/config.example.yml) forwards
only `/mcp` to the local AI Memory listener on `127.0.0.1:49374`; all other
paths receive 404. Copy it to a private configuration file and replace the
tunnel UUID and credentials path only after the deployment gate is approved.
Tunnel credentials are excluded from version control.

The origin Tunnel does not create DNS records. Do not create DNS records,
start the Tunnel, or deploy the Worker until separately authorized.
