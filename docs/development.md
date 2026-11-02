# Local development

## Requirements

- Node.js 22 or newer
- npm
- A Cloudflare account for deployment or local Wrangler use
- AI Memory REST API access for the optional live integration test

## Install and check

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

`npm run build` runs `wrangler deploy --dry-run`; it does not publish. Use
`npx wrangler dev` to run the Worker locally. The local runtime must support
Cloudflare's `workerd` binary. OAuth consent also requires a Cloudflare Access
identity, which a plain local request does not provide; use the unit tests for
the isolated handler behavior and a protected staging deployment for the full
browser flow.

## Local Worker secrets

Wrangler reads local secret values from `.dev.vars`. The file is ignored by
Git. Create it in the repository root and use your own values:

```dotenv
AI_MEMORY_BEARER=aim_REPLACE_WITH_A_DEDICATED_USER_KEY
OAUTH_ALLOWED_USER_ID=REPLACE_WITH_YOUR_CLOUDFLARE_ACCESS_USER_UUID
# Include both Access values only when the origin requires a service token.
AI_MEMORY_ACCESS_CLIENT_ID=REPLACE_WITH_ACCESS_CLIENT_ID
AI_MEMORY_ACCESS_CLIENT_SECRET=REPLACE_WITH_ACCESS_CLIENT_SECRET
```

Never commit `.dev.vars`. Keep `AI_MEMORY_ORIGIN_URL` in Wrangler configuration;
it must use HTTPS and a hostname allowed by `src/mcp-gateway.ts`.

## Optional real AI Memory integration test

The live integration test is skipped unless all three variables below are
provided. It accepts only a loopback HTTP upstream, a native `aim_` user key,
and a valid session UUID. Use a test database and a session the key is allowed
to read.

```sh
AI_MEMORY_TEST_UPSTREAM=http://127.0.0.1:49374/mcp \
AI_MEMORY_TEST_BEARER=aim_REPLACE_WITH_A_DEDICATED_USER_KEY \
AI_MEMORY_TEST_SESSION_ID=00000000-0000-4000-8000-000000000000 \
npm test -- test/gateway-real-upstream.spec.ts
```

The test discovers a project, reads pages, searches, reads a briefing, lists
sessions, and checks observation pagination. It does not use a root credential
or call a non-loopback host. Do not place a real key in shell history or logs.

## Project checks

- `npm test`: unit and provider-flow tests; the live upstream test is skipped
  unless configured.
- `npm run typecheck`: TypeScript type checking without emitting files.
- `npm run lint`: Biome lint checks.
- `npm run format:check`: checks formatting without writing files.
- `npm run build`: Wrangler deployment dry run.
