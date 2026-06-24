// runner 的 fork 协议 + 超时单测,用桩 worker(__fixtures__/stub-worker.cjs)避开 officeParser/asar。
// 验证:正常回显 resolve、worker 报错 reject、永不回复触发超时 SIGKILL。
import { describe, expect, it } from "vitest";
import { join } from "path";
import { runExtraction } from "./runner";

const STUB = join(__dirname, "__fixtures__", "stub-worker.cjs");

describe("runExtraction(fork 协议 + 超时)", () => {
  it("正常回显 → resolve 抽取结果", async () => {
    const r = await runExtraction("/some/doc.pdf", { workerScript: STUB });
    expect(r.text).toBe("echo:/some/doc.pdf");
    expect(r.empty).toBe(false);
  });

  it("worker 报错 → reject", async () => {
    await expect(runExtraction("ERR", { workerScript: STUB })).rejects.toThrow(/boom/);
  });

  it("worker 永不回复 → 超时 reject(进程被 SIGKILL)", async () => {
    await expect(runExtraction("HANG", { workerScript: STUB, timeoutMs: 200 })).rejects.toThrow(/超时/);
  });
});
