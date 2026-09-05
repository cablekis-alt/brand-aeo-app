// electron-builder afterAllArtifactBuild 훅.
// NSIS 설치본(.exe)을 ZIP으로 감싼 "설치본 ZIP"을 자동 생성한다.
// 브라우저/SmartScreen이 .exe 직접 다운로드를 막을 때, 사용자가 ZIP으로 받아 풀어 실행하게 하기 위함.
// (Windows 패키징 전용 — PowerShell Compress-Archive 사용)

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

module.exports = async function afterAllArtifactBuild(context) {
  const exe = (context.artifactPaths || []).find(
    (p) => p.toLowerCase().endsWith('.exe') && !p.toLowerCase().endsWith('.blockmap'),
  )
  if (!exe || !fs.existsSync(exe)) return [] // 설치본 exe가 없으면(예: --dir) 건너뜀

  const zip = exe.replace(/-x64\.exe$/i, '-installer.zip')
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path "${exe}" -DestinationPath "${zip}" -Force`],
      { stdio: 'inherit' },
    )
    console.log('[afterAllArtifactBuild] 설치본 ZIP 생성:', zip)
    return [zip] // electron-builder 아티팩트 목록에 추가(→ 릴리스 업로드 대상)
  } catch (err) {
    console.warn('[afterAllArtifactBuild] 설치본 ZIP 생성 실패:', err instanceof Error ? err.message : err)
    return []
  }
}
