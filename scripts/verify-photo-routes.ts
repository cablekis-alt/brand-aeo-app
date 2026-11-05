/**
 * 공공 사진(공공누리 제1유형) 서버 검사를 확인한다 — 사진 PUT(pick · auto · credit), 사진 받기(photo-file), 사진 사용 확인(photo-rights).
 * 임시 데이터 폴더 · 모의 엔진으로 서버(server/index.ts)를 포트 4104에 띄워 HTTP로 부른다. AI · 바깥 사이트는 부르지 않는다(사진 받기는
 * 받을 수 없는 가짜 주소라 검사를 통과하면 502로 끝난다).
 *
 * 왜: 출처 표시는 공공누리의 이용 조건이다. 화면이 보낸 값만 믿으면 제2~4유형 · 출처 없는 사진 · 「제공」 같은 말이 든 출처가 저장되고,
 * 공공 사진 사용 확인 없이 고르거나 받을 수 있다. 공공 사진 호스트의 사진을 출처 없이 고르는 길도 막혀야 한다.
 *
 *   npx tsx scripts/verify-photo-routes.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const PORT = 4104
const BASE = `http://127.0.0.1:${PORT}`
const TENANT = 'vphoto'
const AT = '2026-11-03T00:00:00.000Z'
const KOGL1 = 'https://www.kogl.or.kr/info/licenseType1.do'
const PUBLIC_SRC = 'https://tour.invalid/cms/island_image2_1.jpg'
const LEGACY_SRC = 'https://tong.visitkorea.or.kr/cms/legacy_image2_1.jpg'
const LEGACY2_SRC = 'https://tong.visitkorea.or.kr/cms/legacy2_image2_1.jpg'

const portFree = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })

const dir = mkdtempSync(path.join(tmpdir(), 'verify-photo-routes-'))
const tenantDir = path.join(dir, 'data', TENANT)
mkdirSync(tenantDir, { recursive: true })
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    {
      tenantId: TENANT, brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['site.example', 'own.visitkorea.or.kr'], industry: '관광안내', region: '가상시',
      engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
    },
  ]),
)
const place = (slot: string, heading: string) => ({ slot, nth: 1, heading })
const sitePick = (slot: string, heading: string, src: string, over: Record<string, unknown> = {}) => ({
  ...place(slot, heading), same: 1, src, alt: '', pageUrl: 'https://site.example/', confirmedAt: AT, ...over,
})
const publicFields = { origin: 'public', license: 'kogl-1', credit: '가상관광공사', creditUrl: KOGL1 }
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({
    'content:a': {
      actionId: 'content:a',
      generatedAt: AT,
      draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] },
      photos: [
        sitePick('가상섬 바닷가', '섬', PUBLIC_SRC, { ...publicFields, alt: '가상섬', pageUrl: 'https://site.example/places/가상섬/' }),
        sitePick('가상 지도 화면', '지도', LEGACY_SRC),
        sitePick('가상 등대', '등대', LEGACY2_SRC),
      ],
    },
    'content:b': { actionId: 'content:b', generatedAt: AT, draft: { format: 'article', title: '가상 글 둘', sections: [], gapCount: 0, usedFacts: [] } },
    'content:c': { actionId: 'content:c', generatedAt: AT, draft: { format: 'article', title: '가상 글 셋', sections: [], gapCount: 0, usedFacts: [] } },
  }),
)
writeFileSync(path.join(tenantDir, 'publish-settings.json'), JSON.stringify({ photoRights: { confirmedAt: AT } }))

const env = {
  ...process.env,
  APP_DATA_DIR: dir,
  PORT: String(PORT),
  USE_MOCK_ENGINES: 'true',
  DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
  BLOB_READ_WRITE_TOKEN: '',
  BLOB_STORE_ID: '',
  PIPELINE_CRON: '',
  GH_MEASURE_TOKEN: '',
}
delete env.AEO_SERVER_HOST

const put = async (url: string, body: unknown) => {
  const res = await fetch(`${BASE}${url}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}
const photos = (body: unknown) => put(`/api/content-draft/${TENANT}/photos`, body)
const photoFile = async (slot: string, heading: string) => {
  const q = new URLSearchParams({ actionId: 'content:a', generatedAt: AT, slot, nth: '1', heading })
  const res = await fetch(`${BASE}/api/content-draft/${TENANT}/photo-file?${q.toString()}`)
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } }
}
const stored = () => JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: Record<string, unknown>[] }>
const settings = () => JSON.parse(readFileSync(path.join(tenantDir, 'publish-settings.json'), 'utf-8')) as { photoRights?: Record<string, unknown> }
const pickBody = (pick: Record<string, unknown>, actionId = 'content:b') => ({ actionId, generatedAt: AT, op: 'pick', pick })
const newPublic = (over: Record<string, unknown> = {}) => ({
  ...sitePick('가상근대박물관 외관', '박물관', 'https://tour.invalid/cms/museum_image2_1.jpg', { alt: '가상근대박물관', pageUrl: 'https://site.example/places/가상근대박물관/' }),
  ...publicFields,
  ...over,
})

if (!(await portFree())) {
  console.error(`포트 ${PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)

  // 1) 공공 사진 사용 확인 전
  const before = await photos(pickBody(newPublic()))
  ok('공공 사진 사용 확인 전에는 공공 사진을 고르지 못한다(409)', before.status === 409 && String(before.body.error).includes('공공 사진'))
  ok('공공 사진 사용 확인 전에는 공공 사진을 받지 않는다(409)', (await photoFile('가상섬 바닷가', '섬')).status === 409)
  const autoBefore = await photos({ op: 'auto', articles: [{ actionId: 'content:b', generatedAt: AT, picks: [{ ...newPublic(), auto: true }] }] })
  ok('공공 사진 사용 확인 전에는 자동 채우기 저장도 409', autoBefore.status === 409)

  // 2) 공공 사진 사용 확인 — 서버가 시각을 찍고, 홈페이지 사진 확인은 그대로
  const confirm = await put(`/api/tenants/${TENANT}/photo-rights`, { public: true })
  const rightsAfter = settings().photoRights
  ok('공공 사진 사용 확인은 서버 시각(publicAt)으로, 홈페이지 사진 확인은 그대로', confirm.status === 200 && typeof rightsAfter?.publicAt === 'string' && rightsAfter.confirmedAt === AT)
  const reconfirm = await put(`/api/tenants/${TENANT}/photo-rights`, {})
  ok('홈페이지 사진을 다시 확인해도 공공 사진 확인은 남는다', reconfirm.status === 200 && settings().photoRights?.publicAt === rightsAfter?.publicAt)

  // 3) 손으로 고르기 — 허용 목록 · 출처 · 이용 허락 주소
  ok('제1유형이 아니면 400', (await photos(pickBody(newPublic({ license: 'kogl-3' })))).status === 400)
  ok('출처가 없으면 400', (await photos(pickBody(newPublic({ credit: '' })))).status === 400)
  ok('출처에 「제공」 같은 말이 있으면 400', (await photos(pickBody(newPublic({ credit: '가상관광공사 제공' })))).status === 400)
  ok('이용 허락 주소가 유형과 다르면 400', (await photos(pickBody(newPublic({ creditUrl: 'https://www.kogl.or.kr/info/licenseType3.do' })))).status === 400)
  const bare = await photos(pickBody(sitePick('가상섬 바닷가', '섬', 'https://tong.visitkorea.or.kr/cms/bare_image2_1.jpg')))
  ok('공공 사진 호스트의 사진을 출처 없이 고르면 400', bare.status === 400 && String(bare.body.error).includes('출처'))
  const OWN_SRC = 'https://own.visitkorea.or.kr/img/hall_1.jpg'
  const own = await photos(pickBody(sitePick('가상 전시관 로비', '전시관', OWN_SRC, { alt: '전시관 로비', pageUrl: 'https://own.visitkorea.or.kr/' }), 'content:c'))
  const ownSaved = stored()['content:c']?.photos?.find((p) => p.src === OWN_SRC)
  ok('자사 사이트(공공 사진 호스트의 하위 도메인)의 사진은 출처 없이 고르고 홈페이지 사진(origin site)으로 저장한다', own.status === 200 && ownSaved?.origin === 'site')
  const ownAuto = await photos({ op: 'auto', articles: [{ actionId: 'content:c', generatedAt: AT, picks: [{ ...sitePick('가상 전시관 입구', '입구', 'https://own.visitkorea.or.kr/img/gate_1.jpg', { alt: '전시관 입구', pageUrl: 'https://own.visitkorea.or.kr/' }), auto: true }] }] })
  ok('자동 채우기도 자사 사이트 사진은 받는다', ownAuto.status === 200 && ownAuto.body.saved === 1 && stored()['content:c']?.photos?.some((p) => String(p.src).includes('gate_1') && p.origin === 'site') === true)
  const good = await photos(pickBody(newPublic()))
  const saved = stored()['content:b']?.photos?.[0]
  ok(
    '맞는 공공 사진은 출처 · 유형 · 이용 허락 주소와 함께 저장한다',
    good.status === 200 && saved?.origin === 'public' && saved.license === 'kogl-1' && saved.credit === '가상관광공사' && saved.creditUrl === KOGL1 && typeof saved.confirmedAt === 'string',
  )

  // 4) 자동 채우기 저장 — 공공 사진은 같은 검사, 틀린 것은 빼고 센다
  const auto = await photos({
    op: 'auto',
    articles: [
      {
        actionId: 'content:b',
        generatedAt: AT,
        picks: [
          { ...newPublic({ slot: '가상섬 등대', heading: '등대', src: 'https://tour.invalid/cms/light_image2_1.jpg', alt: '가상섬' }), auto: true },
          { ...newPublic({ slot: '가상섬 포구', heading: '포구', src: 'https://tour.invalid/cms/port_image2_1.jpg', alt: '가상섬', license: 'kogl-3' }), auto: true },
        ],
      },
    ],
  })
  const autoSaved = stored()['content:b']?.photos ?? []
  ok(
    '자동 채우기 — 맞는 공공 사진만 저장(제3유형은 빼고 센다)',
    auto.status === 200 && auto.body.saved === 1 && auto.body.skipped === 1 && autoSaved.some((p) => p.src === 'https://tour.invalid/cms/light_image2_1.jpg' && p.auto === true && p.origin === 'public') && !autoSaved.some((p) => String(p.src).includes('port_')),
  )

  // 5) 출처 붙이기 — 출처 없는 공공 사진에만
  const credit = await photos({ actionId: 'content:a', generatedAt: AT, op: 'credit', place: place('가상 지도 화면', '지도'), src: LEGACY_SRC, pageUrl: 'https://site.example/places/가상섬/', ...publicFields })
  const credited = stored()['content:a']?.photos?.find((p) => p.src === LEGACY_SRC)
  ok('출처 붙이기 — 그 사진에 출처를 붙이고 확인 시각은 그대로', credit.status === 200 && credited?.origin === 'public' && credited.credit === '가상관광공사' && credited.confirmedAt === AT)
  const creditWrong = await photos({ actionId: 'content:a', generatedAt: AT, op: 'credit', place: place('가상섬 바닷가', '섬'), src: LEGACY_SRC, pageUrl: 'https://site.example/', ...publicFields })
  ok('자리와 주소가 맞지 않으면 붙이지 않는다(400)', creditWrong.status === 400)
  const creditBad = await photos({ actionId: 'content:a', generatedAt: AT, op: 'credit', place: place('가상 등대', '등대'), src: LEGACY2_SRC, pageUrl: 'https://site.example/', ...publicFields, license: 'kogl-2' })
  ok('제1유형이 아닌 표시로는 붙이지 않는다(400)', creditBad.status === 400)

  // 6) 사진 받기 — 출처 없는 공공 사진은 409, 출처가 맞는 공공 사진은 받기 단계로(가짜 주소라 502)
  const legacyFile = await photoFile('가상 등대', '등대')
  ok('출처 없는 공공 사진은 받지 않는다(409)', legacyFile.status === 409 && String(legacyFile.body.error).includes('출처'))
  const publicFile = await photoFile('가상섬 바닷가', '섬')
  ok('출처가 맞는 공공 사진은 확인 뒤 받기로 넘어간다(가짜 주소 — 502)', publicFile.status === 502)

  // 7) 2026-11-05 결정 D5(d) — 「이 자리 빼기」(drop)는 그 자리의 사진을 빼고 뺀 자리로 적는다(본문은 그대로), 「다시 넣기」(undrop)는 표시만 지운다.
  type Cleared = { slot: string; nth: number; heading: string; removed?: string[]; drop?: true }
  const clearedOf = (id: string) => (stored()[id] as { photoCleared?: Cleared[] } | undefined)?.photoCleared ?? []
  const drop = await photos({ actionId: 'content:a', generatedAt: AT, op: 'drop', place: place('가상 지도 화면', '지도') })
  const dropRec = clearedOf('content:a').find((c) => c.slot === '가상 지도 화면')
  ok(
    '이 자리 빼기 — 그 자리의 사진을 빼고 뺀 사진 주소와 drop을 적는다',
    drop.status === 200 && !stored()['content:a']?.photos?.some((p) => p.src === LEGACY_SRC) && dropRec?.drop === true && (dropRec.removed ?? []).includes(LEGACY_SRC),
  )
  const emptyDrop = await photos({ actionId: 'content:b', generatedAt: AT, op: 'drop', place: place('가상 예약 화면', '예약') })
  ok('사진이 없는 자리도 뺄 수 있다(뺀 사진 없이 drop만)', emptyDrop.status === 200 && clearedOf('content:b').some((c) => c.slot === '가상 예약 화면' && c.drop === true && !c.removed))
  await photos({ actionId: 'content:a', generatedAt: AT, op: 'undrop', place: place('가상 지도 화면', '지도') })
  const undone = clearedOf('content:a').find((c) => c.slot === '가상 지도 화면')
  ok('다시 넣기 — drop만 지우고 뺀 사진 기록은 남긴다(사람이 뺀 자리)', undone !== undefined && !undone.drop && (undone.removed ?? []).includes(LEGACY_SRC))
  await photos({ actionId: 'content:b', generatedAt: AT, op: 'undrop', place: place('가상 예약 화면', '예약') })
  ok('뺀 사진이 없던 자리는 다시 넣기로 기록이 없어진다', !clearedOf('content:b').some((c) => c.slot === '가상 예약 화면'))
  ok('자리가 없으면 400', (await photos({ actionId: 'content:a', generatedAt: AT, op: 'drop' })).status === 400)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 800))
  rmSync(dir, { recursive: true, force: true })
}

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
