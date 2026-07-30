// 生物荧光水母 = Cortex 的视觉化身（蓝紫渐变 + 发光）。纯 SVG + 内联 <style>，无 hooks、
// 不接数据，可直接复用于落地页 Hero。移植自营销站 site/components/Jellyfish.tsx，配色独立于
// UI accent。动效（伞盖漂浮 / 光晕呼吸 / 触手错峰摆动 / 神经元光点闪烁）在 prefers-reduced-motion
// 下自动静默。外层用 className 控制尺寸。
export function Jellyfish({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      // viewBox 裁到内容实际包围盒(halo x15–425 / y45–556),去掉四周死空白,
      // 让外层 className 给的尺寸真正落在水母本体上;预留触手摆动溢出空间
      viewBox="15 40 410 516"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      // 让根元素可被外层 className 控制尺寸；预留触手摆动溢出空间
      style={{ overflow: "visible" }}
    >
      <defs>
        {/* 伞盖主体：蓝→紫渐变 */}
        <linearGradient id="jf-bell" x1="0.12" y1="0" x2="0.86" y2="1">
          <stop offset="0%" stopColor="#8fd2ff" />
          <stop offset="42%" stopColor="#6a8bff" />
          <stop offset="78%" stopColor="#9a6bff" />
          <stop offset="100%" stopColor="#b46bff" />
        </linearGradient>

        {/* 顶部玻璃高光：从伞顶亮白向下淡出，制造体积与玻璃感 */}
        <radialGradient id="jf-gloss" cx="0.42" cy="0.22" r="0.62">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="34%" stopColor="#d8f0ff" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#d8f0ff" stopOpacity="0" />
        </radialGradient>

        {/* 内层伞腔：底部更深的紫，叠在主体上压暗下缘、抬高顶部光感 */}
        <linearGradient id="jf-inner" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#bfe6ff" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#6a8bff" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#b46bff" stopOpacity="0.55" />
        </linearGradient>

        {/* 最外圈柔和光晕（halo） */}
        <radialGradient id="jf-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#5b8cff" stopOpacity="0.55" />
          <stop offset="42%" stopColor="#8b5cf6" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>

        {/* 触手渐变：上承伞盖紫、向末端收细并淡出 */}
        <linearGradient id="jf-tentacle" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#9a6bff" stopOpacity="0.92" />
          <stop offset="55%" stopColor="#7b78ff" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#36c8dc" stopOpacity="0.12" />
        </linearGradient>

        {/* 口腕（粗触手）渐变：更靓的青蓝 */}
        <linearGradient id="jf-arm" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#8fd2ff" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#6a8bff" stopOpacity="0.62" />
          <stop offset="100%" stopColor="#36c8dc" stopOpacity="0.1" />
        </linearGradient>

        {/* 发光描边渐变：边缘更亮的青白光 */}
        <linearGradient id="jf-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#cdeeff" />
          <stop offset="60%" stopColor="#a9c6ff" />
          <stop offset="100%" stopColor="#d6b6ff" />
        </linearGradient>

        {/* 光点辉光滤镜（神经元放电意象） */}
        <filter id="jf-spark" x="-180%" y="-180%" width="460%" height="460%">
          <feGaussianBlur stdDeviation="2.1" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* 伞盖整体柔化辉光 */}
        <filter id="jf-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="0.6" />
        </filter>
      </defs>

      <style>{`
        .jf-float { transform-box: fill-box; transform-origin: center; animation: jfFloat 6.5s var(--ease, cubic-bezier(.2,.7,.2,1)) infinite; }
        .jf-halo  { transform-box: fill-box; transform-origin: center; animation: jfHalo 5.5s ease-in-out infinite; }
        /* 伞盖游动脉搏:横向微扩、纵向微缩,原点定在伞盖下缘,模拟水母收缩推进 */
        .jf-pulse { transform-box: fill-box; transform-origin: 50% 92%; animation: jfPulse 3.2s ease-in-out infinite; }
        /* 触手分组错峰摆动(幅度放大,小尺寸渲染下也要肉眼可见) */
        .jf-sway-a { transform-box: fill-box; transform-origin: 220px 250px; animation: jfSwayA 6s ease-in-out infinite; }
        .jf-sway-b { transform-box: fill-box; transform-origin: 220px 250px; animation: jfSwayB 7.6s ease-in-out infinite; }
        .jf-sway-c { transform-box: fill-box; transform-origin: 220px 250px; animation: jfSwayC 9.4s ease-in-out infinite; }
        /* 神经元光点呼吸 / 闪烁，错峰 */
        .jf-spark { transform-box: fill-box; transform-origin: center; }
        .jf-spark.s1 { animation: jfSparkle 3.4s ease-in-out infinite; }
        .jf-spark.s2 { animation: jfSparkle 4.2s ease-in-out .6s infinite; }
        .jf-spark.s3 { animation: jfSparkle 2.8s ease-in-out 1.1s infinite; }
        .jf-spark.s4 { animation: jfSparkle 3.9s ease-in-out 1.8s infinite; }
        .jf-spark.s5 { animation: jfSparkle 3.1s ease-in-out .3s infinite; }
        .jf-spark.s6 { animation: jfSparkle 4.6s ease-in-out 2.2s infinite; }

        @keyframes jfFloat {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50%      { transform: translateY(-26px) rotate(1.2deg); }
        }
        @keyframes jfHalo {
          0%, 100% { transform: scale(1);    opacity: .66; }
          50%      { transform: scale(1.12); opacity: 1; }
        }
        @keyframes jfPulse {
          0%, 100% { transform: scale(1, 1); }
          50%      { transform: scale(1.045, .955); }
        }
        @keyframes jfSwayA {
          0%, 100% { transform: rotate(-5deg); }
          50%      { transform: rotate(5deg); }
        }
        @keyframes jfSwayB {
          0%, 100% { transform: rotate(4.2deg); }
          50%      { transform: rotate(-4.6deg); }
        }
        @keyframes jfSwayC {
          0%, 100% { transform: rotate(-3deg); }
          50%      { transform: rotate(3.6deg); }
        }
        @keyframes jfSparkle {
          0%, 100% { opacity: .15; transform: scale(.65); }
          50%      { opacity: 1;   transform: scale(1.3); }
        }

        @media (prefers-reduced-motion: reduce) {
          .jf-float, .jf-halo, .jf-pulse, .jf-sway-a, .jf-sway-b, .jf-sway-c,
          .jf-spark.s1, .jf-spark.s2, .jf-spark.s3,
          .jf-spark.s4, .jf-spark.s5, .jf-spark.s6 {
            animation: none !important;
          }
        }
      `}</style>

      {/* —— 最外层柔和光晕 —— */}
      <circle className="jf-halo" cx="220" cy="250" r="205" fill="url(#jf-halo)" />

      {/* 整体随水流缓慢漂浮 */}
      <g className="jf-float">
        {/* —— 触手（先画，叠在伞盖之下）—— */}
        {/* C 组：最外侧细丝，最慢 */}
        <g className="jf-sway-c">
          <path
            d="M118 262 C 104 330, 132 372, 110 442 C 98 478, 120 506, 108 540"
            fill="none"
            stroke="url(#jf-tentacle)"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
          <path
            d="M322 262 C 338 332, 312 374, 334 444 C 346 480, 324 508, 336 542"
            fill="none"
            stroke="url(#jf-tentacle)"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
        </g>

        {/* B 组：中间偏外，中速 */}
        <g className="jf-sway-b">
          <path
            d="M158 272 C 150 336, 172 380, 152 452 C 142 488, 162 512, 150 546"
            fill="none"
            stroke="url(#jf-tentacle)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <path
            d="M282 272 C 292 338, 268 382, 290 454 C 300 490, 280 514, 292 548"
            fill="none"
            stroke="url(#jf-tentacle)"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>

        {/* A 组：中央粗口腕（带状），最快、幅度最大 */}
        <g className="jf-sway-a">
          {/* 左口腕：用带宽的填充形塑造「粗→细」收尾 */}
          <path
            d="M196 278
               C 188 348, 206 392, 190 470
               C 184 506, 198 532, 192 552
               C 200 532, 214 508, 210 470
               C 218 392, 210 348, 218 280 Z"
            fill="url(#jf-arm)"
          />
          {/* 中口腕 */}
          <path
            d="M222 282
               C 222 356, 234 404, 224 482
               C 220 518, 230 540, 226 556
               C 234 540, 246 516, 244 480
               C 252 404, 244 356, 246 282 Z"
            fill="url(#jf-arm)"
          />
          {/* 右口腕 */}
          <path
            d="M246 280
               C 254 348, 240 392, 256 470
               C 262 506, 250 532, 256 552
               C 248 532, 234 508, 238 470
               C 230 392, 238 348, 230 280 Z"
            fill="url(#jf-arm)"
          />
        </g>

        {/* —— 半透明伞盖（bell）：随 jf-pulse 做收缩推进的游动脉搏 —— */}
        <g className="jf-pulse" filter="url(#jf-soft)">
          {/* 伞盖主体：蓝→紫渐变 */}
          <path
            d="M70 252
               C 70 150, 138 86, 220 86
               C 302 86, 370 150, 370 252
               C 370 268, 360 280, 344 280
               C 332 268, 322 276, 312 286
               C 300 274, 288 282, 278 292
               C 266 280, 252 286, 244 296
               C 232 282, 208 282, 196 296
               C 188 286, 174 280, 162 292
               C 152 282, 140 274, 128 286
               C 118 276, 108 268, 96 280
               C 80 280, 70 268, 70 252 Z"
            fill="url(#jf-bell)"
          />

          {/* 内层伞腔：压暗下缘、抬亮顶部，制造体积 */}
          <path
            d="M70 252
               C 70 150, 138 86, 220 86
               C 302 86, 370 150, 370 252
               C 370 268, 360 280, 344 280
               C 332 268, 322 276, 312 286
               C 300 274, 288 282, 278 292
               C 266 280, 252 286, 244 296
               C 232 282, 208 282, 196 296
               C 188 286, 174 280, 162 292
               C 152 282, 140 274, 128 286
               C 118 276, 108 268, 96 280
               C 80 280, 70 268, 70 252 Z"
            fill="url(#jf-inner)"
          />

          {/* 顶部玻璃高光 */}
          <path
            d="M70 252
               C 70 150, 138 86, 220 86
               C 302 86, 370 150, 370 252 Z"
            fill="url(#jf-gloss)"
          />

          {/* 内缘暗弧：勾出伞腔内壁的厚度 */}
          <path
            d="M104 244
               C 104 176, 156 128, 220 128
               C 284 128, 336 176, 336 244"
            fill="none"
            stroke="#3a2c66"
            strokeOpacity="0.16"
            strokeWidth="2"
          />

          {/* 边缘更亮的发光描边 */}
          <path
            d="M70 252
               C 70 150, 138 86, 220 86
               C 302 86, 370 150, 370 252
               C 370 268, 360 280, 344 280
               C 332 268, 322 276, 312 286
               C 300 274, 288 282, 278 292
               C 266 280, 252 286, 244 296
               C 232 282, 208 282, 196 296
               C 188 286, 174 280, 162 292
               C 152 282, 140 274, 128 286
               C 118 276, 108 268, 96 280
               C 80 280, 70 268, 70 252 Z"
            fill="none"
            stroke="url(#jf-rim)"
            strokeOpacity="0.9"
            strokeWidth="2.4"
          />

          {/* 一道细长竖向高光，强化玻璃曲面 */}
          <path
            d="M150 124 C 132 168, 128 214, 138 262"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.5"
            strokeWidth="6"
            strokeLinecap="round"
          />
        </g>

        {/* —— 伞盖上的神经元光点（白/青），部分错峰呼吸 —— */}
        <g>
          {/* 静态细点：底纹星点（不闪，营造密度） */}
          <circle cx="178" cy="150" r="2" fill="#eaf6ff" opacity="0.85" />
          <circle cx="262" cy="142" r="1.8" fill="#eaf6ff" opacity="0.8" />
          <circle cx="208" cy="118" r="1.6" fill="#ffffff" opacity="0.9" />
          <circle cx="298" cy="186" r="2" fill="#d7ecff" opacity="0.75" />
          <circle cx="140" cy="196" r="1.8" fill="#d7ecff" opacity="0.7" />
          <circle cx="236" cy="170" r="1.5" fill="#ffffff" opacity="0.85" />
          <circle cx="320" cy="222" r="1.6" fill="#cfe6ff" opacity="0.7" />
          <circle cx="120" cy="226" r="1.5" fill="#cfe6ff" opacity="0.65" />
          <circle cx="190" cy="216" r="1.5" fill="#eaf6ff" opacity="0.7" />

          {/* 放电光点：错峰闪烁（神经元意象），带辉光 */}
          <g filter="url(#jf-spark)">
            <circle className="jf-spark s1" cx="196" cy="166" r="4.4" fill="#ffffff" />
            <circle className="jf-spark s2" cx="252" cy="200" r="4" fill="#bfe9ff" />
            <circle className="jf-spark s3" cx="160" cy="160" r="3.4" fill="#a9f0ff" />
            <circle className="jf-spark s4" cx="288" cy="148" r="3.8" fill="#ffffff" />
            <circle className="jf-spark s5" cx="224" cy="208" r="3.2" fill="#cfe0ff" />
            <circle className="jf-spark s6" cx="172" cy="224" r="3" fill="#a9f0ff" />
          </g>
        </g>
      </g>
    </svg>
  );
}
