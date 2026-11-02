# MCP tools

All tools are read-only. The gateway returns the upstream JSON response as MCP
text content and sanitizes upstream failures. AI Memory determines which data
the configured user credential may read.

| Tool | Required arguments | Optional arguments | Purpose |
| --- | --- | --- | --- |
| `memory_list_projects` | None | `workspace` | List projects visible to the configured credential. |
| `memory_list_pages` | `workspace`, `project` | None | List pages in a project. |
| `memory_read_page` | `workspace`, `project`, `path` | None | Read a complete page. `path` is a page path, not a URL. |
| `memory_search` | `query` | `global`, `workspace`, `project`, `limit` | Search globally or in one project. |
| `memory_read_briefing` | `workspace`, `project` | None | Read the project's structured briefing. |
| `memory_list_sessions` | `workspace`, `project` | `include_open`, `limit`, `offset` | List sessions visible to the credential. |
| `memory_read_session_observations` | `workspace`, `project`, `session_id` | `limit`, `offset`, `order`, `kinds`, `query`, `body_max_chars` | Read one page of authorized session observations. |

## Scope rules

Use the workspace and project names returned by `memory_list_projects` for
project-scoped calls. Both values are required together. Do not invent or infer
them.

Search has two mutually exclusive modes:

```json
{"query":"gateway","global":true,"limit":10}
```

```json
{"query":"gateway","workspace":"default","project":"ai-memory-mcp-gateway","limit":10}
```

Global search must omit both `workspace` and `project`. Project search requires
both. `limit` is from 1 through 100 and defaults to 10.

## Sessions and observation pagination

`memory_list_sessions` defaults to `include_open:false`, `limit:20`, and
`offset:0`. Its limit is between 1 and 100.

`memory_read_session_observations` defaults to `limit:50`, `offset:0`, and
`order:"asc"`. Its maximum limit is 200. The optional `kinds` values are
`session-start`, `user-prompt`, `pre-tool-use`, `post-tool-use`, `pre-compact`,
`post-compaction`, `notification`, `stop`, `session-end`, and `other`. The
optional `query` is sent upstream as the `q` filter. `body_max_chars` defaults
to 4000 and accepts values from 200 through 16384.

Read observations until the returned `offset` reaches `total`. Advance by the
returned `limit` and preserve `total`, `offset`, `limit`, and
`elided_other_scope` from every page. Do not treat a single page as the full
session or infer access to observations filtered by AI Memory.

Example first page:

```json
{
  "workspace":"default",
  "project":"ai-memory-mcp-gateway",
  "session_id":"00000000-0000-4000-8000-000000000000",
  "limit":50,
  "offset":0,
  "order":"asc"
}
```

The UUID above is a placeholder. Use a session ID returned by AI Memory and
authorized for the configured credential.
