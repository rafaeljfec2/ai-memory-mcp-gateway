import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { handleAuthorizeRequest, type OAuthAuthorizationHelpers } from "../src/oauth.js";
import { accessContext, allowedUserId, createOAuthHelpers } from "./oauth-test-fixtures.js";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  CimdFetchError: class CimdFetchError extends Error {},
}));

describe("handleAuthorizeRequest security", () => {
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
