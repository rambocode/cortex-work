// 本地假聚合网关（new-api / one-api 形态），用于在**没有真实网关**时验证「设置 → 模型服务 →
// 接入聚合网关」这条链路，以及自定义供应商在聊天里的真实收发。
//
// 用法：
//   node scripts/mock-gateway.mjs            # 监听 http://127.0.0.1:8799
//   PORT=9001 node scripts/mock-gateway.mjs  # 换端口
// 然后在应用里：设置 → 模型服务 → 接入聚合网关 → 地址填 http://127.0.0.1:8799/v1，
// API Key 随便填（本服务只校验「有没有带」，不校验内容）。
//
// ── 为什么要严格校验而不是照单全收 ─────────────────────────────────────────────
// 这个服务的价值在于**能复现真实上游的拒绝行为**。国产上游（MiniMax / Kimi 等）经网关转发时
// 只认 system/assistant/user/tool 四种 role、且要求 `max_tokens` 而非 `max_completion_tokens`；
// pi 对推理模型在缺 `compat` 时会按现代 OpenAI 约定发 `developer` 角色 —— 那正是线上那条
// `invalid value: developer` 400 的来源。若这里来者不拒，回归就测不出来了。
//
// 每条请求都会打印一行摘要（role 列表、token 字段名、模型），便于肉眼核对 pi 实际发了什么。
//
// ⚠️ 本服务**比真实 new-api 更严格**，这是刻意的（当回归金丝雀用），但读结论时要区分：
//   · `role: developer` 被拒 —— 真实上游确实这么拒，用户实测到过，是**真问题**；
//   · `max_completion_tokens` 被拒 —— 只有非 OpenAI 上游会拒；new-api 转发到真 OpenAI 时接受。
//     所以这里报错**不等于**线上一定坏（例如 gpt-4o 经网关转发到官方端点是正常的）。
// 想放宽后者：STRICT_MAX_TOKENS=0 node scripts/mock-gateway.mjs

import http from "node:http";

const PORT = Number(process.env.PORT ?? 8799);
/** 是否拒绝 `max_completion_tokens`（模拟非 OpenAI 上游）。见文件头的解读说明。 */
const STRICT_MAX_TOKENS = process.env.STRICT_MAX_TOKENS !== "0";

/** 上游只认这四种 role —— 与用户实测到的 400 文案一致。 */
const ALLOWED_ROLES = new Set(["system", "assistant", "user", "tool"]);

/**
 * 模型清单。刻意混了三类，覆盖向导的三条能力解析路径：
 *   · pi 内置目录能命中的（gpt-4o / deepseek-chat）      → 能力自动识别，带正确 compat
 *   · 目录里有但只在别的协议下收录的（MiniMax-M2.7）      → 跨协议命中，compat 必须保留
 *   · 目录完全不认识的（kimi-k2.5 / 自研模型）            → 走保守兜底，仍应可用
 *   · 非对话模型（grok-imagine-image）                    → 用来观察噪声模型的表现
 */
const MODELS = [
  "gpt-4o",
  "deepseek-chat",
  "MiniMax-M2.7",
  "kimi-k2.5",
  "qwen3-max-internal",
  "grok-imagine-image",
];

/** OpenAI 风格错误体，字段与 new-api 实际返回对齐。 */
function badRequest(res, message) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ message, type: "BadRequest", param: "", code: "InvalidParameter" }));
}

/** 一段最小可用的 SSE 补全，让 pi 能正常收流并结束这一轮。 */
function streamOk(res, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id: "mock-1",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant", content: "假网关已收到请求，链路正常。" }));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // 模型发现：向导的「连接」按钮打这里。故意不校验 Key —— 真实网关多数也允许匿名列表。
    if (req.url.endsWith("/models")) {
      console.log(`[models] ${req.url}  auth=${req.headers.authorization ? "有" : "无"}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return badRequest(res, "request body is not valid JSON");
    }

    const roles = (payload.messages ?? []).map((m) => m.role);
    const tokenKeys = Object.keys(payload).filter((k) => k.includes("token"));
    console.log(
      `[chat] model=${payload.model} roles=[${roles.join(",")}] tokenField=[${tokenKeys.join(",")}] ` +
        `auth=${req.headers.authorization ? "有" : "无"}`,
    );

    if (!req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "missing authorization header", type: "Unauthorized" }));
      return;
    }
    // 这两条就是线上 400 的两个成因，务必保留。
    const badRole = roles.find((r) => !ALLOWED_ROLES.has(r));
    if (badRole) {
      return badRequest(
        res,
        `The parameter messages.role specified in the request are not valid: invalid value: ${badRole}, ` +
          `supported values are: ${[...ALLOWED_ROLES].join(", ")}`,
      );
    }
    if (STRICT_MAX_TOKENS && tokenKeys.includes("max_completion_tokens")) {
      return badRequest(res, "unsupported parameter: max_completion_tokens (this upstream expects max_tokens)");
    }

    streamOk(res, payload.model ?? "mock");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`假聚合网关已启动: http://127.0.0.1:${PORT}/v1`);
  console.log(`  模型清单 ${MODELS.length} 条: ${MODELS.join(", ")}`);
  console.log(`  在应用里填这个地址（注意要带 /v1）:  http://127.0.0.1:${PORT}/v1`);
  console.log(`  它会拒绝 role=developer${STRICT_MAX_TOKENS ? " 与 max_completion_tokens" : ""} —— 模拟非 OpenAI 上游。`);
  if (STRICT_MAX_TOKENS) console.log(`  （真实 new-api 转发到官方 OpenAI 时接受 max_completion_tokens，可用 STRICT_MAX_TOKENS=0 放宽）`);
});
