/* =========================================================================
   Open Graph 图（1200×630）
   设计：暖纸底 × 蓝紫生物荧光。左侧大标题「Cortex Desktop」+ 英文标语，
   右上角一抹蓝紫径向光晕 + 简化水母剪影 + 几颗发光点（神经元意象）。

   关键约束：零外部字体 / 零网络请求。
   next/og（@vercel/og）离线只内置 Latin 字体（Geist），不含中文字形。
   若放中文，build 不会失败但会渲染成空豆腐块。故这里只用拉丁文案
   （品牌名 + 英文标语，均取自 dict，仍不硬编码可见文案），保证
   next build 在离线环境既能成功、画面又干净。

   注：本文件位于 [locale] 段下，继承 layout 的 metadataBase 以解析社交图绝对 URL；
   两种语言各预渲染一张静态 OG 图。画面文案统一用英文（CJK 字体不内置），不随 locale 变。
   ========================================================================= */
import { ImageResponse } from "next/og";
import { getDict } from "@/lib/dictionary";

// OG 图尺寸与类型（Next 约定导出）
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// 两语言各自静态预渲染 OG 图（与 [locale]/layout 的 generateStaticParams 对齐）
export function generateStaticParams() {
  return [{ locale: "zh" }, { locale: "en" }];
}
// 替代文本走英文 dict，避免 OG 元数据里出现无意义信息
export const alt = getDict("en").meta.ogAlt;

// 设计 token 取值（OG 渲染环境读不到 CSS 变量，与 globals.css 对齐后内联）
const PAPER = "#faf8f4"; // 暖纸底
const INK = "#1a1916"; // 深墨标题
const INK_2 = "#5e5c56"; // 次级文字
const CLAY = "#c96442"; // 品牌动作色
const GLOW_BLUE = "#5b8cff";
const GLOW_VIOLET = "#8b5cf6";
const GLOW_CYAN = "#36c8dc";

export default async function OpenGraphImage() {
  // 一切可见文案来自 dict（拉丁内容用 en 切片）。
  const en = getDict("en");
  const brandName = en.brand.name; // "Cortex Desktop"
  const tagline = en.footer.tagline; // "One workspace for every coding agent."
  const eyebrow = en.brand.tagline; // "The team agent workspace"

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          position: "relative",
          backgroundColor: PAPER,
          // 极轻暖纸纵向过渡，避免大色块死板
          backgroundImage: "linear-gradient(160deg, #fdfbf7 0%, #faf8f4 55%, #f5f2ec 100%)",
          padding: "84px 96px",
          overflow: "hidden",
          fontFamily: "sans-serif",
        }}
      >
        {/* 右上角蓝紫径向光晕（绝对定位 div + radial-gradient） */}
        <div
          style={{
            position: "absolute",
            top: -260,
            right: -200,
            width: 760,
            height: 760,
            borderRadius: "50%",
            background:
              "radial-gradient(closest-side, rgba(91,140,255,0.42), rgba(139,92,246,0.20) 52%, rgba(139,92,246,0) 78%)",
          }}
        />
        {/* 第二层更内聚的青蓝光核，制造体积感 */}
        <div
          style={{
            position: "absolute",
            top: -90,
            right: 60,
            width: 360,
            height: 360,
            borderRadius: "50%",
            background:
              "radial-gradient(closest-side, rgba(54,200,220,0.30), rgba(54,200,220,0) 72%)",
          }}
        />

        {/* 简化水母剪影：发光伞盖 + 内部高光 + 下垂触手 */}
        <div
          style={{
            position: "absolute",
            top: 92,
            right: 150,
            width: 260,
            height: 320,
            display: "flex",
          }}
        >
          {/* 伞盖：蓝紫渐变半圆 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 30,
              width: 200,
              height: 130,
              borderRadius: "100px 100px 64px 64px",
              background:
                "linear-gradient(165deg, #8fd2ff 0%, #6a8bff 42%, #9a6bff 78%, #b46bff 100%)",
              boxShadow: "0 0 60px -6px rgba(91,140,255,0.55)",
              opacity: 0.92,
            }}
          />
          {/* 伞盖内高光 */}
          <div
            style={{
              position: "absolute",
              top: 18,
              left: 70,
              width: 70,
              height: 34,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.45)",
            }}
          />
          {/* 触手：几条下垂的渐隐细条 */}
          {[58, 92, 126, 160].map((left, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                top: 122,
                left,
                width: 8,
                height: 110 + (i % 2) * 26,
                borderRadius: 8,
                background:
                  "linear-gradient(180deg, rgba(154,107,255,0.78), rgba(180,107,255,0))",
              }}
            />
          ))}
        </div>

        {/* 散布的发光点（神经元星点，呼应水母伞盖光点） */}
        {[
          { top: 70, right: 470, size: 12, c: GLOW_CYAN },
          { top: 150, right: 380, size: 8, c: GLOW_BLUE },
          { top: 250, right: 110, size: 10, c: GLOW_VIOLET },
          { top: 360, right: 300, size: 7, c: GLOW_BLUE },
          { top: 440, right: 190, size: 9, c: GLOW_VIOLET },
        ].map((p, i) => (
          <div
            key={`dot-${i}`}
            style={{
              position: "absolute",
              top: p.top,
              right: p.right,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.c,
              boxShadow: `0 0 14px 2px ${p.c}`,
            }}
          />
        ))}

        {/* 左侧文案块 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            maxWidth: 720,
            position: "relative",
          }}
        >
          {/* eyebrow：陶土橙圆点 + 工作台标语 */}
          <div style={{ display: "flex", alignItems: "center", marginBottom: 30 }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: CLAY,
                marginRight: 13,
                boxShadow: "0 0 0 5px rgba(201,100,66,0.16)",
              }}
            />
            <div
              style={{
                display: "flex",
                fontSize: 26,
                fontWeight: 600,
                letterSpacing: 3,
                textTransform: "uppercase",
                color: CLAY,
              }}
            >
              {eyebrow}
            </div>
          </div>

          {/* 主标题：Cortex Desktop */}
          <div
            style={{
              display: "flex",
              fontSize: 124,
              fontWeight: 800,
              lineHeight: 1.0,
              letterSpacing: -4,
              color: INK,
            }}
          >
            {brandName}
          </div>

          {/* 副标题：英文标语 */}
          <div
            style={{
              display: "flex",
              fontSize: 44,
              fontWeight: 500,
              lineHeight: 1.28,
              marginTop: 36,
              color: INK_2,
              maxWidth: 660,
            }}
          >
            {tagline}
          </div>
        </div>

        {/* 底部细荧光分隔线，呼应站点 divider */}
        <div
          style={{
            position: "absolute",
            left: 96,
            bottom: 70,
            width: 480,
            height: 3,
            borderRadius: 3,
            background:
              "linear-gradient(90deg, rgba(91,140,255,0.7), rgba(139,92,246,0.5) 60%, rgba(139,92,246,0))",
          }}
        />
      </div>
    ),
    { ...size },
  );
}
