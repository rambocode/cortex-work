// 全局分区记忆 md 文件存储的单测：分区文件读写往返、迁移链（memory.json → md /
// 旧分片 → md）、物化模板、清空语义、Finder 手编即时可见。
// electron 绑定层（ipc/reply.ts）人工验证。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { emptyMemoryState, type MemoryState } from "@cortex-work/core/reply/memory";
import { AUTO_MARKER, stripMemoryComments } from "@cortex-work/core/reply/memory-files";
import { ReplyMemoryStore, type ReplyMemoryStoreDeps } from "./memory-store";

let dir: string;
let memoryDir: string;
let legacyJson: string;

function makeStore(overrides: Partial<ReplyMemoryStoreDeps> = {}): ReplyMemoryStore {
  return new ReplyMemoryStore({
    memoryDir: () => memoryDir,
    legacyJsonPath: () => legacyJson,
    ...overrides,
  });
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), "reply-memory-"));
  memoryDir = join(dir, "memory");
  legacyJson = join(dir, "memory.json");
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("ReplyMemoryStore（markdown 后端）", () => {
  it("全空初始态：无文件无迁移源 → 空分区", async () => {
    expect(await makeStore().getMemory()).toEqual(emptyMemoryState());
  });

  it("setFile 写单分区 md，磁盘往返一致且不动其它分区文件", async () => {
    const store = makeStore();
    await store.setFile("im", { auto: "- 短句" });
    await store.setFile("im", { manual: "别用 emoji" });
    const memory = await makeStore().getMemory();
    expect(memory.im).toEqual({ manual: "别用 emoji", auto: "- 短句" });
    // 只创建了 im 的文件
    expect((await makeStore().getMemory()).email).toEqual({ manual: "", auto: "" });
    const raw = await fsp.readFile(join(memoryDir, "voice/im.md"), "utf8");
    expect(raw).toContain(AUTO_MARKER);
  });

  it("ensureMaterialized：五个分区文件物化为引导模板（目录对齐源项目结构）", async () => {
    await makeStore().ensureMaterialized();
    for (const rel of ["profile/profile.md", "voice/core.md", "voice/im.md", "voice/email.md", "voice/public.md"]) {
      const raw = await fsp.readFile(join(memoryDir, rel), "utf8");
      expect(raw).toContain("<!--");
      expect(raw).toContain(AUTO_MARKER);
    }
    // 模板注释不产生可注入内容
    const memory = await makeStore().getMemory();
    expect(stripMemoryComments(memory.core.manual)).toBe("");
  });

  it("迁移源 1：memory.json 拆分为 md 并改名 .migrated（不重复迁移）", async () => {
    const legacy: MemoryState = {
      ...emptyMemoryState(),
      core: { manual: "简短", auto: "- 爱用语气词" },
    };
    await fsp.writeFile(legacyJson, JSON.stringify({ version: 1, memory: legacy }), "utf8");
    const store = makeStore();
    // 物化前的读取也能看到迁移源
    expect((await store.getMemory()).core.auto).toBe("- 爱用语气词");
    await store.ensureMaterialized();
    expect((await makeStore().getMemory()).core).toEqual({ manual: "简短", auto: "- 爱用语气词" });
    await expect(fsp.access(legacyJson)).rejects.toThrow();
    await fsp.access(legacyJson + ".migrated"); // 原文件保留为 .migrated
  });

  it("迁移源 2：更早的 replyMemory 分片经 loadLegacy 读入并物化", async () => {
    const loadLegacy = vi.fn(async () => ({
      ...emptyMemoryState(),
      profile: { manual: "我是 PM", auto: "" },
    }));
    const store = makeStore({ loadLegacy });
    await store.ensureMaterialized();
    expect((await makeStore().getMemory()).profile.manual).toBe("我是 PM");
  });

  it("ensureMaterialized 对已有文件不动（不覆盖用户内容）", async () => {
    const store = makeStore();
    await store.setFile("core", { manual: "已有" });
    await store.ensureMaterialized();
    expect((await makeStore().getMemory()).core.manual).toBe("已有");
  });

  it("Finder 手编文件（含用户注释）下次读取即生效，注释在剥离后不进 prompt", async () => {
    const store = makeStore();
    await store.ensureMaterialized();
    await fsp.writeFile(
      join(memoryDir, "voice/im.md"),
      `<!-- 我的备忘 -->\n回复要短\n\n${AUTO_MARKER}\n- 学到的\n`,
      "utf8",
    );
    const memory = await store.getMemory();
    expect(memory.im.manual).toContain("回复要短");
    expect(memory.im.auto).toBe("- 学到的");
    expect(stripMemoryComments(memory.im.manual)).toBe("回复要短");
  });

  it("clearAuto 只清自动区保留手写（含注释）；clearAll 重置为模板", async () => {
    const store = makeStore();
    await store.setFile("core", { manual: "<!-- 注 -->\n手写", auto: "- 学到" });
    await store.clearAuto();
    let memory = await store.getMemory();
    expect(memory.core.manual).toBe("<!-- 注 -->\n手写");
    expect(memory.core.auto).toBe("");
    await store.clearAll();
    memory = await store.getMemory();
    // 模板注释剥离后为空 → 手写内容确已清除
    expect(stripMemoryComments(memory.core.manual)).toBe("");
    expect(memory.core.auto).toBe("");
  });
});
