---
title: "CRE U0 协议与安全 spike 实测结论"
type: spike-findings
date: 2026-07-25
status: done
origin: docs/superpowers/specs/2026-07-25-cortex-research-engine-development-spec.md
---

# CRE U0 Spike 实测结论

本文记录 Cortex Research Engine 开工前的实测结果，以及由此确定的**对开发规格（下称 spec）的偏离**。
所有结论均由本机真实执行得出，环境：macOS 25.5.0 / arm64。

| 组件 | 版本 |
| --- | --- |
| Electron | 39.8.10（`apps/desktop` 声明 `^39.2.6`） |
| Electron 内嵌 Node | 22.22.1 |
| 系统 Node（跑 Vitest 用） | 20.19.5 |
| Vitest | 4.1.7 |
| agent-browser | 0.31.1（`resources/agent-browser/mac-arm64/`） |

---

## S1. `node:sqlite` 在 Electron 主进程可用；系统 Node 20 不可用

```
ELECTRON_RUN_AS_NODE=1 electron -e "require('node:sqlite')"
→ node 22.22.1 / node:sqlite OK / DatabaseSync(':memory:') 建表插入查询全通
→ 附带 ExperimentalWarning: SQLite is an experimental feature
```

系统 Node v20.19.5 无 `node:sqlite`。

**结论**：spec §13.2 的 `node:sqlite` 方案可行。因实验性 API 有漂移史，`node:sqlite` 只允许在
`main/research/sqlite-driver.ts` 一处动态 import，其余代码一律走 `SqliteDriver` 接口。

## S2. Vitest 能在 `ELECTRON_RUN_AS_NODE=1` 下运行

```
ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run <file>
→ RUN v4.1.7 / Test Files 1 passed / Tests 1 passed / 118ms
```

测试内容即 S1 的 `node:sqlite` 往返。

**结论**：**风险 R5 解除**，不需要自建 `scripts/run-sqlite-tests.mjs`。真 SQLite 集成测试走
`apps/desktop/vitest.sqlite.config.ts` + `pnpm --filter @cortex-work/desktop test:sqlite`，
默认 `vitest.config.ts` 把 `**/*.sqlite.test.ts` 排除，保证系统 Node 20 下的现有测试行为不变。

## S3. `utilityProcess` 的 stdin **不可 pipe**；协议改走 `postMessage`

`node_modules/electron/electron.d.ts:20716`（`ForkOptions.stdio` 文档）原文：

> Currently this option only supports configuring `stdout` and `stderr` to either `pipe`,
> `inherit` or `ignore`. **Configuring `stdin` to any property other than `ignore` is not
> supported and will result in an error.**

因此 spec §12.1「stdin/stdout 使用 JSONL」在 `utilityProcess` 下**物理上不可实现**。

实测替代方案（`utilityProcess.fork` + `postMessage` / `process.parentPort`）：

```
stdio: ["ignore", "pipe", "pipe"]
child.postMessage(JSON.stringify(req))   ←→   process.parentPort.postMessage(JSON.stringify(res))
```

结果：
```
STDERR_PIPE_OK: worker stderr line          ← stderr 管道可用，可做 2KB stderrTail
RECV: {"type":"response","id":"hello_01",...}
RECV: {"type":"response","id":"r2",...}
ROUNDTRIP_OK                                 ← 两条请求乱序无关，按 id 关联成功
EXIT: 0                                      ← 退出码正常传播
```

**偏离 spec §12.1（R1）**：定义 `WorkerTransport` 抽象，契约是「**一行 JSONL 进 / 一行 JSONL 出**」，
而不是「stdin/stdout」。**协议消息体、method 名、字段、错误信封、fixtures 与 spec §12 逐字一致**，
只有承载管道不同。将来换 Rust Worker 时只需实现一个真 stdio 版 `WorkerTransport`，其上零改动。

## S4. `agent-browser --action-policy` 的 JSON schema（此前完全未知）

CLI `--help`、README、内置 skills 均未记录。经黑盒探测确定：

```jsonc
{
  "default": "allow" | "deny",   // 未列出的动作的兜底判定
  "allow":   ["read", "open", "get", "snapshot", "close", "session", "wait"],
  "deny":    ["evaluate", "upload", "download", "clipboard"]
}
```

验证（`{"default":"deny","allow":["read","open","get","snapshot","close","session","wait"]}`）：

| 命令 | 结果 |
| --- | --- |
| `read https://example.com` | ✅ 通过 |
| `close` | ✅ 通过 |
| `eval "1+1"` | ❌ `Action 'evaluate' denied by policy: ... not in the allow list` |
| `upload "#f" /etc/passwd` | ❌ `Action 'upload' denied by policy` |
| `clipboard read` | ❌ `Action 'clipboard' denied by policy` |
| `screenshot /tmp/x.png` | ❌ `Action 'screenshot' denied by policy` |

**注意动作名是「规范名」不是「子命令名」**：`eval` 子命令对应的动作名是 `evaluate`。
白名单必须按规范名写，靠子命令名会静默放行。

**结论**：**风险 R6 解除**，U6 无需降级，spec KTD7 的「静态 action policy 禁止 eval、上传、
下载、认证、剪贴板和持久化存储」可以完整落地。

### S4a. ⚠️ action policy 是 **fail-open** 的（新增安全发现）

```
echo 'NOT JSON {{{' > bad.json
agent-browser --action-policy ./bad.json --json read https://example.com
→ {"success":true, ...}          ← 策略被静默忽略，动作照常执行

agent-browser --action-policy ./nope.json --json session
→ {"success":true, ...}          ← 文件不存在同样静默通过
```

畸形或缺失的 policy 文件**不报错、不阻断**，等同于「无策略」。

**处置**：`agent-browser-adapter.ts` 不得假设「传了 `--action-policy` 就等于策略生效」。
适配器必须做**自检**——每次启动 Research Browser 前，先用同一份 policy 跑一次
必被拒绝的探针动作（如 `eval`），确认返回 `denied by policy` 后才继续；探针未被拒绝即
判定策略失效，**fail closed**，本次抓取直接放弃并降级回纯 HTTP。此项写进 P6 的测试。

## S5. `--allowed-domains` 确实拦截

```
agent-browser --allowed-domains example.org --json read https://example.com
→ {"success":false,"data":null,"error":"Domain 'example.com' is not in the allowed domains list"}

agent-browser --allowed-domains example.com --json read https://example.com
→ {"success":true, ...}
```

**已验证**：顶层导航/读取层面的域名拦截生效，错误信息明确。

**未验证（列入人工验证清单）**：子资源、`fetch`、WebSocket、EventSource 是否同样受
`--allowed-domains` 约束（spec §19.2.3）。这需要真 Chrome + 一个会发起跨域子请求的测试页，
无法在无窗口 CI 中自动化。P9 人工执行并记入 acceptance log。

## S6. ⚠️ `agent-browser read` 对简单页面**不启动浏览器**（新增发现）

`read https://example.com` 的返回体里：

```json
"lifecycle": { "effectiveLaunch": { "browserLaunched": false, ... }, "launched": false },
"source": "html-fallback"
```

即 agent-browser 走了它自己的 HTTP 客户端直接取页，Chrome 根本没起。

**影响**：Browser 降级路径的 SSRF 面**不完全等同于 Chrome 的网络栈**，其中一部分是
agent-browser 自带的 HTTP 客户端，**不受我们 Worker 的 DNS 钉扎与私网判定保护**。

**处置**：Worker 在把任何 URL 交给 agent-browser 之前，**必须先跑完整的
`checkUrlPolicy` + DNS 解析私网判定**（与 HTTP Fetcher 同一套策略，spec §12.3 末段本就
要求「各自执行策略，不能假设另一层已校验」）。`--allowed-domains` 只作为第二道防线。

## S7. 开发态 fork 已验证；打包态待 P9

P4 完成后用真实构建产物做了 fork 验证：

```
utilityProcess.fork("apps/desktop/out/worker/research-worker.js", [], { stdio: ["ignore","pipe","pipe"] })
→ [worker stderr] [research-worker] worker 0.1.0 ready on node v22.22.1
→ RECV: {"type":"response","id":"hello_01","result":{"worker_version":"0.1.0","max_protocol_version":1,
         "methods":["hello","doctor","fetch_prepare","rerank","cancel","shutdown"],"browser_available":false}}
→ RECV: {"type":"response","id":"doc_01","result":{"ok":true,"node_version":"v22.22.1",
         "browser_available":false,"pdf_available":true,"issues":[]}}
→ PROTOCOL_ROUNDTRIP_OK / worker exit: 0
```

`pdf_available: true` 是关键——它证明 bundle 进产物的 pdfjs 真的能在 worker 里加载（见 S8）。

**打包态已于 P9 验证通过**（`apps/desktop/scripts/verify-research-packaging.mjs`）：
从 `app.asar.unpacked/out/worker/research-worker.js` fork，hello + doctor 往返成功，
`pdf_available: true`。`asarUnpack: - "out/worker/**"` 生效，pdf chunk 一并解包。
详见 `2026-07-25-cre-acceptance-log.md` §3。

验证脚本自身踩过一个坑，已在脚本注释里记下：`dist/` 会同时留着历史构建
（`mac/`、`mac-arm64/`、`mac-x64/`），按目录名顺序取第一个会验到几天前的陈旧产物
——当时报「worker 缺失」，实际是在验一个 CRE 还不存在的旧包。脚本现按 mtime 取最新，
并在产物超过 2 小时时给出提示。

## S8. ⚠️ Vite `build.ssr: true` 默认外部化全部依赖（新增发现，已修）

Worker 首次构建产物只有 62 KB / 20 modules，`grep` 可见 `require("zod")` 与被原样保留的
`import("pdfjs-dist/legacy/build/pdf.mjs")`。

根因两层叠加：
1. `build.ssr: true` 让 vite 把所有 node_modules 依赖判为 external；`rollupOptions.external`
   只能**追加**外部化，无法反向强制内联。必须显式写**顶层** `ssr: { noExternal: true }`。
2. `electron-builder.yml` 的 `files` 段本就把 `pdfjs-dist` 整个排除出 asar
   （主进程那次 dynamic import 是被 electron-vite bundle 进 `out/main` 才没事的）。

两者叠加的后果：**打包后 worker 的 PDF 抽取直接失败**，而 dev 下一切正常、单测全绿
（`loadPdfJs` 是可注入依赖，根本不加载真 pdfjs）、typecheck 也不看运行期解析。

附带坑：`build.ssr` 模式下 `lib.fileName` **不生效**，产物退回 `index.js`，依赖确定文件名的
entry-resolver 会找不到入口。须用 `rollupOptions.output.entryFileNames` 显式指定。

修复后：产物 190 KB / 100 modules + `chunks/pdf-*.js`(875 KB)，外部 require 只剩 node 内建。
该 pdf chunk 与 `out/main/pdf-*.js` 的 hash 相同，说明 worker 的 pdfjs 打包行为与已在生产运行的
主进程路径完全一致（包括同样对 `@napi-rs/canvas` 的可选依赖引用），不是新增风险。

已记入 `docs/lessons.md`。

---

## 对 spec 的偏离汇总

| # | spec 条款 | 偏离 | 依据 |
| --- | --- | --- | --- |
| R1 | §12.1 stdin/stdout JSONL | 改为 `WorkerTransport`（一行进/一行出），生产实现走 `postMessage`；协议体逐字不变 | S3 |
| R2 | §17.1 Rust Worker / §20 cargo 命令 / §19.5 三架构二进制 | 首版用 TypeScript Worker（用户决策）。不建 `tools/research-worker`、不建 `resources/research-worker`；§20 的三条 cargo 命令替换为 `pnpm --filter @cortex-work/desktop test`。**§19.5「不复用其他架构二进制」自动满足**（TS Worker 跑 Electron 内嵌 Node，无架构相关产物） | 用户决策 |
| R5 | §13.2 SQLite 测试策略 | **无偏离**，`ELECTRON_RUN_AS_NODE` + Vitest 可行 | S2 |
| R6 | KTD7 action policy | **无偏离**，schema 已确定并验证 | S4 |
| **新增** | — | action policy **fail-open**，适配器必须自检探针，fail closed | S4a |
| **新增** | — | `agent-browser read` 可能不起浏览器，SSRF 面含其自带 HTTP 客户端；URL 策略必须在调用前自行执行 | S6 |

其余偏离（R3 PAT 鉴权、R4 `local_only`、R8 正文抽取、R9 SearXNG、R13 pdfjs 双份等）见实现计划，
不属于本次 spike 的实测范围。
