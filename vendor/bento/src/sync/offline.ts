// CORTEX-PATCH: 浏览器侧网络总开关。更新能力已移除,这里只约束在线协作。
export const offlineEnabled = (): boolean => {
  try {
    return localStorage.getItem('bento-offline') === 'on'
  } catch {
    return false
  }
}

export const setOffline = (on: boolean): void => {
  try {
    localStorage.setItem('bento-offline', on ? 'on' : 'off')
  } catch {
    /* storage unavailable */
  }
}
