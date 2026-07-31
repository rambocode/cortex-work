// 静态守护：`main/providers/contract.ts` 与 `packages/core/desktop/provider-catalog.ts`
// 的**类型声明**必须逐字一致。
//
// 为什么需要它：这是一份**手工镜像**的跨进程契约（主进程刻意不依赖 @cortex-work/core，
// 见 main/ipc/types.ts 文件头），两侧没有任何编译期约束把它们绑在一起。漂移时的表现最难查——
// 两边 typecheck 各自都能过，只有跨进程传的对象字段对不上，症状出现在运行时。
// 靠注释里写一句「必须同步改」是留不住的，所以做成测试。
//
// 只比类型（interface / type），不比各自的附加物：contract.ts 有 PROVIDER_IPC（通道名只有
// 主进程与 preload 需要），provider-catalog.ts 有 modelSupportsImage / findCatalogModel
// 两个纯函数（渲染端查询用）。这些**有意不镜像**，见两边文件头。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_CONTRACT = join(HERE, "contract.ts");
const CORE_CONTRACT = join(HERE, "../../../../../packages/core/desktop/provider-catalog.ts");

/**
 * 抽出文件里全部 `export interface` / `export type` 声明块，归一化后返回 name → 声明体。
 *
 * 归一化：去掉注释与空行、压掉行首缩进与多余空白。两边的说明性注释本就该各写各的
 * （main 侧讲 IPC、core 侧讲渲染端消费），比注释只会制造假失败；真正要钉住的是字段与类型。
 */
function extractTypeDecls(source: string): Map<string, string> {
  const stripped = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  const decls = new Map<string, string>();
  const re = /^export (?:interface|type) (\w+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const name = match[1]!;
    // 声明块从这一行开始，到下一个顶层 `export ` 或文件末尾为止。
    const rest = stripped.slice(match.index);
    const next = rest.slice(1).search(/^export /m);
    const body = next === -1 ? rest : rest.slice(0, next + 1);
    decls.set(
      name,
      body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
    );
  }
  return decls;
}

const mainDecls = extractTypeDecls(readFileSync(MAIN_CONTRACT, "utf8"));
const coreDecls = extractTypeDecls(readFileSync(CORE_CONTRACT, "utf8"));

describe("Provider 契约的主进程镜像与 core 定义一致", () => {
  it("抽取到的类型数量合理（防止正则写歪导致空比、假绿）", () => {
    expect(mainDecls.size).toBeGreaterThan(15);
    expect(coreDecls.size).toBeGreaterThan(15);
  });

  it("两侧声明的类型名集合完全相同", () => {
    expect([...mainDecls.keys()].sort()).toEqual([...coreDecls.keys()].sort());
  });

  it.each([...mainDecls.keys()].sort())("%s 的声明体逐字一致", (name) => {
    expect(mainDecls.get(name)).toBe(coreDecls.get(name));
  });
});
