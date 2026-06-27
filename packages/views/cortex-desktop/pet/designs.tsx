// 宠物造型库：4 个造型共用同一套状态机与动画类名骨架
// （pet-tail / pet-body / pet-paws / pet-head / pet-ear-l|r / pet-eyes 组 /
//   pet-mouth(-talk) / pet-blush + 共享配件）,CSS 状态规则对所有造型生效。
// 每个造型的动画节点用内联 transformOrigin 标定自己的旋转支点。

import type { ReactNode } from "react";
import type { PetKind } from "@cortex-work/core";

const OUTLINE = "#4a3f30";

// ── 共享配件:思考泡泡 / 对话气泡 / Zzz / 齿轮 / 汗滴 / 爱心 ────────────────
// 也被 sprite 路径作为叠加层复用(Pet.tsx 的 .pet-accessories),让 sprite 角色
// 在 thinking/working/replying/sleeping/happy 下仍有浮动状态反馈。
export function Accessories() {
  return (
    <>
      <g className="pet-bubble pet-think">
        <circle cx="103" cy="38" r="2.5" fill="#fff" stroke={OUTLINE} strokeWidth="1.4" />
        <circle cx="110" cy="29" r="4" fill="#fff" stroke={OUTLINE} strokeWidth="1.4" />
        <rect x="112" y="4" rx="9" ry="9" width="26" height="19" fill="#fff" stroke={OUTLINE} strokeWidth="1.5" />
        <circle className="dot d1" cx="119" cy="13.5" r="1.8" fill={OUTLINE} />
        <circle className="dot d2" cx="125" cy="13.5" r="1.8" fill={OUTLINE} />
        <circle className="dot d3" cx="131" cy="13.5" r="1.8" fill={OUTLINE} />
      </g>
      <g className="pet-bubble pet-speech">
        <path
          d="M108 8 h28 a8 8 0 0 1 8 8 v8 a8 8 0 0 1 -8 8 h-16 l-7 8 v-8 h-5 a8 8 0 0 1 -8 -8 v-8 a8 8 0 0 1 8 -8 z"
          fill="#fff"
          stroke={OUTLINE}
          strokeWidth="1.5"
        />
        <circle className="dot d1" cx="115" cy="20" r="2" fill="var(--accent, #c96442)" />
        <circle className="dot d2" cx="122" cy="20" r="2" fill="var(--accent, #c96442)" />
        <circle className="dot d3" cx="129" cy="20" r="2" fill="var(--accent, #c96442)" />
      </g>
      <g className="pet-zzz" fill="none" stroke={OUTLINE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path className="z z1" d="M104 36 h8 l-8 9 h8" />
        <path className="z z2" d="M116 22 h7 l-7 8 h7" />
        <path className="z z3" d="M127 9 h6 l-6 7 h6" />
      </g>
      <g className="pet-gear">
        <g className="pet-gear-spin">
          <circle cx="116" cy="26" r="7.5" fill="none" stroke="var(--accent, #c96442)" strokeWidth="2.6" />
          <g stroke="var(--accent, #c96442)" strokeWidth="2.6" strokeLinecap="round">
            <path d="M116 14.5 v4" />
            <path d="M116 33.5 v4" />
            <path d="M104.5 26 h4" />
            <path d="M123.5 26 h4" />
            <path d="M107.9 17.9 l2.8 2.8" />
            <path d="M121.3 31.3 l2.8 2.8" />
            <path d="M124.1 17.9 l-2.8 2.8" />
            <path d="M110.7 31.3 l-2.8 2.8" />
          </g>
          <circle cx="116" cy="26" r="2.4" fill="var(--accent, #c96442)" />
        </g>
      </g>
      <path className="pet-sweat" d="M38 30 q-3.5 5 0 7.5 q3.5 -2.5 0 -7.5z" fill="#7bc3e8" />
      <path
        className="pet-heart"
        d="M112 24 c-2.6 -5 -10 -3.2 -10 2 c0 4.4 6 7.6 10 10.4 c4 -2.8 10 -6 10 -10.4 c0 -5.2 -7.4 -7 -10 -2z"
        fill="var(--accent, #c96442)"
      />
      {/* typing:头顶冒一支写字的小铅笔(用户正在输入时摆动)。 */}
      <g className="pet-typing">
        <g transform="rotate(34 119 20)">
          <rect x="115" y="6" width="8" height="4" rx="1.2" fill="#f4a0b4" stroke={OUTLINE} strokeWidth="1.2" />
          <rect x="115" y="10" width="8" height="2" fill="#cfcfcf" stroke={OUTLINE} strokeWidth="0.8" />
          <rect x="115" y="12" width="8" height="13" fill="#f5c542" stroke={OUTLINE} strokeWidth="1.3" />
          <path d="M115 25 h8 l-4 6 z" fill="#e8c08a" stroke={OUTLINE} strokeWidth="1.2" strokeLinejoin="round" />
          <path d="M117.6 28.5 h2.8 l-1.4 2.5 z" fill={OUTLINE} />
        </g>
        <g className="pet-typing-marks" stroke="var(--accent, #c96442)" strokeWidth="1.6" strokeLinecap="round">
          <path className="dot d1" d="M101 40 h6" />
          <path className="dot d2" d="M101 44 h9" />
        </g>
      </g>
    </>
  );
}

// ── 共享五官:眼睛三态 + 眨眼眼皮(眼皮色随毛色) ────────────────────────────
// 杏仁眼形 + 虹膜(深色缘)/瞳孔/双高光分层,iris 为各造型虹膜色。
function Eyes({ lidFill, iris = "#b5803c" }: { lidFill: string; iris?: string }) {
  return (
    <>
      <g className="pet-eyes">
        <g className="pet-eye-sock">
          <path
            d="M39.3 44 q1.9 -7.4 6.7 -7.4 q4.8 0 6.7 7.4 q-1.9 7.2 -6.7 7.2 q-4.8 0 -6.7 -7.2z"
            fill="#fff"
            stroke="#2e2a22"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M67.3 44 q1.9 -7.4 6.7 -7.4 q4.8 0 6.7 7.4 q-1.9 7.2 -6.7 7.2 q-4.8 0 -6.7 -7.2z"
            fill="#fff"
            stroke="#2e2a22"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </g>
        <g className="pet-pupils">
          {/* 虹膜:外缘深一圈,内部主色 */}
          <circle cx="46" cy="44.6" r="4.7" fill={iris} stroke="#3a2c1c" strokeWidth="1.1" />
          <circle cx="74" cy="44.6" r="4.7" fill={iris} stroke="#3a2c1c" strokeWidth="1.1" />
          <ellipse cx="46" cy="44.9" rx="2.2" ry="3.1" fill="#1c1812" />
          <ellipse cx="74" cy="44.9" rx="2.2" ry="3.1" fill="#1c1812" />
          {/* 主高光 + 下侧反光 */}
          <circle cx="47.9" cy="42.1" r="1.4" fill="#fff" />
          <circle cx="75.9" cy="42.1" r="1.4" fill="#fff" />
          <circle cx="44" cy="46.8" r="0.8" fill="#fff" opacity="0.75" />
          <circle cx="72" cy="46.8" r="0.8" fill="#fff" opacity="0.75" />
        </g>
        {/* 上眼睑睫毛线 */}
        <path
          d="M40.3 40 q5.7 -4.8 11.4 0 M68.3 40 q5.7 -4.8 11.4 0"
          fill="none"
          stroke="#2e2a22"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.5"
        />
        <g className="pet-lids">
          <rect x="38" y="35.5" width="16" height="17.5" rx="7.5" fill={lidFill} />
          <rect x="66" y="35.5" width="16" height="17.5" rx="7.5" fill={lidFill} />
        </g>
      </g>
      <g className="pet-eyes-happy" fill="none" stroke={OUTLINE} strokeWidth="2.4" strokeLinecap="round">
        <path d="M40 45 q6 -6.5 12 0" />
        <path d="M68 45 q6 -6.5 12 0" />
      </g>
      <g className="pet-eyes-closed" fill="none" stroke={OUTLINE} strokeWidth="2.4" strokeLinecap="round">
        <path d="M40 45 q6 4.5 12 0" />
        <path d="M68 45 q6 4.5 12 0" />
      </g>
    </>
  );
}

// ── 共享:贴轮廓的弧形碎毛(画在头形之下,露出柔软的小毛绺) ──────────────────
function FurTufts({ fill }: { fill: string }) {
  return (
    <g fill={fill} stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round">
      {/* 左颊两绺(弧形毛锋朝外下) */}
      <path d="M31 43 q-6.5 -1.5 -9 1.8 q4 0.8 5.8 3 z" />
      <path d="M29.5 53 q-6.8 0.8 -8.6 4.6 q4.3 0.2 6.4 2.2 z" />
      {/* 右颊两绺 */}
      <path d="M89 43 q6.5 -1.5 9 1.8 q-4 0.8 -5.8 3 z" />
      <path d="M90.5 53 q6.8 0.8 8.6 4.6 q-4.3 0.2 -6.4 2.2 z" />
      {/* 头顶呆毛两绺 */}
      <path d="M53 17 q-2 -5.5 -5.6 -7.2 q5 0.2 7.8 3.4 z" />
      <path d="M67 17 q2 -5.5 5.6 -7.2 q-5 0.2 -7.8 3.4 z" />
    </g>
  );
}

// ── 趴窗共用:垂搭在框沿上的前爪(肉爪;边沿基线 y=PERCH_EDGE_Y) ────────────
// 形状:从边沿垂下的圆底小爪,带两道脚趾线(参考 peeking pet 贴纸构图)。
export const PERCH_EDGE_Y = 80;

function PerchPaw({ cx, side, fill }: { cx: number; side: "pl" | "pr"; fill: string }) {
  const y = PERCH_EDGE_Y;
  return (
    <g className={`perch-paw ${side}`} style={{ transformOrigin: `${cx}px ${y}px` }}>
      {/* 腕侧碎毛 */}
      <path d={`M ${cx - 13} ${y + 3} l -4.5 1.5 l 4.5 2.5 z M ${cx + 13} ${y + 3} l 4.5 1.5 l -4.5 2.5 z`} fill={fill} stroke={OUTLINE} strokeWidth="1.5" strokeLinejoin="round" />
      {/* 爪体:底缘四个趾瓣鼓包 */}
      <path
        d={`M ${cx - 13} ${y}
            L ${cx - 13} ${y + 11}
            a 3.25 4.4 0 0 0 6.5 0.6
            a 3.25 5 0 0 0 6.5 0.4
            a 3.25 5 0 0 0 6.5 -0.4
            a 3.25 4.4 0 0 0 6.5 -0.6
            L ${cx + 13} ${y} Z`}
        fill={fill}
        stroke={OUTLINE}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* 趾缝(从趾瓣凹谷向上收) */}
      <path
        d={`M ${cx - 6.6} ${y + 15.6} q -0.5 -3.6 0 -5.6 M ${cx} ${y + 16.6} q -0.4 -3.8 0 -6 M ${cx + 6.6} ${y + 15.6} q 0.5 -3.6 0 -5.6`}
        fill="none"
        stroke={OUTLINE}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </g>
  );
}

// 趴窗共用:颈胸绒毛(尖刺毛缘,底边齐框沿,藏在头后)。
function PerchChest({ fill }: { fill: string }) {
  const y = PERCH_EDGE_Y;
  return (
    <path
      d={`M 25 ${y}
          l 4 -8.5 l 3.5 4.5 l 4.5 -7.5 l 4 5 l 5 -7.5 l 4.5 5 l 5.5 -7 l 5.5 7
          l 4.5 -5 l 5 7.5 l 4 -5 l 4.5 7.5 l 3.5 -4.5 l 4 8.5 z`}
      fill={fill}
      stroke={OUTLINE}
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  );
}

// ── 小柯 · 橘猫 ───────────────────────────────────────────────────────────
function CatHead() {
  return (
    <g className="pet-head" style={{ transformOrigin: "60px 60px" }}>
        <g className="pet-ear-l" style={{ transformOrigin: "44px 22px" }}>
          <path d="M33 27 q-5 -13 -3.6 -21 q0.4 -2 2.2 -0.8 q7.6 5 16.4 10.4 z" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d="M36.5 21.5 q-2.4 -7 -2 -11 q5.6 3.6 10.5 6.8 z" fill="#e8a3ad" />
          {/* 耳口绒毛 */}
          <path d="M37 23 q2.5 -2 5 -1.5 M40.5 25 q2 -1.6 4.2 -1.2" fill="none" stroke="var(--pet-light, #f7dfc0)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g className="pet-ear-r" style={{ transformOrigin: "76px 22px" }}>
          <path d="M87 27 q5 -13 3.6 -21 q-0.4 -2 -2.2 -0.8 q-7.6 5 -16.4 10.4 z" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d="M83.5 21.5 q2.4 -7 2 -11 q-5.6 3.6 -10.5 6.8 z" fill="#e8a3ad" />
          <path d="M83 23 q-2.5 -2 -5 -1.5 M79.5 25 q-2 -1.6 -4.2 -1.2" fill="none" stroke="var(--pet-light, #f7dfc0)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        {/* 颊毛簇(头形之下,撑出毛茸轮廓) */}
        <FurTufts fill="var(--pet-main, #ecb98a)" />
        <ellipse cx="60" cy="46" rx="34" ry="30" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" />
        {/* 额头虎斑纹:中三道 + 两侧各一道 */}
        <g stroke="var(--pet-dark, #d99a62)" strokeWidth="3.4" strokeLinecap="round" fill="none">
          <path d="M54 17.5 q1 5 0 8" />
          <path d="M60 16.6 q1.2 5.4 0 9" />
          <path d="M66 17.5 q-1 5 0 8" />
          <path d="M43 21.5 q1.8 3.8 1.2 6.6" strokeWidth="2.6" />
          <path d="M77 21.5 q-1.8 3.8 -1.2 6.6" strokeWidth="2.6" />
        </g>
        {/* 脸侧斑纹 */}
        <path d="M28.5 38 q4 1 6.5 3.4 M91.5 38 q-4 1 -6.5 3.4" fill="none" stroke="var(--pet-dark, #d99a62)" strokeWidth="2.4" strokeLinecap="round" opacity="0.7" />
        {/* 浅色口吻区 */}
        <path d="M46 54 q4 -6 14 -6 q10 0 14 6 q-2.5 11.5 -14 11.5 q-11.5 0 -14 -11.5z" fill="var(--pet-light, #f7dfc0)" opacity="0.92" />
        <Eyes lidFill="var(--pet-main, #ecb98a)" iris="#7fa052" />
        {/* 鼻:圆角小三角 + 鼻孔 + 高光,鼻梁阴影 */}
        <path d="M60 51.2 q-3.6 0 -3.9 2 q-0.3 1.9 2.2 3.6 q1.2 0.8 1.7 0.8 q0.5 0 1.7 -0.8 q2.5 -1.7 2.2 -3.6 q-0.3 -2 -3.9 -2z" fill="#dd8d97" stroke={OUTLINE} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M58.2 53.4 l-1 1 M61.8 53.4 l1 1" stroke="#a05560" strokeWidth="0.9" strokeLinecap="round" />
        <circle cx="58.6" cy="52.4" r="0.75" fill="#fff" opacity="0.6" />
        <path className="pet-mouth" d="M60 57.6 q-0.8 3.8 -5.4 3.4 M60 57.6 q0.8 3.8 5.4 3.4" fill="none" stroke={OUTLINE} strokeWidth="1.6" strokeLinecap="round" />
        <ellipse className="pet-mouth-talk" style={{ transformOrigin: "60px 61.5px" }} cx="60" cy="61.5" rx="3.6" ry="2.8" fill="#a8503e" />
        {/* 胡须点 + 弧形胡须 */}
        <g fill={OUTLINE} opacity="0.45">
          <circle cx="51" cy="56" r="0.7" /><circle cx="49" cy="58.6" r="0.7" /><circle cx="52" cy="60.8" r="0.7" />
          <circle cx="69" cy="56" r="0.7" /><circle cx="71" cy="58.6" r="0.7" /><circle cx="68" cy="60.8" r="0.7" />
        </g>
        <g stroke={OUTLINE} strokeWidth="1.2" strokeLinecap="round" fill="none" opacity="0.8">
          <path d="M31 46.5 q-9 -2.5 -15 -6" />
          <path d="M30 52 q-10 -0.5 -16 -2" />
          <path d="M31 57.5 q-9 2 -15 5" />
          <path d="M89 46.5 q9 -2.5 15 -6" />
          <path d="M90 52 q10 -0.5 16 -2" />
          <path d="M89 57.5 q9 2 15 5" />
        </g>
        <g className="pet-blush" fill="#e88e96" opacity="0">
          <ellipse cx="36" cy="56" rx="5" ry="3" />
          <ellipse cx="84" cy="56" rx="5" ry="3" />
        </g>
      </g>
  );
}

function CatParts() {
  return (
    <>
      <Accessories />
      <path
        className="pet-tail"
        style={{ transformOrigin: "114px 92px" }}
        d="M114 92 q16 -2 18 -16 q1.2 -8 -5 -11"
        fill="none"
        stroke="var(--pet-dark, #d99a62)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <g className="pet-body" style={{ transformOrigin: "70px 92px" }}>
        <ellipse cx="70" cy="92" rx="46" ry="26" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" />
        <path d="M96 72 q5 7 4 14" fill="none" stroke="var(--pet-dark, #d99a62)" strokeWidth="4" strokeLinecap="round" />
        <path d="M106 78 q3.6 5.4 2.6 10.4" fill="none" stroke="var(--pet-dark, #d99a62)" strokeWidth="4" strokeLinecap="round" />
        <ellipse cx="62" cy="98" rx="24" ry="14" fill="var(--pet-light, #f7dfc0)" />
      </g>
      <g className="pet-paws">
        <ellipse className="paw p1" cx="48" cy="113" rx="10" ry="6" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" />
        <ellipse className="paw p2" cx="76" cy="113" rx="10" ry="6" fill="var(--pet-main, #ecb98a)" stroke={OUTLINE} strokeWidth="2" />
      </g>
      <CatHead />
    </>
  );
}

// 趴窗:胸毛 + 头 + 两只垂搭前爪(头在胸毛上、爪在最前)。
function CatPerch() {
  return (
    <>
      <Accessories />
      <PerchChest fill="var(--pet-light, #f7dfc0)" />
      <CatHead />
      <PerchPaw cx={32} side="pl" fill="var(--pet-main, #ecb98a)" />
      <PerchPaw cx={88} side="pr" fill="var(--pet-main, #ecb98a)" />
    </>
  );
}

// ── 阿柴 · 柴犬 ───────────────────────────────────────────────────────────
function ShibaHead() {
  return (
    <g className="pet-head" style={{ transformOrigin: "60px 60px" }}>
        <g className="pet-ear-l" style={{ transformOrigin: "40px 22px" }}>
          <path d="M29 29 q-3.5 -14 -1.6 -21 q0.5 -1.8 2.3 -0.7 q8.6 5.2 18.3 11.2 z" fill="var(--pet-main, #e3a767)" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d="M33 23.5 q-1.8 -7.5 -1.2 -11 q6 3.7 11 6.9 z" fill="#c9967e" />
          <path d="M34 25 q3 -2 6 -1.6" fill="none" stroke="var(--pet-light, #f8efdd)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g className="pet-ear-r" style={{ transformOrigin: "80px 22px" }}>
          <path d="M91 29 q3.5 -14 1.6 -21 q-0.5 -1.8 -2.3 -0.7 q-8.6 5.2 -18.3 11.2 z" fill="var(--pet-main, #e3a767)" stroke={OUTLINE} strokeWidth="2" strokeLinejoin="round" />
          <path d="M87 23.5 q1.8 -7.5 1.2 -11 q-6 3.7 -11 6.9 z" fill="#c9967e" />
          <path d="M86 25 q-3 -2 -6 -1.6" fill="none" stroke="var(--pet-light, #f8efdd)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <FurTufts fill="var(--pet-main, #e3a767)" />
        {/* 头 + 白色面颊面具 */}
        <ellipse cx="60" cy="46" rx="34" ry="30" fill="var(--pet-main, #e3a767)" stroke={OUTLINE} strokeWidth="2" />
        <path
          d="M30 52 q4 -12 14 -13 q8 -1 16 6 q8 -7 16 -6 q10 1 14 13 q-5 22 -30 22 q-25 0 -30 -22z"
          fill="var(--pet-light, #f8efdd)"
        />
        {/* 面具边缘的碎毛衔接 */}
        <path d="M33 48 q2.5 -1.8 4.5 -1 M83 47 q2.5 -1 4.5 1" fill="none" stroke="var(--pet-light, #f8efdd)" strokeWidth="1.6" strokeLinecap="round" opacity="0.9" />
        {/* 眉点(柴犬标志) */}
        <ellipse cx="44" cy="30.5" rx="3" ry="2.4" fill="var(--pet-light, #f8efdd)" />
        <ellipse cx="76" cy="30.5" rx="3" ry="2.4" fill="var(--pet-light, #f8efdd)" />
        <Eyes lidFill="var(--pet-main, #e3a767)" iris="#8a5a32" />
        {/* 鼻:饱满深色鼻头 + 鼻孔 + 高光 */}
        <path d="M60 50.6 q-4.2 0 -4.5 2.3 q-0.3 2.2 2.5 4 q1.4 0.9 2 0.9 q0.6 0 2 -0.9 q2.8 -1.8 2.5 -4 q-0.3 -2.3 -4.5 -2.3z" fill="#2e2a22" />
        <path d="M57.8 53.3 l-1.1 0.9 M62.2 53.3 l1.1 0.9" stroke="#6b6457" strokeWidth="0.9" strokeLinecap="round" />
        <ellipse cx="58.3" cy="52.2" rx="1.1" ry="0.8" fill="#fff" opacity="0.35" />
        <path className="pet-mouth" d="M60 57.6 q-1 4 -5.8 3.6 M60 57.6 q1 4 5.8 3.6" fill="none" stroke={OUTLINE} strokeWidth="1.6" strokeLinecap="round" />
        {/* 说话时露出小舌头 */}
        <path className="pet-mouth-talk" style={{ transformOrigin: "60px 62px" }} d="M56 60 q4 7 8 0 q-1.6 5.4 -4 5.4 q-2.4 0 -4 -5.4z" fill="#e8848e" />
        {/* 吻部胡须点 */}
        <g fill={OUTLINE} opacity="0.4">
          <circle cx="50.5" cy="57" r="0.7" /><circle cx="49" cy="59.6" r="0.7" />
          <circle cx="69.5" cy="57" r="0.7" /><circle cx="71" cy="59.6" r="0.7" />
        </g>
        <g className="pet-blush" fill="#e8a3a0" opacity="0">
          <ellipse cx="36" cy="56" rx="5" ry="3" />
          <ellipse cx="84" cy="56" rx="5" ry="3" />
        </g>
      </g>
  );
}

function ShibaParts() {
  return (
    <>
      <Accessories />
      {/* 卷尾 */}
      <path
        className="pet-tail"
        style={{ transformOrigin: "110px 86px" }}
        d="M110 88 q14 -4 12 -15 q-1.6 -8.5 -10 -7 q-6 1.2 -4.6 7"
        fill="none"
        stroke="var(--pet-main, #e3a767)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <g className="pet-body" style={{ transformOrigin: "70px 92px" }}>
        <ellipse cx="70" cy="92" rx="46" ry="26" fill="var(--pet-main, #e3a767)" stroke={OUTLINE} strokeWidth="2" />
        <ellipse cx="62" cy="98" rx="26" ry="15" fill="var(--pet-light, #f8efdd)" />
      </g>
      <g className="pet-paws">
        <ellipse className="paw p1" cx="48" cy="113" rx="10" ry="6" fill="var(--pet-light, #f8efdd)" stroke={OUTLINE} strokeWidth="2" />
        <ellipse className="paw p2" cx="76" cy="113" rx="10" ry="6" fill="var(--pet-light, #f8efdd)" stroke={OUTLINE} strokeWidth="2" />
      </g>
      <ShibaHead />
    </>
  );
}

function ShibaPerch() {
  return (
    <>
      <Accessories />
      <PerchChest fill="var(--pet-light, #f8efdd)" />
      <ShibaHead />
      <PerchPaw cx={32} side="pl" fill="var(--pet-light, #f8efdd)" />
      <PerchPaw cx={88} side="pr" fill="var(--pet-light, #f8efdd)" />
    </>
  );
}

// ── 团子 · 兔子 ───────────────────────────────────────────────────────────
function BunnyHead() {
  return (
    <g className="pet-head" style={{ transformOrigin: "60px 60px" }}>
        {/* 长竖耳 */}
        <g className="pet-ear-l" style={{ transformOrigin: "47px 24px" }}>
          <ellipse cx="44" cy="9" rx="8" ry="19" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" transform="rotate(-8 44 9)" />
          <ellipse cx="44.5" cy="10" rx="4" ry="13" fill="#efb9c4" transform="rotate(-8 44.5 10)" />
        </g>
        <g className="pet-ear-r" style={{ transformOrigin: "73px 24px" }}>
          <ellipse cx="76" cy="9" rx="8" ry="19" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" transform="rotate(8 76 9)" />
          <ellipse cx="75.5" cy="10" rx="4" ry="13" fill="#efb9c4" transform="rotate(8 75.5 10)" />
        </g>
        <ellipse cx="60" cy="47" rx="33" ry="29" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" />
        {/* 浅色口吻区 */}
        <path d="M47 55 q4 -5.5 13 -5.5 q9 0 13 5.5 q-2.5 10.5 -13 10.5 q-10.5 0 -13 -10.5z" fill="var(--pet-light, #fffaf2)" opacity="0.95" />
        <Eyes lidFill="var(--pet-main, #f3ece1)" iris="#9c6a4a" />
        {/* 粉鼻 + 高光 */}
        <path d="M60 51.6 q-3 0 -3.2 1.7 q-0.2 1.6 1.9 3 q0.9 0.6 1.3 0.6 q0.4 0 1.3 -0.6 q2.1 -1.4 1.9 -3 q-0.2 -1.7 -3.2 -1.7z" fill="#e8a3b2" stroke={OUTLINE} strokeWidth="1.3" strokeLinejoin="round" />
        <circle cx="58.9" cy="52.7" r="0.6" fill="#fff" opacity="0.6" />
        <path className="pet-mouth" d="M60 56.5 q-1 3.5 -5 3.2 M60 56.5 q1 3.5 5 3.2 M57.5 59.4 h5 v3.4 a2.5 2.5 0 0 1 -5 0 z" fill="#fff" stroke={OUTLINE} strokeWidth="1.4" strokeLinecap="round" />
        <ellipse className="pet-mouth-talk" style={{ transformOrigin: "60px 61px" }} cx="60" cy="61" rx="3.4" ry="2.6" fill="#c96a74" />
        {/* 颊须点 */}
        <g fill={OUTLINE} opacity="0.6">
          <circle cx="34" cy="50" r="1" />
          <circle cx="31" cy="54" r="1" />
          <circle cx="86" cy="50" r="1" />
          <circle cx="89" cy="54" r="1" />
        </g>
        <g className="pet-blush" fill="#efb9c4" opacity="0">
          <ellipse cx="36" cy="55" rx="5" ry="3" />
          <ellipse cx="84" cy="55" rx="5" ry="3" />
        </g>
      </g>
  );
}

function BunnyParts() {
  return (
    <>
      <Accessories />
      {/* 圆球尾(轻摆) */}
      <circle
        className="pet-tail"
        style={{ transformOrigin: "110px 96px" }}
        cx="112"
        cy="94"
        r="8.5"
        fill="var(--pet-light, #fbf6ec)"
        stroke={OUTLINE}
        strokeWidth="2"
      />
      <g className="pet-body" style={{ transformOrigin: "70px 92px" }}>
        <ellipse cx="70" cy="93" rx="44" ry="25" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" />
        <ellipse cx="62" cy="99" rx="23" ry="13" fill="var(--pet-light, #fffaf2)" />
      </g>
      <g className="pet-paws">
        <ellipse className="paw p1" cx="48" cy="113" rx="10" ry="6" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" />
        <ellipse className="paw p2" cx="76" cy="113" rx="10" ry="6" fill="var(--pet-main, #f3ece1)" stroke={OUTLINE} strokeWidth="2" />
      </g>
      <BunnyHead />
    </>
  );
}

function BunnyPerch() {
  return (
    <>
      <Accessories />
      <PerchChest fill="var(--pet-light, #fffaf2)" />
      <BunnyHead />
      <PerchPaw cx={32} side="pl" fill="var(--pet-main, #f3ece1)" />
      <PerchPaw cx={88} side="pr" fill="var(--pet-main, #f3ece1)" />
    </>
  );
}

// ── 比特 · 机器人 ─────────────────────────────────────────────────────────
function RobotHead() {
  return (
    <g className="pet-head" style={{ transformOrigin: "60px 60px" }}>
        {/* 天线(耳朵动画挂在天线上) */}
        <g className="pet-ear-l" style={{ transformOrigin: "60px 18px" }}>
          <path d="M60 18 v-9" stroke={OUTLINE} strokeWidth="2.4" strokeLinecap="round" />
          <circle className="pet-antenna" cx="60" cy="6.5" r="3.4" fill="var(--accent, #c96442)" />
        </g>
        {/* 侧面螺栓 */}
        <g className="pet-ear-r" style={{ transformOrigin: "60px 40px" }}>
          <rect x="20" y="36" width="7" height="12" rx="3" fill="var(--pet-dark, #b8b2a3)" stroke={OUTLINE} strokeWidth="1.8" />
          <rect x="93" y="36" width="7" height="12" rx="3" fill="var(--pet-dark, #b8b2a3)" stroke={OUTLINE} strokeWidth="1.8" />
        </g>
        {/* 方头 + 屏幕脸(扫描线 + 四角铆钉) */}
        <rect x="26" y="18" width="68" height="48" rx="13" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
        <rect x="33" y="25" width="54" height="34" rx="9" fill="#3a352b" />
        <path d="M35 31 h50 M35 36 h50" stroke="#4a443a" strokeWidth="0.8" opacity="0.6" />
        <g fill="var(--pet-dark, #b8b2a3)" stroke={OUTLINE} strokeWidth="0.8">
          <circle cx="31.5" cy="23.5" r="1.3" /><circle cx="88.5" cy="23.5" r="1.3" />
          <circle cx="31.5" cy="60.5" r="1.3" /><circle cx="88.5" cy="60.5" r="1.3" />
        </g>
        <Eyes lidFill="#3a352b" iris="#6fd6a8" />
        <path className="pet-mouth" d="M52 55.5 h16" stroke="#9be8c4" strokeWidth="2.2" strokeLinecap="round" fill="none" />
        <rect className="pet-mouth-talk" style={{ transformOrigin: "60px 55.5px" }} x="53" y="52.5" width="14" height="6" rx="2" fill="#9be8c4" />
        <g className="pet-blush" fill="#e8848e" opacity="0">
          <ellipse cx="40" cy="52" rx="4" ry="2.4" />
          <ellipse cx="80" cy="52" rx="4" ry="2.4" />
        </g>
      </g>
  );
}

function RobotParts() {
  return (
    <>
      <Accessories />
      {/* 尾部弹簧线 */}
      <path
        className="pet-tail"
        style={{ transformOrigin: "108px 90px" }}
        d="M108 90 q8 -1 9 -7 q1 -5 -4 -6 q-4 -0.8 -5 3 q-0.7 3 2.4 3.6"
        fill="none"
        stroke="var(--pet-dark, #8e887a)"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <g className="pet-body" style={{ transformOrigin: "70px 92px" }}>
        <rect x="32" y="72" width="76" height="40" rx="12" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
        <rect x="42" y="80" width="56" height="24" rx="7" fill="var(--pet-light, #efe9da)" />
        {/* 胸口指示灯 */}
        <circle cx="58" cy="92" r="3.4" fill="var(--accent, #c96442)" />
        <rect x="66" y="89" width="18" height="6" rx="3" fill="var(--pet-dark, #b8b2a3)" />
      </g>
      <g className="pet-paws">
        <rect className="paw p1" x="40" y="108" width="18" height="9" rx="4" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
        <rect className="paw p2" x="68" y="108" width="18" height="9" rx="4" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
      </g>
      <RobotHead />
    </>
  );
}

// 趴窗:颈柱 + 头 + 机械夹爪(直角风格,区别于肉爪)。
function RobotPerch() {
  const y = PERCH_EDGE_Y;
  return (
    <>
      <Accessories />
      {/* 颈柱补上头与框沿之间的空隙 */}
      <rect x="48" y="60" width="24" height={y - 60} fill="var(--pet-dark, #b8b2a3)" stroke={OUTLINE} strokeWidth="2" />
      <RobotHead />
      <g className="perch-paw pl" style={{ transformOrigin: `32px ${y}px` }}>
        <rect x="20" y={y} width="24" height="15" rx="5" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
        <path d={`M 32 ${y + 6} v 6`} stroke={OUTLINE} strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <g className="perch-paw pr" style={{ transformOrigin: `88px ${y}px` }}>
        <rect x="76" y={y} width="24" height="15" rx="5" fill="var(--pet-main, #cfc9bb)" stroke={OUTLINE} strokeWidth="2" />
        <path d={`M 88 ${y + 6} v 6`} stroke={OUTLINE} strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </>
  );
}

export interface PetDesign {
  name: string;
  desc: string;
  Parts: () => ReactNode;
  /** 趴窗(perch)专属造型:头 + 搭在框沿的前爪,身子不显示。 */
  Perch: () => ReactNode;
}

export const PET_DESIGNS: Record<PetKind, PetDesign> = {
  cat: { name: "小柯", desc: "橘猫", Parts: CatParts, Perch: CatPerch },
  shiba: { name: "阿柴", desc: "柴犬", Parts: ShibaParts, Perch: ShibaPerch },
  bunny: { name: "团子", desc: "兔子", Parts: BunnyParts, Perch: BunnyPerch },
  robot: { name: "比特", desc: "机器人", Parts: RobotParts, Perch: RobotPerch },
};

export const PET_KIND_KEY = "cortex_pet_kind";

export function loadPetKind(): PetKind {
  try {
    const k = localStorage.getItem(PET_KIND_KEY);
    if (k && k in PET_DESIGNS) return k as PetKind;
  } catch {
    /* 忽略 */
  }
  return "cat";
}

// ── 自定义配色:由主色派生深(轮廓纹路)/浅(肚皮面板)两档,生成 CSS 变量 ──────
// 造型 SVG 的主题色都写成 var(--pet-main|dark|light, 各自默认色),
// 不设变量时回落到造型原配色;设置后三档统一跟随用户主色。

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  let c = m[1];
  if (c.length === 3) c = c.replace(/./g, (ch) => ch + ch);
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 由主色生成宠物三档配色的 CSS 变量;hex 无效时返回 null。 */
export function petColorVars(hex: string): Record<string, string> | null {
  const hsl = hexToHsl(hex);
  if (!hsl) return null;
  const [h, s, l] = hsl;
  return {
    "--pet-main": hslToHex(h, s, l),
    "--pet-dark": hslToHex(h, Math.min(100, s * 1.08), l * 0.76),
    "--pet-light": hslToHex(h, s * 0.55, l + (100 - l) * 0.62),
  };
}

// ── 尺寸 / 颜色持久化(沿用 PET_KIND_KEY 的 views 层 localStorage 模式) ────

export const PET_SIZE_KEY = "cortex_pet_size";
export const PET_COLOR_KEY = "cortex_pet_color";
export const PET_SIZE_MIN = 0.8;
export const PET_SIZE_MAX = 2;

export function loadPetSize(): number {
  try {
    const v = Number(localStorage.getItem(PET_SIZE_KEY));
    if (Number.isFinite(v) && v >= PET_SIZE_MIN && v <= PET_SIZE_MAX) return v;
  } catch {
    /* 忽略 */
  }
  return 1;
}

export function loadPetColor(): string | null {
  try {
    const c = localStorage.getItem(PET_COLOR_KEY);
    if (c && petColorVars(c)) return c;
  } catch {
    /* 忽略 */
  }
  return null;
}
