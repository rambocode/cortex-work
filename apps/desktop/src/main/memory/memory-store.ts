// 用户记忆三分区存储（不依赖 electron;平移 reply/memory-store.ts 的成熟形态,独立命名空间）。
// 每分区一个 markdown 文件，用户可直接在 Finder 查看/编辑：
//   memory/profile.md       用户画像(你是谁)
//   memory/preferences.md   偏好习惯
//   memory/projects.md      项目背景
// 文件格式（parse/render 在 core/memory/markdown.ts）：「## ⟨auto⟩」标记行上方手写、
// 下方做梦自动整理区;HTML 注释为引导模板,注入 prompt 时剥离。
//
// 读不落缓存：文件是用户可编辑的真源,每次 getMemory 现读（3 个小文件,毫秒级）,
// Finder 里的修改下轮会话即生效。写经单 writeQueue 串行 + tmp+rename 原子写。
// 全新功能,无迁移源（区别于 ReplyMemoryStore 的两级迁移链）。

import { promises as fsp } from "fs";
import { dirname, join } from "path";
import {
  emptyUserMemoryState,
  USER_MEMORY_SCOPES,
  type UserMemoryFile,
  type UserMemoryScope,
  type UserMemoryState,
} from "@cortex-work/core/memory/memory";
import {
  parseUserMemoryMarkdown,
  renderUserMemoryMarkdown,
  userMemoryFileTemplate,
} from "@cortex-work/core/memory/markdown";

/// 分区 → 相对 memory/ 目录的文件名（扁平结构,三个文件一目了然）。
const SCOPE_FILES: Record<UserMemoryScope, string> = {
  profile: "profile.md",
  preferences: "preferences.md",
  projects: "projects.md",
};

export interface UserMemoryStoreDeps {
  /// 记忆根目录（~/.cortex-desktop/memory）;测试注入临时目录。
  memoryDir: () => string;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

export class UserMemoryStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: UserMemoryStoreDeps) {}

  private scopePath(scope: UserMemoryScope): string {
    return join(this.deps.memoryDir(), SCOPE_FILES[scope]);
  }

  // 读单分区文件；缺失返回 null（区别于空内容）。
  private async readScope(scope: UserMemoryScope): Promise<UserMemoryFile | null> {
    try {
      return parseUserMemoryMarkdown(await fsp.readFile(this.scopePath(scope), "utf8"));
    } catch {
      return null;
    }
  }

  /// 读全部分区（每次现读文件,Finder 编辑即时生效）。恒返回字段完整的 UserMemoryState。
  async getMemory(): Promise<UserMemoryState> {
    const files = await Promise.all(USER_MEMORY_SCOPES.map((scope) => this.readScope(scope)));
    const memory = emptyUserMemoryState();
    USER_MEMORY_SCOPES.forEach((scope, i) => {
      const file = files[i];
      if (file) memory[scope] = file;
    });
    return memory;
  }

  /// 写单分区的手写区/自动区：读-改-写该分区文件（其余文件不动,保留用户手写与注释）。
  setFile(scope: UserMemoryScope, patch: Partial<UserMemoryFile>): Promise<void> {
    return this.enqueue(async () => {
      const current = (await this.readScope(scope)) ?? { manual: "", auto: "" };
      await this.writeScope(scope, renderUserMemoryMarkdown({ ...current, ...patch }));
    });
  }

  /// 清空全部记忆：所有分区重置为引导模板（手写+自动一并清除）。
  clearAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of USER_MEMORY_SCOPES) {
        await this.writeScope(scope, userMemoryFileTemplate(scope));
      }
    });
  }

  /// 只清全部分区的自动整理要点，保留手写区（含用户注释）原样。
  clearAuto(): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of USER_MEMORY_SCOPES) {
        const current = await this.readScope(scope);
        if (!current || current.auto.length === 0) continue;
        await this.writeScope(scope, renderUserMemoryMarkdown({ manual: current.manual, auto: "" }));
      }
    });
  }

  /// 启动物化：缺失的分区文件补引导模板（已有文件一律不动）。数据目录启动即存在,
  /// 用户打开文件夹可直接看到分区结构（对齐 reply 域「目录自解释」的做法）。
  ensureMaterialized(): Promise<void> {
    return this.enqueue(async () => {
      for (const scope of USER_MEMORY_SCOPES) {
        if ((await this.readScope(scope)) !== null) continue;
        await this.writeScope(scope, userMemoryFileTemplate(scope));
      }
    });
  }

  // 原子写单分区文件（mkdir + tmp + rename）。
  private async writeScope(scope: UserMemoryScope, content: string): Promise<void> {
    const path = this.scopePath(scope);
    await fsp.mkdir(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, path);
  }

  // 写操作串行；单条失败只警告，不断链。
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(job).catch((err) => {
      this.deps.logger?.warn("[memory] 记忆写入失败", err);
    });
    this.writeQueue = next;
    return next;
  }
}
