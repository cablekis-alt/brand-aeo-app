// 패키징 전(前) 실행: 빌드 머신의 로컬 .env에서 화이트리스트 키만 뽑아
// electron/build/bundled.env 로 굽는다. 이 파일은 설치본 리소스로 동봉되어,
// 설치한 앱이 "기본 API 키"를 이미 가진 상태로 동작한다(머신마다 수동 입력 불필요).
//
// 보안:
//  - .env / bundled.env 는 gitignore 됨 — 공개 저장소 소스에는 절대 키가 없다.
//  - 단, 굽힌 키는 배포 설치본 안에 들어간다. 공개 릴리스로 배포하면 내려받은 누구나
//    설치본에서 키를 추출할 수 있으므로, 내부 배포에만 사용하거나 사용량 제한을 두라.
//  - 로컬 .env에 키가 없으면 빈(주석만) bundled.env를 만들어 동작을 그대로 둔다.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WHITELIST = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
const OUT = join('electron', 'build', 'bundled.env')

function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

let source = {}
try {
  source = parseEnv(readFileSync('.env', 'utf8'))
} catch {
  console.warn('[prepare-bundled-env] 로컬 .env 없음 — 기본 키 없이 빌드합니다.')
}

const lines = ['# 설치본 동봉 기본 API 키 (빌드 시 자동 생성 — 커밋 금지). 사용자 .env가 있으면 그쪽이 우선.']
let baked = 0
for (const name of WHITELIST) {
  const v = source[name]
  if (v) {
    lines.push(`${name}=${v}`)
    baked++
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')

if (baked > 0) {
  console.log(
    `[prepare-bundled-env] ${OUT} 생성 — 기본 키 ${baked}개 동봉.\n` +
      '  ⚠ 이 설치본을 공개 배포하면 다운로드한 누구나 키를 추출할 수 있습니다(내부 배포/사용량 제한 권장).',
  )
} else {
  console.log(`[prepare-bundled-env] ${OUT} 생성 — 동봉할 기본 키 없음(사용자가 앱에서 입력).`)
}
