import { describe, expect, it } from "vitest";
import { READ_SESSION_OBSERVATIONS_TOOL, scopeToolArguments } from "../src/policy.js";

describe("READ_SESSION_OBSERVATIONS_TOOL", () => {
  it("exposes the upstream argument fields with read-only annotations", () => {
    expect(READ_SESSION_OBSERVATIONS_TOOL.name).toBe("memory_read_session_observations");
    expect(Object.keys(READ_SESSION_OBSERVATIONS_TOOL.inputSchema.properties)).toEqual([
      "session_id",
      "limit",
      "offset",
      "order",
      "kinds",
      "query",
      "body_max_chars",
      "project",
      "workspace",
    ]);
    expect(READ_SESSION_OBSERVATIONS_TOOL.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});

describe("scopeToolArguments", () => {
  it("rejects tools that persist access-reinforcement metadata", () => {
    for (const name of [
      "memory_handoff_list",
      "memory_lint",
      "memory_query",
      "memory_recent",
      "memory_read_page",
      "memory_briefing",
      "memory_status",
    ]) {
      expect(() => scopeToolArguments(name, {})).toThrow("Unknown or disallowed tool");
    }
  });

  it("overrides caller-supplied project scope", () => {
    const args = scopeToolArguments("memory_read_session_observations", {
      workspace: "other-workspace",
      project: "other-project",
    });

    expect(args).toEqual({
      workspace: "default",
      project: "rafaeljfec2-connexto-aihub",
    });
  });
});
