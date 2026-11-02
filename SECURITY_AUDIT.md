# Security model and verification

This document describes the gateway's current security controls and the latest
available deployment evidence. It is an operational review, not a penetration
test or a security certification.

## Security controls

- **Single-user OAuth allowlist:** consent requires a Cloudflare Access identity
  and an exact match against `OAUTH_ALLOWED_USER_ID`. Email is not used as an
  identity fallback. Protected MCP requests also verify the identity bound to
  the OAuth token.
- **Read-only OAuth scope:** the only supported scope is `mcp:read`. The
  consent handler requires Authorization Code with PKCE S256 and bounds the
  consent form body.
- **Tool allowlist:** only the seven tools in `docs/tools.md` are published.
  `tools/call` rejects unknown and write-capable names before contacting AI
  Memory.
- **Read-only upstream access:** `src/upstream-api.ts` constructs the REST path
  locally, uses `GET`, rejects redirects, and sends the configured user
  credential. It never accepts a client-provided origin URL.
- **Credential boundary:** `AI_MEMORY_BEARER` must match the native `aim_` user
  key format. The gateway rejects root-style credentials. AI Memory remains
  responsible for grants, project access, and session-owner filtering.
- **Error handling:** upstream response bodies are not forwarded for failed
  requests; server errors and fetch failures return sanitized messages.
- **OAuth state:** provider state and grants use the `OAUTH_KV` binding.

## Staging evidence

The following checks were recorded for the maintained staging deployment:

- The Worker dry run and staging deployment completed successfully.
- The named Cloudflare Tunnel reported healthy with four active connections.
- The origin DNS name resolved. Unauthenticated requests to the origin and
  Worker returned `401`, as expected for protected APIs.
- The user confirmed a successful ChatGPT `memory_list_projects` call that
  returned 44 projects. This is direct user-provided evidence from the ChatGPT
  client.
- The user systemd tunnel service is enabled, and user linger is enabled.
- An end-to-end reboot test has not been performed.

The last previously recorded local test run reported 35 passing tests and one
skipped live-upstream integration test. Typecheck, lint, format check, and
Wrangler dry run also passed in that implementation phase. Documentation edits
have not been validated by running the test suite again.

## Deployment-specific notes

The shared deployment is staging-only. The staging Worker currently has the
dedicated `AI_MEMORY_BEARER` secret. The optional
`AI_MEMORY_ACCESS_CLIENT_ID` and `AI_MEMORY_ACCESS_CLIENT_SECRET` pair is not
configured there; add both only if the origin is protected by a Cloudflare
Access Service Auth policy. The AI Memory API still requires its dedicated user
bearer.

`wrangler.jsonc` contains account-specific Worker/KV configuration and a
single-user OAuth allowlist. Replace those values for a fork. The allowlist
UUID is an identifier, not an authentication credential, but it is specific to
the maintainer. Never commit API keys, tunnel tokens, or service-token values.

## Public release blocker

A scan of the local Git history found an AI Memory bearer key in a historical
`.env` blob. The value was not printed. The `.env` path has now been removed
from all local refs; backup refs and reflogs were pruned, and a scan found no
matching key pattern in the remaining Git objects. This checkout has no Git
remote configured and the rewritten history has not been pushed.

The credential itself has not been revoked or rotated. Treat it as exposed and
rotate it before public publication. If any earlier clone or backup exists,
ensure it is not published with the old history. `.gitignore` prevents future
local secret files from being added but does not clean other clones.

The local AI Memory host is exposed through a named tunnel and remains
unavailable while the host computer or its network is offline. Cloudflared
binary updates are not automatic in the current systemd unit.

## Residual limitations

- The OAuth allowlist supports one Cloudflare Access user. Supporting multiple
  users requires an explicit authorization design change.
- The real-upstream test is opt-in and requires a loopback AI Memory URL, a
  dedicated user key, and `AI_MEMORY_TEST_SESSION_ID`. It is not a substitute
  for AI Memory's own authorization checks.
- The tunnel and Worker are validated in staging. Production configuration and
  production deployment are outside this repository's current setup.
- The full post-reboot startup path has not been exercised.

See [architecture](docs/architecture.md), [deployment](docs/deployment.md),
and [operations](docs/operations.md) for setup details.
