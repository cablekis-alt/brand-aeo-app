// 렌더러(React)와 안전하게 통신하기 위한 최소 preload.
// contextIsolation=true 하에서 window.electron으로 몇 가지 정보만 노출한다.
// 지금은 스캐폴딩이라 최소한만 — 이후 로컬 측정 트리거·파일 경로 열기 등을 여기에 추가한다.

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
})
