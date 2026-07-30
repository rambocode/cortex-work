// VariablePicker.tsx — 工作流变量选择器。
// 功能：
// 1. 「插入变量」按钮点击后展示下拉面板，列出所有可用变量。
// 2. 面板内搜索过滤。
// 3. 点击变量项 → 调 onInsert(varExpr) 将 {{...}} 插入到上层字段。
// 4. 变量来源：上游节点（$nodes.<id>.json / text）+ $input + $env.<key> + $run + $loop。
//
// 参考 Kun VariablePicker，最小可用实现（不做 chip，保持原始 {{...}} 模板字符串形态）。

import { useRef, useState, useEffect } from "react";
import type { WorkflowNode, WorkflowEnvVar } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";

// ── 变量条目 ─────────────────────────────────────────────────────────────────

interface VarItem {
  /** 插入的模板表达式，如 {{$input.text}} */
  expr: string;
  /** 面板显示标签 */
  label: string;
  /** 可选分组标题 */
  group: string;
  /** 可选类型标注 */
  type?: string;
}

// ── 构建变量列表 ─────────────────────────────────────────────────────────────

function buildVarItems(
  /** 工作流所有节点（用于推导上游节点输出描述符）*/
  allNodes: WorkflowNode[],
  /** 当前节点 id（排除自身）*/
  currentNodeId: string,
  /** 工作流级环境变量 */
  envVars: WorkflowEnvVar[],
): VarItem[] {
  const items: VarItem[] = [];

  // ── $input — 直接上游 payload ────────────────────────────────────────────
  items.push(
    { group: "上游输入", expr: "{{$input.text}}", label: "$input.text", type: "string" },
    { group: "上游输入", expr: "{{$input.json}}", label: "$input.json", type: "object" },
  );

  // ── $nodes.<id>.json / text ──────────────────────────────────────────────
  // 取所有非当前节点（全量展示，更实用；连线推断太复杂）
  for (const n of allNodes) {
    if (n.id === currentNodeId) continue;
    const name = n.name || n.type;
    const prefix = `$nodes.${n.id}`;
    items.push(
      {
        group: `节点：${name}`,
        expr: `{{${prefix}.text}}`,
        label: `${n.type} → text`,
        type: "string",
      },
      {
        group: `节点：${name}`,
        expr: `{{${prefix}.json}}`,
        label: `${n.type} → json`,
        type: "object",
      },
      {
        group: `节点：${name}`,
        expr: `{{${prefix}.error}}`,
        label: `${n.type} → error`,
        type: "string",
      },
    );
  }

  // ── $env — 工作流环境变量 ────────────────────────────────────────────────
  if (envVars.length > 0) {
    for (const v of envVars) {
      items.push({
        group: "环境变量",
        expr: `{{$env.${v.key}}}`,
        label: `$env.${v.key}`,
        type: v.type ?? "string",
      });
    }
  } else {
    // 即使没有定义，也提示占位
    items.push({
      group: "环境变量",
      expr: "{{$env.MY_KEY}}",
      label: "$env.MY_KEY（未定义，先在顶部环境变量配置）",
      type: "string",
    });
  }

  // ── $run — 运行级变量 ────────────────────────────────────────────────────
  items.push(
    { group: "运行上下文", expr: "{{$run.id}}", label: "$run.id", type: "string" },
    { group: "运行上下文", expr: "{{$run.trigger}}", label: "$run.trigger", type: "string" },
    { group: "运行上下文", expr: "{{$run.startedAt}}", label: "$run.startedAt", type: "string" },
  );

  // ── $loop — 循环上下文（foreach 模式有效）────────────────────────────────
  items.push(
    { group: "循环上下文", expr: "{{$loop.item}}", label: "$loop.item（当前元素）", type: "any" },
    { group: "循环上下文", expr: "{{$loop.index}}", label: "$loop.index（当前索引）", type: "number" },
    {
      group: "循环上下文",
      expr: "{{$loop.total}}",
      label: "$loop.total（总次数）",
      type: "number",
    },
  );

  return items;
}

// ── 组分组 ───────────────────────────────────────────────────────────────────

function groupItems(items: VarItem[]): Array<{ group: string; items: VarItem[] }> {
  const map = new Map<string, VarItem[]>();
  for (const item of items) {
    if (!map.has(item.group)) map.set(item.group, []);
    map.get(item.group)!.push(item);
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Props = {
  /** 当前节点 id（排除自身）*/
  currentNodeId: string;
  /** 工作流所有节点 */
  allNodes: WorkflowNode[];
  /** 工作流环境变量 */
  envVars: WorkflowEnvVar[];
  /**
   * 插入变量回调。调用方将返回的 expr（含 {{...}}）拼接到目标 textarea/input 中。
   * 如需光标位置插入，调用方自行处理（VariablePicker 不感知具体字段）。
   */
  onInsert: (expr: string) => void;
};

// ── VariablePicker ────────────────────────────────────────────────────────────

export function VariablePicker({ currentNodeId, allNodes, envVars, onInsert }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const allItems = buildVarItems(allNodes, currentNodeId, envVars);

  // 搜索过滤（对 expr 和 label 都搜）
  const filtered = search
    ? allItems.filter(
        (it) =>
          it.expr.toLowerCase().includes(search.toLowerCase()) ||
          it.label.toLowerCase().includes(search.toLowerCase()),
      )
    : allItems;

  const groups = groupItems(filtered);

  function handleInsert(expr: string) {
    onInsert(expr);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* 触发按钮 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-[11.5px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
      >
        <Icon.Variable size={12} sw={1.8} />
        插入变量
      </button>

      {/* 下拉面板 */}
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded-xl border border-ds-border bg-ds-card shadow-xl">
          {/* 搜索框 */}
          <div className="border-b border-ds-border p-2">
            <input
              autoFocus
              className="w-full rounded-lg border border-ds-border bg-ds-main px-2.5 py-1.5 text-[12px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25"
              value={search}
              placeholder="搜索变量…"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* 变量列表 */}
          <div className="max-h-[320px] overflow-y-auto p-1">
            {groups.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-ds-faint">无匹配变量</p>
            ) : (
              groups.map(({ group, items }) => (
                <div key={group} className="mb-1">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ds-faint">
                    {group}
                  </div>
                  {items.map((it) => (
                    <button
                      key={it.expr}
                      type="button"
                      onClick={() => handleInsert(it.expr)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-ds-hover"
                    >
                      <code className="flex-1 truncate font-mono text-[11.5px] text-accent">
                        {it.expr}
                      </code>
                      {it.type ? (
                        <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-medium text-ds-faint bg-ds-border/50">
                          {it.type}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* footer hint */}
          <div className="border-t border-ds-border px-3 py-2 text-[10.5px] text-ds-faint">
            点击变量将 {"{{...}}"} 插入聚焦字段
          </div>
        </div>
      ) : null}
    </div>
  );
}
