import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  type GatewayEnvironment,
  type GatewayFetch,
  handleMcpRequest,
} from "../src/mcp-gateway.js";
import { GATEWAY_TOOLS } from "../src/policy.js";

const sessionId = process.env.AI_MEMORY_TEST_SESSION_ID ?? "";
const configuredUpstream = process.env.AI_MEMORY_TEST_UPSTREAM;
const bearer = process.env.AI_MEMORY_TEST_BEARER;
const localUpstream = parseLocalUpstream(configuredUpstream);
const integrationConfigured =
  localUpstream !== undefined && isNativeUserCredential(bearer) && isUuid(sessionId);
const gatewayEnvironment: GatewayEnvironment = {
  AI_MEMORY_ORIGIN_URL: "https://memory-origin.connexto.com.br/mcp",
  AI_MEMORY_BEARER: bearer ?? "",
};

const realApiFetch: GatewayFetch = (input, init) => {
  if (localUpstream === undefined) {
    throw new Error("The real upstream test requires a loopback AI Memory URL");
  }
  const requested = new URL(input instanceof Request ? input.url : input.toString());
  const target = new URL(`${requested.pathname}${requested.search}`, localUpstream.origin);
  return fetch(target, init);
};

describe("real AI Memory REST integration", () => {
  it.skipIf(!integrationConfigured)(
    "uses the user credential and reads all authorized observations across pages",
    async () => {
      const identityResponse = await realApiFetch(
        "https://memory-origin.connexto.com.br/identity",
        {
          headers: { Authorization: `Bearer ${bearer}` },
        },
      );
      expect(identityResponse.status).toBe(200);
      const identity: unknown = await identityResponse.json();
      expect(identity).toMatchObject({ level: "user", version: expect.any(String) });

      const gatewayFetch: typeof fetch = (input, init) =>
        handleMcpRequest(new Request(input, init), gatewayEnvironment, realApiFetch);
      const transport = new StreamableHTTPClientTransport(new URL("https://gateway.test/mcp"), {
        fetch: gatewayFetch,
      });
      const client = new Client({ name: "local-real-upstream-check", version: "1.0.0" });

      await client.connect(transport);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
          GATEWAY_TOOLS.map((tool) => tool.name),
        );
        const projectResult = await client.callTool({
          name: "memory_list_projects",
          arguments: {},
        });
        expect(projectResult.isError).not.toBe(true);
        const projects = parseProjects(readText(projectResult));
        const project = projects[0];
        expect(project).toBeDefined();
        if (project === undefined) throw new Error("AI Memory returned no readable projects");

        const pagesResult = await client.callTool({
          name: "memory_list_pages",
          arguments: project,
        });
        expect(pagesResult.isError).not.toBe(true);
        const pagePaths = parsePagePaths(readText(pagesResult));
        const pagePath = pagePaths[0];
        expect(pagePath).toBeDefined();
        if (pagePath === undefined) throw new Error("AI Memory returned no readable pages");

        const fullPageResult = await client.callTool({
          name: "memory_read_page",
          arguments: { ...project, path: pagePath },
        });
        expect(fullPageResult.isError).not.toBe(true);
        expect(JSON.parse(readText(fullPageResult))).toBeTypeOf("object");

        const globalSearch = await client.callTool({
          name: "memory_search",
          arguments: { query: "memory", global: true, limit: 1 },
        });
        expect(globalSearch.isError).not.toBe(true);
        const projectSearch = await client.callTool({
          name: "memory_search",
          arguments: { ...project, query: "memory", limit: 1 },
        });
        expect(projectSearch.isError).not.toBe(true);

        const briefingResult = await client.callTool({
          name: "memory_read_briefing",
          arguments: project,
        });
        expect(briefingResult.isError).not.toBe(true);

        const sessionsResult = await client.callTool({
          name: "memory_list_sessions",
          arguments: { ...project, include_open: true, limit: 1, offset: 0 },
        });
        expect(sessionsResult.isError).not.toBe(true);

        const sessions = await findAuthorizedSessions(client, projects);
        expect(sessions.length).toBeGreaterThan(0);
        let fetchedTotal = 0;
        let expectedTotal = 0;
        for (const session of sessions) {
          expectedTotal += session.firstPage.total;
          let fetched = 0;
          let offset = 0;
          while (offset < session.firstPage.total) {
            const page =
              offset === session.firstPage.offset
                ? session.firstPage
                : await readObservationPage(client, session.project, offset);
            expect(page.total).toBe(session.firstPage.total);
            expect(page.offset).toBe(offset);
            expect(page.limit).toBeGreaterThan(0);
            expect(page.elided_other_scope).toBeGreaterThanOrEqual(0);
            fetched += page.observations.length;
            offset += page.limit;
          }
          expect(fetched).toBe(session.firstPage.total);
          fetchedTotal += fetched;
        }
        expect(fetchedTotal).toBe(expectedTotal);
      } finally {
        await client.close();
      }
    },
    60_000,
  );
});

type ProjectScope = Readonly<{ workspace: string; project: string }>;
type ProjectSummary = Readonly<{ workspace_name: string; project_name: string }>;
type ObservationPage = Readonly<{
  total: number;
  offset: number;
  limit: number;
  elided_other_scope: number;
  observations: readonly unknown[];
}>;

function parseLocalUpstream(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isNativeUserCredential(value: string | undefined): value is string {
  return typeof value === "string" && /^aim_[A-Za-z0-9_-]{43}$/.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (result.isError) throw new Error("The AI Memory tool call was rejected");
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("The AI Memory tool did not return JSON text");
  return content.text;
}

function parseProjects(value: string): readonly ProjectScope[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("AI Memory projects response was not an array");
  return parsed.filter(isProjectSummary).map((project) => ({
    workspace: project.workspace_name,
    project: project.project_name,
  }));
}

function parsePagePaths(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("AI Memory pages response was not an array");
  return parsed.flatMap((page) =>
    typeof page === "object" && page !== null && "path" in page && typeof page.path === "string"
      ? [page.path]
      : [],
  );
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "workspace_name" in value &&
    typeof value.workspace_name === "string" &&
    "project_name" in value &&
    typeof value.project_name === "string"
  );
}

async function findAuthorizedSessions(
  client: Client,
  projects: readonly ProjectScope[],
): Promise<readonly Readonly<{ project: ProjectScope; firstPage: ObservationPage }>[]> {
  const sessions: { project: ProjectScope; firstPage: ObservationPage }[] = [];
  for (const project of projects) {
    const result = await client.callTool({
      name: "memory_read_session_observations",
      arguments: { ...project, session_id: sessionId, limit: 50, offset: 0, order: "asc" },
    });
    if (result.isError) continue;
    sessions.push({ project, firstPage: parseObservationPage(readText(result)) });
  }
  return sessions;
}

async function readObservationPage(
  client: Client,
  project: ProjectScope,
  offset: number,
): Promise<ObservationPage> {
  const result = await client.callTool({
    name: "memory_read_session_observations",
    arguments: { ...project, session_id: sessionId, limit: 50, offset, order: "asc" },
  });
  return parseObservationPage(readText(result));
}

function parseObservationPage(value: string): ObservationPage {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("total" in parsed) ||
    typeof parsed.total !== "number" ||
    !("offset" in parsed) ||
    typeof parsed.offset !== "number" ||
    !("limit" in parsed) ||
    typeof parsed.limit !== "number" ||
    !("elided_other_scope" in parsed) ||
    typeof parsed.elided_other_scope !== "number" ||
    !("observations" in parsed) ||
    !Array.isArray(parsed.observations)
  ) {
    throw new Error("AI Memory observations response omitted pagination metadata");
  }
  return {
    total: parsed.total,
    offset: parsed.offset,
    limit: parsed.limit,
    elided_other_scope: parsed.elided_other_scope,
    observations: parsed.observations,
  };
}
