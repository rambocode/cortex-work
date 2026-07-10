// 做梦蒸馏 prompt 构建与输出清洗测试。
import { describe, expect, it } from "vitest";
import { buildDreamPrompt, cleanDreamedFacts, DREAM_MAX_FACTS } from "./dream-prompt";
import type { EpisodeSample } from "./episodic";

const episodes: EpisodeSample[] = [
  { sessionId: "s1", title: "桌面端开发", lines: ["用户：我在做 Electron 应用", "助手：好的"] },
  { sessionId: "s2", lines: ["用户：以后回复我都用中文"] },
];

describe("buildDreamPrompt", () => {
  it("system 含分区目标与合并/遗忘/忽略一次性内容的指令", () => {
    const prompt = buildDreamPrompt("profile", episodes, "");
    expect(prompt.system).toContain("关于用户本人的稳定事实");
    expect(prompt.system).toContain("遗忘");
    expect(prompt.system).toContain("一次性任务细节");
    expect(prompt.system).toContain(`不超过 ${DREAM_MAX_FACTS} 条`);
  });

  it("existingAuto 非空时并入「已有记忆」段；为空时不出现该段", () => {
    const withAuto = buildDreamPrompt("preferences", episodes, "- 喜欢 pnpm");
    expect(withAuto.user).toContain("已有记忆：\n- 喜欢 pnpm");
    const withoutAuto = buildDreamPrompt("preferences", episodes, "  ");
    expect(withoutAuto.user).not.toContain("已有记忆");
  });

  it("会话按标题标注、正文逐行并入", () => {
    const prompt = buildDreamPrompt("projects", episodes, "");
    expect(prompt.user).toContain("会话 1（桌面端开发）：");
    expect(prompt.user).toContain("用户：我在做 Electron 应用");
    expect(prompt.user).toContain("会话 2：");
  });
});

describe("cleanDreamedFacts", () => {
  it("只保留要点行，丢弃解释/标题", () => {
    const raw = "好的，总结如下：\n- 用户是前端工程师\n• 偏好中文交流\n以上就是全部。";
    expect(cleanDreamedFacts(raw)).toBe("- 用户是前端工程师\n• 偏好中文交流");
  });

  it("超过上限时硬截断", () => {
    const raw = Array.from({ length: DREAM_MAX_FACTS + 5 }, (_, i) => `- 条目${i}`).join("\n");
    expect(cleanDreamedFacts(raw).split("\n")).toHaveLength(DREAM_MAX_FACTS);
  });

  it("模型只吐解释时返回空串（调用方据此保留旧记忆）", () => {
    expect(cleanDreamedFacts("没有可提炼的内容。")).toBe("");
  });
});
