import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/user-data", getVersion: () => "test" },
}));

import { _internals, getLocalAsrModelStatus, modelFilePath } from "./models";

describe("SenseVoice 模型管理", () => {
  beforeEach(() => _internals.resetState());

  it("模型路径只能由白名单 ID 派生", () => {
    expect(modelFilePath("sensevoice-small-q8")).toBe(
      "/user-data/models/speech/sensevoice/sensevoice-small-q8/sensevoice-small-q8.gguf",
    );
    expect(() => modelFilePath("../../escape" as never)).toThrow(/无效的本地 ASR 模型/);
  });

  it("IPC 状态查询拒绝任意 modelId", async () => {
    await expect(getLocalAsrModelStatus("../../escape")).rejects.toThrow(/无效的 modelId/);
  });
});
