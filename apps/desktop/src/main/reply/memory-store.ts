// 全局 5 分区记忆存储（不依赖 electron）——KTD6 二次修订（借鉴 Reply.app 数据形态,经用户确认）：
// 每分区一个 markdown 文件,用户可直接在 Finder 查看/编辑：
//   memory/profile/profile.md                    档案(你是谁)
//   memory/voice/{core,im,email,public}.md       四个语气分区
// 文件格式（parse/render 在 core/reply/memory-files.ts）：「## ⟨auto⟩」标记行上方手写、
// 下方自动学习区;HTML 注释为引导模板,组装 prompt 时剥离。
//
// 读不落缓存：文件是用户可编辑的真源,每次 getMemory 现读（5 个小文件,毫秒级）,
// Finder 里的修改下次起草即生效。写经单 writeQueue 串行 + tmp+rename 原子写。
// 迁移链（ensureMaterialized 内完成,一次性）：
//   memory.json（上一版单文件）→ 拆分为 md 后改名 .migrated;
//   更早的 personal-workspace.json replyMemory 分片 → 经 deps.loadLegacy 读入。

import { promises as fsp } from "fs";
import { dirname, join } from "path";
import {
  emptyMemoryState,
  MEMORY_SCOPES,
  type MemoryFile,
  type MemoryScope,
  type MemoryState,
} from "@cortex-work/core/reply/memory";
import {
  memoryFileTemplate,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
} from "@cortex-work/core/reply/memory-files";

/// 分区 → 相对 memory/ 目录的文件路径（目录结构对齐源项目 Reply.app）。
const SCOPE_FILES: Record<MemoryScope, string> = {
  profile: "profile/profile.md",
  core: "voice/core.md",
  im: "voice/im.md",
  email: "voice/email.md",
  publicVoice: "voice/public.md",
};

/// 字段级兜底归一（迁移源可能半缺,契约同 store/reply.ts mergeMemory）。
function normalizeMemory(memory: Partial<MemoryState> | undefined): MemoryState {
  const base = emptyMemoryState();
  if (!memory) return base;
  for (const scope of MEMORY_SCOPES) {
    const file = memory[scope] as Partial<MemoryFile> | undefined;
    if (file) {
      base[scope] = { manual: file.manual ?? "", auto: file.auto ?? "" };
    }
  }
  return base;
}

export interface ReplyMemoryStoreDeps {
  /// 记忆根目录（~/.cortex-desktop/reply/memory）;测试注入临时目录。
  memoryDir: () => string;
  /// 迁移源 1：上一版单文件 memory.json 路径（存在则拆分为 md 后改名 .migrated）。
  legacyJsonPath?: () => string;
  /// 迁移源 2：更早的 personal-workspace.json replyMemory 分片。
  loadLegacy?: () => Promise<MemoryState | undefined>;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

export class ReplyMemoryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReplyMemoryStoreDeps) {}

  private scopePath(scope: MemoryScope): string {
    return join(this.deps.memoryDir(), SCOPE_FILES[scope]);
  }

  // 读单分区文件；缺失返回 null（区别于空内容）。
  private async readScope(scope: MemoryScope): Promise<MemoryFile | null> {
    try {
      return parseMemoryMarkdown(await fsp.readFile(this.scopePath(scope), "utf8"));
    } catch {
      return null;
    }
  }

  // 读迁移源 1（memory.json）；缺失/损坏返回 undefined。
  private async readLegacyJson(): Promise<MemoryState | undefined> {
    const path = this.deps.legacyJsonPath?.();
    if (!path) return undefined;
    try {
      const parsed = JSON.parse(await fsp.readFile(path, "utf8"));
      if (parsed?.version === 1 && parsed.memory && typeof parsed.memory === "object") {
        return parsed.memory as MemoryState;
      }
    } catch {
      // 缺失或损坏：视为无迁移源
    }
    return undefined;
  }

  // 读迁移源 2（旧分片）；读失败视为无。
  private async readLegacyShard(): Promise<MemoryState | undefined> {
    try {
      return await this.deps.loadLegacy?.();
    } catch (err) {
      this.deps.logger?.warn("[reply] 读取旧记忆分片失败,按空记忆处理", err);
      return undefined;
    }
  }

  /// 读全部分区（每次现读文件,Finder 编辑即时生效）。md 文件一个都不存在时回落迁移源
  /// （物化前的读取也能看到旧数据）。恒返回字段完整的 MemoryState。
  async getMemory(): Promise<MemoryState> {
    const files = await Promise.all(MEMORY_SCOPES.map((scope) => this.readScope(scope)));
    if (files.every((file) => file === null)) {
      const legacy = (await this.readLegacyJson()) ?? (await this.readLegacyShard());
      return normalizeMemory(legacy);
    }
    const memory = emptyMemoryState();
    MEMORY_SCOPES.forEach((scope, i) => {
      const file = files[i];
      if (file) memory[scope] = file;
    });
    return memory;
  }

  /// 写单分区的手写区/自动区：读-改-写该分区文件（其余文件不动,保留用户手写与注释）。
  setFile(scope: MemoryScope, patch: Partial<MemoryFile>): Promise<void> {
    return this.enqueue(async () => {
      const current = (await this.readScope(scope)) ?? { manual: "", auto: "" };
      await this.writeScope(scope, renderMemoryMarkdown({ ...current, ...patch }));
    });
  }

  /// 清空全部记忆：所有分区重置为引导模板（手写+自动一并清除）。
  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of MEMORY_SCOPES) {
        await this.writeScope(scope, memoryFileTemplate(scope));
      }
    });
  }

  /// 只清全部分区的自动学习要点，保留手写区（含用户注释）原样。
  clearAuto(): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of MEMORY_SCOPES) {
        const current = await this.readScope(scope);
        if (!current || current.auto.length === 0) continue;
        await this.writeScope(scope, renderMemoryMarkdown({ manual: current.manual, auto: "" }));
      }
    });
  }

  /// 启动物化 + 一次性迁移：md 一个都没有时从迁移源拆分写入（旧 memory.json 改名
  /// .migrated 防重复迁移）;个别文件缺失补引导模板。已有文件一律不动。
  ensureMaterialized(): Promise<void> {
    return this.enqueue(async () => {
      const existing = await Promise.all(MEMORY_SCOPES.map((scope) => this.readScope(scope)));
      const noneExists = existing.every((file) => file === null);

      let migrated: MemoryState | undefined;
      let renameLegacyJson = false;
      if (noneExists) {
        migrated = await this.readLegacyJson();
        renameLegacyJson = migrated !== undefined;
        migrated ??= await this.readLegacyShard();
        if (migrated) {
          this.deps.logger?.info?.("[reply] 记忆已迁移为 memory/ 下的 markdown 分区文件");
        }
      }
      const source = normalizeMemory(migrated);

      for (let i = 0; i < MEMORY_SCOPES.length; i++) {
        const scope = MEMORY_SCOPES[i]!;
        if (existing[i] !== null) continue; // 已有文件不动
        const file = source[scope];
        const content =
          file.manual.trim().length === 0 && file.auto.trim().length === 0
            ? memoryFileTemplate(scope)
            : renderMemoryMarkdown(file);
        await this.writeScope(scope, content);
      }

      if (renameLegacyJson) {
        const path = this.deps.legacyJsonPath!();
        try {
          await fsp.rename(path, path + ".migrated");
        } catch {
          // 改名失败不阻断（下次启动 md 已存在,不会重复迁移）
        }
      }
    });
  }

  // 原子写单分区文件（mkdir + tmp + rename）。
  private async writeScope(scope: MemoryScope, content: string): Promise<void> {
    const path = this.scopePath(scope);
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, path);
  }

  // 写操作串行；单条失败只警告，不断链。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[reply] 记忆写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
