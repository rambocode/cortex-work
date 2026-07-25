// Worker 协议的跨端样例真源（spec §18 U0：「输出协议 fixtures，四端解析同一份样例」）。
//
// 用途：TS main、TS Worker、将来的 Rust Worker 都必须能解析这里的每一行。改动本文件即视为
// 破坏性协议变更，必须同步 bump RESEARCH_PROTOCOL_VERSION 并更新全部实现。
//
// 为什么样例是**字符串而不是对象**：协议的最小单元是「一行 JSONL」，字段顺序、转义、单行性
// 都属于契约的一部分。存成对象会让这些性质在序列化时才被决定，测试也就测不到它们。

/// 消息方向。to_worker 用 parseWorkerInbound 解析，to_main 用 parseWorkerOutbound。
export type ProtocolDirection = "to_worker" | "to_main";

export interface ProtocolFixture {
  /// 稳定标识，测试按名取用；改名等同于删旧增新。
  name: string;
  direction: ProtocolDirection;
  /// 该样例归属的 method。to_main 的响应样例据此校验「每个 method 都有响应样例」。
  forMethod: string;
  line: string;
}

export const PROTOCOL_FIXTURES: readonly ProtocolFixture[] = [
  // --- hello：握手必须是第一条请求（spec §12.1） ---
  {
    name: "hello:request",
    direction: "to_worker",
    forMethod: "hello",
    line: '{"type":"request","id":"hello_01","method":"hello","params":{"protocol_version":1,"desktop_version":"0.1.48"}}',
  },
  {
    name: "hello:response",
    direction: "to_main",
    forMethod: "hello",
    line: '{"type":"response","id":"hello_01","result":{"worker_version":"0.1.0","max_protocol_version":1,"methods":["hello","doctor","fetch_prepare","rerank","cancel","shutdown"],"browser_available":true}}',
  },
  {
    // 版本不兼容时 main 不得继续发业务请求，故这条错误样例也是契约的一部分。
    name: "hello:protocol_mismatch",
    direction: "to_main",
    forMethod: "hello",
    line: '{"type":"response","id":"hello_01","error":{"code":"protocol_mismatch","message":"worker supports protocol <= 1, main requested 2"}}',
  },

  // --- doctor：自检，供设置页展示，不参与自动化判定 ---
  {
    name: "doctor:request",
    direction: "to_worker",
    forMethod: "doctor",
    line: '{"type":"request","id":"doc_01","method":"doctor","params":{"agent_browser_binary":"/Applications/Cortex.app/Contents/Resources/agent-browser/agent-browser"}}',
  },
  {
    name: "doctor:response",
    direction: "to_main",
    forMethod: "doctor",
    line: '{"type":"response","id":"doc_01","result":{"ok":true,"node_version":"22.22.1","browser_available":true,"pdf_available":true,"issues":[]}}',
  },

  // --- fetch_prepare：主流程。输入只含候选与策略，不含 Memory / 本地文件正文（spec KTD4） ---
  {
    name: "fetch_prepare:request",
    direction: "to_worker",
    forMethod: "fetch_prepare",
    line: '{"type":"request","id":"req_07","method":"fetch_prepare","params":{"operation_id":"op_07","objective":"open source desktop AI agent 现状","subquestions":[{"id":"sq_1","text":"有哪些开源桌面 AI agent"},{"id":"sq_2","text":"它们的许可证分别是什么"}],"candidates":[{"candidate_id":"c_1","query_id":"q_1","title":"Example Domain","url":"https://example.com/a","canonical_url":"https://example.com/a","snippet":"an example","domain":"example.com","engines":["duckduckgo","brave"],"published_at":"2026-06-01T00:00:00Z","server_score":0.82}],"known_fingerprints":[{"document_id":"doc_prev","content_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}],"policy":{"trust_zone":"public_web","allow_search_server":true,"allow_cloud_model":true,"allow_cross_session_reuse":true},"limits":{"max_documents":24,"max_browser_fetches":5,"max_total_bytes":52428800,"max_duration_ms":600000,"http_concurrency":6,"per_host_concurrency":2,"request_timeout_ms":20000},"agent_browser_binary":"/Applications/Cortex.app/Contents/Resources/agent-browser/agent-browser","allowed_domains":["example.com"]}}',
  },
  {
    name: "fetch_prepare:progress_event",
    direction: "to_main",
    forMethod: "fetch_prepare",
    line: '{"type":"event","event":"progress","operation_id":"op_07","stage":"fetching","completed":3,"total":8}',
  },
  {
    name: "fetch_prepare:response",
    direction: "to_main",
    forMethod: "fetch_prepare",
    line: '{"type":"response","id":"req_07","result":{"operation_id":"op_07","documents":[{"candidate_id":"c_1","url":"https://example.com/a","canonical_url":"https://example.com/a","title":"Example Domain","content_hash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","simhash":"c3f1a2b4d5e60718","media_type":"text/html","fetch_method":"http","fetched_at":"2026-07-25T09:00:00Z","published_at":"2026-06-01T00:00:00Z","text":"This domain is for use in documentation examples.","text_length":49,"trust_zone":"public_web"}],"chunks":[{"chunk_id":"ch_1","content_hash":"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","start_offset":0,"end_offset":49,"heading_path":["Example Domain"],"text":"This domain is for use in documentation examples.","text_hash":"2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae","lexical_score":0.41}],"duplicate_clusters":[],"failures":[{"candidate_id":"c_2","url":"http://10.0.0.5/internal","code":"blocked_by_policy","message":"resolved address is in a forbidden range"}],"stats":{"http_fetches":1,"browser_fetches":0,"total_bytes":1256,"duration_ms":842,"skipped_known":1}}}',
  },

  // --- rerank：复用词法打分，无网络无模型 ---
  {
    name: "rerank:request",
    direction: "to_worker",
    forMethod: "rerank",
    line: '{"type":"request","id":"req_08","method":"rerank","params":{"operation_id":"op_08","query":"开源桌面 AI agent 许可证","subquestions":[{"id":"sq_2","text":"它们的许可证分别是什么"}],"chunks":[{"chunk_id":"ch_1","text":"This project is licensed under the Apache-2.0 license."},{"chunk_id":"ch_2","text":"Unrelated marketing copy."}],"top_k":10}}',
  },
  {
    name: "rerank:response",
    direction: "to_main",
    forMethod: "rerank",
    line: '{"type":"response","id":"req_08","result":{"operation_id":"op_08","ranked":[{"chunk_id":"ch_1","score":2.71},{"chunk_id":"ch_2","score":0.03}]}}',
  },

  // --- cancel / shutdown：只回 ack ---
  {
    name: "cancel:request",
    direction: "to_worker",
    forMethod: "cancel",
    line: '{"type":"request","id":"req_09","method":"cancel","params":{"operation_id":"op_07"}}',
  },
  {
    name: "cancel:response",
    direction: "to_main",
    forMethod: "cancel",
    line: '{"type":"response","id":"req_09","result":{"ok":true}}',
  },
  {
    // 被取消的 operation 自身以 cancelled 错误码结束，与 cancel 请求的 ack 是两条消息。
    name: "cancel:operation_cancelled",
    direction: "to_main",
    forMethod: "fetch_prepare",
    line: '{"type":"response","id":"req_07","error":{"code":"cancelled","message":"operation op_07 cancelled by main"}}',
  },
  {
    name: "shutdown:request",
    direction: "to_worker",
    forMethod: "shutdown",
    line: '{"type":"request","id":"req_10","method":"shutdown","params":{"grace_ms":3000}}',
  },
  {
    name: "shutdown:response",
    direction: "to_main",
    forMethod: "shutdown",
    line: '{"type":"response","id":"req_10","result":{"ok":true}}',
  },

  // --- 错误信封的其余样例 ---
  {
    name: "error:invalid_params",
    direction: "to_main",
    forMethod: "fetch_prepare",
    line: '{"type":"response","id":"req_11","error":{"code":"invalid_params","message":"candidates must not be empty"}}',
  },
  {
    name: "error:budget_exceeded",
    direction: "to_main",
    forMethod: "fetch_prepare",
    line: '{"type":"response","id":"req_12","error":{"code":"budget_exceeded","message":"max_total_bytes exceeded after 24 documents","data":{"total_bytes":52428801}}}',
  },
] as const;
