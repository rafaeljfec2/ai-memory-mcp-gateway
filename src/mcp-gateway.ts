import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  isReadOnlyToolName,
  READ_SESSION_OBSERVATIONS_TOOL,
  scopeToolArguments,
} from "./policy.js";

const trustedOrigin = "memory-origin.connexto.com.br";
const quickTunnelHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
const schemaValidator = new CfWorkerJsonSchemaValidator();

export interface GatewayEnvironment {
  readonly AI_MEMORY_ORIGIN_URL: string;
  readonly AI_MEMORY_BEARER: string;
  readonly AI_MEMORY_ACCESS_CLIENT_ID?: string;
  readonly AI_MEMORY_ACCESS_CLIENT_SECRET?: string;
}

type GatewayEnvironmentWithAccessCredentials = GatewayEnvironment &
  Readonly<{
    AI_MEMORY_ACCESS_CLIENT_ID: string;
    AI_MEMORY_ACCESS_CLIENT_SECRET: string;
  }>;

export type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function handleMcpRequest(
  request: Request,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch = fetch,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  const server = createMcpServer(env, upstreamFetch);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 64 * 1024,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function createMcpServer(env: GatewayEnvironment, upstreamFetch: GatewayFetch): Server {
  // The low-level API preserves upstream JSON Schemas without lossy conversion.
  const server = new Server(
    { name: "ai-memory-read-only-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: [READ_SESSION_OBSERVATIONS_TOOL] }));
  server.setRequestHandler("tools/call", async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, env, upstreamFetch),
  );
  return server;
}

async function callTool(
  name: string,
  arguments_: Readonly<Record<string, unknown>>,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch,
): Promise<CallToolResult> {
  if (!isReadOnlyToolName(name)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown or disallowed tool");
  }
  if (!isConfigured(env)) {
    return toolError("AI Memory upstream request failed");
  }

  const scopedArguments = scopeToolArguments(name, arguments_);
  return callUpstreamTool(name, scopedArguments, env, upstreamFetch);
}

async function callUpstreamTool(
  name: string,
  arguments_: Record<string, unknown>,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch,
): Promise<CallToolResult> {
  const fetchWithoutRedirects: GatewayFetch = async (input, init) => {
    const response = await upstreamFetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("AI Memory upstream redirects are not allowed");
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(env.AI_MEMORY_ORIGIN_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${env.AI_MEMORY_BEARER}`,
        ...(hasAccessCredentials(env)
          ? {
              "CF-Access-Client-Id": env.AI_MEMORY_ACCESS_CLIENT_ID,
              "CF-Access-Client-Secret": env.AI_MEMORY_ACCESS_CLIENT_SECRET,
            }
          : {}),
      },
      redirect: "manual",
    },
    fetch: fetchWithoutRedirects,
  });
  const client = new Client({ name: "ai-memory-mcp-gateway", version: "0.1.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const upstreamTool = tools.find((tool) => tool.name === name);
    if (upstreamTool === undefined) {
      throw new Error("Required read-only tool is unavailable upstream");
    }

    const validation = schemaValidator.getValidator<Record<string, unknown>>(
      upstreamTool.inputSchema as JsonSchemaType,
    )(arguments_);
    if (!validation.valid) {
      return toolError("Invalid arguments for memory_read_session_observations");
    }

    return await client.callTool({ name, arguments: arguments_ });
  } catch (error) {
    logUpstreamFailure("tools/call", error);
    return toolError("AI Memory upstream request failed");
  } finally {
    try {
      await client.close();
    } catch (cleanupError) {
      logUpstreamFailure("tools/call cleanup", cleanupError);
    }
  }
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isConfigured(env: GatewayEnvironment): boolean {
  let origin: URL;
  try {
    origin = new URL(env.AI_MEMORY_ORIGIN_URL);
  } catch {
    return false;
  }

  const noAccessCredentials =
    (env.AI_MEMORY_ACCESS_CLIENT_ID === undefined || env.AI_MEMORY_ACCESS_CLIENT_ID === "") &&
    (env.AI_MEMORY_ACCESS_CLIENT_SECRET === undefined || env.AI_MEMORY_ACCESS_CLIENT_SECRET === "");

  return (
    origin.protocol === "https:" &&
    origin.username === "" &&
    origin.password === "" &&
    (origin.hostname === trustedOrigin || quickTunnelHostname.test(origin.hostname)) &&
    origin.port === "" &&
    origin.pathname === "/mcp" &&
    origin.search === "" &&
    origin.hash === "" &&
    isSafeHeaderValue(env.AI_MEMORY_BEARER) &&
    (noAccessCredentials || hasAccessCredentials(env))
  );
}

function hasAccessCredentials(
  env: GatewayEnvironment,
): env is GatewayEnvironmentWithAccessCredentials {
  return (
    isSafeHeaderValue(env.AI_MEMORY_ACCESS_CLIENT_ID) &&
    isSafeHeaderValue(env.AI_MEMORY_ACCESS_CLIENT_SECRET)
  );
}

function isSafeHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value && !/[\r\n]/.test(value)
  );
}

function logUpstreamFailure(operation: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const errorMessage =
    error instanceof Error
      ? error.message
          .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/\baim_[A-Za-z0-9_-]+\b/gi, "[redacted]")
          .slice(0, 200)
      : undefined;
  console.error("AI Memory MCP upstream request failed", { operation, errorName, errorMessage });
}
