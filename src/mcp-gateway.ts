import {
  type CallToolResult,
  type JsonSchemaType,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { GATEWAY_TOOLS, isReadOnlyToolName, validateToolArguments } from "./policy.js";
import { callReadEndpoint, type GatewayEnvironment, type GatewayFetch } from "./upstream-api.js";

const trustedOrigin = "memory-origin.connexto.com.br";
const quickTunnelHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
const schemaValidator = new CfWorkerJsonSchemaValidator();

export type { GatewayEnvironment, GatewayFetch } from "./upstream-api.js";

export async function handleMcpRequest(
  request: Request,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch = fetch,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
  const server = new Server(
    { name: "ai-memory-read-only-gateway", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools: GATEWAY_TOOLS }));
  server.setRequestHandler("tools/call", async (call) =>
    callTool(call.params.name, call.params.arguments ?? {}, env, upstreamFetch),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 64 * 1024,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch,
): Promise<CallToolResult> {
  if (!isReadOnlyToolName(name)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown or disallowed tool");
  }
  const tool = GATEWAY_TOOLS.find((candidate) => candidate.name === name);
  const validationError = validateToolArguments(name, args);
  if (validationError !== undefined) return toolError(validationError);
  const validation = schemaValidator.getValidator<Record<string, unknown>>(
    tool?.inputSchema as JsonSchemaType,
  )(args);
  if (!validation.valid) return toolError(`Invalid tool arguments: ${validation.errorMessage}`);
  if (!isConfigured(env)) return toolError("AI Memory upstream request failed");

  try {
    const response = await callReadEndpoint(name, args, env, upstreamFetch);
    if (!response.ok) {
      await response.body?.cancel();
      return response.status >= 500
        ? toolError("AI Memory upstream request failed")
        : toolError(`AI Memory rejected the read request (${response.status})`);
    }
    const body = await response.text();
    return {
      content: [{ type: "text", text: body }],
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error("AI Memory REST read failed", { errorName });
    return toolError("AI Memory upstream request failed");
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
    (!env.AI_MEMORY_ACCESS_CLIENT_ID || env.AI_MEMORY_ACCESS_CLIENT_ID === "") &&
    (!env.AI_MEMORY_ACCESS_CLIENT_SECRET || env.AI_MEMORY_ACCESS_CLIENT_SECRET === "");
  return (
    origin.protocol === "https:" &&
    origin.username === "" &&
    origin.password === "" &&
    (origin.hostname === trustedOrigin || quickTunnelHostname.test(origin.hostname)) &&
    origin.port === "" &&
    origin.pathname === "/mcp" &&
    origin.search === "" &&
    origin.hash === "" &&
    isNativeUserCredential(env.AI_MEMORY_BEARER) &&
    (noAccessCredentials || hasAccessCredentials(env))
  );
}

function hasAccessCredentials(env: GatewayEnvironment): boolean {
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

function isNativeUserCredential(value: unknown): value is string {
  return isSafeHeaderValue(value) && /^aim_[A-Za-z0-9_-]{43}$/.test(value);
}
