import { describe, expect, it } from "vitest";
import {
  buildGoalSystemPrompt,
  createThreadGoal,
  goalCanAutoContinue,
  goalStatusFromAssistantText,
  parseGoalCommand,
} from "./goal";

describe("会话目标", () => {
  it("解析创建与控制命令", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "menu" });
    expect(parseGoalCommand("/goal 完成登录页")).toEqual({ action: "set", objective: "完成登录页" });
    expect(parseGoalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(parseGoalCommand("普通消息")).toBe(false);
  });

  it("只给活动目标生成执行契约并识别隐藏终态", () => {
    const goal = createThreadGoal("s1", "完成发布并验证");
    expect(buildGoalSystemPrompt(goal)).toContain("跨回合持久目标");
    expect(buildGoalSystemPrompt({ ...goal, status: "paused" })).toBeUndefined();
    expect(goalStatusFromAssistantText("完成。<!-- cortex_goal:complete -->")).toBe("complete");
  });

  it("自动续跑有明确上限", () => {
    const goal = createThreadGoal("s1", "持续推进");
    expect(goalCanAutoContinue(goal)).toBe(true);
    expect(goalCanAutoContinue({ ...goal, autoTurnCount: 5 })).toBe(false);
  });
});
