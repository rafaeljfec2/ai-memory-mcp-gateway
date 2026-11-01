import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import type {
  ApprovedConsent,
  AuthRequest,
  ConsentDescription,
  ConsentTransaction,
  DeniedConsent,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { handleAuthorizeRequest, type OAuthAuthorizationHelpers } from "../src/oauth.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  CimdFetchError: class CimdFetchError extends Error {},
}));

const authRequest = {
  responseType: "code",
  clientId: "chatgpt-client",
  redirectUri: "https://chatgpt.com/oauth/callback",
  scope: ["mcp:read"],
  state: "client-state",
  codeChallenge: "A".repeat(43),
  codeChallengeMethod: "S256",
  resource: "https://memory.connexto.com.br/mcp",
  issuer: "https://memory.connexto.com.br",
} satisfies AuthRequest;
const allowedUserId = "access-user-id";

const consentDescription = {
  clientId: "chatgpt-client",
  clientName: '<img src=x onerror="alert(1)">',
  clientDomain: "client.example",
  redirectUri: "https://chatgpt.com/oauth/callback",
  redirectHost: "chatgpt.com",
  redirectIsLoopback: false,
  scope: ["mcp:read"],
} satisfies ConsentDescription;

type AuthorizationCall = Readonly<{
  userId: string;
  scope: readonly string[];
  props: unknown;
}>;

function createOAuthHelpers(parsedAuthRequest: AuthRequest = authRequest): Readonly<{
  helpers: OAuthAuthorizationHelpers;
  approvals: readonly string[][];
  authorizations: AuthorizationCall[];
  denials: string[];
}> {
  const approvals: string[][] = [];
  const authorizations: AuthorizationCall[] = [];
  const denials: string[] = [];
  const consentTransaction = {
    handle: "one-time-consent-handle",
    headers: new Headers({
      "Set-Cookie": "__Host-oauth-consent=browser-binding; Secure; HttpOnly; Path=/",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    }),
  } satisfies ConsentTransaction;
  const approvedConsent = {
    request: parsedAuthRequest,
    headers: new Headers(),
  } satisfies ApprovedConsent;
  const deniedConsent = {
    request: parsedAuthRequest,
    redirectTo: "https://chatgpt.com/oauth/callback?error=access_denied",
    headers: new Headers(),
  } satisfies DeniedConsent;
  const helpers = {
    parseAuthRequest: async (_request: Request) => parsedAuthRequest,
    describeConsent: async (_request: AuthRequest) => consentDescription,
    beginConsent: async (_request: AuthRequest) => consentTransaction,
    approveConsent: async (_request: Request, _handle: string, options?: { scope?: string[] }) => {
      approvals.push(options?.scope ?? []);
      return approvedConsent;
    },
    denyConsent: async (_request: Request, handle: string) => {
      denials.push(handle);
      return deniedConsent;
    },
    completeAuthorization: async (
      options: Parameters<OAuthHelpers["completeAuthorization"]>[0],
    ) => {
      authorizations.push({
        userId: options.userId,
        scope: options.scope,
        props: options.props,
      });
      return { redirectTo: "https://chatgpt.com/oauth/callback?code=authorization-code" };
    },
  } satisfies OAuthAuthorizationHelpers;

  return { helpers, approvals, authorizations, denials };
}

function accessContext(identity?: { email?: string; user_uuid?: string }): CloudflareAccessContext {
  return {
    aud: "access-policy-audience",
    getIdentity: async () => identity,
  };
}

describe("handleAuthorizeRequest", () => {
  it("requires a Cloudflare Access identity before processing authorization", async () => {
    const { helpers } = createOAuthHelpers();
    const request = new Request("https://memory.connexto.com.br/authorize");

    const response = await handleAuthorizeRequest(request, undefined, helpers, allowedUserId);

    expect(response.status).toBe(403);
  });

  it("renders escaped client details and a read-only consent form", async () => {
    const { helpers } = createOAuthHelpers();
    const request = new Request(
      "https://ai-memory-mcp-gateway-staging.rafaeljfec2-ai-memory-staging.workers.dev/authorize?client_id=client",
    );
    const response = await handleAuthorizeRequest(
      request,
      accessContext({ email: "rafael@example.com", user_uuid: "access-user-id" }),
      helpers,
      allowedUserId,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html.split('action="/authorize"')).toHaveLength(3);
    expect(html).not.toContain("formaction=");
    expect(response.headers.get("set-cookie")).toContain("__Host-oauth-consent");
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("mcp:read");
    expect(html).toContain("one-time-consent-handle");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires an explicit S256 challenge before rendering consent", async () => {
    const withoutChallenge: AuthRequest = {
      responseType: "code",
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      state: authRequest.state,
      resource: authRequest.resource,
      issuer: authRequest.issuer,
    };
    const plainChallenge: AuthRequest = { ...authRequest, codeChallengeMethod: "plain" };

    for (const parsedRequest of [withoutChallenge, plainChallenge]) {
      const { helpers } = createOAuthHelpers(parsedRequest);
      const response = await handleAuthorizeRequest(
        new Request("https://memory.connexto.com.br/authorize"),
        accessContext({ user_uuid: allowedUserId }),
        helpers,
        allowedUserId,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("PKCE S256");
    }
  });

  it("approves only the read scope and binds the grant to the Access user", async () => {
    const { helpers, approvals, authorizations } = createOAuthHelpers();
    const body = new URLSearchParams({
      handle: "one-time-consent-handle",
      decision: "approve",
      scope: "mcp:read",
    });
    const request = new Request("https://memory.connexto.com.br/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const response = await handleAuthorizeRequest(
      request,
      accessContext({ email: "rafael@example.com", user_uuid: "access-user-id" }),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://chatgpt.com/oauth/callback?code=authorization-code",
    );
    expect(approvals).toEqual([["mcp:read"]]);
    expect(authorizations).toEqual([
      {
        userId: "access-user-id",
        scope: ["mcp:read"],
        props: { userId: "access-user-id" },
      },
    ]);
  });

  it("denies missing or broader consent scopes", async () => {
    const { helpers, approvals, denials } = createOAuthHelpers();
    const body = new URLSearchParams({
      handle: "one-time-consent-handle",
      decision: "approve",
      scope: "mcp:write",
    });
    const request = new Request("https://memory.connexto.com.br/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const response = await handleAuthorizeRequest(
      request,
      accessContext({ user_uuid: "access-user-id" }),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(302);
    expect(approvals).toEqual([]);
    expect(denials).toEqual(["one-time-consent-handle"]);
  });

  it("accepts a consent form at the byte limit", async () => {
    const { helpers, denials } = createOAuthHelpers();
    const prefix = "handle=one-time-consent-handle&decision=deny&pad=";
    const body = `${prefix}${"x".repeat(4096 - prefix.length)}`;
    const request = new Request("https://memory.connexto.com.br/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    const response = await handleAuthorizeRequest(
      request,
      accessContext({ user_uuid: allowedUserId }),
      helpers,
      allowedUserId,
    );

    expect(new TextEncoder().encode(body)).toHaveLength(4096);
    expect(response.status).toBe(302);
    expect(denials).toEqual(["one-time-consent-handle"]);
  });

  it("stops reading and rejects a streamed consent form over the byte limit", async () => {
    const { helpers, approvals, denials } = createOAuthHelpers();
    let pulledChunks = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulledChunks === 12) {
          controller.close();
          return;
        }
        pulledChunks += 1;
        controller.enqueue(new Uint8Array(1024).fill(120));
      },
      cancel() {
        canceled = true;
      },
    });
    const requestInit = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    };
    const request = new Request("https://memory.connexto.com.br/authorize", requestInit);

    const response = await handleAuthorizeRequest(
      request,
      accessContext({ user_uuid: allowedUserId }),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
    expect(pulledChunks).toBeLessThan(20);
    expect(approvals).toEqual([]);
    expect(denials).toEqual([]);
  });

  it("rejects malformed, unsupported, and unrelated authorization requests", async () => {
    const { helpers } = createOAuthHelpers();
    const malformedPost = new Request("https://memory.connexto.com.br/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });
    const unsupportedMethod = new Request("https://memory.connexto.com.br/authorize", {
      method: "DELETE",
    });
    const unrelatedPath = new Request("https://memory.connexto.com.br/admin");
    const access = accessContext({ user_uuid: "access-user-id" });

    const malformedResponse = await handleAuthorizeRequest(
      malformedPost,
      access,
      helpers,
      allowedUserId,
    );
    const methodResponse = await handleAuthorizeRequest(
      unsupportedMethod,
      access,
      helpers,
      allowedUserId,
    );
    const pathResponse = await handleAuthorizeRequest(
      unrelatedPath,
      access,
      helpers,
      allowedUserId,
    );

    expect(malformedResponse.status).toBe(400);
    expect(methodResponse.status).toBe(405);
    expect(pathResponse.status).toBe(404);
  });

  it("requires a stable Access user identifier", async () => {
    const { helpers } = createOAuthHelpers();
    const response = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({}),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(403);
  });

  it("allows consent only for the explicitly configured Access UUID", async () => {
    const { helpers } = createOAuthHelpers();
    const denied = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({ user_uuid: "another-access-user" }),
      helpers,
      allowedUserId,
    );
    const unconfigured = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({ user_uuid: allowedUserId }),
      helpers,
      undefined,
    );

    expect(denied.status).toBe(403);
    expect(unconfigured.status).toBe(503);
  });

  it("does not use email as a fallback identity", async () => {
    const { helpers } = createOAuthHelpers();
    const response = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({ email: "rafael@example.com" }),
      helpers,
      "rafael@example.com",
    );

    expect(response.status).toBe(403);
  });

  it("adds security headers to validated OAuth error redirects", async () => {
    const error = Object.assign(
      new AuthorizationError("invalid_request", {
        description: "Invalid authorization request",
        redirectUri: "https://chatgpt.com/oauth/callback",
      }),
      { redirectTo: "https://chatgpt.com/oauth/callback?error=invalid_request" },
    );
    const created = createOAuthHelpers();
    const helpers: OAuthAuthorizationHelpers = {
      ...created.helpers,
      parseAuthRequest: async () => {
        throw error;
      },
    };

    const response = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({ user_uuid: "access-user-id" }),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://chatgpt.com/oauth/callback?error=invalid_request",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("returns a safe error when OAuth client metadata cannot be verified", async () => {
    const created = createOAuthHelpers();
    const helpers: OAuthAuthorizationHelpers = {
      ...created.helpers,
      parseAuthRequest: async () => {
        throw new CimdFetchError(
          "https://client.example/.well-known/oauth-client",
          new Error("metadata fetch failed"),
        );
      },
    };

    const response = await handleAuthorizeRequest(
      new Request("https://memory.connexto.com.br/authorize"),
      accessContext({ user_uuid: "access-user-id" }),
      helpers,
      allowedUserId,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("OAuth client metadata could not be verified");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
