// CORTEX-PATCH: 浏览器侧网络总开关。更新能力已移除,这里只约束在线协作。
//
// Cortex Desktop 里这个开关**恒为开(离线)**,不再读用户偏好。理由:
//   1. 本产品的 deck 是本地工作区里的单文件、AI 经磁盘写入,在线协作没有任何用处;
//   2. 上游会给「没有 collab 字段」的文档自动铸造凭据并连公共中继,此后每次打开都全量重放
//      房间历史,CRDT 的并集合并把历史世代的元素叠回当前页 —— 这正是用户实测的「新旧内容
//      重贴在一起」,顺带还把 deck 内容推给第三方;
//   3. 主防线是「不建 SyncSession」(见 src/cortex/no-sync.ts),但那依赖 session 的形状。
//      这里在**发起网络调用的最后一道门**上恒定返回 true:即使将来某次上游合并把 SyncSession
//      接回来,也不会静默恢复出站连接。判定不读 localStorage,因此也不受宿主 shim 注入时机
//      (dom-ready 晚于 boot)的影响。
export const offlineEnabled = (): boolean => true

// 写入能力保留:宿主 shim 也会写这个偏好(多一道纵深防御),文档属性面板的勾选框仍绑定它。
// 注意该勾选框此刻只反映偏好本身,不再影响 offlineEnabled() 的判定。
export const setOffline = (on: boolean): void => {
  try {
    localStorage.setItem('bento-offline', on ? 'on' : 'off')
  } catch {
    /* storage unavailable */
  }
}
