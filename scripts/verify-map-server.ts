/**
 * 군산 지도 그림의 서버 쪽을 확인한다 — 자사 사이트 /map/의 장소 목록 읽기 · 저장(server/mapPoints.ts — 점만, 페이지 HTML은 저장하지 않는다),
 * 메인 프로세스에 그리기를 맡기는 다리(server/maps.ts — 'map-render' · 'map-render-result'), 그린 지도 저장(maps/<id>.png + maps.json, 이름은
 * 그리기 요청 · 그림 판 · 장소 목록 판의 해시), 그리고 임시 데이터 폴더로 띄운 서버(포트 4121)의 지도 라우트 · 사진 PUT(origin osm-map) ·
 * 사진 받기. 바깥 사이트 · 지도 타일 서버는 부르지 않는다(장소 목록 받기는 가짜, 서버의 장소 목록은 미리 넣어 둔다).
 *
 * 왜:
 * - 자사 사이트 /map/ 페이지에는 카카오 앱 키가 든 속성이 같은 태그에 있다 — 점 목록만 저장하고 HTML · 다른 속성은 남기지 않는다.
 * - 지도 그림은 서버가 장소 목록에서 좌표를 찾아 정한다 — 화면이 보낸 좌표 · 대체 텍스트를 믿으면 틀린 지도가 나간다.
 * - 같은 장소 묶음을 다시 그리지 않는다(같은 요청 · 같은 판이면 같은 그림).
 * - 웹 · dev 실행은 그릴 수 없다 — 설치한 데스크톱 앱에서만 그린다고 분명히 답해야 한다.
 *
 *   npx tsx scripts/verify-map-server.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const dir = mkdtempSync(path.join(tmpdir(), 'verify-map-server-'))
process.env.APP_DATA_DIR = dir
const TENANT = 'vmap'
const tenantDir = path.join(dir, 'data', TENANT)
mkdirSync(tenantDir, { recursive: true })

const { mapPointsFromHtml, loadMapPoints, readMapPoints, MAP_POINTS_MAX_AGE_MS, MapPointsError } = await import('../server/mapPoints')
const maps = await import('../server/maps')
const { screenProfileFor } = await import('../src/lib/screenCapture')
const { MAP_CREDIT, MAP_STYLE_VERSION, mapAppSrc, mapVariantKey } = await import('../src/lib/mapImage')

const profile = screenProfileFor(['gunsan.webforai.kr'])!
const FAKE_KEY = 'FAKEAPPKEY0123456789'
const pt = (id: string, name: string, kind: string, lng: number, lat: number, r = '원도심') => ({ lat, lng, name, url: `/places/${id}/`, kind, r, id })
const SITE_POINTS = {
  all: [
    pt('가상역사관', '가상역사관', 'attraction', 126.7121, 35.9908),
    pt('가상바다공원', '가상바다공원', 'attraction', 126.7175, 35.9893),
    pt('가상빵집', '가상빵집', 'food', 126.7112, 35.987),
    pt('기지옆골프장', '기지옆골프장', 'attraction', 126.64, 35.92, '은파'),
    pt('먼섬', '먼섬', 'attraction', 125.97, 36.12, '먼 섬'),
  ],
  anchor_pts: {},
}
const attr = JSON.stringify(SITE_POINTS).replace(/&/g, '&amp;').replace(/'/g, '&#39;')
const PAGE = `<!doctype html><html><head><script src="//dapi.example/sdk.js?appkey=${FAKE_KEY}"></script></head><body>
<div class="map-grid"><div class="map" role="region" aria-label="장소 지도" data-points='${attr}' data-kakao-sdk="//dapi.example/sdk.js?appkey=${FAKE_KEY}&amp;autoload=false"></div></div></body></html>`

// ── 장소 목록 읽기 ─────────────────────────────────────────────────────────
const parsed = mapPointsFromHtml(PAGE) as { all?: unknown[] } | null
ok('div.map[data-points]의 JSON만 읽는다(작은따옴표 속성 · 글자 참조)', Array.isArray(parsed?.all) && parsed!.all!.length === 5)
ok('data-points가 없거나 JSON이 아니면 null', mapPointsFromHtml('<div class="map"></div>') === null && mapPointsFromHtml(`<div class="map" data-points="{x"></div>`) === null)
ok('class에 map이 없는 div의 data-points는 읽지 않는다', mapPointsFromHtml(`<div class="mapx" data-points='${attr}'></div>`) === null)
let fetches = 0
const fetchPage = async (url: string) => {
  fetches += 1
  return { status: url === 'https://gunsan.webforai.kr/map/' ? 200 : 404, html: PAGE, fetchError: null }
}
const t0 = new Date('2026-11-05T00:00:00.000Z')
const first = await loadMapPoints(TENANT, profile, { now: () => t0, fetchPage })
const savedText = readFileSync(path.join(tenantDir, 'map-points.json'), 'utf8')
ok(
  '처음에는 /map/을 한 번 받아 점만 저장한다(범위 밖 섬은 빼고, 공군기지 상자 안 장소는 남긴다 — 고를 때 뺀다)',
  first.fetched && fetches === 1 && first.file.points.length === 4 && first.file.source === 'https://gunsan.webforai.kr/map/' && first.file.fetchedAt === t0.toISOString() && /^[0-9a-f]{12}$/.test(first.file.version),
)
ok('저장한 파일에 페이지 HTML · 앱 키 · 다른 속성이 없다', !savedText.includes(FAKE_KEY) && !savedText.includes('<') && !savedText.includes('kakao') && !savedText.includes('anchor_pts') && !savedText.includes('/places/'))
const again = await loadMapPoints(TENANT, profile, { now: () => new Date(t0.getTime() + MAP_POINTS_MAX_AGE_MS - 1000), fetchPage })
ok('기한 안이면 다시 받지 않는다', !again.fetched && fetches === 1 && again.file.version === first.file.version)
const failing = async () => {
  fetches += 1
  return { status: 0, html: '', fetchError: 'ECONNRESET' }
}
const staleUse = await loadMapPoints(TENANT, profile, { now: () => new Date(t0.getTime() + MAP_POINTS_MAX_AGE_MS + 1000), fetchPage: failing })
ok('기한이 지났는데 받지 못하면 저장한 목록을 쓰고 알린다(stale)', !staleUse.fetched && staleUse.stale && Boolean(staleUse.warning) && staleUse.file.points.length === 4)
const refreshed = await loadMapPoints(TENANT, profile, { now: () => new Date(t0.getTime() + 1000), fetchPage, refresh: true })
ok('refresh면 기한 안이어도 다시 받는다', refreshed.fetched && (await readMapPoints(TENANT))?.fetchedAt === new Date(t0.getTime() + 1000).toISOString())
rmSync(path.join(dir, 'data', 'vmap2'), { recursive: true, force: true })
const noFile = await loadMapPoints('vmap2', profile, { fetchPage: failing }).then(
  () => 'resolved',
  (e: unknown) => (e instanceof MapPointsError ? e.code : 'other'),
)
ok('저장한 목록도 없고 받지도 못하면 fetch-failed', noFile === 'fetch-failed')
const empty = await loadMapPoints('vmap3', profile, { fetchPage: async () => ({ status: 200, html: '<div class="map" data-points=\'{"all":[]}\'></div>', fetchError: null }) }).then(
  () => 'resolved',
  (e: unknown) => (e instanceof MapPointsError ? e.code : 'other'),
)
ok('점이 하나도 없으면 no-points(저장하지 않는다)', empty === 'no-points' && !existsSync(path.join(dir, 'data', 'vmap3', 'map-points.json')))
const noSource = await loadMapPoints(TENANT, { host: 'x.example', screens: [] }, { fetchPage }).then(
  () => 'resolved',
  (e: unknown) => (e instanceof MapPointsError ? e.code : 'other'),
)
ok('장소 목록 출처가 없는 프로필은 no-source', noSource === 'no-source')

// ── 다리(메인 프로세스에 그리기 맡기기) ─────────────────────────────────────
const png = (w = 1280, h = 800, tail = 0) => {
  const b = Buffer.alloc(40 + tail)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}
type Listener = (e: { data?: unknown }) => void
const fakePort = () => {
  const sent: Record<string, unknown>[] = []
  const listeners: Listener[] = []
  return { sent, port: { on: (_ev: 'message', l: Listener) => listeners.push(l), postMessage: (m: unknown) => sent.push(m as Record<string, unknown>) }, reply: (m: unknown) => listeners.forEach((l) => l({ data: m })) }
}
const fp = fakePort()
const bridge = maps.createMapBridge(fp.port, { waitMs: () => 200 })
const spec = { width: 1280, height: 800, center: [126.71, 35.99] as [number, number], zoom: 15, markers: [{ lng: 126.71, lat: 35.99, kind: 'attraction', label: '가상' }], areaLabels: true, legend: true }
const pending = bridge.render(spec)
await new Promise((r) => setTimeout(r, 10))
ok('다리 — map-render 요청에 spec을 싣는다', fp.sent.length === 1 && fp.sent[0]!.type === 'map-render' && typeof fp.sent[0]!.id === 'string' && JSON.stringify(fp.sent[0]!.spec) === JSON.stringify(spec))
fp.reply({ type: 'screen-capture-result', id: fp.sent[0]!.id, ok: true, png: png().toString('base64') })
fp.reply({ type: 'map-render-result', id: fp.sent[0]!.id, ok: true, png: png().toString('base64'), bounds: [1, 2, 3, 4], labels: { placed: 1, dropped: ['가'] }, areaLabels: ['동'], renderer: 'ANGLE (가짜)' })
const got = await pending
ok('다리 — map-render-result만 받고(화면 찍기 답은 무시) PNG · 이름 뺌 · 렌더러를 준다', got.png.length === 40 && got.labelsDropped.join() === '가' && got.renderer === 'ANGLE (가짜)')
const failed = bridge.render(spec)
await new Promise((r) => setTimeout(r, 10))
fp.reply({ type: 'map-render-result', id: fp.sent[1]!.id, ok: false, code: 'avoid-area', message: '겹침' })
ok('다리 — 실패 답은 그 code로', await failed.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code) === 'avoid-area')
const late = bridge.render(spec)
ok('다리 — 한도 안에 답이 없으면 timeout(늦은 답은 버린다)', (await late.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code)) === 'timeout')
fp.reply({ type: 'map-render-result', id: fp.sent[2]!.id, ok: true, png: png().toString('base64') })
ok('다리 — port가 없으면 쓸 수 없다(unavailable)', !maps.createMapBridge(null).available && (await maps.createMapBridge(undefined).render(spec).then(() => 'resolved', (e: unknown) => (e as { code?: string }).code)) === 'unavailable')

// ── 그리기 · 저장 ─────────────────────────────────────────────────────────
const pointsFile = (await readMapPoints(TENANT))!
const renders: unknown[] = []
const fakeBridge = { available: true, render: async (s: unknown) => (renders.push(s), { png: png(), labelsDropped: [], areaLabels: [], renderer: 'fake' }) }
const ids = ['가상바다공원', '가상역사관']
const drawn = await maps.drawMapVariant(TENANT, profile, pointsFile, ['가상역사관', '가상바다공원'], { bridge: fakeBridge, now: () => t0 })
const rec = drawn.record
const firstSpec = renders[0] as { center: number[]; zoom: number; markers: { label: string }[]; areaLabels: boolean }
ok(
  '그리기 — 장소 목록에서 좌표를 찾아 틀을 정하고 그린 그림을 maps/<id>.png로, maps.json에 기록',
  !drawn.reused && renders.length === 1 && /^[0-9a-f]{16}$/.test(rec.id) && rec.variant === mapVariantKey(ids) && existsSync(path.join(tenantDir, 'maps', `${rec.id}.png`)) &&
    rec.pointsVersion === pointsFile.version && rec.styleVersion === MAP_STYLE_VERSION && rec.side === 'east-of-base' && firstSpec.markers.map((m) => m.label).join() === '가상역사관,가상바다공원',
)
const view = maps.mapImageView(TENANT, rec)
ok('보기 — 앱 주소 · 지도 대체 텍스트 · 위치 문장', view.src === mapAppSrc(TENANT, rec.id) && view.alt === '군산 지도 — 가상역사관 · 가상바다공원 위치' && view.caption === '가상역사관 · 가상바다공원 위치를 지도에 표시했습니다.')
const reused = await maps.drawMapVariant(TENANT, profile, pointsFile, ['가상바다공원', '가상역사관'], { bridge: fakeBridge, now: () => t0 })
ok('같은 장소 묶음 · 같은 판이면 다시 그리지 않는다(reused — 순서가 달라도)', reused.reused && reused.record.id === rec.id && renders.length === 1)
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e as { code?: string }).code ?? 'other')
ok('목록에 없는 장소 id는 unknown-point', (await codeOf(maps.drawMapVariant(TENANT, profile, pointsFile, ['없는곳'], { bridge: fakeBridge }))) === 'unknown-point')
ok('공군기지 상자 안 장소만이면 no-markers(그리지 않는다)', (await codeOf(maps.drawMapVariant(TENANT, profile, pointsFile, ['기지옆골프장'], { bridge: fakeBridge }))) === 'no-markers' && renders.length === 1)
const messageOf = (p: Promise<unknown>) => p.then(() => '', (e: unknown) => (e instanceof Error ? e.message : String(e)))
const noMarkersMessage = await messageOf(maps.drawMapVariant(TENANT, profile, pointsFile, ['기지옆골프장'], { bridge: fakeBridge }))
ok('그리지 않은 까닭 글은 중립 — 「지도에 넣지 않는 구역」, 시설 이름(공군 · 군사)을 쓰지 않는다', noMarkersMessage.includes('지도에 넣지 않는 구역') && !/공군|군사/.test(noMarkersMessage))
const withBase = await maps.drawMapVariant(TENANT, profile, pointsFile, ['가상빵집', '기지옆골프장'], { bridge: fakeBridge, now: () => t0 })
ok('상자 안 장소는 빼고 그린다(dropped avoid)', withBase.record.markers.map((m) => m.id).join() === '가상빵집' && withBase.record.dropped.map((d) => `${d.id}:${d.why}`).join() === '기지옆골프장:avoid')
ok('그릴 수 없으면 unavailable(그려 둔 것은 그대로 준다)', (await codeOf(maps.drawMapVariant(TENANT, profile, pointsFile, ['가상빵집', '가상역사관'], { bridge: maps.createMapBridge(null) }))) === 'unavailable' &&
  (await maps.drawMapVariant(TENANT, profile, pointsFile, ids, { bridge: maps.createMapBridge(null) })).reused)
ok('그린 그림이 1280×800 PNG가 아니면 bad-png(쓰지 않는다)', (await codeOf(maps.drawMapVariant(TENANT, profile, pointsFile, ['가상빵집', '가상바다공원'], { bridge: { available: true, render: async () => ({ png: png(640, 400), labelsDropped: [], areaLabels: [], renderer: '' }) } }))) === 'bad-png')
const crowded = await maps.drawMapVariant(TENANT, profile, pointsFile, ['가상빵집', '가상역사관'], {
  bridge: { available: true, render: async () => ({ png: png(), labelsDropped: ['가상빵집'], areaLabels: [], renderer: 'fake' }) },
})
ok(
  '그림에 이름을 넣지 못한 표지는 대체 텍스트 · 위치 문장에서 뺀다(표지는 그대로 기록)',
  crowded.record.labelsDropped?.join() === '가상빵집' && crowded.record.markers.length === 2 &&
    maps.mapImageView(TENANT, crowded.record).alt === '군산 지도 — 가상역사관 위치' && maps.mapTextOf(crowded.record).caption === '가상역사관 위치를 지도에 표시했습니다.',
)
const listed = await maps.readMapImages(TENANT)
ok('maps.json — 그린 것만(세 장)', listed.length === 3 && listed.every((x) => existsSync(path.join(tenantDir, 'maps', `${x.id}.png`))))
ok('그림 파일 읽기 — 목록에 있는 id만', (await maps.readMapFile(TENANT, rec.id))?.length === 40 && (await maps.readMapFile(TENANT, 'ffffffffffffffff')) === null && (await maps.readMapFile(TENANT, '../x')) === null)
// 줄 이름 — 줄인 이름(「가상호수」)이 다른 장소 이름과 같으면 줄이지 않는다(화면의 표지 고르기 src/lib/mapImage.ts와 같은 이름). 다른 브랜드
// 폴더에 그려 위 maps.json 셈을 건드리지 않는다.
const LAKE_TENANT = 'vmap-lake'
const lakeFile = {
  ...pointsFile,
  version: 'lake00000001',
  points: [
    { id: '가상호수', name: '가상호수', kind: 'attraction' as const, lng: 126.7172, lat: 35.9781, region: '원도심' },
    { id: '가상제방', name: '군산 제1수원지제방 (가상호수)', kind: 'attraction' as const, lng: 126.7186, lat: 35.9752, region: '원도심' },
  ],
}
const lakeRenders: { markers: { label: string }[] }[] = []
const lakeBridge = { available: true, render: async (s: unknown) => (lakeRenders.push(s as { markers: { label: string }[] }), { png: png(), labelsDropped: [], areaLabels: [], renderer: 'fake' }) }
const lakeDrawn = await maps.drawMapVariant(LAKE_TENANT, profile, lakeFile, ['가상호수', '가상제방'], { bridge: lakeBridge, now: () => t0 })
ok(
  '줄 이름 — 다른 장소 이름과 같아지면 줄이지 않는다(그림 · 기록 · 대체 텍스트)',
  lakeRenders[0]?.markers.map((m) => m.label).join() === '가상호수,군산 제1수원지제방 (가상호수)' &&
    maps.mapImageView(LAKE_TENANT, lakeDrawn.record).alt === '군산 지도 — 가상호수 · 군산 제1수원지제방 (가상호수) 위치',
)
// 그려 둔 그림의 줄 이름이 지금 이름 규칙과 다르면(같은 묶음 · 같은 판이어도) 다시 그린다 — 옛 이름이 든 그림을 다시 쓰지 않는다.
const oldRule = await maps.drawMapVariant(LAKE_TENANT, profile, { ...lakeFile, points: [lakeFile.points[1]!] }, ['가상제방'], { bridge: lakeBridge, now: () => t0 })
const newRule = await maps.drawMapVariant(LAKE_TENANT, profile, lakeFile, ['가상제방'], { bridge: lakeBridge, now: () => t0 })
ok(
  '줄 이름이 바뀐 묶음은 다시 그린다(reused 아님)',
  oldRule.record.markers[0]?.label === '가상호수' && !newRule.reused && newRule.record.markers[0]?.label === '군산 제1수원지제방 (가상호수)' && lakeRenders.length === 3,
)

// ── 임시 서버(라우트 · 사진 PUT · 사진 받기) ─────────────────────────────────
const PORT = 4121
const BASE = `http://127.0.0.1:${PORT}`
const AT = '2026-11-05T00:00:00.000Z'
const SLOT = '가상각 웹사이트의 지도에서 찾기 화면에 가상역사관·가상바다공원 위치가 표시된 모습'
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    {
      tenantId: TENANT, brandName: '가상각', aliases: ['가상각'], ownedDomains: ['gunsan.webforai.kr'], industry: '관광안내', region: '가상시',
      engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
    },
  ]),
)
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({ 'content:a': { actionId: 'content:a', generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] } } }),
)
writeFileSync(path.join(tenantDir, 'publish-settings.json'), JSON.stringify({ photoRights: { confirmedAt: AT } }))
// 서버가 바깥에서 받지 않게 장소 목록의 받은 때를 지금으로.
const fresh = { ...pointsFile, fetchedAt: new Date().toISOString() }
writeFileSync(path.join(tenantDir, 'map-points.json'), JSON.stringify(fresh))

const portFree = () =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(PORT, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
if (!(await portFree())) {
  console.error(`포트 ${PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
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
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: 'ignore' })
const json = async (url: string, init?: RequestInit) => {
  const res = await fetch(`${BASE}${url}`, init)
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, type, body: (type.includes('json') ? await res.json() : await res.arrayBuffer()) as Record<string, unknown> & ArrayBuffer }
}
const send = (method: string, url: string, body: unknown) => json(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
try {
  let up = false
  for (let i = 0; i < 80 && !up; i += 1) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false)
    if (!up) await new Promise((r) => setTimeout(r, 500))
  }
  ok('임시 서버가 뜬다', up)
  const health = await json('/api/health')
  ok('/api/health maps — 이 실행(tsx · parentPort 없음)은 false', health.body.maps === false)
  const list = await json(`/api/maps/${TENANT}`)
  const listMaps = list.body.maps as { id: string; src: string; alt: string; caption: string }[]
  ok(
    '지도 목록 — 그릴 수 있는지 · 장소 목록 판 · 그린 지도(앱 주소 · 대체 텍스트 · 위치 문장)',
    list.status === 200 && list.body.available === false && list.body.source === true && (list.body.points as { version: string }).version === fresh.version &&
      listMaps.length === 3 && listMaps.some((x) => x.id === rec.id && x.src === mapAppSrc(TENANT, rec.id) && x.alt === view.alt && x.caption === view.caption),
  )
  const pts = await json(`/api/maps/${TENANT}/points`)
  ok('장소 목록 — 저장한 것을 준다(기한 안이면 받지 않는다)', pts.status === 200 && (pts.body.points as unknown[]).length === 4 && pts.body.fetched === false)
  const render = await send('POST', `/api/maps/${TENANT}/render`, { maps: [{ ids: ['가상빵집', '가상바다공원'] }] })
  ok(
    '그리기 — 이 실행에서는 그릴 수 없다고 분명히 답한다(503 · 설치한 데스크톱 앱)',
    render.status === 503 && render.body.code === 'unavailable' && String(render.body.error).includes('데스크톱 앱'),
  )
  const reuse = await send('POST', `/api/maps/${TENANT}/render`, { maps: [{ ids }] })
  const r0 = (reuse.body.results as { ok: boolean; reused?: boolean; map?: { id: string } }[])[0]
  ok('그리기 — 그려 둔 묶음은 그릴 수 없어도 그대로 준다(reused)', reuse.status === 200 && r0?.ok === true && r0.reused === true && r0.map?.id === rec.id)
  ok('그리기 — 요청 모양이 틀리면 400', (await send('POST', `/api/maps/${TENANT}/render`, { maps: [{ ids: 'x' }] })).status === 400 && (await send('POST', `/api/maps/${TENANT}/render`, {})).status === 400)
  const file = await json(`/api/maps/${TENANT}/${rec.id}.png`)
  ok('그림 파일 — 목록에 있는 id만 PNG로', file.status === 200 && file.type === 'image/png' && (await json(`/api/maps/${TENANT}/ffffffffffffffff.png`)).status === 404)
  const pick = { slot: SLOT, nth: 1, same: 1, heading: '', origin: 'osm-map', mapId: rec.id, mapVariant: rec.variant, src: 'https://evil.example/x.png', alt: '군산각 웹사이트 화면', caption: '아무 말', credit: '아무 출처', pageUrl: 'https://evil.example/' }
  const auto = await send('PUT', `/api/content-draft/${TENANT}/photos`, { op: 'auto', articles: [{ actionId: 'content:a', generatedAt: AT, picks: [{ ...pick, auto: true }] }] })
  const saved = (JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf8'))['content:a'].photos ?? [])[0] as Record<string, unknown> | undefined
  ok(
    '자동 채우기 저장 — 화면이 보낸 주소 · 대체 텍스트 · 설명 · 출처는 버리고 서버가 그린 지도 기록으로 단다',
    auto.status === 200 && saved?.origin === 'osm-map' && saved.src === mapAppSrc(TENANT, rec.id) && saved.alt === view.alt && saved.caption === view.caption &&
      saved.credit === MAP_CREDIT && saved.mapId === rec.id && saved.mapVariant === rec.variant && saved.pageUrl === 'https://gunsan.webforai.kr/map/' && saved.auto === true,
  )
  const unknownMap = await send('PUT', `/api/content-draft/${TENANT}/photos`, { actionId: 'content:a', generatedAt: AT, op: 'pick', pick: { ...pick, slot: '다른 지도 자리', mapId: 'ffffffffffffffff' } })
  ok('그린 적 없는 지도 id는 넣지 않는다(400)', unknownMap.status === 400)
  const q = new URLSearchParams({ actionId: 'content:a', generatedAt: AT, slot: SLOT, nth: '1', heading: '' })
  const pf = await json(`/api/content-draft/${TENANT}/photo-file?${q.toString()}`)
  ok('사진 받기 — 지도 그림 파일을 그대로 준다', pf.status === 200 && pf.type === 'image/png' && (pf.body as ArrayBuffer).byteLength === 40)
} finally {
  server.kill()
  await new Promise((r) => setTimeout(r, 300))
  rmSync(dir, { recursive: true, force: true })
}
ok('임시 폴더에 남은 파일 없음', !existsSync(dir) || readdirSync(dir).length === 0)

let failedCount = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failedCount += 1
}
if (failedCount > 0) {
  console.error(`\n${failedCount}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
