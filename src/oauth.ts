import type {
  AuthRequest,
  ConsentDescription,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { readConsentForm } from "./oauth-form.js";
import {
  authorizationErrorResponse,
  consentPageHeaders,
  redirectResponse,
  renderConsentPage,
  securityHeaders,
} from "./oauth-responses.js";

export type OAuthAuthorizationHelpers = Pick<
  OAuthHelpers,
  | "parseAuthRequest"
  | "describeConsent"
  | "beginConsent"
  | "approveConsent"
  | "denyConsent"
  | "completeAuthorization"
>;

const readScope = "mcp:read";

export async function handleAuthorizeRequest(
  request: Request,
  access: CloudflareAccessContext | undefined,
  oauth: OAuthAuthorizationHelpers,
  allowedUserId: string | undefined,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/authorize") {
    return new Response("Not found", { status: 404 });
  }

  if (allowedUserId === undefined || allowedUserId.length === 0) {
    return new Response("Gateway authorization is not configured", {
      status: 503,
      headers: securityHeaders(),
    });
  }

  const identity = await access?.getIdentity();
  const identityId = identity?.user_uuid;
  if (identityId === undefined || identityId.length === 0 || identityId !== allowedUserId) {
    return new Response("Cloudflare Access authentication is required", {
      status: 403,
      headers: securityHeaders(),
    });
  }

  try {
    if (request.method === "GET") {
      return await renderConsent(request, oauth);
    }
    if (request.method === "POST") {
      return await completeConsent(request, oauth, identityId);
    }
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  } catch (error) {
    const response = authorizationErrorResponse(error);
    if (response !== undefined) {
      return response;
    }
    throw error;
  }
}

async function renderConsent(
  request: Request,
  oauth: OAuthAuthorizationHelpers,
): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  if (!usesRequiredPkceS256(authRequest)) {
    return new Response("Authorization code flow requires PKCE S256", {
      status: 400,
      headers: securityHeaders(),
    });
  }

  const details = await oauth.describeConsent(authRequest);
  if (!requestsOnlyReadScope(details)) {
    return new Response("Only the mcp:read scope is supported", {
      status: 400,
      headers: securityHeaders(),
    });
  }

  const consent = await oauth.beginConsent(authRequest);
  const headers = consentPageHeaders(consent.headers, details.redirectUri);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(renderConsentPage(details, consent.handle), { headers });
}

function usesRequiredPkceS256(authRequest: AuthRequest): boolean {
  return (
    authRequest.responseType === "code" &&
    authRequest.codeChallengeMethod === "S256" &&
    typeof authRequest.codeChallenge === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(authRequest.codeChallenge)
  );
}

async function completeConsent(
  request: Request,
  oauth: OAuthAuthorizationHelpers,
  identityId: string,
): Promise<Response> {
  const parsedForm = await readConsentForm(request);
  if (parsedForm.kind === "invalid") {
    return parsedForm.response;
  }

  const handle = parsedForm.form.get("handle");
  if (handle === null || handle.length === 0 || handle.length > 512) {
    return new Response("Invalid consent form", {
      status: 400,
      headers: securityHeaders(),
    });
  }

  if (
    parsedForm.form.get("decision") !== "approve" ||
    !parsedForm.form.getAll("scope").includes(readScope)
  ) {
    const denied = await oauth.denyConsent(request, handle);
    return redirectResponse(denied.headers, denied.redirectTo);
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [readScope] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: encodeURIComponent(identityId),
    metadata: {},
    scope: [readScope],
    props: { userId: identityId },
  });
  return redirectResponse(approved.headers, redirectTo);
}

function requestsOnlyReadScope(details: ConsentDescription): boolean {
  return details.scope.length === 1 && details.scope[0] === readScope;
}
