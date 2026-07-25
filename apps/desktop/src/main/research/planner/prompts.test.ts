import { describe, expect, it } from "vitest";
import { GAP_PLANNER_SYSTEM_PROMPT, INITIAL_PLANNER_SYSTEM_PROMPT } from "./prompts";

const CATEGORY_SCHEMA = '"categories"?: ("general"|"it"|"science"|"news")[]';

describe("research planner category routing", () => {
  it("initial planner can route each query to a supported search category", () => {
    expect(INITIAL_PLANNER_SYSTEM_PROMPT).toContain(CATEGORY_SCHEMA);
    expect(INITIAL_PLANNER_SYSTEM_PROMPT).toContain("不确定时省略 categories");
  });

  it("gap planner can route follow-up queries to a supported search category", () => {
    expect(GAP_PLANNER_SYSTEM_PROMPT).toContain(CATEGORY_SCHEMA);
    expect(GAP_PLANNER_SYSTEM_PROMPT).toContain("不确定时省略 categories");
  });
});
