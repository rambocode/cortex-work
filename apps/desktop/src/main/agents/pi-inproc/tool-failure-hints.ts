// bash 工具「可识别失败」的纠偏提示:在结果回给模型之前,识别几类典型的环境缺失错误
//(Python 模块不存在 / 命令不存在 / Node 模块不存在),在输出尾部追加一行英文提示,
// 告诉模型该换方案而不是原样重试或再猜一个包名。
//
// 为什么放在 tool_result 钩子而不是系统提示:系统提示的 <environment> 块(capabilities/environment)
// 负责「事前少猜」,这里负责「猜错后一次纠正」——模型看到裸的 ModuleNotFoundError 时常见反应是
// `pip install` 或换个同类第三方包再试,两者都是用户可见的额外红字。提示紧贴错误出现,遵循度最高。
//
// 只挂 pi 引擎:claude / codex 各自在自己的进程里跑工具循环,主进程拿不到它们的工具结果。

import type { ExtensionAPI, InlineExtension, ToolResultEvent } from "@earendil-works/pi-coding-agent";

// pi 0.84.2 的包根 index.d.ts 没有再导出 `ToolResultEventResult`(types.d.ts 里有),这里只用到 content
// 一个字段,就地声明最小形状,避免 deep import `dist/core/extensions/types` 绑死内部路径。
type ToolResultHookResult = { content?: ToolResultEvent["content"] };

/** 提示行前缀:让模型(和排查日志的人)一眼分清这行不是命令自己的输出。 */
export const TOOL_FAILURE_HINT_PREFIX = "[cortex hint]";

/** 能识别的失败类型;导出便于测试与日志分类。 */
export type ToolFailureKind = "python-module" | "command-not-found" | "node-module";

export interface ToolFailureHint {
  kind: ToolFailureKind;
  subject: string; // 缺失的模块名 / 命令名
  text: string; // 追加给模型的英文提示(不含前缀)
}

// Python:`ModuleNotFoundError: No module named 'bs4'`(子模块形如 'yaml.loader' 取顶层名)。
const PY_MODULE_RE = /ModuleNotFoundError: No module named ['"]([A-Za-z_][\w.]*)['"]/;
// shell:zsh 写法 `zsh: command not found: foo`,必须先于 bash 写法匹配——否则 `zsh: command not found`
// 本身会被下一条按「zsh: ... not found」误读成命令名是 zsh。
const CMD_NOT_FOUND_ZSH_RE = /command not found: ([\w.+-]+)/;
// bash / sh:`bash: foo: command not found` / `sh: 1: foo: not found`。
const CMD_NOT_FOUND_SH_RE = /(?:^|[\s:])([\w.+-]+): (?:command )?not found/m;
// Node:`Error: Cannot find module 'cheerio'`;相对/绝对路径(`./x`、`/x`)是文件缺失而非包缺失,不匹配。
const NODE_MODULE_RE = /Cannot find module ['"]((?:@[\w.-]+\/)?[A-Za-z][\w.-]*)['"]/;

/** 常见「盲猜包 → 标准库替代」映射;命中时提示里点名替代品,减少模型再猜一轮。 */
const PY_STDLIB_ALTERNATIVES: Record<string, string> = {
  bs4: "html.parser (from the standard library)",
  lxml: "html.parser or xml.etree.ElementTree (standard library)",
  requests: "urllib.request (standard library) or the curl CLI",
  httpx: "urllib.request (standard library) or the curl CLI",
  yaml: "json (standard library) or a minimal manual parser",
  pandas: "csv (standard library)",
  openpyxl: "the extract_document tool for spreadsheets, or zipfile + xml.etree (standard library)",
};

/**
 * 从工具输出里识别可纠偏的失败;识别不出返回 null。
 * 只看输出文本本身,不依赖 isError:pi 的 bash 工具在非零退出时会带 isError,但 `cmd || true`
 * 这类写法会吞掉退出码,错误文本仍在输出里,同样值得提示。
 */
export function detectToolFailure(output: string): ToolFailureHint | null {
  if (!output) return null;

  const py = PY_MODULE_RE.exec(output);
  if (py) {
    const top = py[1]!.split(".")[0]!;
    const alt = PY_STDLIB_ALTERNATIVES[top];
    return {
      kind: "python-module",
      subject: top,
      text:
        `Python module '${top}' is not installed in this environment. ` +
        (alt ? `Use ${alt} instead. ` : "Use a standard-library alternative instead. ") +
        "Do not retry the same import and do not install packages without asking the user first.",
    };
  }

  const cmd = CMD_NOT_FOUND_ZSH_RE.exec(output) ?? CMD_NOT_FOUND_SH_RE.exec(output);
  if (cmd) {
    const name = cmd[1]!;
    return {
      kind: "command-not-found",
      subject: name,
      text:
        `Command '${name}' is not installed or not on PATH. ` +
        "Use a tool listed as available in the environment section, or a built-in alternative. " +
        "Do not retry the same command and do not install packages without asking the user first.",
    };
  }

  const node = NODE_MODULE_RE.exec(output);
  if (node) {
    return {
      kind: "node-module",
      subject: node[1]!,
      text:
        `Node module '${node[1]}' is not installed here. ` +
        "Use Node built-ins or another available tool instead. " +
        "Do not retry the same import and do not install packages without asking the user first.",
    };
  }

  return null;
}

/** 把 tool_result 的 content 里的文本块拼成一段,给识别用。 */
function textOf(content: ToolResultEvent["content"]): string {
  return content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * tool_result 钩子扩展:bash 工具结果命中可识别失败时,在 content 末尾追加一条提示文本块。
 *
 * 只处理 `bash`:read / grep 等工具的输出是文件内容,里面出现 "command not found" 字样是数据不是错误,
 * 追加提示反而误导。isError 与其余字段原样保留(返回值只给 content,pi 对未给字段沿用原值)。
 */
export function createToolFailureHintExtension(): InlineExtension {
  return {
    name: "cortex-tool-failure-hint",
    factory: (pi: ExtensionAPI) => {
      pi.on("tool_result", (event: ToolResultEvent): ToolResultHookResult | void => {
        if (event.toolName !== "bash") return;
        const hint = detectToolFailure(textOf(event.content));
        if (!hint) return;
        return {
          content: [...event.content, { type: "text", text: `\n${TOOL_FAILURE_HINT_PREFIX} ${hint.text}` }],
        };
      });
    },
  };
}
