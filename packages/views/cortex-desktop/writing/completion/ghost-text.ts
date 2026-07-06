// 写作 live/source 档的 ghost text 打字续写 CodeMirror 扩展(U3,参照 Kun inline-completion/codemirror.ts,大幅精简)。
//
// 精简掉 Kun 的 long/edit-candidate/emptyCooldown/recentEdits 等信号,只保留最小可用闭环:
//   去抖(≥600ms)触发 → 请求续写 → 在光标后以灰字 widget 展示 → Tab 采纳 / Esc 或继续编辑取消。
//
// CM 运行期对象经参数 mods 注入(由 NoteCodeMirrorEditor 的动态 import 传入),本模块只用 `import type` 引 CM 类型,
// 故不会把 @codemirror/* 静态卷进 web 产物(遵守「views 大依赖一律动态 import」硬规则)。
// isEnabled/requestCompletion 由 WritingEditorPane 经闭包注入(读 ref 取最新配置),扩展本身不碰 window.desktopAPI。

import type { Extension, StateField as StateFieldType } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  WRITING_COMPLETION_DEBOUNCE_MS,
  buildCompletionWindows,
  computeGhostAccept,
  shouldRequestCompletion,
} from "./completion-core";

// NoteCodeMirrorEditor 已动态 import 的 CM 命名空间(state / view),注入给本工厂用其运行期构造。
export interface WritingGhostTextCmMods {
  state: typeof import("@codemirror/state");
  view: typeof import("@codemirror/view");
}

export interface WritingGhostTextConfig {
  // 是否启用(已配置 + ghost text 开关开);读 ref 取最新,关闭时不请求也不显。
  isEnabled: () => boolean;
  // 发起续写:给前后缀,返回续写文本或 null(无续写/失败)。由上层经 bridge.writingComplete 实现。
  requestCompletion: (prefix: string, suffix: string) => Promise<string | null>;
  debounceMs?: number;
}

type GhostState = { text: string; anchor: number } | null;

// 构造 ghost text 扩展。返回的 Extension[] 由 NoteCodeMirrorEditor 展开进 EditorState。
export function buildWritingGhostTextExtension(
  mods: WritingGhostTextCmMods,
  config: WritingGhostTextConfig,
): Extension {
  const { StateEffect, StateField, Prec } = mods.state;
  const { Decoration, ViewPlugin, WidgetType, keymap } = mods.view;

  const setGhost = StateEffect.define<{ text: string; anchor: number }>();
  const clearGhost = StateEffect.define<null>();

  const ghostField: StateFieldType<GhostState> = StateField.define<GhostState>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setGhost)) return e.value;
        if (e.is(clearGhost)) return null;
      }
      // 文档变化(用户继续打字)时清除旧建议:光标位移后旧 ghost 已失效,由控制器重新调度。
      if (tr.docChanged && value) return null;
      return value;
    },
  });

  // 灰字续写 widget:纯展示,不进文档(采纳时才真正插入)。
  class GhostWidget extends WidgetType {
    constructor(private readonly text: string) {
      super();
    }
    override eq(other: GhostWidget): boolean {
      return other.text === this.text;
    }
    override toDOM(): HTMLElement {
      const span = document.createElement("span");
      span.className = "cm-writing-ghost";
      span.style.opacity = "0.42";
      span.textContent = this.text;
      return span;
    }
    override get lineBreaks(): number {
      return this.text.split("\n").length - 1;
    }
  }

  // 渲染插件:仅当建议锚点 === 当前光标且为空选区时展示(光标一动就不显,避免错位)。
  const renderPlugin = ViewPlugin.fromClass(
    class {
      decorations = Decoration.none;
      constructor(view: EditorView) {
        this.build(view);
      }
      update(u: { view: EditorView }): void {
        this.build(u.view);
      }
      build(view: EditorView): void {
        const g = view.state.field(ghostField);
        const sel = view.state.selection.main;
        if (!g?.text || g.anchor !== sel.head || !sel.empty) {
          this.decorations = Decoration.none;
          return;
        }
        const widget = Decoration.widget({ widget: new GhostWidget(g.text), side: 1 });
        this.decorations = Decoration.set([widget.range(sel.head)]);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // 控制器:去抖调度 + 请求 + 陈旧结果丢弃(sequence)。禁用/有选区/无前缀实义 → 清并不请求。
  const controller = ViewPlugin.fromClass(
    class {
      private seq = 0;
      private timer: number | null = null;
      constructor(private readonly view: EditorView) {
        this.schedule();
      }
      update(u: { docChanged: boolean; selectionSet: boolean; focusChanged: boolean }): void {
        if (!u.docChanged && !u.selectionSet && !u.focusChanged) return;
        this.schedule();
      }
      private schedule(): void {
        this.seq += 1;
        if (this.timer != null) window.clearTimeout(this.timer);
        const sel = this.view.state.selection.main;
        const doc = this.view.state.doc.toString();
        const { prefix, suffix } = buildCompletionWindows(doc, sel.head);
        if (!sel.empty || !shouldRequestCompletion(config.isEnabled(), prefix)) {
          if (this.view.state.field(ghostField)) this.view.dispatch({ effects: clearGhost.of(null) });
          return;
        }
        const reqId = this.seq;
        const anchor = sel.head;
        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.run(reqId, anchor, prefix, suffix);
        }, config.debounceMs ?? WRITING_COMPLETION_DEBOUNCE_MS);
      }
      private async run(reqId: number, anchor: number, prefix: string, suffix: string): Promise<void> {
        let text: string | null = null;
        try {
          text = await config.requestCompletion(prefix, suffix);
        } catch {
          text = null;
        }
        // 陈旧丢弃:期间又打字/移动光标(seq 变了)或光标已离开锚点 → 丢弃本次结果。
        if (reqId !== this.seq) return;
        const sel = this.view.state.selection.main;
        if (!sel.empty || sel.head !== anchor) return;
        if (!text) {
          if (this.view.state.field(ghostField)) this.view.dispatch({ effects: clearGhost.of(null) });
          return;
        }
        this.view.dispatch({ effects: setGhost.of({ text, anchor }) });
      }
      destroy(): void {
        this.seq += 1;
        if (this.timer != null) window.clearTimeout(this.timer);
      }
    },
  );

  // Tab 采纳 / Esc 取消。Prec.highest 保证在有建议时压过 indentWithTab;无建议时返回 false 放行默认键。
  const acceptKeymap = Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run: (view: EditorView): boolean => {
          const g = view.state.field(ghostField);
          const sel = view.state.selection.main;
          if (!g?.text || !sel.empty || g.anchor !== sel.head) return false;
          const { from, insert, anchor } = computeGhostAccept("", sel.head, g.text);
          view.dispatch({
            changes: { from, insert },
            selection: { anchor },
            effects: clearGhost.of(null),
          });
          return true;
        },
      },
      {
        key: "Escape",
        run: (view: EditorView): boolean => {
          if (!view.state.field(ghostField)) return false;
          view.dispatch({ effects: clearGhost.of(null) });
          return true;
        },
      },
    ]),
  );

  return [ghostField, renderPlugin, controller, acceptKeymap];
}
