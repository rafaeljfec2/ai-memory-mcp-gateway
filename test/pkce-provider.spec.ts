import {
  getOAuthApi,
  OAuthProvider,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { handleAuthorizeRequest } from "../src/oauth.js";

interface OAuthTestEnvironment {
  readonly OAUTH_ALLOWED_USER_ID: string;
  readonly OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

interface ExchangeCodeOptions {
  readonly provider: OAuthProvider<OAuthTestEnvironment>;
  readonly environment: OAuthTestEnvironment;
  readonly helpers: OAuthHelpers;
  readonly clientId: string;
  readonly challenge: string;
  readonly verifier: string;
}

class MemoryKV {
  private readonly values = new Map<string, string>();

  async get(
    key: string,
    options?: { readonly type?: "text" | "json" | "arrayBuffer" | "stream" },
  ): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) {
      return null;
    }
    if (options?.type === "json") {
      return JSON.parse(value);
    }
    if (options?.type === "arrayBuffer") {
      return new TextEncoder().encode(value).buffer;
    }
    if (options?.type === "stream") {
      return new Response(value).body;
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options: { readonly prefix?: string; readonly limit?: number } = {}) {
    const names = [...this.values.keys()]
      .filter((name) => name.startsWith(options.prefix ?? ""))
      .slice(0, options.limit ?? 1000);
    return {
      keys: names.map((name) => ({ name, expiration: undefined, metadata: undefined })),
      list_complete: true,
    };
  }
}

const resource = "https://memory.connexto.com.br/mcp";
const callback = "https://chatgpt.com/oauth/callback";
const providerOptions = {
  apiRoute: "/mcp",
  apiHandler: { fetch: async () => new Response(null, { status: 501 }) },
  defaultHandler: {
    fetch: async (request: Request, env: OAuthTestEnvironment, context: ExecutionContext) => {
      const helpers = env.OAUTH_PROVIDER;
      if (helpers === undefined) {
        return new Response("OAuth helpers unavailable", { status: 503 });
      }
      return handleAuthorizeRequest(request, context.access, helpers, env.OAUTH_ALLOWED_USER_ID);
    },
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp:read"],
  requiredScopes: ["mcp:read"],
  resourceMetadata: {
    resource,
    authorization_servers: ["https://memory.connexto.com.br"],
    bearer_methods_supported: ["header"],
  },
} satisfies OAuthProviderOptions<OAuthTestEnvironment>;

const authContext = {
  access: {
    aud: "test-access-policy-audience",
    getIdentity: async () => ({ user_uuid: "authorized-user-id" }),
  },
} as unknown as ExecutionContext;

function createEnvironment(): OAuthTestEnvironment {
  return {
    OAUTH_ALLOWED_USER_ID: "authorized-user-id",
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
  };
}

async function createS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("OAuth provider PKCE exchange", () => {
  it("registers a client and exchanges a valid S256 authorization code", async () => {
    const environment = createEnvironment();
    const provider = new OAuthProvider<OAuthTestEnvironment>(providerOptions);
    const helpers = getOAuthApi(providerOptions, environment);
    const registration = await provider.fetch(
      new Request("https://memory.connexto.com.br/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "PKCE integration test",
          redirect_uris: [callback],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      environment,
      authContext,
    );
    expect(registration.status).toBe(201);
    const registrationPayload: unknown = await registration.json();
    if (
      typeof registrationPayload !== "object" ||
      registrationPayload === null ||
      !("client_id" in registrationPayload) ||
      typeof registrationPayload.client_id !== "string"
    ) {
      throw new Error("Dynamic client registration omitted client_id");
    }
    const clientId = registrationPayload.client_id;

    const verifier = "v".repeat(43);
    const challenge = await createS256Challenge(verifier);
    const exchange = { provider, environment, helpers, clientId, challenge };

    const rejected = await exchangeCode({ ...exchange, verifier: "x".repeat(43) });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });

    const accepted = await exchangeCode({ ...exchange, verifier });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ token_type: "bearer" });
  });
});

async function exchangeCode(options: Readonly<ExchangeCodeOptions>): Promise<Response> {
  const code = await createAuthorizationCode(options.helpers, options.clientId, options.challenge);
  return options.provider.fetch(
    new Request("https://memory.connexto.com.br/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.clientId,
        code,
        redirect_uri: callback,
        code_verifier: options.verifier,
        resource,
      }),
    }),
    options.environment,
    authContext,
  );
}

async function createAuthorizationCode(
  helpers: OAuthHelpers,
  clientId: string,
  challenge: string,
): Promise<string> {
  const authorization = new URL("https://memory.connexto.com.br/authorize");
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: "mcp:read",
    state: "pkce-test-state",
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const request = new Request(authorization);
  const authRequest = await helpers.parseAuthRequest(request);
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: "authorized-user-id",
    metadata: {},
    scope: ["mcp:read"],
    props: { userId: "authorized-user-id" },
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) {
    throw new Error("OAuth provider did not return an authorization code");
  }
  return code;
}
