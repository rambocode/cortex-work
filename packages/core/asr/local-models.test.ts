import { describe, expect, it } from "vitest";

import {
  LOCAL_ASR_DEFAULT_MODEL_ID,
  LOCAL_ASR_MODELS,
  localAsrDownloadUrl,
  localAsrModelById,
} from "./local-models";

describe("SenseVoiceSmall 本地模型目录", () => {
  it("只暴露固定校验过的 SenseVoiceSmall Q8 模型", () => {
    expect(LOCAL_ASR_DEFAULT_MODEL_ID).toBe("sensevoice-small-q8");
    expect(LOCAL_ASR_MODELS).toHaveLength(1);
    expect(localAsrModelById(LOCAL_ASR_DEFAULT_MODEL_ID)).toMatchObject({
      fileName: "sensevoice-small-q8.gguf",
      sizeBytes: 254_208_320,
      sha256: "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5",
      recommended: true,
    });
  });

  it("官方源与镜像源都指向固定 revision，避免 main 漂移", () => {
    expect(localAsrDownloadUrl("huggingface")).toBe(
      "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf",
    );
    expect(localAsrDownloadUrl("hf-mirror")).toBe(
      "https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf",
    );
  });

  it("拒绝未进入白名单的模型 id", () => {
    expect(() => localAsrModelById("../../secret")).toThrow(/无效的本地 ASR 模型/);
  });
});
