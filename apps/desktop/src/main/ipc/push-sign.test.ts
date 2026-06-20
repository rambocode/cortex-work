import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  audioSpeechPayload,
  audioSpeechUrl,
  audioTranscriptionsUrl,
  audioVoiceUrls,
  chatCompletionsUrl,
  dingtalkSignedUrl,
  feishuSign,
} from "./push-sign";

describe("dingtalkSignedUrl", () => {
  it("追加 timestamp 与 URL 编码后的 HMAC-SHA256 签名", () => {
    const ts = 1781180000000;
    const secret = "SECtest";
    const url = dingtalkSignedUrl("https://oapi.dingtalk.com/robot/send?access_token=abc", secret, ts);
    const expected = encodeURIComponent(
      createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64"),
    );
    expect(url).toBe(
      `https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=${ts}&sign=${expected}`,
    );
  });

  it("无查询串时用 ? 连接", () => {
    expect(dingtalkSignedUrl("https://oapi.dingtalk.com/robot/send", "s", 1)).toContain("/send?timestamp=1&");
  });
});

describe("feishuSign", () => {
  // 已知答案向量(由独立 Node 参考实现算出),字面量相等 —— 快照只能锁自洽、不能证正确。
  it("匹配独立参考实现的已知向量", () => {
    expect(feishuSign("test-secret", 1700000000)).toBe("mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=");
  });

  // 锁住「与钉钉算法相反」:同 (secret, ts) 下飞书(key=ts\nsecret,data 空)
  // 必须 ≠ 钉钉式(key=secret,data=ts\nsecret),防回归到钉钉实现。
  it("与钉钉式 HMAC 结果不相等", () => {
    const secret = "test-secret";
    const ts = 1700000000;
    const dingStyle = createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64");
    expect(feishuSign(secret, ts)).not.toBe(dingStyle);
  });

  it("空 secret 仍返回确定性 base64,不抛", () => {
    expect(feishuSign("", 1700000000)).toBe("DaBQacIHB6FCKocfPme7o5BIrwne87ibBLj7EYGUds0=");
  });
});

describe("chatCompletionsUrl", () => {
  it("无版本段时补 /v1", () => {
    expect(chatCompletionsUrl("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(chatCompletionsUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("已带版本段时不重复", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(chatCompletionsUrl("http://127.0.0.1:8000/v2/")).toBe("http://127.0.0.1:8000/v2/chat/completions");
  });
});

describe("audioSpeechUrl", () => {
  it("无版本段时补 /v1,已带版本段不重复", () => {
    expect(audioSpeechUrl("http://localhost:8880")).toBe("http://localhost:8880/v1/audio/speech");
    expect(audioSpeechUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/audio/speech");
  });
});

describe("audioSpeechPayload", () => {
  it("透传 Qwen TTS 需要的 stream 参数", () => {
    expect(
      audioSpeechPayload({
        baseUrl: "http://127.0.0.1:8000",
        model: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        voice: "vivian",
        text: "你好，今天天气很好。",
        language: "zh",
        stream: true,
        streamingInterval: 1.0,
      }),
    ).toEqual({
      model: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
      input: "你好，今天天气很好。",
      voice: "vivian",
      language: "zh",
      stream: true,
      streaming_interval: 1.0,
    });
  });
});

describe("audioTranscriptionsUrl", () => {
  it("无版本段时补 /v1,已带版本段不重复", () => {
    expect(audioTranscriptionsUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(audioTranscriptionsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/audio/transcriptions");
  });
});

describe("audioVoiceUrls", () => {
  it("生成按模型发现音色的常见候选端点", () => {
    expect(audioVoiceUrls("http://localhost:8880", "tts model")).toEqual([
      "http://localhost:8880/v1/audio/voices?model=tts%20model",
      "http://localhost:8880/v1/models/tts%20model/voices",
      "http://localhost:8880/v1/voices?model=tts%20model",
    ]);
  });
});
