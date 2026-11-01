import {
  insufficientScope,
  OAuthProvider,
  type OAuthResourceAuth,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { handleMcpRequest, type GatewayEnvironment } from "./mcp-gateway.js";
import { handleAuthorizeRequest } from "./oauth.js";

interface Env extends GatewayEnvironment {
  readonly OAUTH_ALLOWED_USER_ID: string;
  readonly OAUTH_KV: KVNamespace;
  readonly OAUTH_PROVIDER: OAuthHelpers;
}

const apiHandler = {
  fetch: async (request: Request, env: Env, context: ExecutionContext): Promise<Response> => {
    const auth = getOAuthResourceAuth(context);
    if (!isAuthorizedOAuthIdentity(context, env.OAUTH_ALLOWED_USER_ID) || auth === undefined) {
      return new Response("OAuth identity is not authorized", { status: 403 });
    }
    if (!auth.scope.includes("mcp:read")) {
      return insufficientScope(auth, ["mcp:read"]);
    }
    return handleMcpRequest(request, env);
  },
};

const defaultHandler = {
  fetch: (request: Request, env: Env, context: ExecutionContext) =>
    handleAuthorizeRequest(request, context.access, env.OAUTH_PROVIDER, env.OAUTH_ALLOWED_USER_ID),
};

function isAuthorizedOAuthIdentity(context: unknown, allowedUserId: unknown): boolean {
  const contextRecord = toRecord(context);
  const props = toRecord(contextRecord?.props);
  const auth = toRecord(contextRecord?.auth);
  return (
    typeof allowedUserId === "string" &&
    allowedUserId.length > 0 &&
    props?.userId === allowedUserId &&
    auth?.userId === encodeURIComponent(allowedUserId)
  );
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getOAuthResourceAuth(context: unknown): OAuthResourceAuth | undefined {
  const auth = toRecord(toRecord(context)?.auth);
  if (
    typeof auth?.token !== "string" ||
    typeof auth.audience !== "string" ||
    !Array.isArray(auth.scope) ||
    !auth.scope.every((scope) => typeof scope === "string")
  ) {
    return undefined;
  }

  return {
    token: auth.token,
    audience: auth.audience,
    scope: auth.scope,
    ...(typeof auth.expiresAt === "number" ? { expiresAt: auth.expiresAt } : {}),
    ...(typeof auth.userId === "string" ? { userId: auth.userId } : {}),
    ...(typeof auth.clientId === "string" ? { clientId: auth.clientId } : {}),
  };
}

const providerOptions = {
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:read"],
  requiredScopes: ["mcp:read"],
  resourceMetadata: {
    resource: "https://ai-memory-mcp-gateway-staging.rafaeljfec2-ai-memory-staging.workers.dev/mcp",
    authorization_servers: [
      "https://ai-memory-mcp-gateway-staging.rafaeljfec2-ai-memory-staging.workers.dev",
    ],
    bearer_methods_supported: ["header"],
    resource_name: "Connexto AI Hub project memory",
  },
} satisfies OAuthProviderOptions<Env>;

export default new OAuthProvider<Env>(providerOptions);
