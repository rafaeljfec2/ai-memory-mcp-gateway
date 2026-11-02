import type {
  ApprovedConsent,
  AuthRequest,
  ConsentDescription,
  ConsentTransaction,
  DeniedConsent,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { OAuthAuthorizationHelpers } from "../src/oauth.js";

export const authRequest = {
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
export const allowedUserId = "access-user-id";

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

export function createOAuthHelpers(parsedAuthRequest: AuthRequest = authRequest): Readonly<{
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

export function accessContext(identity?: {
  email?: string;
  user_uuid?: string;
}): CloudflareAccessContext {
  return {
    aud: "access-policy-audience",
    getIdentity: async () => identity,
  };
}
