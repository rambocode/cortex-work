// 发布控制台前端。原生 JS,无构建步骤——发版工具链上少一个能坏的环节。
// 状态经 SSE 单向推送(/api/events),按钮只发 POST,不在前端维护第二份真相。

const $ = (id) => document.getElementById(id);
const state = { run: null, logs: [], filter: "" };

/** 毫秒 → 人类可读时长。阶段耗时和公证已等时长都用它，统一口径。 */
function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// ── 阶段列表 ──────────────────────────────────────────────────────────────────
function renderSteps(snap) {
  const box = $("steps");
  box.innerHTML = "";
  let group = null;
  for (const s of snap.steps) {
    if (s.group !== group) {
      group = s.group;
      const h = document.createElement("div");
      h.className = "group-title";
      h.textContent = group;
      box.appendChild(h);
    }
    const el = document.createElement("div");
    el.className = `step ${s.status}`;
    // 运行中的阶段显示实时计时,让「还在跑」和「卡死了」能被区分出来。
    const elapsed = s.startedAt ? (s.finishedAt ?? Date.now()) - s.startedAt : null;
    el.innerHTML = `
      <span class="dot"></span>
      <span class="title"></span>
      <span class="time">${elapsed ? dur(elapsed) : ""}</span>`;
    el.querySelector(".title").textContent = s.title;
    box.appendChild(el);
    if (s.error) {
      const e = document.createElement("div");
      e.className = "err";
      e.textContent = s.error;
      box.appendChild(e);
    }
  }

  const failed = snap.steps.find((s) => s.status === "failed");
  const doneCount = snap.steps.filter((s) => s.status === "done").length;
  $("overall").textContent = snap.running
    ? `进行中 · ${doneCount}/${snap.steps.length}`
    : failed
      ? `已中断 · ${doneCount}/${snap.steps.length} 完成`
      : doneCount === snap.steps.length
        ? "✅ 发布完成"
        : `未开始 · ${doneCount}/${snap.steps.length} 完成`;

  $("btn-stop").disabled = !snap.running;
  $("btn-start").disabled = snap.running;
  $("btn-rerun").disabled = snap.running;
  // 有已完成阶段时，按钮语义变成「续跑」，避免用户误以为会从头再来。
  $("btn-start").textContent = doneCount > 0 && doneCount < snap.steps.length ? "从断点继续" : "开始发布";
}

// ── 日志 ──────────────────────────────────────────────────────────────────────
function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 5000) state.logs.shift();
  if (state.filter && !entry.text.toLowerCase().includes(state.filter)) return;
  const box = $("log");
  const line = document.createElement("div");
  line.className = `line ${entry.level}`;
  line.textContent = entry.text;
  box.appendChild(line);
  while (box.childElementCount > 3000) box.removeChild(box.firstChild);
  if ($("autoscroll").checked) box.scrollTop = box.scrollHeight;
}

function rerenderLogs() {
  const box = $("log");
  box.innerHTML = "";
  for (const e of state.logs) {
    if (state.filter && !e.text.toLowerCase().includes(state.filter)) continue;
    const line = document.createElement("div");
    line.className = `line ${e.level}`;
    line.textContent = e.text;
    box.appendChild(line);
  }
  box.scrollTop = box.scrollHeight;
}

// ── 前置检查 ──────────────────────────────────────────────────────────────────
async function loadPreflight() {
  const box = $("preflight");
  box.innerHTML = '<span class="hint">检查中…</span>';
  const r = await fetch("/api/preflight").then((x) => x.json());
  box.innerHTML = "";
  for (const c of r.checks) {
    const cls = c.ok ? "ok" : c.level === "warn" ? "warn" : "bad";
    const el = document.createElement("div");
    el.className = `check ${cls}`;
    el.innerHTML = `<span class="mark">${c.ok ? "✓" : c.level === "warn" ? "!" : "✗"}</span>
      <span class="name"></span><span class="detail"></span>`;
    el.querySelector(".name").textContent = c.name;
    el.querySelector(".detail").textContent = c.detail;
    box.appendChild(el);
  }
}

// ── 公证队列 ──────────────────────────────────────────────────────────────────
async function loadNotary() {
  const box = $("notary");
  const r = await fetch("/api/notary").then((x) => x.json());
  box.innerHTML = "";
  if (!r.ok) {
    box.innerHTML = `<span class="hint"></span>`;
    box.firstChild.textContent = r.error ?? "查询失败";
    return;
  }
  if (!r.items.length) {
    box.innerHTML = '<span class="hint">暂无提交记录</span>';
    return;
  }
  for (const it of r.items) {
    const el = document.createElement("div");
    el.className = "sub";
    // 超过 15 分钟仍未出结果就标黄——这是「Apple 在排队」的实用阈值，正常几分钟内就该回。
    const long = it.status === "In Progress" && it.waitedMs > 15 * 60 * 1000;
    el.innerHTML = `<span class="st"></span><span class="nm"></span><span class="wt ${long ? "long" : ""}"></span>`;
    const st = el.querySelector(".st");
    // status 来自 notarytool 输出，走 classList 而非模板插值，杜绝把外部字符串拼进 HTML。
    st.classList.add((it.status || "").replace(/\s+/g, ""));
    st.textContent = it.status;
    el.querySelector(".nm").textContent = it.name ?? it.id;
    el.querySelector(".wt").textContent = it.status === "In Progress" ? `已等 ${dur(it.waitedMs)}` : dur(it.waitedMs) + " 前";
    box.appendChild(el);
  }
}

// ── 事件流 ────────────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    state.run = JSON.parse(e.data);
    renderSteps(state.run);
  });
  es.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  es.onerror = () => {
    // 服务重启时浏览器会自动重连，这里不做额外处理，只提示。
    $("overall").textContent = "连接中断，重连中…";
  };
}

// ── 交互 ──────────────────────────────────────────────────────────────────────
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.checks?.filter((c) => !c.ok && c.level === "error").map((c) => `${c.name}：${c.detail}`).join("\n");
    alert(`${data.error ?? "请求失败"}${detail ? `\n\n${detail}` : ""}`);
    return false;
  }
  return true;
}

$("btn-start").onclick = () => post("/api/start", { mode: "resume" });
$("btn-rerun").onclick = async () => {
  if (!confirm("全部重跑会重新构建两个架构（约 20 分钟以上），确定？")) return;
  await post("/api/start", { mode: "all" });
};
$("btn-stop").onclick = () => post("/api/stop");
$("btn-preflight").onclick = loadPreflight;
$("btn-notary").onclick = loadNotary;
$("btn-clear-view").onclick = () => {
  state.logs = [];
  $("log").innerHTML = "";
};
$("filter").oninput = (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  rerenderLogs();
};

(async function boot() {
  const s = await fetch("/api/state").then((r) => r.json());
  $("chip-version").textContent = `v${s.version}`;
  $("chip-tag").textContent = `tag ${s.tag}`;
  $("chip-repo").textContent = s.repo;
  renderSteps(s.run);
  connect();
  loadPreflight();
  loadNotary();
  // 公证队列定时刷新:卡在公证时,这块是唯一会变的信息,得自己动起来。
  setInterval(loadNotary, 60_000);
  // 运行中每秒重绘一次阶段,把耗时计时走起来。
  setInterval(() => {
    if (state.run?.running) renderSteps(state.run);
  }, 1000);
})();
