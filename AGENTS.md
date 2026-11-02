# Agent instructions

## Repository scope

- This repository contains the TypeScript Cloudflare Worker gateway only.
- Do not edit the AI Memory repository, Rust source, upstream database, or
  upstream authorization rules.
- AI Memory's native `/api/v1` REST API is the source of truth. Do not add
  gateway endpoints or duplicate upstream REST features without a separate
  user request.
- Keep the seven-tool MCP allowlist read-only. Never use an AI Memory root
  bearer; use a dedicated native `aim_` user key.

## Cloudflare operations

- Distinguish the Cloudflare API MCP from this AI Memory gateway. The Cloudflare
  MCP manages Cloudflare account resources; this gateway reads AI Memory.
- Before using the Cloudflare API MCP, read `docs/agent-playbooks.md` and the
  relevant deployment or operations guide.
- Before an API mutation, inspect the account and resource with read requests,
  use the Cloudflare MCP `search` tool to confirm the current endpoint schema
  and permission group, and verify the target account/zone explicitly.
- Perform mutations only when the user explicitly authorizes them. Keep this
  repository's deployment on staging; do not alter production.
- Never print, paste, or commit OAuth tokens, Worker secrets, AI Memory keys,
  tunnel tokens, or full global MCP configuration output. Prefer targeted
  `codex mcp get <name>` checks over `codex mcp list`.
- Do not disable an existing tunnel until an authenticated gateway read has
  succeeded through the replacement route.

## Changes and validation

- Write all repository documentation in English.
- Keep changes limited to the user-requested gateway or documentation scope.
- Do not commit, push, merge, rebase, or rewrite Git history unless the user
  explicitly requests that operation.
- Do not run tests unless the user asks for testing or verification. Report
  exactly which checks were run and which were not.
- Read `docs/architecture.md`, `docs/tools.md`, `docs/deployment.md`,
  `docs/operations.md`, and `SECURITY_AUDIT.md` before changing related
  behavior or operational instructions.
