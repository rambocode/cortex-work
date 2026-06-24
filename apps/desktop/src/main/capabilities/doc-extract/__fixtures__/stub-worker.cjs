// runner.test.ts 用的桩 worker(CJS,child_process.fork 直接跑)。
// 按 path 模拟三种行为:正常回显 / 报错 / 永不回复(测超时)。
process.on("message", (msg) => {
  if (msg.path === "HANG") return; // 不回复 → 触发 runner 超时
  if (msg.path === "ERR") {
    process.send({ id: msg.id, ok: false, error: "boom" });
    return;
  }
  process.send({
    id: msg.id,
    ok: true,
    result: { text: "echo:" + msg.path, truncated: false, empty: false },
  });
});
