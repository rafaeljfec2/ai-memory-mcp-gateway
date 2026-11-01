import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { handleMcpRequest, type GatewayFetch } from "../src/mcp-gateway.js";
import { READ_SESSION_OBSERVATIONS_TOOL } from "../src/policy.js";

const sessionId = "448f4ba3-f167-4f64-a4a0-001346246e02";
const upstreamUrl = "http://127.0.0.1:49374/mcp";
const gatewayEnvironment = {
  AI_MEMORY_ORIGIN_URL: "https://temporary-tunnel.trycloudflare.com/mcp",
  AI_MEMORY_BEARER: readEnvironmentValue("AI_MEMORY_API_KEY"),
};

function readEnvironmentValue(name: string): string {
  const line = readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${name}=`));
  if (line === undefined) {
    throw new Error(`Missing ${name} in local environment file`);
  }
  const value = line
    .slice(name.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (name === "AI_MEMORY_API_KEY" && !value.startsWith("aim_")) {
    throw new Error("The integration test requires the dedicated AI Memory credential");
  }
  return value;
}

const localUpstreamFetch: GatewayFetch = async (input, init) => {
  const request = new Request(input, init);
  const redirect = init?.redirect;
  return fetch(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    ...(request.method === "GET" || request.method === "HEAD"
      ? {}
      : { body: await request.arrayBuffer() }),
    ...(redirect === undefined ? {} : { redirect }),
  });
};

function containsSessionId(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSessionId);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(
    ([key, item]) => (key === "session_id" && item === sessionId) || containsSessionId(item),
  );
}

describe("real AI Memory upstream integration", () => {
  it("uses the live schema and reads the requested captured session through the gateway", async () => {
    const directUpstream = new Client({ name: "schema-verification", version: "1.0.0" });
    const directTransport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
      requestInit: {
        headers: { Authorization: `Bearer ${gatewayEnvironment.AI_MEMORY_BEARER}` },
      },
    });

    await directUpstream.connect(directTransport);
    try {
      const { tools } = await directUpstream.listTools();
      const actualTool = tools.find((tool) => tool.name === READ_SESSION_OBSERVATIONS_TOOL.name);
      if (actualTool === undefined) {
        throw new Error("The live upstream tool is unavailable");
      }
      expect(actualTool.inputSchema).toEqual(READ_SESSION_OBSERVATIONS_TOOL.inputSchema);
      expect(actualTool.description).toBe(READ_SESSION_OBSERVATIONS_TOOL.description);
    } finally {
      await directUpstream.close();
    }

    const gatewayFetch: typeof fetch = async (input, init) =>
      handleMcpRequest(new Request(input, init), gatewayEnvironment, localUpstreamFetch);
    const gatewayTransport = new StreamableHTTPClientTransport(
      new URL("https://gateway.test/mcp"),
      { fetch: gatewayFetch },
    );
    const gatewayClient = new Client({ name: "real-session-check", version: "1.0.0" });

    await gatewayClient.connect(gatewayTransport);
    try {
      const listed = await gatewayClient.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["memory_read_session_observations"]);
      const result = await gatewayClient.callTool({
        name: "memory_read_session_observations",
        arguments: {
          session_id: sessionId,
          limit: 1,
          project: null,
          workspace: null,
        },
      });
      if (result.isError) {
        throw new Error("The gateway returned a tool execution error");
      }

      const text = result.content
        .filter(
          (item): item is typeof item & { type: "text"; text: string } => item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("The upstream response was not valid JSON");
      }
      if (!containsSessionId(payload)) {
        throw new Error("The upstream response did not identify the requested session");
      }
      const total =
        typeof payload === "object" && payload !== null && "total" in payload
          ? payload.total
          : undefined;
      if (typeof total !== "number" || total < 1) {
        throw new Error("The requested session returned no observations");
      }
      console.log(`Real session read succeeded: session=${sessionId}, total=${total}`);
    } finally {
      await gatewayClient.close();
    }
  }, 30_000);
});
