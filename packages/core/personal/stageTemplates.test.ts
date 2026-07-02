// stageTemplates 纯函数表驱动单测：内置模板锁定、合并去重、模板实例化、输入校验。
import { describe, expect, it } from "vitest";
import type { StageTemplate } from "../desktop/tasks-types";
import {
  BUILTIN_STAGE_TEMPLATES,
  isBuiltinTemplateId,
  instantiateStages,
  mergeTemplates,
  validateStageTemplateInput,
} from "./stageTemplates";

describe("BUILTIN_STAGE_TEMPLATES", () => {
  it("含 6 个内置模板且全部 builtin=true、id 带内置前缀", () => {
    expect(BUILTIN_STAGE_TEMPLATES).toHaveLength(6);
    for (const t of BUILTIN_STAGE_TEMPLATES) {
      expect(t.builtin).toBe(true);
      expect(isBuiltinTemplateId(t.id)).toBe(true);
    }
  });

  it("软件项目模板为完整 8 阶段生命周期", () => {
    const software = BUILTIN_STAGE_TEMPLATES.find((t) => t.name === "软件项目")!;
    expect(software.stages).toEqual(["客户洽谈", "需求调研", "规划", "执行/开发", "测试", "交付", "验收", "结项"]);
  });

  it("无阶段模板 stages 为空数组", () => {
    expect(BUILTIN_STAGE_TEMPLATES.find((t) => t.name === "无阶段")!.stages).toEqual([]);
  });
});

describe("mergeTemplates", () => {
  const custom: StageTemplate = { id: "tpl-x1", name: "自定义", stages: ["a", "b"] };

  it("内置在前、自定义在后", () => {
    const merged = mergeTemplates([custom]);
    expect(merged.slice(0, BUILTIN_STAGE_TEMPLATES.length).map((t) => t.id)).toEqual(
      BUILTIN_STAGE_TEMPLATES.map((t) => t.id),
    );
    expect(merged[merged.length - 1]).toEqual(custom);
  });

  it("自定义混入内置 id 时按 id 去重丢弃（防重复展示）", () => {
    const dup: StageTemplate = { id: BUILTIN_STAGE_TEMPLATES[0]!.id, name: "冒充内置", stages: [] };
    const merged = mergeTemplates([dup, custom]);
    expect(merged.filter((t) => t.id === dup.id)).toHaveLength(1);
    expect(merged.find((t) => t.id === dup.id)!.name).not.toBe("冒充内置");
  });

  it("自定义之间同 id 只保留第一个", () => {
    const merged = mergeTemplates([custom, { ...custom, name: "重复" }]);
    expect(merged.filter((t) => t.id === custom.id)).toHaveLength(1);
  });
});

describe("instantiateStages", () => {
  // 测试注入确定 id 生成器（生产侧由 main 注入 newTaskId 风格生成器）。
  const seqId = () => {
    let n = 0;
    return () => `stage-${++n}`;
  };

  it("按序实例化：order 用下标、状态全部 not-started", () => {
    const stages = instantiateStages(["调研", "设计", "开发"], seqId());
    expect(stages).toEqual([
      { id: "stage-1", name: "调研", status: "not-started", order: 0 },
      { id: "stage-2", name: "设计", status: "not-started", order: 1 },
      { id: "stage-3", name: "开发", status: "not-started", order: 2 },
    ]);
  });

  it("trim 阶段名并丢弃空白项", () => {
    const stages = instantiateStages(["  a  ", "", "   ", "b"], seqId());
    expect(stages.map((s) => s.name)).toEqual(["a", "b"]);
    expect(stages.map((s) => s.order)).toEqual([0, 1]);
  });

  it("空列表（无阶段模板）返回空数组", () => {
    expect(instantiateStages([], seqId())).toEqual([]);
  });
});

describe("validateStageTemplateInput", () => {
  it.each<[{ name: string; stages: string[] }, string | null]>([
    [{ name: "ok", stages: ["a"] }, null],
    [{ name: "ok", stages: [] }, null], // 空阶段列表合法 = 无阶段模板
    [{ name: "", stages: ["a"] }, "模板名称不能为空"],
    [{ name: "   ", stages: ["a"] }, "模板名称不能为空"],
    [{ name: "ok", stages: ["a", " "] }, "阶段名不能为空"],
  ])("%j → %s", (input, expected) => {
    expect(validateStageTemplateInput(input)).toBe(expected);
  });
});
