// 静态资产 import 的环境类型声明(供 pet sprite sheet 等使用)。
// Vite(desktop)/ vitest 对资产 import 返回字符串 URL,这里以字符串近似。
// Next(web)对位图返回 { src,... } 对象,运行时由 sprites.ts 的 assetUrl() 归一化。
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
