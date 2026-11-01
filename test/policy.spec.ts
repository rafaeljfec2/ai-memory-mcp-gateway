import { describe, expect, it } from "vitest";
import { GATEWAY_TOOLS, validateToolArguments } from "../src/policy.js";

describe("gateway tool policy", () => {
  it("publishes only read tools with explicit project scopes", () => {
    expect(GATEWAY_TOOLS.map((tool) => tool.name)).toEqual([
      "memory_list_projects",
      "memory_list_pages",
      "memory_read_page",
      "memory_search",
      "memory_read_briefing",
      "memory_list_sessions",
      "memory_read_session_observations",
    ]);
    for (const tool of GATEWAY_TOOLS) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("requires workspace and project for scoped queries", () => {
    expect(validateToolArguments("memory_list_pages", {})).toContain("workspace and project");
    expect(
      validateToolArguments("memory_list_pages", { workspace: "default", project: "demo" }),
    ).toBeUndefined();
  });

  it("permits global search only without an explicit project scope", () => {
    expect(
      validateToolArguments("memory_search", { query: "needle", global: true }),
    ).toBeUndefined();
    expect(
      validateToolArguments("memory_search", {
        query: "needle",
        global: true,
        workspace: "default",
        project: "demo",
      }),
    ).toContain("cannot include workspace or project");
    expect(
      validateToolArguments("memory_search", {
        query: "needle",
        global: true,
        workspace: "",
      }),
    ).toContain("cannot include workspace or project");
    expect(validateToolArguments("memory_search", { query: "needle" })).toContain(
      "workspace and project are required",
    );
    expect(
      validateToolArguments("memory_search", {
        query: "needle",
        global: "true",
      }),
    ).toContain("global must be a boolean");
  });

  it("publishes the upstream observation limits, UUID, kinds, and pagination fields", () => {
    const observationTool = GATEWAY_TOOLS.find(
      (tool) => tool.name === "memory_read_session_observations",
    );

    expect(observationTool?.inputSchema).toMatchObject({
      properties: {
        session_id: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
        order: { type: "string", enum: ["asc", "desc"] },
        kinds: {
          type: "array",
          items: {
            enum: [
              "session-start",
              "user-prompt",
              "pre-tool-use",
              "post-tool-use",
              "pre-compact",
              "post-compaction",
              "notification",
              "stop",
              "session-end",
              "other",
            ],
          },
        },
      },
    });
    expect(observationTool?.description).toContain("until offset reaches total");
  });
});
