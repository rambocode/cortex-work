import { describe, expect, it } from "vitest";
import type { PetState } from "../store/pet";
import { derivePetState } from "./derive";
import { IDLE_ACTIVITY, type PetActivity } from "./types";

const A = (over: Partial<PetActivity>): PetActivity => ({ ...IDLE_ACTIVITY, ...over });

describe("derivePetState", () => {
  const CASES: Array<[string, Partial<PetActivity>, PetState]> = [
    ["全空 → idle", {}, "idle"],
    ["只在打字", { typing: true }, "typing"],
    ["run 起来但还没输出", { busy: true }, "thinking"],
    ["思考相位", { busy: true, phase: "reasoning" }, "thinking"],
    ["正文相位", { busy: true, phase: "text" }, "replying"],
    ["审批挂起压过工具", { busy: true, toolRunning: true, awaitingInput: true }, "waiting"],
    ["庆祝压过一切正常态", { busy: true, phase: "text", celebrate: true }, "happy"],
    ["失败优先级最高", { busy: true, celebrate: true, awaitingInput: true, error: true }, "failed"],
    ["打字垫底:agent 在忙时不显示在看你打字", { busy: true, typing: true }, "thinking"],
  ];

  it.each(CASES)("%s", (_name, activity, expected) => {
    expect(derivePetState(A(activity))).toBe(expected);
  });

  // 这两条是整个重构要修的 bug,单独立断言,别和上面的表混在一起被顺手改掉。
  it("工具运行时压过正文相位——不会出现「边跑工具边显示在回话」", () => {
    expect(derivePetState(A({ busy: true, phase: "text", toolRunning: true }))).toBe("working");
  });

  it("工具结束后自动落回 thinking——无需任何调用方显式 set", () => {
    const running = A({ busy: true, phase: "reasoning", toolRunning: true });
    expect(derivePetState(running)).toBe("working");
    // 只翻转电平位,相位原封不动
    expect(derivePetState({ ...running, toolRunning: false })).toBe("thinking");
  });

  it("是纯函数:同一输入恒定同一输出,且不改动入参", () => {
    const input = A({ busy: true, phase: "text" });
    const snapshot = { ...input };
    expect(derivePetState(input)).toBe(derivePetState(input));
    expect(input).toEqual(snapshot);
  });

  it("sleeping 不由本函数产生(它是时间函数,归 engine 覆写)", () => {
    const all: PetState[] = [];
    for (const [, activity] of CASES) all.push(derivePetState(A(activity)));
    expect(all).not.toContain("sleeping");
  });
});
