// fs:writingSaveImage handler 单测(U1):落盘到 <spaceRoot>/img/、命名形状、重名递增、
// 空数据/越权拒绝。以及导出的纯 helper(扩展名净化 / 命名 / 重名递增)。
// 复用 fs-rename.test.ts 的 electron mock 思路:捕获 ipcMain.handle 注册的 handler,
// 用真实临时目录跑真实 fs;getPersistedState 桩把临时根并入白名单(assertAllowed 放行)。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  root: "",
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  app: { getPath: () => tmpdir() },
  dialog: {},
  shell: {},
}));

// 白名单只含本测临时根(=写作空间根):img 子目录与目标文件都在其内 → assertAllowed 放行。
vi.mock("./store", () => ({
  getPersistedState: vi.fn(async () => ({ promptRoot: mocks.root, projects: [] })),
}));

import {
  registerFsHandlers,
  normalizeWritingImageExt,
  buildWritingImageName,
  resolveNonCollidingPath,
} from "./fs";

let tmp = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "writing-image-"));
  mocks.root = tmp;
  registerFsHandlers();
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册: ${channel}`);
  return handler(null, ...args);
}

// 1x1 PNG 的合法字节(仅需非空即可)。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("normalizeWritingImageExt", () => {
  it("去点小写、只留合法后缀", () => {
    expect(normalizeWritingImageExt(".PNG")).toBe("png");
    expect(normalizeWritingImageExt("jpg")).toBe("jpg");
    expect(normalizeWritingImageExt("webp")).toBe("webp");
  });
  it("畸形/超长/空 → 回落 png", () => {
    expect(normalizeWritingImageExt("")).toBe("png");
    expect(normalizeWritingImageExt("../evil")).toBe("png");
    expect(normalizeWritingImageExt("toolongextension")).toBe("png");
  });
});

describe("buildWritingImageName", () => {
  it("形如 pasted-<紧凑时间戳>-<rand>.<ext>", () => {
    const name = buildWritingImageName("png", new Date("2026-07-06T01:02:03.456Z"), "abc123");
    expect(name).toBe("pasted-20260706-010203-abc123.png");
  });
  it("扩展名走净化(jpeg 保留 / 畸形回落 png)", () => {
    expect(buildWritingImageName(".JPG", new Date("2026-01-01T00:00:00Z"), "r")).toBe(
      "pasted-20260101-000000-r.jpg",
    );
    expect(buildWritingImageName("!!", new Date("2026-01-01T00:00:00Z"), "r")).toBe(
      "pasted-20260101-000000-r.png",
    );
  });
});

describe("resolveNonCollidingPath", () => {
  it("目标不存在 → 原名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collide-a-"));
    const p = await resolveNonCollidingPath(dir, "pic.png");
    expect(p).toBe(join(dir, "pic.png"));
    await rm(dir, { recursive: true, force: true });
  });
  it("已存在 → 递增 -1、-2,不覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collide-b-"));
    await fsp.writeFile(join(dir, "pic.png"), "0");
    expect(await resolveNonCollidingPath(dir, "pic.png")).toBe(join(dir, "pic-1.png"));
    await fsp.writeFile(join(dir, "pic-1.png"), "1");
    expect(await resolveNonCollidingPath(dir, "pic.png")).toBe(join(dir, "pic-2.png"));
    await rm(dir, { recursive: true, force: true });
  });
});

describe("fs:writingSaveImage", () => {
  it("落盘到 <spaceRoot>/img/,文件名以 pasted- 开头,返回绝对路径且内容正确", async () => {
    const abs = (await invoke("fs:writingSaveImage", {
      spaceRoot: tmp,
      bytesBase64: PNG_BASE64,
      ext: "png",
    })) as string;
    expect(abs.startsWith(join(tmp, "img"))).toBe(true);
    const base = abs.split(/[/\\]/).pop()!;
    expect(base).toMatch(/^pasted-.*\.png$/);
    // 内容 = 解码后的原始字节。
    const written = await fsp.readFile(abs);
    expect(written.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);
  });

  it("同名(同一时间戳+随机)重复落盘 → 递增,不覆盖已有文件", async () => {
    // 直接构造一个确定文件名占位,再让 handler 走同名递增路径:先写占位,再验证 resolve 递增。
    const imgDir = join(tmp, "img");
    await fsp.mkdir(imgDir, { recursive: true });
    const fixed = "pasted-fixed.png";
    await fsp.writeFile(join(imgDir, fixed), "existing");
    const next = await resolveNonCollidingPath(imgDir, fixed);
    expect(next).toBe(join(imgDir, "pasted-fixed-1.png"));
    // 占位文件内容不变(未被覆盖)。
    expect(await fsp.readFile(join(imgDir, fixed), "utf8")).toBe("existing");
  });

  it("空数据 → 抛错,不落盘", async () => {
    await expect(invoke("fs:writingSaveImage", { spaceRoot: tmp, bytesBase64: "", ext: "png" })).rejects.toThrow(
      /图片数据为空/,
    );
  });

  it("越权空间根(白名单外)→ assertAllowed 拒绝", async () => {
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await expect(
      invoke("fs:writingSaveImage", { spaceRoot: outside, bytesBase64: PNG_BASE64, ext: "png" }),
    ).rejects.toThrow(/不在允许范围内/);
    await rm(outside, { recursive: true, force: true });
  });
});
