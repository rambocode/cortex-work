// 流式 ASR 模型清单校验。
//
// 这些断言看着琐碎，但每一条都对应一种「下载完了才发现用不了」的失败：清单缺角色、
// revision 写成分支名（远端漂移后哈希对不上）、URL 被拼接成任意路径。

import { describe, expect, it } from "vitest";
import {
  STREAMING_ASR_DEFAULT_MODEL_ID,
  STREAMING_ASR_DOWNLOAD_SOURCES,
  STREAMING_ASR_MODELS,
  isStreamingAsrDownloadSourceId,
  isStreamingAsrModelId,
  streamingAsrDownloadUrl,
  streamingAsrModelById,
  streamingAsrModelTotalBytes,
} from "./streaming-models";

describe("流式 ASR 模型清单", () => {
  it("默认模型在清单内", () => {
    expect(isStreamingAsrModelId(STREAMING_ASR_DEFAULT_MODEL_ID)).toBe(true);
  });

  it.each(STREAMING_ASR_MODELS.map((m) => [m.id, m] as const))(
    "%s 具备 transducer 四件套且元数据完整",
    (_id, model) => {
      // encoder/decoder/joiner/tokens 缺一个，OnlineRecognizer 就只会抛不可读的原生错误。
      const roles = model.files.map((f) => f.role).sort();
      expect(roles).toEqual(["decoder", "encoder", "joiner", "tokens"]);
      for (const file of model.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(file.sizeBytes).toBeLessThanOrEqual(model.maxBytesPerFile);
      }
      // revision 必须钉到 commit sha：写 main/分支名会让远端更新后哈希校验必然失败。
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
    },
  );

  it("文件名互不重复（同目录落盘，重名会互相覆盖）", () => {
    for (const model of STREAMING_ASR_MODELS) {
      const names = model.files.map((f) => f.fileName);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("总字节数等于各文件之和", () => {
    const model = streamingAsrModelById(STREAMING_ASR_DEFAULT_MODEL_ID);
    const sum = model.files.reduce((acc, f) => acc + f.sizeBytes, 0);
    expect(streamingAsrModelTotalBytes(STREAMING_ASR_DEFAULT_MODEL_ID)).toBe(sum);
  });

  it("下载源枚举可用且各自 host 为 https", () => {
    for (const source of STREAMING_ASR_DOWNLOAD_SOURCES) {
      expect(isStreamingAsrDownloadSourceId(source.id)).toBe(true);
      expect(source.host.startsWith("https://")).toBe(true);
    }
  });
});

describe("下载 URL 构造", () => {
  const model = streamingAsrModelById(STREAMING_ASR_DEFAULT_MODEL_ID);

  it("按清单 revision 拼出固定 URL", () => {
    const url = streamingAsrDownloadUrl("huggingface", model.id, "tokens.txt");
    expect(url).toBe(
      `https://huggingface.co/${model.repository}/resolve/${model.revision}/tokens.txt`,
    );
  });

  it("镜像源换 host 但路径一致", () => {
    const a = streamingAsrDownloadUrl("huggingface", model.id, "tokens.txt");
    const b = streamingAsrDownloadUrl("hf-mirror", model.id, "tokens.txt");
    expect(b.replace("https://hf-mirror.com", "")).toBe(a.replace("https://huggingface.co", ""));
  });

  it("拒绝清单外的文件名（防路径注入）", () => {
    expect(() => streamingAsrDownloadUrl("huggingface", model.id, "../../etc/passwd")).toThrow();
    expect(() => streamingAsrDownloadUrl("huggingface", model.id, "evil.onnx")).toThrow();
  });

  it("拒绝非法 modelId / sourceId", () => {
    expect(() => streamingAsrDownloadUrl("huggingface", "nope" as never, "tokens.txt")).toThrow();
    expect(() => streamingAsrDownloadUrl("nope" as never, model.id, "tokens.txt")).toThrow();
  });
});
