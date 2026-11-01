import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";

const chatGptCallbackOrigin = "https://chatgpt.com";
const baseContentSecurityPolicy =
  "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const consentContentSecurityPolicy = `default-src 'none'; form-action 'self' ${chatGptCallbackOrigin}; base-uri 'none'; frame-ancestors 'none'`;

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const readScope = "mcp:read";
  const clientName = escapeHtml(details.clientName);
  const clientPublisher =
    details.clientDomain === undefined
      ? "<strong>Publisher domain not verified</strong>"
      : `Published by <strong>${escapeHtml(details.clientDomain)}</strong>`;
  const loopbackWarning = details.redirectIsLoopback
    ? "<p><strong>This request redirects to an application on this computer.</strong></p>"
    : "";
  const redirectHost = escapeHtml(details.redirectHost);
  const escapedHandle = escapeHtml(handle);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${clientName}</title>
</head>
<body>
<main>
<h1>Allow ${clientName} to read AI Memory?</h1>
<p>${clientPublisher}</p>
<p>Authorization will be returned to <strong>${redirectHost}</strong>.</p>
${loopbackWarning}
<p>Access is limited to read-only tools for the current project.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapedHandle}">
<label><input type="checkbox" name="scope" value="${readScope}" checked> Read current-project memory</label>
<p><button type="submit" name="decision" value="approve">Allow read-only access</button></p>
</form>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapedHandle}">
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</main>
</body>
</html>`;
}

export function securityHeaders(headers?: HeadersInit): Headers {
  return createSecurityHeaders(headers, baseContentSecurityPolicy);
}

export function consentPageHeaders(headers?: HeadersInit): Headers {
  return createSecurityHeaders(headers, consentContentSecurityPolicy);
}

function createSecurityHeaders(headers: HeadersInit | undefined, policy: string): Headers {
  const secureHeaders = new Headers(headers);
  secureHeaders.set("Cache-Control", "no-store");
  secureHeaders.set("Content-Security-Policy", policy);
  secureHeaders.set("Referrer-Policy", "no-referrer");
  secureHeaders.set("X-Content-Type-Options", "nosniff");
  return secureHeaders;
}

export function redirectResponse(headers: HeadersInit, redirectTo: string): Response {
  const redirectHeaders = securityHeaders(headers);
  redirectHeaders.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: redirectHeaders });
}

export function authorizationErrorResponse(error: unknown): Response | undefined {
  if (error instanceof AuthorizationError) {
    if (error.redirectTo !== undefined) {
      return redirectResponse(new Headers(), error.redirectTo);
    }
    return new Response("Invalid OAuth authorization request", {
      status: 400,
      headers: securityHeaders(),
    });
  }
  if (error instanceof CimdFetchError) {
    return new Response("OAuth client metadata could not be verified", {
      status: 400,
      headers: securityHeaders(),
    });
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
