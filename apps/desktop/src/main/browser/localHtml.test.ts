// isAuthorizedFileUrl 的 query/hash 归一化行为:设计画布实时刷新以 `?rev=N` 变体
// 重载已授权文件,闸门必须放行同文件的 query 变体、仍拒绝未授权路径。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// 白名单校验单独有 fs.ts 测试覆盖,此处 no-op 以聚焦授权集合的匹配语义。
vi.mock("../ipc/fs", () => ({ assertAllowed: async () => {} }));
vi.mock("../skills/locate", () => ({ expandTilde: (p: string) => p }));

import { isAuthorizedFileUrl, resolveLocalHtml } from "./localHtml";

describe("isAuthorizedFileUrl — query/hash 归一化", () => {
  it("授权后放行裸 URL 与 ?rev= / #hash 变体,未授权路径仍拒", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-html-"));
    const file = join(dir, "v1.html");
    writeFileSync(file, "<html></html>");

    const url = await resolveLocalHtml(file);
    expect(url).toBeTruthy();

    expect(isAuthorizedFileUrl(url as string)).toBe(true);
    expect(isAuthorizedFileUrl(`${url}?rev=3`)).toBe(true);
    expect(isAuthorizedFileUrl(`${url}?rev=3#top`)).toBe(true);
    // 同目录未授权文件:即使真实存在也不在集合内。
    const other = join(dir, "v2.html");
    writeFileSync(other, "<html></html>");
    expect(isAuthorizedFileUrl(pathToFileURL(other).toString())).toBe(false);
  });
});
