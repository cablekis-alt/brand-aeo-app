// 렌더러(React)와 안전하게 통신하기 위한 preload.
// contextIsolation=true 하에서 window.electron으로 최소 API만 노출한다.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  // 자동 업데이트
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  quitAndInstall: () => ipcRenderer.invoke('update:quitAndInstall'),
  onUpdateStatus: (cb) => {
    const listener = (_e, status) => cb(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  // API 키 설정
  apiKeyStatus: () => ipcRenderer.invoke('settings:apiKeyStatus'),
  setApiKey: (name, value) => ipcRenderer.invoke('settings:setApiKey', { name, value }),
})
