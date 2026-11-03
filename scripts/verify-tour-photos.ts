/**
 * 관광공사 사진(3단계 — src/lib/tourPhotos.ts · server/tourPhotos.ts · GET /api/tourapi/photos)을 확인한다. 진짜 TourAPI는 부르지 않는다 —
 * 가짜 응답(고정 JSON)을 주는 가짜 TourAPI 서버를 127.0.0.1:4105에 띄우고, 임시 데이터 폴더 · 가짜 키로 앱 서버를 4104에 띄워 HTTP로 부른다.
 *
 * 왜:
 * - 사이트 장소 이름과 관광공사 제목이 다를 수 있다(「…해양공원」 ↔ 「…해양테마공원」) — 다른 이름 · 좌표로 찾되, 다른 도시의 장소는
 *   맞추지 않아야 한다.
 * - 공공누리 제1유형만 쓴다 — 국문 관광정보는 사진마다 Type1만, 관광사진은 촬영지 · 제목 · 사람 낱말을 본다.
 * - 개발계정 한도가 하루 1,000건쯤이다 — 같은 요청은 캐시에서, 한도 · 승인 없음(403)은 알림으로.
 * - 키는 서버 밖으로 나가지 않는다 — 응답 · 로그 · 캐시 파일 어디에도.
 *
 *   npx tsx scripts/verify-tour-photos.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cityMatches,
  galleryTourPhotos,
  korTourPhotos,
  pickTourPlace,
  regionCityOf,
  titleDistance,
  TOUR_SOURCES,
  tourCreditOf,
  tourItems,
  tourPhotoSrc,
  type TourPhotoResult,
} from '../src/lib/tourPhotos'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// 1) 응답 읽기 · 지역 · 이름 · 출처 — 서버 없이
ok('지역 글자의 도시', [
  regionCityOf('전북 가상') === '가상',
  regionCityOf('가상시 해변로 1') === '가상',
  regionCityOf('가상 내항길 2 가상해양테마공원') === '가상',
  regionCityOf('서울 강남') === '강남',
  regionCityOf('부산') === '부산',
  regionCityOf('해변로 240') === null,
  regionCityOf('국내') === null,
  regionCityOf('') === null,
].every(Boolean))
ok('주소 · 촬영지에 도시가 낱말로 있어야', cityMatches('전북특별자치도 가상시 해변로 1', '가상') && cityMatches('전라북도 가상', '가상') && !cityMatches('부산광역시 다른구 가상로 1', '가상') && !cityMatches('가상시', ''))
ok('이름 맞춤 — 같으면 0, 품으면 글자 수 차이, 3글자보다 짧은 이름은 보지 않는다', titleDistance('가상시근대박물관', ['근대박물관']) === 3 && titleDistance('가상해양테마공원', ['가상해양공원']) === null && titleDistance('가상섬', ['가상섬']) === 0 && titleDistance('가상섬', ['섬']) === null)
ok('항목 모양 — 배열 · 하나 · 빈 글자', tourItems({ response: { body: { items: { item: [{ a: 1 }, { a: 2 }] } } } }).length === 2 && tourItems({ response: { body: { items: { item: { a: 1 } } } } }).length === 1 && tourItems({ response: { body: { items: '' } } }).length === 0)
ok('출처 — 촬영자 있으면 함께, 「제공」 같은 말이면 한국관광공사만', tourCreditOf('한국관광공사 가상촬영') === '한국관광공사 가상촬영' && tourCreditOf('가상촬영') === '한국관광공사 가상촬영' && tourCreditOf('') === '한국관광공사' && tourCreditOf('가상 제공') === '한국관광공사')
ok('사진 주소 — visitkorea.or.kr만, http는 https로', tourPhotoSrc('http://tong.visitkorea.or.kr/cms/a.jpg') === 'https://tong.visitkorea.or.kr/cms/a.jpg' && tourPhotoSrc('https://evil.example/a.jpg') === null && tourPhotoSrc('') === null)

const IMG = (n: string) => `https://tong.visitkorea.or.kr/cms/resource/00/${n}_image2_1.jpg`
const GAL = (n: string) => `https://tong.visitkorea.or.kr/cms2/website/00/${n}.jpg`
const museumItems = [
  { contentid: '9002', title: '다른시가상근대박물관', addr1: '부산광역시 다른구 바다로 9', firstimage: IMG('9002'), cpyrhtDivCd: 'Type1' },
  { contentid: '9001', title: '가상시가상근대박물관', addr1: '전북특별자치도 가상시 해변로 1', firstimage: IMG('9001'), cpyrhtDivCd: 'Type3' },
]
const museum = pickTourPlace(museumItems, ['가상근대박물관'], '가상')
ok('다른 도시의 같은 이름은 맞추지 않는다', museum?.contentId === '9001')
const kor = korTourPhotos(
  { contentId: '9100', title: '가상해양테마공원', addr: '' },
  { firstimage: IMG('9100'), cpyrhtDivCd: 'Type1' },
  [
    { contentid: '9100', originimgurl: IMG('9101'), imgname: '가상해양테마공원_1.jpg', cpyrhtDivCd: 'Type1' },
    { contentid: '9100', originimgurl: IMG('9102'), imgname: '가상해양테마공원', cpyrhtDivCd: 'Type3' },
    { contentid: '9100', originimgurl: IMG('9103'), imgname: '가상해양테마공원 관광객', cpyrhtDivCd: 'Type1' },
    { contentid: '9100', originimgurl: IMG('9104'), imgname: '가상해양테마공원_2.jpg', cpyrhtDivCd: '' },
  ],
  '가상해양공원',
  ['가상해양공원', '가상해양테마공원'],
)
ok(
  '국문 관광정보 — 대표 사진 다음 상세 사진, Type1만(Type3 · 빈 값은 뺀 수로), 사람 낱말 사진은 뺀다',
  JSON.stringify(kor.photos.map((p) => p.src)) === JSON.stringify([IMG('9100'), IMG('9101')]) && kor.rejected === 2 &&
    kor.photos.every((p) => p.license === 'kogl-1' && p.creditText === '한국관광공사' && p.sourcePageUrl === TOUR_SOURCES.kor.page && p.place === '가상해양공원'),
)
const gal = galleryTourPhotos(
  [
    { galContentId: '1', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('1'), galPhotographyLocation: '전라북도 가상', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '가상시가상근대박물관, 전시관' },
    { galContentId: '2', galTitle: '다른시가상근대박물관', galWebImageUrl: GAL('2'), galPhotographyLocation: '부산 다른구', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '박물관' },
    { galContentId: '3', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('3'), galPhotographyLocation: '전라북도 가상시', galPhotographer: '가상작가', galSearchKeyword: '가상시가상근대박물관, 관람객' },
    { galContentId: '4', galTitle: '가상 시간여행축제', galWebImageUrl: GAL('4'), galPhotographyLocation: '전라북도 가상', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '축제' },
    { galContentId: '5', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('5'), galPhotographyLocation: '전라북도 가상', galPhotographer: '가상작가', galSearchKeyword: '야경' },
  ],
  '가상근대박물관',
  ['가상근대박물관', '가상시가상근대박물관'],
  '가상',
)
ok(
  '관광사진 — 촬영지가 그 도시 · 제목이 장소 · 사람 낱말 없는 사진만, 출처는 촬영자와 함께',
  JSON.stringify(gal.photos.map((p) => [p.src, p.creditText])) === JSON.stringify([[GAL('1'), '한국관광공사 가상촬영'], [GAL('5'), '한국관광공사 가상작가']]) &&
    gal.rejected === 3 && gal.photos.every((p) => p.sourcePageUrl === TOUR_SOURCES.gallery.page && p.licenseType === 1),
)

// 2) 가짜 TourAPI 서버
const FAKE_KEY = 'FAKE+key/abc=123'
const MOCK_PORT = 4105
const PORT = 4104
const BASE = `http://127.0.0.1:${PORT}`
// 실제 응답 모양 — 결과가 없으면 items가 ''(빈 글자), 하나면 item이 객체 하나, 여럿이면 배열.
const ok0 = (item: unknown) => ({
  response: { header: { resultCode: '0000', resultMsg: 'OK' }, body: { items: item === '' ? '' : { item }, numOfRows: 40, pageNo: 1, totalCount: Array.isArray(item) ? item.length : item === '' ? 0 : 1 } },
})
const mockCalls: string[] = []
const badKeys: string[] = []
const mock = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${MOCK_PORT}`)
  const p = url.searchParams
  const op = url.pathname.replace('/B551011/', '')
  const kw = p.get('keyword') ?? p.get('contentId') ?? `${p.get('mapX')},${p.get('mapY')}`
  mockCalls.push(`${op}|${kw}`)
  if (p.get('serviceKey') !== FAKE_KEY || p.get('MobileOS') !== 'ETC' || p.get('_type') !== 'json') badKeys.push(op)
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (kw === '가상금지관') {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end(`Forbidden ${FAKE_KEY}`)
    return
  }
  if (kw === '가상한도관') {
    res.writeHead(200, { 'Content-Type': 'text/xml' })
    res.end(`<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</returnAuthMsg><echo>${FAKE_KEY}</echo></cmmMsgHeader></OpenAPI_ServiceResponse>`)
    return
  }
  switch (`${op}|${kw}`) {
    case 'KorService2/searchKeyword2|가상근대박물관':
      return json(ok0(museumItems))
    case 'KorService2/detailImage2|9001':
      return json(ok0([1, 2, 3].map((i) => ({ contentid: '9001', originimgurl: IMG(`900${i}x`), imgname: `가상시가상근대박물관_${i}`, cpyrhtDivCd: 'Type3' }))))
    case 'PhotoGalleryService1/gallerySearchList1|가상시가상근대박물관':
      return json(ok0([
        { galContentId: '11', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('11'), galPhotographyLocation: '전라북도 가상', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '가상시가상근대박물관, 전시관' },
        { galContentId: '12', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('12'), galPhotographyLocation: '전라북도 가상', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '가상시가상근대박물관, 야경' },
        { galContentId: '13', galTitle: '다른시가상근대박물관', galWebImageUrl: GAL('13'), galPhotographyLocation: '부산 다른구', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '박물관' },
        { galContentId: '14', galTitle: '가상시가상근대박물관', galWebImageUrl: GAL('14'), galPhotographyLocation: '전라북도 가상', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '관람객' },
      ]))
    case 'KorService2/searchKeyword2|가상해양공원':
      return json(ok0(''))
    case 'KorService2/searchKeyword2|가상해양테마공원':
      return json(ok0({ contentid: '9100', title: '가상해양테마공원', addr1: '전북특별자치도 가상시 내항길 2', firstimage: IMG('9100'), cpyrhtDivCd: 'Type1' }))
    case 'KorService2/detailImage2|9100':
      return json(ok0([
        ...[1, 2, 3, 4].map((i) => ({ contentid: '9100', originimgurl: IMG(`910${i}`), imgname: `가상해양테마공원_${i}.jpg`, cpyrhtDivCd: 'Type1' })),
        { contentid: '9100', originimgurl: IMG('9105'), imgname: '가상해양테마공원 관광객', cpyrhtDivCd: 'Type1' },
        { contentid: '9100', originimgurl: IMG('9106'), imgname: '가상해양테마공원', cpyrhtDivCd: 'Type3' },
      ]))
    case 'KorService2/searchKeyword2|가상등대':
      return json(ok0(''))
    case 'KorService2/locationBasedList2|126.7100000,35.9800000':
      return json(ok0([
        { contentid: '9300', title: '가상식당', addr1: '전북특별자치도 가상시 등대길 3', dist: '40' },
        { contentid: '9200', title: '가상등대전망대', addr1: '전북특별자치도 가상시 등대길 1', dist: '120', firstimage: '', cpyrhtDivCd: '' },
        { contentid: '9400', title: '가상등대', addr1: '부산광역시 다른구 등대길 1', dist: '10' },
      ]))
    case 'KorService2/detailImage2|9200':
      return json(ok0({ contentid: '9200', originimgurl: IMG('9201'), imgname: '가상등대전망대_1.jpg', cpyrhtDivCd: 'Type1' }))
    case 'PhotoGalleryService1/gallerySearchList1|가상등대전망대':
      return json(ok0(''))
    case 'KorService2/searchKeyword2|가상다른관':
      return json(ok0([{ contentid: '9500', title: '가상다른관', addr1: '부산광역시 다른구 바다로 1', firstimage: IMG('9500'), cpyrhtDivCd: 'Type1' }]))
    case 'PhotoGalleryService1/gallerySearchList1|가상다른관':
      return json(ok0([{ galContentId: '51', galTitle: '가상다른관', galWebImageUrl: GAL('51'), galPhotographyLocation: '부산 다른구', galPhotographer: '한국관광공사 가상촬영', galSearchKeyword: '가상다른관' }]))
    default:
      return json(ok0(''))
  }
})

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })

const dir = mkdtempSync(path.join(tmpdir(), 'verify-tour-photos-'))
const TENANT = 'vtour'
const NATIONAL = 'vtour-national'
const NOPUBLIC = 'vtour-nopublic'
const AT = '2026-11-03T00:00:00.000Z'
const tenant = (tenantId: string, region: string) => ({
  tenantId, brandName: `가상 여행 ${tenantId}`, aliases: [`가상 여행 ${tenantId}`], ownedDomains: [`${tenantId}.example`], industry: '관광안내', region,
  engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
})
writeFileSync(path.join(dir, 'tenants.overlay.json'), JSON.stringify([tenant(TENANT, '전북 가상'), tenant(NATIONAL, '국내'), tenant(NOPUBLIC, '전북 가상')]))
for (const t of [TENANT, NATIONAL, NOPUBLIC]) {
  mkdirSync(path.join(dir, 'data', t), { recursive: true })
  const rights = t === NOPUBLIC ? { confirmedAt: AT } : { confirmedAt: AT, publicAt: AT }
  writeFileSync(path.join(dir, 'data', t, 'publish-settings.json'), JSON.stringify({ photoRights: rights }))
}
writeFileSync(
  path.join(dir, 'data', TENANT, 'drafts.json'),
  JSON.stringify({ 'content:a': { actionId: 'content:a', generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] } } }),
)

const envFor = (key: string) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_DATA_DIR: dir,
    PORT: String(PORT),
    USE_MOCK_ENGINES: 'true',
    DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'),
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    GH_MEASURE_TOKEN: '',
    TOURAPI_SERVICE_KEY: key,
    TOURAPI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/B551011`,
  }
  delete env.AEO_SERVER_HOST
  return env
}
let logs = ''
const start = async (key: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env: envFor(key), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.on('data', (d: Buffer) => (logs += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (logs += d.toString()))
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return child
    await new Promise((r) => setTimeout(r, 500))
  }
  return child
}
const stop = async (child: ChildProcess) => {
  child.kill()
  for (let i = 0; i < 20 && !(await portFree(PORT)); i += 1) await new Promise((r) => setTimeout(r, 250))
}
const bodies: string[] = []
const get = async (url: string) => {
  const res = await fetch(`${BASE}${url}`)
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: JSON.parse(text || '{}') as TourPhotoResult & { error?: string; tourApi?: boolean } }
}
const tour = (tenantId: string, params: Record<string, string | string[]>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) q.append(k, x)
  return get(`/api/tourapi/photos/${tenantId}?${q.toString()}`)
}

if (!(await portFree(PORT)) || !(await portFree(MOCK_PORT))) {
  console.error(`포트 ${PORT} · ${MOCK_PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
try {
  // 키 없음 — 화면은 건너뛰고, 길은 503
  const noKey = await start('')
  try {
    const health = await get('/api/health')
    ok('키가 없으면 /api/health의 tourApi는 false', health.status === 200 && health.body.tourApi === false)
    const none = await tour(TENANT, { place: '가상근대박물관' })
    ok('키가 없으면 관광공사 사진 길은 503 · TourAPI를 부르지 않는다', none.status === 503 && mockCalls.length === 0)
  } finally {
    await stop(noKey)
  }

  const server = await start(FAKE_KEY)
  try {
    const health = await get('/api/health')
    ok('키가 있으면 tourApi는 true(값은 싣지 않는다)', health.body.tourApi === true)
    ok('공공 사진 사용 확인 전에는 409', (await tour(NOPUBLIC, { place: '가상근대박물관' })).status === 409)
    ok('장소 이름이 너무 짧으면 400', (await tour(TENANT, { place: '섬' })).status === 400)

    const m = await tour(TENANT, { place: '가상근대박물관', address: '가상시 해변로 1' })
    ok(
      '국문 관광정보 사진이 모두 Type3인 장소 — 관광사진(같은 도시 · 사람 없는 사진)으로, 다른 도시는 맞추지 않는다',
      m.status === 200 && m.body.resolved?.contentId === '9001' && m.body.rejectedType === 4 &&
        JSON.stringify(m.body.photos.map((p) => p.src)) === JSON.stringify([GAL('11'), GAL('12')]) &&
        m.body.photos.every((p) => p.source === 'gallery' && p.license === 'kogl-1' && p.creditText === '한국관광공사 가상촬영' && p.place === '가상근대박물관'),
    )
    const j = await tour(TENANT, { place: '가상해양공원', name: '가상해양테마공원', address: '가상 내항길 2', lat: '35.98', lng: '126.71' })
    ok(
      '사이트 이름으로 못 찾으면 장소 페이지의 다른 이름으로 — Type1만, 사람 낱말 사진 빼고, 넉넉하면 관광사진은 부르지 않는다',
      j.body.resolved?.contentId === '9100' && j.body.photos.length === 5 && j.body.photos.every((p) => p.source === 'kor' && p.creditText === '한국관광공사') &&
        !j.body.photos.some((p) => p.src === IMG('9105') || p.src === IMG('9106')) && !mockCalls.some((c) => c.includes('gallerySearchList1|가상해양테마공원')),
    )
    const l = await tour(TENANT, { place: '가상등대', lat: '35.98', lng: '126.71' })
    ok('이름으로 못 찾으면 좌표 근처에서 이름이 비슷한 곳(다른 도시 · 다른 이름은 가까워도 빼고)', l.body.resolved?.contentId === '9200' && l.body.photos.length === 1 && l.body.photos[0]?.src === IMG('9201'))
    const other = await tour(TENANT, { place: '가상다른관' })
    ok('다른 도시에만 있는 장소는 사진 없음 · 알림', other.body.resolved === null && other.body.photos.length === 0 && typeof other.body.note === 'string')
    const callsBefore = mockCalls.length
    const mismatch = await tour(TENANT, { place: '가상근대박물관', address: '다른시 바다로 1' })
    ok('장소 주소의 도시가 브랜드 지역과 다르면 찾지 않는다', mismatch.body.photos.length === 0 && String(mismatch.body.note).includes('다른') && mockCalls.length === callsBefore)
    const nat = await tour(NATIONAL, { place: '가상근대박물관', address: '가상시 해변로 1' })
    ok('전국형 브랜드는 장소 주소의 도시로 확인한다(캐시에서 — TourAPI를 다시 부르지 않는다)', nat.body.city === '가상' && nat.body.photos.length === 2 && mockCalls.length === callsBefore)
    const natNoCity = await tour(NATIONAL, { place: '가상근대박물관' })
    ok('도시를 정하지 못하면 찾지 않는다', natNoCity.body.city === null && natNoCity.body.photos.length === 0 && mockCalls.length === callsBefore)

    const forbidden = await tour(TENANT, { place: '가상금지관' })
    ok('서비스 승인이 없으면(403) 알림 · 오류 코드', forbidden.status === 200 && forbidden.body.error === 'FORBIDDEN' && String(forbidden.body.note).includes('활용신청'))
    const quota = await tour(TENANT, { place: '가상한도관' })
    ok('호출 한도 응답(XML)은 QUOTA 알림', quota.body.error === 'QUOTA' && String(quota.body.note).includes('한도'))
    ok('TourAPI에 키 · 공통 인자를 그대로 보낸다', badKeys.length === 0 && mockCalls.length > 0)

    // 사진 저장 — 관광공사 사진도 공공 사진 검사 그대로(출처 · 제1유형 · 사용 확인), 서버가 받은 적 있는 Type3 사진은 거절
    const put = async (body: unknown) => {
      const res = await fetch(`${BASE}/api/content-draft/${TENANT}/photos`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      bodies.push(text)
      return { status: res.status, body: JSON.parse(text || '{}') as Record<string, unknown> }
    }
    const KOGL1 = 'https://www.kogl.or.kr/info/licenseType1.do'
    const pick = (slot: string, src: string, over: Record<string, unknown> = {}) => ({
      slot, nth: 1, same: 1, heading: slot, src, alt: '가상시가상근대박물관', pageUrl: TOUR_SOURCES.gallery.page, auto: true,
      origin: 'public', license: 'kogl-1', credit: '한국관광공사 가상촬영', creditUrl: KOGL1, ...over,
    })
    const auto = await put({
      op: 'auto',
      articles: [{
        actionId: 'content:a',
        generatedAt: AT,
        picks: [
          pick('가상근대박물관 외관', GAL('11')),
          pick('가상근대박물관 전시실', IMG('9001'), { pageUrl: TOUR_SOURCES.kor.page, credit: '한국관광공사' }),
          pick('가상근대박물관 야경', GAL('12'), { origin: undefined, license: undefined, credit: undefined, creditUrl: undefined }),
        ],
      }],
    })
    const saved = (JSON.parse(readFileSync(path.join(dir, 'data', TENANT, 'drafts.json'), 'utf-8')) as Record<string, { photos?: Record<string, unknown>[] }>)['content:a']?.photos ?? []
    ok(
      '자동 채우기 저장 — 출처 있는 제1유형 관광공사 사진만 저장(받은 적 있는 Type3 · 출처 없는 사진은 빼고 센다)',
      auto.status === 200 && auto.body.saved === 1 && auto.body.skipped === 2 && saved.length === 1 && saved[0]?.src === GAL('11') &&
        saved[0]?.credit === '한국관광공사 가상촬영' && saved[0]?.pageUrl === TOUR_SOURCES.gallery.page && saved[0]?.origin === 'public',
    )
    const manual = await put({ actionId: 'content:a', generatedAt: AT, op: 'pick', pick: { ...pick('가상근대박물관 입구', IMG('9001')), auto: undefined } })
    ok('손으로 고르기도 받은 적 있는 Type3 관광공사 사진은 400', manual.status === 400 && String(manual.body.error).includes('제1유형'))
    const manualBare = await put({ actionId: 'content:a', generatedAt: AT, op: 'pick', pick: { ...pick('가상근대박물관 입구', GAL('12'), { origin: undefined, license: undefined, credit: undefined, creditUrl: undefined }), auto: undefined } })
    ok('출처 없이 고른 관광공사 사진은 400', manualBare.status === 400)

    // 캐시 · 키 노출
    await new Promise((r) => setTimeout(r, 1500))
    const cacheFile = path.join(dir, 'tourapi-cache.json')
    const cacheText = existsSync(cacheFile) ? readFileSync(cacheFile, 'utf-8') : ''
    ok('응답은 캐시 파일에 둔다(키 없이)', cacheText.includes('searchKeyword2') && !cacheText.includes(FAKE_KEY) && !cacheText.includes(encodeURIComponent(FAKE_KEY)))
  } finally {
    await stop(server)
  }
  const leaks = [...bodies, logs].filter((t) => t.includes(FAKE_KEY) || t.includes(encodeURIComponent(FAKE_KEY)))
  ok('응답 · 서버 로그 어디에도 키가 없다', leaks.length === 0)
} finally {
  mock.close()
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
