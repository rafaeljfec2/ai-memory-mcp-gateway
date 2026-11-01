import type {
  ApprovedConsent,
  AuthRequest,
  ConsentDescription,
  ConsentTransaction,
  DeniedConsent,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { handleAuthorizeRequest, type OAuthAuthorizationHelpers } from "../src/oauth.js";

const allowedUserId = "access-user-id";
const callbackUrl = "https://chatgpt.com/connector_platform_oauth_redirect?code=test-code";
const responsePolicy =
  "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const chatGptConsentPolicy =
  "default-src 'none'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'";

const authRequest = {
  responseType: "code",
  clientId: "chatgpt-client",
  redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
  scope: ["mcp:read"],
  state: "test-state",
  codeChallenge: "A".repeat(43),
  codeChallengeMethod: "S256",
  resource: "https://memory.example.com/mcp",
  issuer: "https://memory.example.com",
} satisfies AuthRequest;

const consentDescription = {
  clientId: "chatgpt-client",
  clientName: "ChatGPT",
  clientDomain: "chatgpt.com",
  redirectUri: authRequest.redirectUri,
  redirectHost: "chatgpt.com",
  redirectIsLoopback: false,
  scope: ["mcp:read"],
} satisfies ConsentDescription;

function createOAuthHelpers(): OAuthAuthorizationHelpers {
  const transaction = {
    handle: "one-time-test-handle",
    headers: new Headers(),
  } satisfies ConsentTransaction;
  const approved = { request: authRequest, headers: new Headers() } satisfies ApprovedConsent;
  const denied = {
    request: authRequest,
    redirectTo: "https://chatgpt.com/connector_platform_oauth_redirect?error=access_denied",
    headers: new Headers(),
  } satisfies DeniedConsent;

  return {
    parseAuthRequest: async () => authRequest,
    describeConsent: async () => consentDescription,
    beginConsent: async () => transaction,
    approveConsent: async () => approved,
    denyConsent: async () => denied,
    completeAuthorization: async () => ({ redirectTo: callbackUrl }),
  };
}

function accessContext(): CloudflareAccessContext {
  return {
    aud: "access-policy-audience",
    getIdentity: async () => ({ user_uuid: allowedUserId }),
  };
}

describe("OAuth consent callback CSP", () => {
  it("allows the registered callback origin only from the consent page", async () => {
    const helpers = createOAuthHelpers();
    const access = accessContext();
    const getResponse = await handleAuthorizeRequest(
      new Request("https://memory.example.com/authorize"),
      access,
      helpers,
      allowedUserId,
    );
    const postResponse = await handleAuthorizeRequest(
      new Request("https://memory.example.com/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          handle: "one-time-test-handle",
          decision: "approve",
          scope: "mcp:read",
        }),
      }),
      access,
      helpers,
      allowedUserId,
    );

    expect(getResponse.headers.get("content-security-policy")).toBe(chatGptConsentPolicy);
    expect(postResponse.status).toBe(302);
    expect(postResponse.headers.get("location")).toBe(callbackUrl);
    expect(postResponse.headers.get("content-security-policy")).toBe(responsePolicy);
  });

  it("binds consent and redirect CSP to the registered callback origin", async () => {
    const helpers = createOAuthHelpers();
    const access = accessContext();
    const otherRequest = {
      responseType: "code",
      clientId: "other-client",
      redirectUri: "https://client.example/callback",
      scope: ["mcp:read"],
      state: "other-state",
      codeChallenge: "B".repeat(43),
      codeChallengeMethod: "S256",
      resource: "https://memory.example.com/mcp",
      issuer: "https://memory.example.com",
    } satisfies AuthRequest;
    const otherHelpers: OAuthAuthorizationHelpers = {
      ...helpers,
      parseAuthRequest: async () => otherRequest,
      describeConsent: async () => ({
        ...consentDescription,
        redirectUri: otherRequest.redirectUri,
      }),
      completeAuthorization: async () => ({
        redirectTo: "https://client.example/callback?code=other-test",
      }),
    };
    const getResponse = await handleAuthorizeRequest(
      new Request("https://memory.example.com/authorize"),
      access,
      otherHelpers,
      allowedUserId,
    );
    const postResponse = await handleAuthorizeRequest(
      new Request("https://memory.example.com/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          handle: "one-time-test-handle",
          decision: "approve",
          scope: "mcp:read",
        }),
      }),
      access,
      otherHelpers,
      allowedUserId,
    );

    const expectedPolicy =
      "default-src 'none'; form-action 'self' https://client.example; base-uri 'none'; frame-ancestors 'none'";
    expect(getResponse.headers.get("content-security-policy")).toBe(expectedPolicy);
    expect(postResponse.headers.get("content-security-policy")).toBe(responsePolicy);
  });
});
