# Agent playbooks

Use these playbooks when an agent needs to configure MCP clients, manage
Cloudflare resources, deploy the gateway, or diagnose a failed read. Copy the
matching prompt into a new agent session and fill in the placeholders. A prompt
does not replace explicit user authorization for account mutations.

## Know which MCP is which

| MCP connection     | Endpoint                         | Use                                                                         |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------- |
| Cloudflare API MCP | `https://mcp.cloudflare.com/mcp` | Cloudflare account discovery and administration through the Cloudflare API. |
| AI Memory Gateway  | `https://<worker-host>/mcp`      | Read-only project and memory tools exposed by this repository.              |

They are separate servers with separate OAuth grants. Connecting the Cloudflare
API MCP does not add AI Memory tools to ChatGPT. Connecting the AI Memory
Gateway does not grant Cloudflare account administration.

## Playbook: connect the Cloudflare API MCP to Codex

Codex CLI and its IDE extension share MCP configuration. The official OpenAI
Docs MCP guide describes adding a remote server with `codex mcp add` and
verifying configuration in Codex. See [Codex MCP setup](https://developers.openai.com/learn/docs-mcp).
Cloudflare's official guide documents its API server endpoint and OAuth
permission selection: [Cloudflare MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/).

Check one server without dumping every configured server or command-line secret:

```sh
codex mcp get cloudflare
```

If it is absent, add the official server and complete OAuth:

```sh
codex mcp add cloudflare --url https://mcp.cloudflare.com/mcp
codex mcp login cloudflare
```

Select only the permissions needed for the task. Then verify the authenticated
account using the Cloudflare MCP `whoami` tool. Do not paste OAuth URLs after
authorization, token values, or global MCP listings into logs or chat.

### Copyable setup prompt

```text
Read AGENTS.md and docs/agent-playbooks.md. Check whether the Codex MCP server
named cloudflare is configured using a targeted command. If it is missing, add
https://mcp.cloudflare.com/mcp and start OAuth. Stop for me to complete browser
authorization. Afterward verify the connection with the Cloudflare whoami tool.
Do not print or inspect unrelated MCP credentials, and do not change Cloudflare
resources in this setup task.
```

## Playbook: inspect Cloudflare before making changes

For Cloudflare API MCP work:

1. Call `whoami` to confirm the authenticated profile. If multiple accounts are
   available, list accounts and select the intended account explicitly.
2. Use the MCP `search` tool to find the exact OpenAPI operation, request
   schema, response fields, and required permission group.
3. Read the current zone, DNS record, tunnel, or Worker state with `GET` before
   proposing a mutation. Confirm account ID, zone ID, hostname, and target.
4. Make a write only if the user has authorized that specific change. Return
   only safe metadata such as IDs, status, hostname, and resource names.
5. Keep tokens out of tool output. If an API operation returns a tunnel token,
   transfer it only through a local secret-safe path into a mode `600` file.
   If that cannot be done without displaying the token, stop and ask the
   operator to enter it locally.

### Copyable resource-change prompt

```text
Read AGENTS.md, docs/architecture.md, docs/deployment.md, and
docs/operations.md. Use the Cloudflare API MCP only for the requested resource.
First confirm the account and inspect current state with GET. Use the MCP search
tool to verify exact API paths, request schemas, and permission groups before
writing. Keep the change in staging, show me the planned resource values, and
do not expose tokens. Preserve existing DNS records and tunnels unless I
explicitly authorize changing them.
```

## Playbook: establish or replace the AI Memory origin tunnel

The gateway calls AI Memory REST paths such as `/api/v1/projects` through the
configured origin URL. A tunnel route limited to `/mcp` is insufficient. Route
all paths for the origin hostname to the AI Memory listener and set the origin
HTTP `Host` header to `localhost`.

Use [operations.md](operations.md) for the systemd unit, token-file mode,
linger, DNS, and health checks. Keep an existing Quick Tunnel until an
authenticated read succeeds through the named tunnel and deployed gateway.
The local computer must be on and connected for the local origin to respond.

### Copyable tunnel prompt

```text
Read AGENTS.md and docs/operations.md. Inspect the local AI Memory service,
existing tunnel processes, DNS record, and staging origin configuration before
changing anything. Reuse existing resources when appropriate. Route the named
tunnel to the actual local AI Memory port, set Host: localhost, and preserve
all REST paths. Store the tunnel token in a protected local file; never print
it or put it in shell history. Keep existing Quick Tunnels until an
authenticated memory_list_projects call succeeds through staging. Do not
change production or the AI Memory source/database.
```

## Playbook: connect ChatGPT or Codex to this gateway

Use the gateway URL from the deployment owner, not the Cloudflare API MCP URL.
For Codex CLI:

```sh
codex mcp add ai-memory --url https://<worker-host>/mcp
codex mcp login ai-memory
```

For ChatGPT, add `https://<worker-host>/mcp` as a custom MCP connector and
complete OAuth consent. The maintained staging deployment is single-user; a
different developer needs an authorized deployment using their own Access user
UUID and AI Memory credential.

Verify in this order:

1. `tools/list` returns all seven names listed in `tools.md`.
2. `memory_list_projects` returns projects visible to the dedicated credential.
3. Use returned `workspace` and `project` names for pages, briefing, search,
   and session tools.
4. Read observations page by page until `offset` reaches `total`, preserving
   the metadata returned by AI Memory.

If the client still shows an old tool list after a deployment, refresh the MCP
connection or client session and check the deployed Worker version. Reauthorize
only if OAuth metadata, credentials, or required scopes changed.

### Copyable gateway-validation prompt

```text
Use the AI Memory Gateway MCP, not the Cloudflare API MCP. Call
memory_list_projects first and report only the returned counts and names. Then
list pages for one returned project and read one page. Do not guess workspace,
project, or session identifiers. For observations, preserve total/offset/limit
and paginate to completion. Do not infer data denied by AI Memory, and do not
claim success unless the tools actually return it.
```

## Playbook: stage a gateway release

1. Read `SECURITY_AUDIT.md` and inspect `wrangler.jsonc` to confirm the target
   Worker name is the intended staging service.
2. Confirm secrets are configured by name only; never print secret values.
3. Run the dry-run build and requested project checks.
4. Deploy only after the user authorizes staging publication. Do not deploy
   production.
5. Verify tunnel health, origin DNS, Worker reachability, OAuth, `tools/list`,
   and one authenticated read from an authorized MCP client.
6. Keep a fallback tunnel until the authenticated read succeeds. Report any
   remaining reboot or production checks separately.

### Copyable staging prompt

```text
Read AGENTS.md, docs/deployment.md, docs/operations.md, and SECURITY_AUDIT.md.
Inspect the exact Wrangler Worker name and deployment diff. Do not print secret
values or run a global MCP credential dump. Run the dry-run build. If I have
authorized a staging deployment, publish only the named staging Worker, then
verify tools/list and memory_list_projects through an authenticated client.
Never publish production or change AI Memory code/database.
```

## Common agent diagnostics

| Result                               | Next check                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Only one gateway tool appears        | Confirm the client is connected to the gateway URL, refresh discovery, and check the deployed Worker version.      |
| `workspace and project are required` | Call `memory_list_projects`, then pass both returned names.                                                        |
| AI Memory returns `401`              | Check the dedicated `aim_` key and grants; never switch to a root key.                                             |
| Consent returns `403`                | Check Cloudflare Access identity and exact `OAUTH_ALLOWED_USER_ID` match.                                          |
| Tunnel shows inactive                | Check tunnel UUID, token file permissions, DNS route, service logs, and linger.                                    |
| REST path returns `404`              | Ensure the tunnel routes `/api/v1/*`, not only `/mcp`.                                                             |
| No observations returned             | Check session UUID, project scope, pagination, and upstream owner authorization. Do not bypass upstream filtering. |
