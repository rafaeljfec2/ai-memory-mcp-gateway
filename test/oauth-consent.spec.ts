import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { handleAuthorizeRequest } from "../src/oauth.js";
import {
  accessContext,
  allowedUserId,
  authRequest,
  createOAuthHelpers,
} from "./oauth-test-fixtures.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  CimdFetchError: class CimdFetchError extends Error {},
}));

describe("handleAuthorizeRequest consent", () => {
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
});
