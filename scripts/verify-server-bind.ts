/**
 * 로컬 서버(server/index.ts)가 이 PC 안(루프백)에서만 접속을 받는지 확인한다. 임시 데이터 폴더 · 모의 엔진으로 서버를 띄우고
 * 주소마다 연결해 본다. AI는 부르지 않는다.
 *
 * 왜: 이 서버에는 인증이 없다. 모든 네트워크 인터페이스에서 받으면 같은 와이파이의 다른 기기가 브랜드 데이터 · 측정 실행 ·
 * 페이지 수집 프록시(/api/fetch)에 닿는다. 앱 창 · 개발용 프록시 · 스크립트는 모두 localhost로 부르므로 루프백이면 충분하다.
 * localhost가 IPv6(::1)로 먼저 풀리는 환경(윈도우)이 있어 ::1에서도 받아야 한다.
 *
 *   npx tsx scripts/verify-server-bind.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

/** 그 주소 · 포트에 TCP 연결이 되는가. */
const reachable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = net.connect({ host, port })
    const done = (v: boolean) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(1500)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })

/** 이 PC가 IPv6 루프백(::1)을 쓸 수 있는가 — 잠깐 열어 본다. */
const ipv6Loopback = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(0, '::1', () => srv.close(() => resolve(true)))
  })

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })

const dir = mkdtempSync(path.join(tmpdir(), 'verify-server-bind-'))
const port = await freePort()
const lan = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && !a.internal && a.family === 'IPv4')?.address
const env = { ...process.env, APP_DATA_DIR: dir, PORT: String(port), USE_MOCK_ENGINES: 'true', BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: '', PIPELINE_CRON: '', GH_MEASURE_TOKEN: '' }
delete env.AEO_SERVER_HOST
// PC 전체에 흔한 이름의 HOST가 있어도(다른 개발 도구용) 서버는 읽지 않는다 — 아래 확인은 모두 HOST=0.0.0.0이 깔린 채로 돈다.
env.HOST = '0.0.0.0'
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })

try {
  let up = false
  for (let i = 0; i < 60 && !up; i += 1) {
    up = await reachable('127.0.0.1', port)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('IPv4 루프백(127.0.0.1)에서 받는다', up)
  if (await ipv6Loopback()) ok('IPv6 루프백(::1)에서도 받는다 — localhost가 ::1로 풀려도 열린다', await reachable('::1', port))
  else console.log('· 이 PC는 IPv6 루프백이 없어 ::1 확인을 건너뜁니다')
  const health = await fetch(`http://localhost:${port}/health`).then((r) => r.ok, () => false)
  ok('localhost로 부르면 응답한다(앱 창 · 개발용 프록시와 같은 주소)', health)
  if (lan) ok(`이 PC의 네트워크 주소(${lan})로는 받지 않는다 — 흔한 이름의 HOST=0.0.0.0은 읽지 않는다`, !(await reachable(lan, port)))
  else console.log('· 루프백이 아닌 IPv4 주소가 없어 바깥 주소 확인을 건너뜁니다')
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 500))
}

// AEO_SERVER_HOST로 일부러 연 경우 — 그 주소에서 받는다(다른 기기에서 쓰려는 사람의 탈출구)
if (lan) {
  const openPort = await freePort()
  const open = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...env, PORT: String(openPort), AEO_SERVER_HOST: '0.0.0.0' },
    stdio: 'ignore',
  })
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i += 1) {
      up = await reachable('127.0.0.1', openPort)
      if (!up) await new Promise((r) => setTimeout(r, 500))
    }
    ok(`AEO_SERVER_HOST=0.0.0.0이면 네트워크 주소(${lan})에서도 받는다`, up && (await reachable(lan, openPort)))
  } finally {
    open.kill()
    await new Promise((r) => setTimeout(r, 500))
  }
}
// 이미 다른 프로그램이 그 포트를 잡고 있으면 열지 않고 멈춘다 — 윈도우는 모든 인터페이스에 연 포트에도 127.0.0.1로 또 열게 해 줘서,
// 그대로 열면 루프백 접속을 조용히 가로챈다(예전 설치본이 4000을 잡고 있을 때 개발 서버를 띄우는 경우).
const startOn = (holderHost: string | undefined) =>
  new Promise<{ code: number | null; holderAnswers: boolean }>((resolve, reject) => {
    const holder = net.createServer((sock) => {
      // 서버의 연결 확인(portAnswers)은 붙자마자 끊는다 — 그 끊김(ECONNRESET)만 정상이다.
      sock.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ECONNRESET') throw e
      })
      sock.end('HOLDER')
    })
    holder.once('error', reject)
    const listening = () => {
      const heldPort = (holder.address() as net.AddressInfo).port
      const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: { ...env, PORT: String(heldPort) }, stdio: 'ignore' })
      const timer = setTimeout(() => child.kill(), 30_000)
      child.once('exit', async (code) => {
        clearTimeout(timer)
        const holderAnswers = await reachable(holderHost ?? '127.0.0.1', heldPort)
        holder.close()
        resolve({ code, holderAnswers })
      })
    }
    if (holderHost) holder.listen(0, holderHost, listening)
    else holder.listen(0, listening)
  })
const wildcard = await startOn(undefined)
ok('다른 프로그램이 모든 인터페이스에 잡은 포트면 열지 않고 멈춘다(가로채지 않는다)', wildcard.code === 1 && wildcard.holderAnswers)
const loopbackOnly = await startOn('127.0.0.1')
ok('다른 프로그램이 127.0.0.1만 잡은 포트여도 멈춘다(::1만 열린 반쪽 서버가 남지 않는다)', loopbackOnly.code === 1 && loopbackOnly.holderAnswers)

rmSync(dir, { recursive: true, force: true })

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
