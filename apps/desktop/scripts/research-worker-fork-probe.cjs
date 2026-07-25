// 打包态 Research Worker 的 fork 探针（被 verify-research-packaging.mjs 调起）。
//
// 它做的事就是 main 进程在生产里做的事：utilityProcess.fork 打包产物里的 worker 入口，
// 走一遍 hello + doctor 协议往返。开发态这条链路已在 U0 spike S7 验过；本探针补的是
// **asar 边界之后**那一环——worker 的入口解析、依赖内联、pdfjs 动态 chunk 是否仍然可用。
//
// 用法：electron scripts/research-worker-fork-probe.cjs <worker-entry.js>
// 成功时向 stdout 打印 PACKAGED_FORK_OK 与两条响应行，退出码 0。
const { app, utilityProcess } = require("electron");

const workerEntry = process.argv[2];
if (!workerEntry) {
  console.error("用法: electron research-worker-fork-probe.cjs <worker-entry.js>");
  process.exit(2);
}

app.whenReady().then(() => {
  let child;
  try {
    child = utilityProcess.fork(workerEntry, [], {
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: "cre-fork-probe",
    });
  } catch (err) {
    console.error("FORK_ERROR:", err.message);
    app.exit(1);
    return;
  }

  // worker 的日志走 stderr（stdout 只允许协议消息），转出来便于诊断失败原因。
  child.stderr?.on("data", (d) => process.stdout.write(`[worker stderr] ${d}`));

  const received = [];
  child.on("message", (raw) => {
    received.push(String(raw));
    process.stdout.write(`RECV: ${raw}\n`);
    if (received.length === 2) {
      process.stdout.write("PACKAGED_FORK_OK\n");
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      app.exit(0);
    }
  });

  child.on("spawn", () => {
    child.postMessage(
      JSON.stringify({
        type: "request",
        id: "hello_01",
        method: "hello",
        params: { protocol_version: 1, desktop_version: app.getVersion() },
      }),
    );
    child.postMessage(
      JSON.stringify({ type: "request", id: "doc_01", method: "doctor", params: {} }),
    );
  });

  child.on("exit", (code) => {
    if (received.length < 2) {
      console.error(`worker 在完成协议往返前退出，code=${code}`);
      app.exit(1);
    }
  });

  // 卡住比失败更难诊断，给一个硬超时。
  setTimeout(() => {
    console.error(`TIMEOUT：只收到 ${received.length}/2 条响应`);
    app.exit(3);
  }, 30_000);
});
