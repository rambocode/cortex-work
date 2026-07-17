// Slides 导出的 DOM 场景提取层:在隐藏窗口的页面上下文里把渲染后的 DOM 提炼为
// types.ts 定义的 SlideScene(JSON),并给「将被原生重建」的元素打 data-cortex-native、
// 给「必须栅格降级」的层打 data-cortex-raster —— 宿主据此隐藏原生节点后截 base raster,
// 从而避免「整页截图 + 原生对象」双重渲染。
//
// 页内脚本用 `函数.toString()` 注入(保住语法高亮/lint);函数必须完全自包含
//(不引用闭包外变量),否则注入页面后 ReferenceError。类型注解编译时擦除,不影响注入。
//
// 复杂样式分两级处理(可编辑性优先,用户实测「整页一张图」不可接受):
//  - 结构性复杂(canvas/video/iframe、滤镜、混合模式、clip-path/mask、非平移 transform):
//    绘制或几何会波及子孙,子内容无法独立重建 → 整棵子树交给 base raster;
//  - 装饰性复杂(box-shadow、渐变/背景图、text-shadow):只是容器自身的绘制,子元素
//    坐标不受影响 → 容器盒子留在 base raster,子级文本/图片继续原生提取(PPTX 可编辑)。
//    纯文本块自身带装饰时,盒子进 raster、文字截图时置为透明(data-cortex-native-text)。
import type { SlideRenderWindow } from "../render";
import { parseSlidesChartSpec } from "./chart-spec";
import type { SceneChartNode, SceneNode, SceneRasterNode, SlideScene } from "./types";

export interface RawChartCandidateNode {
  kind: "chart-candidate";
  id: string;
  candidateKey: string;
  chartId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  specText: string;
  ariaLabel?: string;
  style?: SceneChartNode["style"];
}

export interface RawExtractedSlideScene {
  width: number;
  height: number;
  backgroundColor?: string;
  nodes: Array<SceneNode | RawChartCandidateNode>;
  hasComplexLayers: boolean;
  warnings: string[];
}

export function finalizeExtractedSlideScene(rawScene: RawExtractedSlideScene): {
  scene: SlideScene;
  validChartCandidateKeys: string[];
  invalidChartCandidateKeys: string[];
} {
  const nodes: SceneNode[] = [];
  const warnings = [...rawScene.warnings];
  const validChartCandidateKeys: string[] = [];
  const invalidChartCandidateKeys: string[] = [];

  for (const node of rawScene.nodes) {
    if (node.kind !== "chart-candidate") {
      nodes.push(node);
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(node.specText);
    } catch {
      warnings.push(`chart-spec-invalid:${node.chartId}`);
      invalidChartCandidateKeys.push(node.candidateKey);
      nodes.push({
        kind: "raster",
        id: node.id.replace(/^chart/, "raster"),
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        z: node.z,
        reason: "canvas",
      } satisfies SceneRasterNode);
      continue;
    }
    const parsed = parseSlidesChartSpec(parsedJson);
    if (!parsed.ok) {
      warnings.push(`chart-spec-invalid:${node.chartId}`);
      invalidChartCandidateKeys.push(node.candidateKey);
      nodes.push({
        kind: "raster",
        id: node.id.replace(/^chart/, "raster"),
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        z: node.z,
        reason: "canvas",
      } satisfies SceneRasterNode);
      continue;
    }
    if (parsed.value.type === "pie" && (parsed.value.xAxisTitle || parsed.value.yAxisTitle)) {
      warnings.push(`chart-axis-title-ignored:${node.chartId}`);
    }
    validChartCandidateKeys.push(node.candidateKey);
    nodes.push({
      kind: "chart",
      id: node.id,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      z: node.z,
      spec: parsed.value,
      ariaLabel: node.ariaLabel,
      style: node.style,
    } satisfies SceneChartNode);
  }

  return {
    scene: {
      width: rawScene.width,
      height: rawScene.height,
      backgroundColor: rawScene.backgroundColor,
      nodes,
      hasComplexLayers: nodes.some((entry) => entry.kind === "raster"),
      warnings,
    },
    validChartCandidateKeys,
    invalidChartCandidateKeys,
  };
}

/* eslint-disable */
function extractSceneInPage() {
  var CANVAS_W = 1280;
  var CANVAS_H = 720;
  var warnings: string[] = [];
  // 页内脚本用 any 收敛节点构造:各 emit* 分支按 SceneNode 各变体逐字段拼装,
  // 这里若用联合类型,TS 会对「先 push 再补字段」的 JS 写法层层报错而无实益;
  // 真正的类型保证在消费侧(extractSlideScene 断言为 SlideScene,pptx.ts 按 kind 分派)。
  var nodes: any[] = [];
  var seq = 0;
  var zCounter = 0;

  function nextId(prefix) {
    seq += 1;
    return prefix + "-" + seq;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  // rgb()/rgba() → { hex, alpha };全透明返回 null。
  function parseColor(css) {
    if (!css) return null;
    var m = css.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return null;
    var parts = m[1].split(",").map(function (s) {
      return parseFloat(s);
    });
    var a = parts.length > 3 ? parts[3] : 1;
    if (!(a > 0.01)) return null;
    var hex = parts
      .slice(0, 3)
      .map(function (v) {
        var s = Math.round(v).toString(16);
        return s.length < 2 ? "0" + s : s;
      })
      .join("");
    return { hex: hex, alpha: a };
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: round2(r.left), y: round2(r.top), w: round2(r.width), h: round2(r.height) };
  }

  function simpleTransformInfo(cs) {
    var t = cs.transform;
    if (!t || t === "none") return { rotateDeg: undefined, reason: null };
    if (t.indexOf("matrix3d(") === 0) return { rotateDeg: undefined, reason: "transform-3d" };
    var m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) return { rotateDeg: undefined, reason: "transform" };
    var p = m[1].split(",").map(function (s) {
      return parseFloat(s);
    });
    if (p.length < 4) return { rotateDeg: undefined, reason: "transform" };
    var a = p[0];
    var b = p[1];
    var c = p[2];
    var d = p[3];
    var det = a * d - b * c;
    if (Math.abs(det - 1) > 0.03) return { rotateDeg: undefined, reason: "transform" };
    if (Math.abs(a - d) > 0.03 || Math.abs(b + c) > 0.03) return { rotateDeg: undefined, reason: "transform" };
    var angle = Math.atan2(b, a) * (180 / Math.PI);
    return { rotateDeg: Math.abs(angle) < 0.05 ? undefined : round2(angle), reason: null };
  }

  function nodeVisualProps(cs) {
    var opacity = parseFloat(cs.opacity);
    var transform = simpleTransformInfo(cs);
    return {
      rotateDeg: transform.rotateDeg,
      opacity: !isNaN(opacity) && opacity < 0.999 ? round4(opacity) : undefined,
    };
  }

  function normalizeDataUri(src) {
    if (src.indexOf("data:") !== 0) return src;
    var comma = src.indexOf(",");
    if (comma < 0) return src;
    var header = src.slice(0, comma);
    var body = src.slice(comma + 1);
    if (header.indexOf(";base64") !== -1) return src;
    var decoded = decodeURIComponent(body);
    var utf8 = unescape(encodeURIComponent(decoded));
    return header + ";base64," + btoa(utf8);
  }

  function serializeSvgDataUri(el) {
    var clone = el.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    var raw = new XMLSerializer().serializeToString(clone);
    return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(raw)));
  }

  function parsePositionToken(token, fallback) {
    if (!token) return fallback;
    var lower = token.toLowerCase();
    if (lower === "left" || lower === "top") return 0;
    if (lower === "center") return 0.5;
    if (lower === "right" || lower === "bottom") return 1;
    if (/%$/.test(lower)) return Math.max(0, Math.min(1, parseFloat(lower) / 100));
    return fallback;
  }

  function parseObjectPosition(cs) {
    var raw = (cs.objectPosition || "50% 50%").trim().split(/\s+/);
    var x = parsePositionToken(raw[0], 0.5);
    var y = parsePositionToken(raw[1] || raw[0], 0.5);
    return { x: round4(x), y: round4(y) };
  }

  function valignForText(cs) {
    if (cs.display === "flex") {
      if (cs.alignItems === "center") return "middle";
      if (cs.alignItems === "flex-end" || cs.alignItems === "end") return "bottom";
    }
    if (cs.display === "table-cell") {
      if (cs.verticalAlign === "middle") return "middle";
      if (cs.verticalAlign === "bottom") return "bottom";
    }
    return "top";
  }

  function bulletForElement(el) {
    if (el.tagName !== "LI") return undefined;
    var parent = el.parentElement;
    if (!parent) return undefined;
    var tag = parent.tagName.toLowerCase();
    if (tag === "ul") return { type: "bullet" };
    if (tag === "ol") {
      var explicit = parseInt(el.getAttribute("value") || "", 10);
      if (!isNaN(explicit)) return { type: "number", numberStartAt: explicit };
      var start = parseInt(parent.getAttribute("start") || "", 10);
      if (isNaN(start)) start = 1;
      var index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i] === el) break;
        if (parent.children[i].tagName === "LI") index += 1;
      }
      return { type: "number", numberStartAt: start + index };
    }
    return undefined;
  }

  // 结构性复杂判定:绘制/几何会波及子孙(子内容无法按 viewport 坐标独立重建),
  // 命中则整棵子树栅格;可原生重建时返回 null。
  function structuralReason(el, cs) {
    var tag = el.tagName.toLowerCase();
    if (tag === "canvas") return "canvas";
    if (tag === "video") return "video";
    if (tag === "iframe") return "iframe";
    if (cs.filter && cs.filter !== "none") return "css-filter";
    var backdrop = cs.backdropFilter || cs.webkitBackdropFilter;
    if (backdrop && backdrop !== "none") return "backdrop-filter";
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return "blend-mode";
    if (cs.clipPath && cs.clipPath !== "none") return "clip-path";
    var mask = cs.maskImage || cs.webkitMaskImage;
    if (mask && mask !== "none") return "mask";
    var transform = simpleTransformInfo(cs);
    if (transform.reason) return transform.reason;
    return null;
  }

  // 装饰性复杂判定:仅容器自身的绘制超出 PPTX 原生表达(硬阴影/渐变/背景图),
  // 子元素几何不受影响 —— 盒子进 base raster,子内容继续原生提取。
  function decorativeReason(cs) {
    if (cs.boxShadow && cs.boxShadow !== "none") return "box-shadow";
    if (cs.textShadow && cs.textShadow !== "none") return "text-shadow";
    var bg = cs.backgroundImage;
    if (bg && bg !== "none") {
      return bg.indexOf("gradient(") !== -1 ? "gradient" : "background-image";
    }
    return null;
  }

  // 子元素按简化 stacking 规则排序:定位元素的 z-index 升序,同序按 DOM 顺序。
  // 不实现完整 CSS 绘制算法(float、负 z-index 与背景交錯等),slide HTML 场景足够。
  function sortedChildren(el) {
    var kids = Array.prototype.slice.call(el.children);
    return kids
      .map(function (k, i) {
        var kcs = getComputedStyle(k);
        var zi = 0;
        if (kcs.position !== "static") {
          var parsed = parseInt(kcs.zIndex, 10);
          if (!isNaN(parsed)) zi = parsed;
        }
        return { k: k, i: i, zi: zi };
      })
      .sort(function (a, b) {
        return a.zi - b.zi || a.i - b.i;
      })
      .map(function (o) {
        return o.k;
      });
  }

  function isInlineLevel(el) {
    if (el.tagName === "BR") return true;
    var d = getComputedStyle(el).display;
    return d.indexOf("inline") === 0;
  }

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.textContent.trim()) return true;
    }
    return false;
  }

  // 文本块 = 有可见文本,且全部元素子节点都是内联层(可整体重建为一个文本框)。
  function isTextBlock(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 1) {
        var tag = c.tagName.toLowerCase();
        if (tag === "img" || tag === "svg" || tag === "canvas") return false;
        if (!isInlineLevel(c)) return false;
      }
    }
    return true;
  }

  function runFromStyle(text, cs) {
    var family = (cs.fontFamily.split(",")[0] || "Helvetica").trim().replace(/^["']|["']$/g, "");
    var color = parseColor(cs.color);
    return {
      text: text,
      fontFamily: family,
      fontSizePx: parseFloat(cs.fontSize) || 16,
      color: color ? color.hex : "000000",
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
      italic: cs.fontStyle === "italic",
      underline: (cs.textDecorationLine || "").indexOf("underline") !== -1,
    };
  }

  // 收集元素内的文本 run:文本节点取所属元素样式,<br> 记为上一 run 的强制换行。
  function collectRuns(el, runs) {
    var cs = getComputedStyle(el);
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3) {
        var text = c.textContent.replace(/\s+/g, " ");
        if (text.trim()) runs.push(runFromStyle(text, cs));
      } else if (c.nodeType === 1) {
        if (c.tagName === "BR") {
          if (runs.length) runs[runs.length - 1].breakAfter = true;
        } else {
          collectRuns(c, runs);
        }
      }
    }
  }

  // textOnly:元素盒子(背景/边框/阴影)由 base raster 承载,只有文字原生重建 ——
  // 截图时经 data-cortex-native-text 把文字置透明(而非隐藏整个元素,否则盒子也消失)。
  function emitText(el, cs, textOnly) {
    var runs: any[] = [];
    collectRuns(el, runs);
    if (!runs.length) return;
    var r = rectOf(el);
    var firstRun = runs[0];
    var bullet = bulletForElement(el);
    if (firstRun && bullet) firstRun.bullet = bullet;
    if (firstRun) {
      var mt = parseFloat(cs.marginTop) || 0;
      var mb = parseFloat(cs.marginBottom) || 0;
      if (mt > 0.5) firstRun.paraSpaceBeforePx = mt;
      if (mb > 0.5) firstRun.paraSpaceAfterPx = mb;
    }
    el.setAttribute(textOnly ? "data-cortex-native-text" : "data-cortex-native", "1");
    var align = cs.textAlign;
    if (align !== "center" && align !== "right" && align !== "justify") align = "left";
    nodes.push({
      kind: "text",
      id: el.getAttribute("data-cortex-id") || nextId("text"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      rotateDeg: nodeVisualProps(cs).rotateDeg,
      opacity: nodeVisualProps(cs).opacity,
      runs: runs,
      align: align,
      valign: valignForText(cs),
      lineHeightPx: cs.lineHeight === "normal" ? (parseFloat(cs.fontSize) || 16) * 1.2 : parseFloat(cs.lineHeight),
      paddingPx: {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      },
    });
  }

  // 有可见背景色或边框的元素 → 原生矩形 shape(在其子内容之下)。返回是否发出。
  function emitShapeIfAny(el, cs) {
    var fill = parseColor(cs.backgroundColor);
    var borderColor = parseColor(cs.borderTopColor);
    var borderW = parseFloat(cs.borderTopWidth) || 0;
    var hasBorder = !!(borderW > 0 && cs.borderTopStyle !== "none" && borderColor);
    if (!fill && !hasBorder) return false;
    var r = rectOf(el);
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    nodes.push({
      kind: "shape",
      id: el.getAttribute("data-cortex-id") || nextId("shape"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      rotateDeg: nodeVisualProps(cs).rotateDeg,
      opacity: nodeVisualProps(cs).opacity,
      fill: fill ? fill.hex : undefined,
      fillOpacity: fill ? Math.round(fill.alpha * 100) : undefined,
      // 直接用 borderColor 收窄(hasBorder 是它的布尔中介,TS 看不穿)。
      border: borderColor && hasBorder ? { color: borderColor.hex, widthPx: borderW } : undefined,
      borderRadiusPx: radius > 0 ? radius : undefined,
    });
    return true;
  }

  function emitImage(el, cs) {
    var src = el.currentSrc || el.src || "";
    var r = rectOf(el);
    if (src.indexOf("data:") !== 0 && src.indexOf("file:") !== 0) {
      // 远程图片违反页面合同:记警告并整块栅格降级。
      warnings.push("remote-image:" + src.slice(0, 120));
      el.setAttribute("data-cortex-raster", "1");
      nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: "remote-image" });
      return;
    }
    var radius = parseFloat(cs.borderTopLeftRadius) || 0;
    el.setAttribute("data-cortex-native", "1");
    nodes.push({
      kind: "image",
      id: el.getAttribute("data-cortex-id") || nextId("img"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      rotateDeg: nodeVisualProps(cs).rotateDeg,
      opacity: nodeVisualProps(cs).opacity,
      src: normalizeDataUri(src),
      objectFit: cs.objectFit === "contain" || cs.objectFit === "cover" ? cs.objectFit : "fill",
      objectPosition: parseObjectPosition(cs),
      intrinsicSize: el.naturalWidth > 0 && el.naturalHeight > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : undefined,
      borderRadiusPx: radius > 0 ? radius : undefined,
    });
  }

  function emitSvgAsImage(el) {
    var r = rectOf(el);
    el.setAttribute("data-cortex-native", "1");
    nodes.push({
      kind: "image",
      id: el.getAttribute("data-cortex-id") || nextId("img"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      rotateDeg: nodeVisualProps(getComputedStyle(el)).rotateDeg,
      opacity: nodeVisualProps(getComputedStyle(el)).opacity,
      src: serializeSvgDataUri(el),
      objectFit: "fill",
      objectPosition: { x: 0.5, y: 0.5 },
      intrinsicSize: undefined,
    });
  }

  function directChartSpecScript(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (child.tagName === "SCRIPT" && child.hasAttribute("data-cortex-chart-spec")) return child;
    }
    return null;
  }

  function emitChartCandidate(el, cs) {
    var specScript = directChartSpecScript(el);
    if (!specScript) return false;
    var canvas = el.querySelector("canvas");
    if (!canvas) return false;
    var r = rectOf(canvas);
    var color = parseColor(cs.color);
    var bg = parseColor(cs.backgroundColor);
    var markerId = el.getAttribute("data-cortex-id") || nextId("chart-root");
    var candidateKey = nextId("chart-candidate");
    canvas.setAttribute("data-cortex-chart-candidate", candidateKey);
    nodes.push({
      kind: "chart-candidate",
      id: nextId("chart"),
      candidateKey: candidateKey,
      chartId: markerId,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      specText: (specScript.textContent || "").trim(),
      ariaLabel: el.getAttribute("aria-label") || canvas.getAttribute("aria-label") || undefined,
      style: {
        fontFamily: (cs.fontFamily.split(",")[0] || "Helvetica").trim().replace(/^["']|["']$/g, ""),
        fontSizePx: parseFloat(cs.fontSize) || undefined,
        color: color ? color.hex : undefined,
        backgroundColor: bg ? bg.hex : undefined,
      },
    });
    return true;
  }

  function cellAlign(cs) {
    var a = cs.textAlign;
    if (a === "center" || a === "right") return a;
    return "left";
  }

  function emitTable(tableEl, cs) {
    var r = rectOf(tableEl);
    var rows: any[] = [];
    var warnedRadius = false;
    var trs = tableEl.querySelectorAll("tr");
    for (var i = 0; i < trs.length; i++) {
      var cells: any[] = [];
      for (var j = 0; j < trs[i].children.length; j++) {
        var cellEl = trs[i].children[j];
        var tag = cellEl.tagName;
        if (tag !== "TD" && tag !== "TH") continue;
        var ccs = getComputedStyle(cellEl);
        var fill = parseColor(ccs.backgroundColor);
        var color = parseColor(ccs.color);
        var radius = parseFloat(ccs.borderTopLeftRadius) || 0;
        if (!warnedRadius && radius > 0) {
          warnings.push("table-border-radius-approx:" + (tableEl.getAttribute("data-cortex-id") || "table"));
          warnedRadius = true;
        }
        cells.push({
          text: (cellEl.textContent || "").replace(/\s+/g, " ").trim(),
          bold: (parseInt(ccs.fontWeight, 10) || 400) >= 600,
          color: color ? color.hex : "000000",
          fill: fill ? fill.hex : undefined,
          align: cellAlign(ccs),
          fontSizePx: parseFloat(ccs.fontSize) || 16,
          colspan: cellEl.colSpan > 1 ? cellEl.colSpan : undefined,
          rowspan: cellEl.rowSpan > 1 ? cellEl.rowSpan : undefined,
        });
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return;
    if (!warnedRadius && (parseFloat(cs.borderTopLeftRadius) || 0) > 0) {
      warnings.push("table-border-radius-approx:" + (tableEl.getAttribute("data-cortex-id") || "table"));
    }
    var firstTr = tableEl.querySelector("tr");
    var colWidthsPx: number[] = [];
    if (firstTr) {
      for (var k = 0; k < firstTr.children.length; k++) {
        var width = firstTr.children[k].getBoundingClientRect().width;
        var logicalSpan = firstTr.children[k].colSpan > 0 ? firstTr.children[k].colSpan : 1;
        var logicalWidth = round2(width / logicalSpan);
        for (var spanIndex = 0; spanIndex < logicalSpan; spanIndex++) {
          colWidthsPx.push(logicalWidth);
        }
      }
    }
    // 边框取第一个单元格的 border(简单表格假设四边一致)。
    var border;
    var firstCell = tableEl.querySelector("td, th");
    if (firstCell) {
      var fcs = getComputedStyle(firstCell);
      var bw = parseFloat(fcs.borderTopWidth) || 0;
      var bc = parseColor(fcs.borderTopColor);
      if (bw > 0 && fcs.borderTopStyle !== "none" && bc) border = { color: bc.hex, widthPx: bw };
    }
    tableEl.setAttribute("data-cortex-native", "1");
    nodes.push({
      kind: "table",
      id: tableEl.getAttribute("data-cortex-id") || nextId("table"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      rotateDeg: nodeVisualProps(cs).rotateDeg,
      opacity: nodeVisualProps(cs).opacity,
      rows: rows,
      colWidthsPx: colWidthsPx,
      border: border,
      fontFamily: (cs.fontFamily.split(",")[0] || "Helvetica").trim().replace(/^["']|["']$/g, ""),
    });
  }

  function walk(el) {
    if (el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "link" || tag === "meta") return;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    var opacity = parseFloat(cs.opacity);
    if (!isNaN(opacity) && opacity < 0.02) return;
    var r = rectOf(el);
    if (r.w < 1 || r.h < 1) return;
    // 完全在画布外的元素不参与导出。
    if (r.x >= CANVAS_W || r.y >= CANVAS_H || r.x + r.w <= 0 || r.y + r.h <= 0) return;

    var reason = structuralReason(el, cs);
    if (reason) {
      // 整棵子树降级:绘制/几何波及子孙,子内容无法独立重建。
      el.setAttribute("data-cortex-raster", "1");
      nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: reason });
      return;
    }
    if (tag === "img") return emitImage(el, cs);
    if (tag === "svg") return emitSvgAsImage(el);
    if (emitChartCandidate(el, cs)) return;

    if (hasDirectText(el) && !isTextBlock(el)) {
      warnings.push("mixed-content:" + (el.getAttribute("data-cortex-id") || tag));
      warnings.push("blocking:" + (el.getAttribute("data-cortex-id") || tag));
      el.setAttribute("data-cortex-raster", "1");
      nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: "mixed-content" });
      return;
    }

    var decor = decorativeReason(cs);
    if (decor) {
      // 装饰性容器:盒子(阴影/渐变/背景图连同背景色边框)整体留在 base raster,
      // 子级文本/图片继续原生提取 —— 手绘风模板整卡带硬阴影,整棵栅格会让 PPTX
      // 退化成一张图(用户实测不可编辑),这里以「盒子不可动、文字可编辑」为折中。
      el.setAttribute("data-cortex-raster", "1");
      nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: decor });
      if (isTextBlock(el)) {
        // 自身就是文本块(如带硬阴影的药丸标题):文字原生、截图时置透明。
        // text-shadow 留在 raster 里,原生文字叠其上,视觉与 HTML 一致。
        emitText(el, cs, true);
        return;
      }
      var decorKids = sortedChildren(el);
      for (var d = 0; d < decorKids.length; d++) walk(decorKids[d]);
      return;
    }
    if (tag === "table") return emitTable(el, cs);

    var emittedShape = emitShapeIfAny(el, cs);
    if (emittedShape) el.setAttribute("data-cortex-native", "1");

    if (isTextBlock(el)) {
      emitText(el, cs, false);
      return;
    }
    if (hasDirectText(el)) {
      // 直接文本与块级子元素混排:该文本无法单独定位成文本框,记警告(POC 页面应避免)。
      warnings.push("mixed-content:" + (el.getAttribute("data-cortex-id") || tag));
    }
    var kids = sortedChildren(el);
    for (var i2 = 0; i2 < kids.length; i2++) walk(kids[i2]);
  }

  // 页面背景:纯色 → 交给 PPTX slide background;渐变/图片 → 由 base raster 承载。
  var bodyCs = getComputedStyle(document.body);
  var htmlCs = getComputedStyle(document.documentElement);
  var bodyBg = parseColor(bodyCs.backgroundColor) || parseColor(htmlCs.backgroundColor);
  var backgroundColor = bodyBg ? bodyBg.hex : "ffffff";
  var bodyComplex = false;
  var bodyBgImage = bodyCs.backgroundImage;
  if (bodyBgImage && bodyBgImage !== "none") {
    bodyComplex = true;
    backgroundColor = undefined;
    nodes.push({ kind: "raster", id: nextId("raster"), x: 0, y: 0, w: CANVAS_W, h: CANVAS_H, z: -1, reason: "body-background" });
  }

  var roots = sortedChildren(document.body);
  for (var i = 0; i < roots.length; i++) walk(roots[i]);

  var rasterCount = 0;
  for (var j = 0; j < nodes.length; j++) {
    if (nodes[j].kind === "raster") rasterCount += 1;
  }

  return {
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundColor: backgroundColor,
    nodes: nodes,
    hasComplexLayers: rasterCount > 0 || bodyComplex,
    warnings: warnings,
  };
}
/* eslint-enable */

/** 页内提取脚本源码(自执行,返回 SlideScene)。 */
export const EXTRACT_SCENE_SOURCE = "(" + extractSceneInPage.toString() + ")()";

/**
 * 隐藏所有将被原生重建的节点、强制显示栅格层。
 * 用 visibility(而非 display)是关键:容器隐藏后其内的 raster 子层仍能显式显示回来,
 * 且不触发重排 —— 布局必须与提取时完全一致,否则 base raster 会与原生对象错位。
 */
export const HIDE_NATIVE_CSS =
  '[data-cortex-native="1"] { visibility: hidden !important; }' +
  '[data-cortex-raster="1"] { visibility: visible !important; }' +
  // 装饰性文本块:盒子要留在 raster 里,只把文字置透明(text-shadow 仍随 raster 保留)。
  '[data-cortex-native-text="1"], [data-cortex-native-text="1"] * { color: transparent !important; }';

/** 在已加载并就绪的窗口里提取场景(同时给页面打上 native/raster 标记)。 */
export async function extractSlideScene(win: SlideRenderWindow): Promise<SlideScene> {
  const rawScene = (await win.executeJavaScript(EXTRACT_SCENE_SOURCE)) as RawExtractedSlideScene;
  const { scene, validChartCandidateKeys, invalidChartCandidateKeys } = finalizeExtractedSlideScene(rawScene);

  if (validChartCandidateKeys.length || invalidChartCandidateKeys.length) {
    await win.executeJavaScript(
      `(() => {
        const validIds = ${JSON.stringify(validChartCandidateKeys)};
        const invalidIds = ${JSON.stringify(invalidChartCandidateKeys)};
        for (const id of validIds) {
          const el = document.querySelector('[data-cortex-chart-candidate="' + id + '"]');
          if (!el) continue;
          el.setAttribute("data-cortex-native", "1");
          el.removeAttribute("data-cortex-raster");
          el.removeAttribute("data-cortex-chart-candidate");
        }
        for (const id of invalidIds) {
          const el = document.querySelector('[data-cortex-chart-candidate="' + id + '"]');
          if (!el) continue;
          el.removeAttribute("data-cortex-native");
          el.setAttribute("data-cortex-raster", "1");
          el.removeAttribute("data-cortex-chart-candidate");
        }
      })()`,
    );
  }

  return scene;
}

/**
 * 截取 base raster:隐藏原生节点后整页截图 → data URI。
 * 必须在 extractSlideScene 之后调用(依赖它打的标记)。
 */
export async function captureBaseRasterDataUri(win: SlideRenderWindow): Promise<string> {
  await win.insertCSS(HIDE_NATIVE_CSS);
  // 等两帧确保隐藏样式已绘制,再截图。
  await win.executeJavaScript(
    "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))))",
  );
  const image = await win.capturePage();
  return "data:image/png;base64," + image.toPNG().toString("base64");
}
