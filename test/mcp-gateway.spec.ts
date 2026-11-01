import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  type Tool,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { handleMcpRequest, type GatewayFetch } from "../src/mcp-gateway.js";
import { READ_SESSION_OBSERVATIONS_TOOL } from "../src/policy.js";

const readOnlyToolNames = ["memory_read_session_observations"] as const;

const sideEffectToolNames = [
  "memory_briefing",
  "memory_query",
  "memory_recent",
  "memory_read_page",
  "memory_handoff_list",
  "memory_lint",
  "memory_status",
] as const;

const upstreamTools = [
  ...readOnlyToolNames,
  ...sideEffectToolNames,
  "memory_write_page",
  "memory_delete_page",
].map(
  (name) =>
    ({
      name,
      description: `${name} description`,
      inputSchema:
        name === "memory_read_session_observations"
          ? READ_SESSION_OBSERVATIONS_TOOL.inputSchema
          : { type: "object", properties: {} },
    }) satisfies Tool,
);

const env = {
  AI_MEMORY_ORIGIN_URL: "https://memory-origin.connexto.com.br/mcp",
  AI_MEMORY_BEARER: "test-read-only-bearer",
  AI_MEMORY_ACCESS_CLIENT_ID: "test-access-client-id",
  AI_MEMORY_ACCESS_CLIENT_SECRET: "test-access-client-secret",
};

async function createClient(
  upstream: GatewayFetch,
  gatewayEnvironment: typeof env = env,
): Promise<Readonly<{ client: Client }>> {
  const gatewayFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    return handleMcpRequest(request, gatewayEnvironment, upstream);
  };
  const clientTransport = new StreamableHTTPClientTransport(new URL("https://gateway.test/mcp"), {
    fetch: gatewayFetch,
  });
  const client = new Client({ name: "gateway-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client };
}

async function createUpstream(): Promise<
  Readonly<{
    calls: Array<Readonly<{ name: string; arguments: Record<string, unknown> }>>;
    listCalls: number[];
    authorizationHeaders: string[];
    accessHeaders: Array<Readonly<{ clientId: string | null; clientSecret: string | null }>>;
    fetch: GatewayFetch;
  }>
> {
  const calls: Array<Readonly<{ name: string; arguments: Record<string, unknown> }>> = [];
  const listCalls: number[] = [];
  const authorizationHeaders: string[] = [];
  const accessHeaders: Array<Readonly<{ clientId: string | null; clientSecret: string | null }>> =
    [];
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let nextSessionId = 0;

  const fetch: GatewayFetch = async (input, init) => {
    const request = new Request(input, init);
    authorizationHeaders.push(request.headers.get("authorization") ?? "");
    accessHeaders.push({
      clientId: request.headers.get("CF-Access-Client-Id"),
      clientSecret: request.headers.get("CF-Access-Client-Secret"),
    });
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const transport = sessions.get(sessionId);
      if (transport === undefined) {
        return new Response("MCP session not found", { status: 404 });
      }
      const response = await transport.handleRequest(request);
      if (request.method === "DELETE") {
        sessions.delete(sessionId);
      }
      return response;
    }

    const body: unknown = await request.clone().json();
    if (!isInitializeRequest(body)) {
      return new Response("Expected an MCP initialize request", { status: 400 });
    }

    const server = new Server(
      { name: "ai-memory", version: "3.2.10" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => {
      listCalls.push(1);
      return { tools: upstreamTools };
    });
    server.setRequestHandler("tools/call", async (toolRequest) => {
      const args = toolRequest.params.arguments ?? {};
      calls.push({ name: toolRequest.params.name, arguments: args });
      return { content: [{ type: "text", text: "read complete" }] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => `upstream-session-${++nextSessionId}`,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId !== null) {
      sessions.set(newSessionId, transport);
    }
    return response;
  };
  return { calls, listCalls, authorizationHeaders, accessHeaders, fetch };
}

function isInitializeRequest(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    value.method === "initialize"
  );
}

describe("handleMcpRequest", () => {
  it("lists the local read tool and forwards a schema-validated project-scoped call", async () => {
    const upstream = await createUpstream();
    const { client } = await createClient(upstream.fetch);

    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual([...readOnlyToolNames]);
      expect(tools[0]?.inputSchema).toEqual(READ_SESSION_OBSERVATIONS_TOOL.inputSchema);
      expect(upstream.listCalls).toEqual([]);
      expect(tools.map((tool) => tool.name)).not.toContain("memory_write_page");
      for (const name of sideEffectToolNames) {
        expect(tools.map((tool) => tool.name)).not.toContain(name);
      }

      const result = await client.callTool({
        name: "memory_read_session_observations",
        arguments: {
          session_id: "captured-session-id",
          order: "desc",
          project: null,
          workspace: null,
        },
      });

      expect(result.content).toEqual([{ type: "text", text: "read complete" }]);
      expect(upstream.listCalls).toHaveLength(1);
      expect(upstream.calls).toEqual([
        {
          name: "memory_read_session_observations",
          arguments: {
            session_id: "captured-session-id",
            order: "desc",
            workspace: "default",
            project: "rafaeljfec2-connexto-aihub",
          },
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects tool arguments that do not match the live upstream schema", async () => {
    const upstream = await createUpstream();
    const request = new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "memory_read_session_observations",
          arguments: { limit: -1 },
        },
      }),
    });

    const response = await handleMcpRequest(request, env, upstream.fetch);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain(
      "Invalid arguments for memory_read_session_observations",
    );
    expect(JSON.stringify(body)).toContain('"isError":true');
    expect(upstream.listCalls).toHaveLength(1);
    expect(upstream.calls).toEqual([]);
  });

  it("initializes and lists the local tool without contacting an unconfigured upstream", async () => {
    const { client } = await createClient(
      async () => {
        throw new Error("tools/list must not access the upstream");
      },
      { ...env, AI_MEMORY_BEARER: "" },
    );

    try {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual([...readOnlyToolNames]);
      expect(tools[0]?.inputSchema).toEqual(READ_SESSION_OBSERVATIONS_TOOL.inputSchema);
    } finally {
      await client.close();
    }
  });

  it("rejects direct calls to tools with persistent access-reinforcement effects", async () => {
    const upstream = await createUpstream();
    for (const [index, name] of sideEffectToolNames.entries()) {
      const request = new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: index + 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });

      const response = await handleMcpRequest(request, env, upstream.fetch);
      const body: unknown = await response.json();

      expect(response.status).toBe(200);
      expect(JSON.stringify(body)).toContain("Unknown or disallowed tool");
    }

    expect(upstream.calls).toEqual([]);
  });

  it("rejects mutating tools at the JSON-RPC boundary", async () => {
    const upstream = await createUpstream();
    const request = new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "memory_delete_page",
          arguments: { path: "decisions/oauth.md" },
        },
      }),
    });

    const response = await handleMcpRequest(request, env, upstream.fetch);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("Unknown or disallowed tool");
    expect(upstream.calls).toEqual([]);
  });

  it("rejects tool calls without upstream credentials", async () => {
    const pathResponse = await handleMcpRequest(
      new Request("https://gateway.test/admin"),
      env,
      fetch,
    );
    const missingSecretResponse = await handleMcpRequest(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "memory_read_session_observations",
            arguments: { session_id: "captured-session-id" },
          },
        }),
      }),
      { ...env, AI_MEMORY_BEARER: "" },
      fetch,
    );
    expect(pathResponse.status).toBe(404);
    expect(missingSecretResponse.status).toBe(200);
    const missingSecretBody: unknown = await missingSecretResponse.json();
    expect(JSON.stringify(missingSecretBody)).toContain("AI Memory upstream request failed");
    expect(JSON.stringify(missingSecretBody)).toContain('"isError":true');
  });

  it("supports an authenticated Cloudflare Quick Tunnel upstream without Access service credentials", async () => {
    const upstream = await createUpstream();
    const quickTunnelEnvironment = {
      ...env,
      AI_MEMORY_ORIGIN_URL: "https://temporary-tunnel.trycloudflare.com/mcp",
      AI_MEMORY_ACCESS_CLIENT_ID: "",
      AI_MEMORY_ACCESS_CLIENT_SECRET: "",
    };
    const request = new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_read_session_observations",
          arguments: { session_id: "captured-session-id" },
        },
      }),
    });

    const response = await handleMcpRequest(request, quickTunnelEnvironment, upstream.fetch);

    expect(response.status).toBe(200);
    expect(
      upstream.authorizationHeaders.every((header) => header === "Bearer test-read-only-bearer"),
    ).toBe(true);
    expect(
      upstream.accessHeaders.every(
        ({ clientId, clientSecret }) => clientId === null && clientSecret === null,
      ),
    ).toBe(true);
  });

  it("rejects arbitrary upstream hosts and incomplete Access credentials", async () => {
    const createCallRequest = () =>
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "memory_read_session_observations",
            arguments: { session_id: "captured-session-id" },
          },
        }),
      });

    const arbitraryHost = await handleMcpRequest(
      createCallRequest(),
      { ...env, AI_MEMORY_ORIGIN_URL: "https://attacker.example/mcp" },
      fetch,
    );
    const incompleteAccessCredentials = await handleMcpRequest(
      createCallRequest(),
      { ...env, AI_MEMORY_ACCESS_CLIENT_SECRET: "" },
      fetch,
    );

    expect(arbitraryHost.status).toBe(200);
    expect(incompleteAccessCredentials.status).toBe(200);
    expect(JSON.stringify(await arbitraryHost.json())).toContain('"isError":true');
    expect(JSON.stringify(await incompleteAccessCredentials.json())).toContain('"isError":true');
  });

  it("rejects upstream redirects in Workers-compatible manual mode", async () => {
    let requestCount = 0;
    const redirectFetch: GatewayFetch = async (_input, init) => {
      requestCount += 1;
      expect(init?.redirect).toBe("manual");
      return Response.redirect("https://redirect.example/mcp", 302);
    };
    const request = new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_read_session_observations",
          arguments: { session_id: "captured-session-id" },
        },
      }),
    });

    const response = await handleMcpRequest(request, env, redirectFetch);
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("AI Memory upstream request failed");
    expect(JSON.stringify(body)).toContain('"isError":true');
    expect(JSON.stringify(body)).not.toContain("redirect.example");
    expect(requestCount).toBe(1);
  });
});
