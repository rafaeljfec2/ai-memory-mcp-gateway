export interface GatewayEnvironment {
  readonly AI_MEMORY_ORIGIN_URL: string;
  readonly AI_MEMORY_BEARER: string;
  readonly AI_MEMORY_ACCESS_CLIENT_ID?: string;
  readonly AI_MEMORY_ACCESS_CLIENT_SECRET?: string;
}

export type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function callReadEndpoint(
  name: string,
  args: Readonly<Record<string, unknown>>,
  env: GatewayEnvironment,
  upstreamFetch: GatewayFetch,
): Promise<Response> {
  const url = makeApiUrl(env.AI_MEMORY_ORIGIN_URL, name, args);
  const response = await upstreamFetch(url, {
    method: "GET",
    headers: upstreamHeaders(env),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error("AI Memory upstream redirects are not allowed");
  }
  return response;
}

function makeApiUrl(origin: string, name: string, args: Readonly<Record<string, unknown>>): URL {
  const url = new URL(origin);
  const query = new URLSearchParams();
  let path: string;

  switch (name) {
    case "memory_list_projects":
      path = "/api/v1/projects";
      if (typeof args.workspace === "string") query.set("workspace", args.workspace);
      break;
    case "memory_list_pages":
      path = `/api/v1/workspaces/${scopedSegment(args.workspace)}/projects/${scopedSegment(args.project)}/pages`;
      break;
    case "memory_read_page":
      path = `/api/v1/workspaces/${scopedSegment(args.workspace)}/projects/${scopedSegment(args.project)}/pages/${encodePagePath(args.path)}`;
      break;
    case "memory_search":
      path = "/api/v1/search";
      query.set("q", String(args.query));
      query.set("limit", String(args.limit ?? 10));
      if (args.global !== true) {
        query.set("workspace", scopedSegment(args.workspace));
        query.set("project", scopedSegment(args.project));
      }
      break;
    case "memory_read_briefing":
      path = `/api/v1/workspaces/${scopedSegment(args.workspace)}/projects/${scopedSegment(args.project)}/briefing`;
      break;
    case "memory_list_sessions":
      path = `/api/v1/workspaces/${scopedSegment(args.workspace)}/projects/${scopedSegment(args.project)}/sessions`;
      query.set("include_open", String(args.include_open ?? false));
      query.set("limit", String(args.limit ?? 20));
      query.set("offset", String(args.offset ?? 0));
      break;
    case "memory_read_session_observations":
      path = `/api/v1/workspaces/${scopedSegment(args.workspace)}/projects/${scopedSegment(args.project)}/sessions/${encodeURIComponent(String(args.session_id))}/observations`;
      query.set("limit", String(args.limit ?? 50));
      query.set("offset", String(args.offset ?? 0));
      query.set("order", String(args.order ?? "asc"));
      query.set("body_max_chars", String(args.body_max_chars ?? 4000));
      if (Array.isArray(args.kinds)) query.set("kinds", args.kinds.map(String).join(","));
      if (typeof args.query === "string") query.set("q", args.query);
      break;
    default:
      throw new Error("Unknown or disallowed tool");
  }

  url.pathname = path;
  url.search = query.toString();
  return url;
}

function scopedSegment(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value === "." || value === "..") {
    throw new Error("workspace and project are required");
  }
  return encodeURIComponent(value);
}

function encodePagePath(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("path is required");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("invalid page path");
  }
  return segments.map(encodeURIComponent).join("/");
}

function upstreamHeaders(env: GatewayEnvironment): Headers {
  const headers = new Headers({ Authorization: `Bearer ${env.AI_MEMORY_BEARER}` });
  if (env.AI_MEMORY_ACCESS_CLIENT_ID && env.AI_MEMORY_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.AI_MEMORY_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.AI_MEMORY_ACCESS_CLIENT_SECRET);
  }
  return headers;
}
