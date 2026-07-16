// Slides POC 页内提取脚本:在隐藏 BrowserWindow 的页面上下文里执行,把渲染后的 DOM
// 提炼为 scene-types.ts 定义的 SlideScene(JSON)。同时给已重建为原生对象的元素打
// `data-cortex-native` 标记、给降级层打 `data-cortex-raster` 标记,供 harness 隐藏原生
// 节点后截取 base raster(避免「整页截图 + 原生对象」双重渲染)。
//
// 用 `函数.toString()` 导出源码字符串,而不是手写字符串:保住语法高亮 / lint;
// 函数必须完全自包含(不引用闭包外变量),否则注入页面后会 ReferenceError。
//
// 分类为「复杂层(栅格降级)」的判定是保守白名单思路:凡 canvas、滤镜、渐变、非平移
// transform、混合模式、阴影等 PPTX 难以原生表达的样式,一律整棵子树交给 base raster,
// 保真优先、可编辑性其次。

/* eslint-disable */

function extractSceneInPage() {
  var CANVAS_W = 1280;
  var CANVAS_H = 720;
  var warnings = [];
  var nodes = [];
  var seq = 0;
  var zCounter = 0;

  function nextId(prefix) {
    seq += 1;
    return prefix + "-" + seq;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
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

  // 复杂样式判定:返回降级原因字符串;可原生重建时返回 null。
  function complexReason(el, cs) {
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
    if (cs.boxShadow && cs.boxShadow !== "none") return "box-shadow";
    if (cs.textShadow && cs.textShadow !== "none") return "text-shadow";
    var bg = cs.backgroundImage;
    if (bg && bg !== "none") {
      if (bg.indexOf("gradient(") !== -1) return "gradient";
      if (bg.indexOf("url(") !== -1) return "background-image";
      return "background-image";
    }
    var t = cs.transform;
    if (t && t !== "none") {
      // 仅允许纯平移(matrix(1,0,0,1,tx,ty));旋转/缩放/3D 一律降级。
      var m = t.match(/^matrix\(([^)]+)\)$/);
      if (!m) return "transform-3d";
      var p = m[1].split(",").map(function (s) {
        return parseFloat(s);
      });
      if (Math.abs(p[0] - 1) > 0.01 || Math.abs(p[1]) > 0.01 || Math.abs(p[2]) > 0.01 || Math.abs(p[3] - 1) > 0.01) {
        return "transform";
      }
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

  function emitText(el, cs) {
    var runs = [];
    collectRuns(el, runs);
    if (!runs.length) return;
    var r = rectOf(el);
    el.setAttribute("data-cortex-native", "1");
    var align = cs.textAlign;
    if (align !== "center" && align !== "right" && align !== "justify") align = "left";
    nodes.push({
      kind: "text",
      id: nextId("text"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      runs: runs,
      align: align,
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
      id: nextId("shape"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      fill: fill ? fill.hex : undefined,
      fillOpacity: fill ? Math.round(fill.alpha * 100) : undefined,
      border: hasBorder ? { color: borderColor.hex, widthPx: borderW } : undefined,
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
      id: nextId("img"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
      src: src,
      borderRadiusPx: radius > 0 ? radius : undefined,
    });
  }

  // 内联 <svg>:POC 阶段不做矢量重建,整块交给 base raster(Node 侧 PptxGenJS 对 svg
  // 的 png fallback 依赖浏览器 canvas,主进程不可用)。
  function emitSvgAsRaster(el) {
    var r = rectOf(el);
    el.setAttribute("data-cortex-raster", "1");
    nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: "svg" });
  }

  function cellAlign(cs) {
    var a = cs.textAlign;
    if (a === "center" || a === "right") return a;
    return "left";
  }

  function emitTable(tableEl, cs) {
    var r = rectOf(tableEl);
    var rows = [];
    var trs = tableEl.querySelectorAll("tr");
    for (var i = 0; i < trs.length; i++) {
      var cells = [];
      for (var j = 0; j < trs[i].children.length; j++) {
        var cellEl = trs[i].children[j];
        var tag = cellEl.tagName;
        if (tag !== "TD" && tag !== "TH") continue;
        var ccs = getComputedStyle(cellEl);
        var fill = parseColor(ccs.backgroundColor);
        var color = parseColor(ccs.color);
        cells.push({
          text: (cellEl.textContent || "").replace(/\s+/g, " ").trim(),
          bold: (parseInt(ccs.fontWeight, 10) || 400) >= 600,
          color: color ? color.hex : "000000",
          fill: fill ? fill.hex : undefined,
          align: cellAlign(ccs),
          fontSizePx: parseFloat(ccs.fontSize) || 16,
        });
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return;
    var firstTr = tableEl.querySelector("tr");
    var colWidthsPx = [];
    if (firstTr) {
      for (var k = 0; k < firstTr.children.length; k++) {
        colWidthsPx.push(round2(firstTr.children[k].getBoundingClientRect().width));
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
      id: nextId("table"),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      z: zCounter++,
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

    var reason = complexReason(el, cs);
    if (reason) {
      // 整棵子树降级:子孙即便是普通文本也随栅格层走,避免半原生半栅格的重叠。
      el.setAttribute("data-cortex-raster", "1");
      nodes.push({ kind: "raster", id: nextId("raster"), x: r.x, y: r.y, w: r.w, h: r.h, z: zCounter++, reason: reason });
      return;
    }
    if (tag === "img") return emitImage(el, cs);
    if (tag === "svg") return emitSvgAsRaster(el);
    if (tag === "table") return emitTable(el, cs);

    var emittedShape = emitShapeIfAny(el, cs);
    if (emittedShape) el.setAttribute("data-cortex-native", "1");

    if (isTextBlock(el)) {
      emitText(el, cs);
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

// 导出可直接交给 webContents.executeJavaScript 的自执行源码。
module.exports = {
  EXTRACT_SCENE_SOURCE: "(" + extractSceneInPage.toString() + ")()",
};
