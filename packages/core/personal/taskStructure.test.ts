import { describe, it, expect } from "vitest";
import { parseStructureResult, structureTask, buildStructurePrompt } from "./taskStructure";
import type { DesktopBridge } from "../desktop/bridge";

const bridge = {} as DesktopBridge; // 注入 complete，故 bridge 不被真正使用

describe("parseStructureResult（稳健解析不可信模型输出）", () => {
  it("干净 JSON → 全字段", () => {
    const s = parseStructureResult('{"dueDate":"2026-07-03","tags":["@email"],"projectName":"工作"}');
    expect(s).toEqual({ dueDate: "2026-07-03", tags: ["@email"], projectName: "工作" });
  });
  it("围栏 + 前后散文 → 提取其中 JSON", () => {
    const s = parseStructureResult('好的，结果如下：\n```json\n{"dueDate":"2026-07-03"}\n```\n希望有用');
    expect(s.dueDate).toBe("2026-07-03");
  });
  it("非法日期丢弃", () => {
    expect(parseStructureResult('{"dueDate":"周五","deferDate":"2026-13-40"}')).toEqual({});
  });
  it("tags 规范化 + 去重 + 丢非字符串", () => {
    const s = parseStructureResult('{"tags":[" @Email ","@email","#工作",123]}');
    expect(s.tags).toEqual(["@email", "#工作"]);
  });
  it("垃圾/非 JSON → 空建议不抛", () => {
    expect(parseStructureResult("这不是 JSON")).toEqual({});
    expect(parseStructureResult("")).toEqual({});
    expect(parseStructureResult("{ 坏 json")).toEqual({});
  });
  it("未知字段忽略、空 projectName 丢弃", () => {
    expect(parseStructureResult('{"foo":1,"projectName":"  "}')).toEqual({});
  });
});

describe("structureTask（AE1/AE2）", () => {
  it("AE1：注入 complete 返回 JSON → 解析出 due/tag", async () => {
    const complete = async () => '{"dueDate":"2026-07-03","tags":["@email"]}';
    const s = await structureTask(bridge, "周五前给张伟回邮件", { today: "2026-07-01", complete });
    expect(s.dueDate).toBe("2026-07-03");
    expect(s.tags).toEqual(["@email"]);
  });
  it("AE2：complete 抛错（离线）→ 空建议、不抛、不阻断", async () => {
    const complete = async () => {
      throw new Error("offline");
    };
    await expect(structureTask(bridge, "任意", { today: "2026-07-01", complete })).resolves.toEqual({});
  });
  it("prompt 含 today 与标题", () => {
    const p = buildStructurePrompt("周五前回邮件", "2026-07-01");
    expect(p).toContain("2026-07-01");
    expect(p).toContain("周五前回邮件");
  });
});
