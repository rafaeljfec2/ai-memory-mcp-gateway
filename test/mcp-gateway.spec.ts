import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  type GatewayEnvironment,
  type GatewayFetch,
  handleMcpRequest,
} from "../src/mcp-gateway.js";
import { GATEWAY_TOOLS } from "../src/policy.js";

const testApiKey = `aim_${"a".repeat(43)}`;

const env: GatewayEnvironment = {
  AI_MEMORY_ORIGIN_URL: "https://memory-origin.connexto.com.br/mcp",
  AI_MEMORY_BEARER: testApiKey,
  AI_MEMORY_ACCESS_CLIENT_ID: "test-access-client-id",
  AI_MEMORY_ACCESS_CLIENT_SECRET: "test-access-client-secret",
};

async function createClient(upstream: GatewayFetch, environment = env): Promise<Client> {
  const gatewayFetch: typeof fetch = (input, init) =>
    handleMcpRequest(new Request(input, init), environment, upstream);
  const transport = new StreamableHTTPClientTransport(new URL("https://gateway.test/mcp"), {
    fetch: gatewayFetch,
  });
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function createUpstream(): Readonly<{
  calls: Array<
    Readonly<{ url: string; method: string; bearer: string | null; accessId: string | null }>
  >;
  fetch: GatewayFetch;
}> {
  const calls: Array<
    Readonly<{
      url: string;
      method: string;
      bearer: string | null;
      accessId: string | null;
    }>
  > = [];
  const fetch: GatewayFetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      bearer: request.headers.get("authorization"),
      accessId: request.headers.get("CF-Access-Client-Id"),
    });
    return Response.json({
      total: 321,
      offset: 200,
      limit: 200,
      order: "desc",
      observations: [{ body: "test observation" }],
    });
  };
  return { calls, fetch };
}

describe("handleMcpRequest", () => {
  it("lists only local read tools without contacting AI Memory", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        GATEWAY_TOOLS.map((tool) => tool.name),
      );
      expect(upstream.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("lists projects across workspaces and forwards the dedicated credentials", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      await client.callTool({ name: "memory_list_projects", arguments: {} });
      expect(upstream.calls).toEqual([
        {
          url: "https://memory-origin.connexto.com.br/api/v1/projects",
          method: "GET",
          bearer: `Bearer ${testApiKey}`,
          accessId: "test-access-client-id",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("lists pages and reads a complete nested page in the selected project", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      const scope = { workspace: "team space", project: "memory" };
      await client.callTool({ name: "memory_list_pages", arguments: scope });
      await client.callTool({
        name: "memory_read_page",
        arguments: { ...scope, path: "architecture/overview.md" },
      });
      await client.callTool({ name: "memory_read_briefing", arguments: scope });
      expect(new URL(upstream.calls[0]?.url ?? "").pathname).toBe(
        "/api/v1/workspaces/team%20space/projects/memory/pages",
      );
      expect(new URL(upstream.calls[1]?.url ?? "").pathname).toBe(
        "/api/v1/workspaces/team%20space/projects/memory/pages/architecture/overview.md",
      );
      expect(new URL(upstream.calls[2]?.url ?? "").pathname).toBe(
        "/api/v1/workspaces/team%20space/projects/memory/briefing",
      );
    } finally {
      await client.close();
    }
  });

  it("keeps global search unscoped and requires explicit scope for project search", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      await client.callTool({
        name: "memory_search",
        arguments: { query: "needle", global: true },
      });
      await client.callTool({
        name: "memory_search",
        arguments: { query: "needle", workspace: "default", project: "demo" },
      });
      const global = new URL(upstream.calls[0]?.url ?? "");
      expect(global.searchParams.get("q")).toBe("needle");
      expect(global.searchParams.has("workspace")).toBe(false);
      expect(global.searchParams.has("project")).toBe(false);
      const scoped = new URL(upstream.calls[1]?.url ?? "");
      expect(scoped.searchParams.get("workspace")).toBe("default");
      expect(scoped.searchParams.get("project")).toBe("demo");
    } finally {
      await client.close();
    }
  });

  it("lists sessions and returns paginated observations from the requested session", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      const scope = { workspace: "default", project: "demo" };
      await client.callTool({
        name: "memory_list_sessions",
        arguments: { ...scope, limit: 20, offset: 20, include_open: true },
      });
      const result = await client.callTool({
        name: "memory_read_session_observations",
        arguments: {
          ...scope,
          session_id: "448f4ba3-f167-4f64-a4a0-001346246e02",
          limit: 200,
          offset: 200,
          order: "desc",
        },
      });
      const observationsUrl = new URL(upstream.calls[1]?.url ?? "");
      expect(observationsUrl.pathname).toContain(
        "/sessions/448f4ba3-f167-4f64-a4a0-001346246e02/observations",
      );
      expect(observationsUrl.searchParams.get("limit")).toBe("200");
      expect(observationsUrl.searchParams.get("offset")).toBe("200");
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type).toBe("text");
      const payload: unknown = JSON.parse(text?.type === "text" ? text.text : "{}");
      expect(payload).toMatchObject({ total: 321, offset: 200, limit: 200, order: "desc" });
      expect(payload).toHaveProperty("observations.0.body", "test observation");
    } finally {
      await client.close();
    }
  });

  it("explains invalid observation arguments without contacting AI Memory", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch);
    try {
      const missingScope = await client.callTool({
        name: "memory_read_session_observations",
        arguments: {
          session_id: "448f4ba3-f167-4f64-a4a0-001346246e02",
          limit: 200,
        },
      });
      const missingScopeText = missingScope.content.find((item) => item.type === "text");
      expect(missingScope.isError).toBe(true);
      expect(missingScopeText?.type === "text" ? missingScopeText.text : "").toContain(
        "workspace and project are required",
      );

      const missingSession = await client.callTool({
        name: "memory_read_session_observations",
        arguments: { workspace: "default", project: "demo", limit: 200 },
      });
      const missingSessionText = missingSession.content.find((item) => item.type === "text");
      expect(missingSession.isError).toBe(true);
      expect(missingSessionText?.type === "text" ? missingSessionText.text : "").toBe(
        "session_id is required",
      );

      const invalidLimit = await client.callTool({
        name: "memory_read_session_observations",
        arguments: {
          workspace: "default",
          project: "demo",
          session_id: "448f4ba3-f167-4f64-a4a0-001346246e02",
          limit: 201,
        },
      });
      const invalidLimitText = invalidLimit.content.find((item) => item.type === "text");
      expect(invalidLimit.isError).toBe(true);
      expect(invalidLimitText?.type === "text" ? invalidLimitText.text : "").toContain("limit");
      expect(upstream.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rejects write calls and unsafe global scopes before any upstream request", async () => {
    const upstream = createUpstream();
    const rawRequest = new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_write_page", arguments: {} },
      }),
    });
    const response = await handleMcpRequest(rawRequest, env, upstream.fetch);
    expect(JSON.stringify(await response.json())).toContain("Unknown or disallowed tool");
    const client = await createClient(upstream.fetch);
    try {
      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "needle", global: true, workspace: "default", project: "demo" },
      });
      expect(result.isError).toBe(true);
      expect(upstream.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("rejects root-style upstream credentials before making a request", async () => {
    const upstream = createUpstream();
    const client = await createClient(upstream.fetch, {
      ...env,
      AI_MEMORY_BEARER: "root-bearer-must-not-be-used",
    });
    try {
      const result = await client.callTool({ name: "memory_list_projects", arguments: {} });
      expect(result.isError).toBe(true);
      expect(upstream.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("sanitizes upstream authorization errors without returning their body", async () => {
    const upstreamFetch: GatewayFetch = async () =>
      Response.json({ error: "internal credential diagnostics" }, { status: 403 });
    const client = await createClient(upstreamFetch);
    try {
      const result = await client.callTool({ name: "memory_list_projects", arguments: {} });
      const text = result.content.find((item) => item.type === "text");
      expect(result.isError).toBe(true);
      expect(text?.type === "text" ? text.text : "").toBe(
        "AI Memory rejected the read request (403)",
      );
    } finally {
      await client.close();
    }
  });
});
