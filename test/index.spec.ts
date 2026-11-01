import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import type { GatewayEnvironment } from "../src/mcp-gateway.js";

type TestEnvironment = GatewayEnvironment &
  Readonly<{
    OAUTH_ALLOWED_USER_ID: string;
    OAUTH_KV: KVNamespace;
    OAUTH_PROVIDER: OAuthHelpers;
  }>;

type ProviderOptions = Readonly<{
  apiRoute: string;
  apiHandler: Readonly<{
    fetch: (request: Request, env: TestEnvironment, context: ExecutionContext) => Promise<Response>;
  }>;
  defaultHandler: Readonly<{
    fetch: (request: Request, env: TestEnvironment, context: ExecutionContext) => Promise<Response>;
  }>;
}>;

const state = vi.hoisted(() => ({ options: undefined as unknown }));

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  insufficientScope: (_auth: unknown, scopes: string[]) =>
    new Response(JSON.stringify({ error: "insufficient_scope" }), {
      status: 403,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"`,
      },
    }),
  OAuthProvider: class {
    constructor(options: unknown) {
      state.options = options;
    }

    fetch(request: Request, env: TestEnvironment, context: ExecutionContext): Promise<Response> {
      const options = state.options as ProviderOptions;
      if (new URL(request.url).pathname === options.apiRoute) {
        return options.apiHandler.fetch(request, env, context);
      }
      return options.defaultHandler.fetch(request, env, context);
    }
  },
}));

import worker from "../src/index.js";

const env = {
  AI_MEMORY_ORIGIN_URL: "",
  AI_MEMORY_BEARER: "",
  AI_MEMORY_ACCESS_CLIENT_ID: "",
  AI_MEMORY_ACCESS_CLIENT_SECRET: "",
  OAUTH_ALLOWED_USER_ID: "allowed-access-user-id",
  OAUTH_KV: {} as KVNamespace,
  OAUTH_PROVIDER: {} as OAuthHelpers,
} satisfies TestEnvironment;

const context = {
  access: {
    aud: "test-access-policy-audience",
    getIdentity: async () => ({ user_uuid: "allowed-access-user-id" }),
  },
  props: { userId: "allowed-access-user-id" },
  auth: {
    token: "test-access-token",
    audience: "https://memory.connexto.com.br/mcp",
    userId: "allowed-access-user-id",
    scope: ["mcp:read"],
  },
} as unknown as ExecutionContext;

describe("Worker entrypoint", () => {
  it("routes the MCP endpoint to the gateway handler", async () => {
    const response = await worker.fetch(
      new Request("https://memory.connexto.com.br/mcp", {
        headers: { Accept: "application/json, text/event-stream" },
      }),
      env,
      context,
    );

    expect(response.status).toBe(200);
  });

  it("rejects MCP requests whose token is bound to another identity", async () => {
    const response = await worker.fetch(new Request("https://memory.connexto.com.br/mcp"), env, {
      ...context,
      props: { userId: "another-access-user" },
      auth: {
        token: "test-access-token",
        audience: "https://memory.connexto.com.br/mcp",
        userId: "another-access-user",
        scope: ["mcp:read"],
      },
    } as unknown as ExecutionContext);

    expect(response.status).toBe(403);
  });

  it("requires the token subject and protected props to agree", async () => {
    const response = await worker.fetch(new Request("https://memory.connexto.com.br/mcp"), env, {
      ...context,
      props: { userId: "allowed-access-user-id" },
      auth: {
        token: "test-access-token",
        audience: "https://memory.connexto.com.br/mcp",
        userId: "another-access-user",
        scope: ["mcp:read"],
      },
    } as unknown as ExecutionContext);

    expect(response.status).toBe(403);
  });

  it.each([{ scope: [] }, { scope: ["mcp:write"] }])(
    "rejects protected MCP requests without mcp:read (scopes: $scope)",
    async ({ scope }) => {
      const response = await worker.fetch(new Request("https://memory.connexto.com.br/mcp"), env, {
        ...context,
        auth: {
          token: "test-access-token",
          audience: "https://memory.connexto.com.br/mcp",
          userId: "allowed-access-user-id",
          scope,
        },
      } as unknown as ExecutionContext);

      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
      expect(await response.json()).toMatchObject({ error: "insufficient_scope" });
    },
  );

  it("routes authorization to the Access-protected consent handler", async () => {
    const response = await worker.fetch(
      new Request("https://memory.connexto.com.br/authorize"),
      env,
      {
        ...context,
        access: {
          aud: "test-access-policy-audience",
          getIdentity: async () => undefined,
        },
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(403);
  });
});
