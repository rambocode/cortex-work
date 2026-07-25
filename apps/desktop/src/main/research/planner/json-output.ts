// 模型 JSON 输出的容错提取。
//
// 为什么需要它：即使 system prompt 写死「只输出 JSON」，真实模型仍会时不时套上 ```json 代码块、
// 前面加一句「好的，这是计划：」，或者在末尾追加解释。这些都是**格式噪声而非语义错误**，
// 在这里剥掉一层，能省下一次昂贵的重试；真正的结构性错误留给 core 的 parseResearchPlan 拒绝。
//
// 红线：本文件只做「找出那段 JSON」，**不做任何字段级的修补或猜测**——字段清洗是
// core/research/plan-schema 的职责，两处都改会让「模型输出到底被谁改过」变得不可追踪。

/// 从模型输出里提取第一个 JSON 对象；提取或解析失败返回 null。
export function extractJsonObject(raw: string): unknown | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  // 先试整体解析：模型守规矩时这是唯一会走到的分支。
  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  // 再试代码块内部（```json … ``` 或 ``` … ```）。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  if (fenced) {
    const parsed = tryParse(fenced.trim());
    if (parsed !== undefined) return parsed;
  }

  // 最后按括号配对扫出第一个平衡的 {...}。
  // 为什么要自己配对而不是取首尾大括号：模型常在 JSON 之后追加一段解释，
  // 而解释里出现一个 `}` 就会让 lastIndexOf("}") 切到错误的位置。
  const balanced = firstBalancedObject(text);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

/// JSON.parse 的 undefined-on-failure 包装（null 是合法 JSON 值，不能拿它表示失败）。
function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/// 扫出第一个括号平衡的对象字面量；字符串字面量内的括号与转义都会被跳过。
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
