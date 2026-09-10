// utilityProcess 진입점 — 번들된 Express 서버(dist-electron/server.cjs)를 별도 프로세스에서 띄운다.
//
// 왜 별도 프로세스인가: 예전에는 메인 프로세스가 이 번들을 그대로 require해서 서버가 메인과
// 이벤트 루프를 공유했다. 측정 한 건이 수집 8병렬 + 판정 8병렬로 60~140초 동안 루프를 포화시키면
// 메인 프로세스가 창 입력을 처리하지 못하고, 네이티브 <select> 팝업은 메인이 그리기 때문에
// "브랜드 드롭다운을 눌러도 안 눌리는" 상태가 측정이 끝날 때까지 이어졌다.
//
// 메인에서 오는 메시지:
//   { type: 'set-env', name, value } — 앱에서 API 키를 바꿨을 때. 프로세스가 분리되면서
//   메인의 process.env 변경이 서버에 자동 전파되지 않으므로 명시적으로 받아 반영한다.
const path = require('node:path')

const ALLOWED_ENV = new Set([
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PERPLEXITY_API_KEY',
  'JUDGE_ENGINE',
  'COLLECT_ENGINES',
])

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    const msg = event?.data
    if (!msg || msg.type !== 'set-env') return
    // 이름을 화이트리스트로 제한한다 — 메시지로 임의의 환경변수(PATH 등)를 바꾸지 못하게.
    if (typeof msg.name !== 'string' || !ALLOWED_ENV.has(msg.name)) return
    const value = typeof msg.value === 'string' ? msg.value.trim() : ''
    if (value) process.env[msg.name] = value
    else delete process.env[msg.name]
    // 값은 절대 로그에 남기지 않는다(키).
    console.log(`[server] 환경변수 갱신: ${msg.name} ${value ? '설정' : '해제'}`)
  })
}

require(path.join(__dirname, '..', 'dist-electron', 'server.cjs')) // app.listen 실행
