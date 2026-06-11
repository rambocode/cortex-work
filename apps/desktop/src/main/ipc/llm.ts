// 自定义 OpenAI 兼容端点一次性补全（本地大模型生成日报用）。
// 在主进程发请求：规避 renderer CORS,且 apiKey 不出 main。

import { ipcMain } from "electron";
import { chatCompletionsUrl } from "./push-sign";

interface OpenAiCompleteRequest {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
}

const TIMEOUT_MS = 60_000;

export function registerLlmHandlers(): void {
  ipcMain.handle("llm:openaiComplete", async (_e, req: OpenAiCompleteRequest) => {
    const url = chatCompletionsUrl(req.baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.model,
        messages: [{ role: "user", content: req.prompt }],
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`模型接口 HTTP ${res.status}${body ? `:${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("模型未返回内容");
    return content.trim();
  });
}
