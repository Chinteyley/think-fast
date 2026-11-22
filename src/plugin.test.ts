import { describe, expect, it } from "vitest";
import entry from "./index.js";

// The entry registers one tool and the race page's three Gateway routes.
describe("think-fast plugin entry", () => {
  it("registers think_fast and the /think-fast routes", async () => {
    const tools: string[] = [];
    const routes: { path: string; auth: string; match?: string }[] = [];
    const api = {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerHttpRoute: (route: { path: string; auth: string; match?: string }) => routes.push(route),
    };
    await (entry as unknown as { register: (a: typeof api) => unknown }).register(api);
    expect(tools).toEqual(["think_fast"]);
    expect(routes.map((r) => `${r.path} ${r.match ?? "exact"}`)).toEqual([
      "/think-fast exact",
      "/think-fast/events exact",
      "/think-fast/runs prefix",
    ]);
    expect(routes.every((r) => r.auth === "plugin")).toBe(true);
  });
});
