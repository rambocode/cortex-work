// Cortex vendored slides runtime 的「零协作」契约:整条在线协作/CRDT 通路必须处于未接线状态。
//
// 为什么用源码文本做闸门而不是行为测试:出站 WebSocket「不存在」这件事无法在单测里证明,
// 而 vendor/bento 是 vendored 上游源码 —— 下一次同步上游 diff 时,最可能的回归方式就是
// `new SyncSession(store)` 或某个 `startSharing` import 被合并回来。文本断言是唯一能在
// 常规测试轮次里挡住这类回归的手段(源码在仓库里,读文件比启 Electron 便宜得多)。
//
// 背景:上游 SyncSession 会给「没有 collab 字段」的文档自动铸造协作凭据并连公共中继
// wss://sync.bento.page,此后每次打开都全量重放房间历史;而 CRDT 的 mergeSnapshot 对
// 页/元素是并集语义 —— AI 经磁盘写入的内容在其中只拿到 null register,逐字段全输,
// 表现为用户看到的「新旧内容重贴在一起」。见 vendor/bento/CORTEX_PATCHES.md。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const vendorFile = (relative: string): string =>
  readFileSync(join(REPO_ROOT, "vendor/bento", relative), "utf8");

/**
 * 去掉注释后的源码视图。
 *
 * 「不含 startSharing」这类断言针对的是**可执行代码**,不是说明文字 —— 而解释这些补丁
 * 为什么存在,恰恰必须点名被禁用的那些上游 API。若直接对原文断言,注释写得越清楚测试越红,
 * 会逼着后来的人把注释写含糊,正好和仓库「关键代码必须注释」的要求打架。
 *
 * 行注释的剥离刻意跳过 `://`,免得把 URL 里的双斜杠当成注释起点(判定 vendor 源码
 * 是否残留中继地址时用得上)。字符串字面量里出现 `//` 的情况本仓库不存在,不做处理。
 */
const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const at = line.search(/(^|[^:])\/\//);
      return at === -1 ? line : line.slice(0, line.indexOf("//", at));
    })
    .join("\n");

/** 只保留可执行代码的 vendor 源码读取(绝大多数断言都该用这个)。 */
const vendorCode = (relative: string): string => codeOnly(vendorFile(relative));

describe("Cortex slides runtime 零协作契约", () => {
  it("boot 不再实例化 SyncSession,改挂 createNoSyncSession 空壳", () => {
    const main = vendorCode("src/main.ts");
    expect(main).not.toContain("new SyncSession");
    expect(main).toContain("createNoSyncSession");
  });

  it("boot 不再 import 任何在线中继入口", () => {
    const main = vendorCode("src/main.ts");
    // 这三个是「铸凭据 + 连中继」的全部入口;留 import 就意味着随时可能被接回去。
    expect(main).not.toContain("startSharing");
    expect(main).not.toContain("stopSharing");
    expect(main).not.toContain("onlineTransport");
    expect(main).not.toContain("sync/online");
    expect(main).not.toContain("sync/session");
  });

  it("window.bento.sync 对外降级:share 恒 null、online 恒 off", () => {
    const main = vendorCode("src/main.ts");
    expect(main).toContain("share: () => null");
    expect(main).toContain("online: () => 'off'");
  });

  it("no-sync 空壳自身不含任何传输原语,也不铸造协作凭据", () => {
    const noSync = vendorCode("src/cortex/no-sync.ts");
    expect(noSync).not.toContain("BroadcastChannel");
    expect(noSync).not.toContain("WebSocket");
    expect(noSync).not.toContain("mintCollab");
    // shareEligible 恒 false 是「joinFromDoc 不可达」这条安全性论证的支点
    expect(noSync).toContain("shareEligible");
    expect(noSync).toMatch(/shareEligible[^\n]*=>\s*false/);
  });

  it("editor 的 autosave 接线按宿主环境分叉,宿主在场时不走 IndexedDB recovery", () => {
    const editor = vendorFile("src/editor/editor.ts");
    const wireAutosave = editor.slice(
      editor.indexOf("private wireAutosave()"),
      editor.indexOf("private scheduleAutosave()"),
    );
    expect(wireAutosave).not.toBe("");
    expect(wireAutosave).toContain("cortexHost()");
    expect(wireAutosave).toContain("clearRecovery");
    // 版本历史必须留着 —— 它是「热应用覆盖了我的编辑」的第二条找回途径
    expect(editor).toContain("addVersion");
  });

  it("工具栏不再 append Share 入口,但 shareDropdown() 仍被调用(wireOnlineStatus 依赖 shareB)", () => {
    const editor = vendorFile("src/editor/editor.ts");
    const appendLine = editor
      .split("\n")
      .find((line) => line.includes("actions.append("));
    expect(appendLine).toBeDefined();
    expect(appendLine).not.toContain("shareDropdown");
    // 引用仍须存在:直接删会让 wireOnlineStatus() 里的 this.shareB 抛 TypeError,
    // 且 noUnusedLocals 会因私有方法无调用点报 TS6133。
    expect(editor).toContain("this.shareDropdown()");
  });

  it("与协作无关的 Present-only / Template 入口迁到了 Save 菜单", () => {
    const editor = vendorFile("src/editor/editor.ts");
    const saveDropdown = editor.slice(
      editor.indexOf("private saveDropdown()"),
      editor.indexOf("private async savePresentationPackage()"),
    );
    expect(saveDropdown).toContain("savePresentationPackage()");
    expect(saveDropdown).toContain("saveAsTemplate()");
  });

  it("热应用入口挂在 window 上,供宿主 executeScript 调用", () => {
    const applyDoc = vendorCode("src/cortex/apply-doc.ts");
    expect(applyDoc).toContain("__cortexApplyDeckDoc");
    // 刻意走 checkpoint:⌘Z 是「热应用覆盖了我未落盘的编辑」唯一救命通道
    expect(applyDoc).toContain("replaceDoc");
    // replaceDoc 覆盖不到 @font-face,不补就是字体静默失效
    expect(applyDoc).toContain("injectFonts");
    expect(vendorCode("src/main.ts")).toContain("initCortexApplyDoc");
  });

  it("sync 源码目录只是断了引用、并未删除(便于继续跟上游 diff)", () => {
    expect(() => vendorFile("src/sync/session.ts")).not.toThrow();
    expect(() => vendorFile("src/sync/online.ts")).not.toThrow();
  });

  // online.ts 仍会被打进产物(editor.ts 仍 import 它),所以「不可达」不能只靠 NoSyncSession
  // 的形状来论证 —— 出站连接的最后一道门必须在源码层恒闭。这条同时挡住 joinFromDoc 与
  // startSharing 两个入口(见 sync/online.ts 里对 offlineEnabled() 的两处早返回)。
  it("网络总开关恒为离线:不读 localStorage,不受注入时机影响", () => {
    const offline = vendorCode("src/sync/offline.ts");
    expect(offline).toMatch(/offlineEnabled\s*=\s*\(\)\s*:\s*boolean\s*=>\s*true/);
    expect(offline).not.toContain("getItem");
    // online.ts 的两处闸门仍在(改名/删掉就等于把门拆了)
    const online = vendorCode("src/sync/online.ts");
    expect(online.match(/if\s*\(offlineEnabled\(\)\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
