/**
 * 군산 지도 그림(src/lib/mapImage.ts)의 규칙을 확인한다 — 장소 목록 검사, 줄 이름, 이름 맞추기(띄어쓰기 무시 · 같음 → 포함), 지도 자리의
 * 표지 고르기(이름 · 둘레 · 기준 장소 · 권역 · 공군기지 상자), 대체 텍스트 「군산 지도 — … 위치」 · 설명 줄 · 출처 줄, 변형 열쇠 · 앱 주소,
 * 그림 판(스타일 · 덧그림 해시), 그리고 글에 넣을 때(src/lib/articlePhotos.ts) · 내보낼 때(src/lib/htmlFile.ts · screenExport.ts ·
 * sitePhotos.ts) 출처 줄이 그림 바로 아래에 붙고 앱 주소가 새지 않는지. 가짜 장소만 쓴다.
 *
 * 실제 지도 자리(읽기 전용 사본)로도 볼 수 있다 — 자리 목록(JSON: [{ writer, slot, caption, heading, section }])과 장소 목록(사이트 data-points의
 * all, JSON)을 주면 자리마다 고른 표지와 까닭을 적고, 모든 자리에 표지가 있는지 · 공군기지 상자 안 장소가 없는지 · 12곳 이하인지 본다.
 *
 * 왜:
 * - 카카오 · 네이버 지도는 이용 조건상 넣지 않는다 — 앱이 OSM으로 그린 지도는 「지도」라고 말해야 하고(사이트 화면이라고 쓰지 않는다)
 *   출처 줄(ODbL)이 그림 바로 아래에 따라가야 한다.
 * - 장소 이름은 띄어쓰기 · 괄호 별칭이 섞인다(「히로쓰 가옥」 = 「군산신흥동일본식가옥(히로쓰가옥)」) — 다른 장소를 표지로 넣으면 틀린 지도다.
 * - 공군기지 주변은 그리지 않는다.
 * - 앱 주소(/api/maps/)가 앱 밖으로 나가면 운영자 PC에서만 보인다.
 *
 *   npx tsx scripts/verify-map-image.ts [slots.json points.json]
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { photoCreditState, photoPickSrc, withPhotos, type PhotoPick } from '../src/lib/articlePhotos'
import { markdownToHtml } from '../src/lib/htmlFile'
import {
  MAP_AVOID,
  MAP_CREDIT,
  MAP_MAX_MARKERS,
  MAP_STYLE_VERSION,
  inMapAvoid,
  inMapBox,
  isMapImageId,
  mapAltOf,
  mapAppSrc,
  mapCaptionLines,
  mapCaptionOf,
  mapChoiceOf,
  mapDistanceM,
  mapFitZoom,
  mapKindsIn,
  mapLabelOf,
  mapNamesIn,
  mapSectionText,
  mapVariantIds,
  mapVariantKey,
  normalizeMapPoints,
  parseMapAppSrc,
  type MapPoint,
} from '../src/lib/mapImage'
import { frameFor } from '../server/mapFrame'
import { photoRepeatKey, brandRepeatExempt, mapRegionsOf, screenProfileFor } from '../src/lib/screenCapture'
import { exportLeaks, inlineScreens, screenPlainText, screenPreviewHtml } from '../src/lib/screenExport'
import { photoCreditsTable } from '../src/lib/sitePhotos'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

// ── 장소 목록 검사 ──────────────────────────────────────────────────────────
const raw = (over: Record<string, unknown> = {}) => ({ id: '가상박물관', name: '가상박물관', kind: 'attraction', lat: 35.99, lng: 126.712, r: '원도심', url: '/places/가상박물관/', ...over })
const norm = normalizeMapPoints({
  all: [
    raw(),
    raw({ id: '가상박물관', name: '같은 id' }),
    raw({ id: '바깥', name: '범위 밖 섬', lng: 125.97, lat: 36.12 }),
    raw({ id: '모름', name: '모르는 종류', kind: 'parking' }),
    raw({ id: '별표', name: '별*표' }),
    raw({ id: '빈이름', name: '  ' }),
    raw({ id: '경로/글자', name: '경로 글자 id' }),
    raw({ id: '긴이름', name: '가'.repeat(41) }),
    raw({ id: '좌표글자', name: '좌표가 글자', lat: '35.99' }),
    raw({ id: '권역없음', name: '권역 없음', r: '' }),
    raw({ id: '가상-식당', name: '가상  식당', kind: 'food' }),
  ],
  anchor_pts: {},
})
ok(
  '장소 목록 — 같은 id · 범위 밖 · 모르는 종류 · 마크다운 글자 · 빈 이름 · 경로 글자 id · 40자 넘는 이름 · 글자 좌표 · 빈 권역은 뺀다',
  norm.points.length === 2 && norm.skipped === 9 && norm.points[0]!.region === '원도심' && norm.points[1]!.name === '가상 식당' && !('url' in norm.points[0]!),
)
ok('장소 목록 — 배열 그대로도 · 모양이 아니면 빈 목록', normalizeMapPoints([raw()]).points.length === 1 && normalizeMapPoints('x').points.length === 0 && normalizeMapPoints({ all: 3 }).points.length === 0)

// ── 줄 이름 · 변형 열쇠 · 앱 주소 ─────────────────────────────────────────────
ok(
  '줄 이름 — 「긴 이름(짧은 이름)」이 10자를 넘으면 짧은 쪽, 아니면 그대로',
  mapLabelOf('군산신흥동일본식가옥(히로쓰가옥)') === '히로쓰가옥' &&
    mapLabelOf('군산 제1수원지제방 (월명호수)') === '월명호수' &&
    mapLabelOf('모트(Motte)') === '모트(Motte)' &&
    mapLabelOf('몽돌해수욕장 (몽돌해변)') === '몽돌해변' &&
    mapLabelOf('근대역사박물관') === '근대역사박물관',
)
ok('변형 열쇠 — 사전순 · 중복 없이 「|」로, 거꾸로 읽기', mapVariantKey(['나', '가', '나']) === '가|나' && JSON.stringify(mapVariantIds('가|나')) === '["가","나"]')
ok(
  '변형 열쇠 — 정렬이 틀리거나 · 빈 id · 경로 글자 · 13곳 이상이면 null',
  mapVariantIds('나|가') === null && mapVariantIds('가||나') === null && mapVariantIds('가/나') === null && mapVariantIds(Array.from({ length: 13 }, (_v, i) => `a${String(i).padStart(2, '0')}`).join('|')) === null && mapVariantIds(3) === null,
)
const MID = '0123456789abcdef'
ok('앱 주소 — /api/maps/<브랜드>/<16자>.png, 읽기', mapAppSrc('가상 브랜드', MID) === `/api/maps/${encodeURIComponent('가상 브랜드')}/${MID}.png` && parseMapAppSrc(mapAppSrc('가상 브랜드', MID))?.mapId === MID)
ok(
  '앱 주소 — 모양이 다르거나 경로 글자면 null',
  parseMapAppSrc(`/api/maps/x/${MID}.jpg`) === null && parseMapAppSrc(`/api/maps/%2F/${MID}.png`) === null && parseMapAppSrc(`/api/screens/x/${MID}.png`) === null && parseMapAppSrc(`/api/maps/x/${MID.toUpperCase()}.png`) === null,
)
ok('지도 id 모양', isMapImageId(MID) && !isMapImageId('xyz') && !isMapImageId(MID + '0'))
const styleHash = createHash('sha256')
  .update(['electron/map/style.json', 'electron/map/render.js'].map((f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).join('\n'))
  .digest('hex')
  .slice(0, 8)
ok(`그림 판(MAP_STYLE_VERSION)이 스타일 · 덧그림 해시(${styleHash})와 같다 — 고쳤으면 판을 올린다`, MAP_STYLE_VERSION.endsWith(`style-${styleHash}`))
ok('그림 판에 maplibre-gl 판이 들어 있다', MAP_STYLE_VERSION.includes(`maplibre-${JSON.parse(readFileSync('node_modules/maplibre-gl/package.json', 'utf8')).version}`))

// ── 대체 텍스트 · 설명 줄 · 출처 줄 ──────────────────────────────────────────
const mk = (label: string, kind: MapPoint['kind'] = 'attraction') => ({ label, kind })
ok('대체 텍스트 — 「군산 지도 — A · B · C 위치」', mapAltOf([mk('가'), mk('나'), mk('다')]) === '군산 지도 — 가 · 나 · 다 위치')
ok('대체 텍스트 — 5곳 넘으면 「외 n곳」', mapAltOf(['가', '나', '다', '라', '마', '바', '사'].map((l) => mk(l))) === '군산 지도 — 가 · 나 · 다 · 라 · 마 외 2곳 위치')
ok('대체 텍스트는 지도라고 말하고 사이트 화면이라고 쓰지 않는다', !/화면|웹사이트/.test(mapAltOf([mk('가')])) && /지도/.test(mapAltOf([mk('가')])))
ok('설명 줄 — 한 종류', mapCaptionOf([mk('가상박물관'), mk('가상공원')]) === '가상박물관 · 가상공원 위치를 지도에 표시했습니다.')
ok(
  '설명 줄 — 종류가 둘이면 종류마다(와/과는 앞 글자 받침으로)',
  mapCaptionOf([mk('가상박물관'), mk('가상식당', 'food')]) === '관광지 가상박물관과 음식점 가상식당 위치를 지도에 표시했습니다.' &&
    mapCaptionOf([mk('가상카페거리'), mk('가상식당', 'food')]) === '관광지 가상카페거리와 음식점 가상식당 위치를 지도에 표시했습니다.',
)
ok(
  '설명 줄 — 종류가 셋이면 쉼표로, 종류마다 4곳 넘으면 「외 n곳」',
  mapCaptionOf([mk('가'), mk('나', 'stay'), ...['a', 'b', 'c', 'd', 'e'].map((l) => mk(`식당${l}`, 'food'))]) ===
    '관광지 가, 음식점 식당a · 식당b · 식당c · 식당d 외 1곳과 숙소 나 위치를 지도에 표시했습니다.',
)
ok('출처 줄 상수', MAP_CREDIT === '지도 데이터 © OpenStreetMap contributors · ODbL · https://www.openstreetmap.org/copyright')
ok(
  '그림 아래 줄들 — 출처 줄 다음 줄에 위치 문장(별표 · 줄바꿈은 걷는다), 설명이 비면 출처 줄만',
  JSON.stringify(mapCaptionLines('가 *위치*\n표시')) === JSON.stringify([MAP_CREDIT, '가 위치 표시']) &&
    JSON.stringify(mapCaptionLines('')) === JSON.stringify([MAP_CREDIT]) && JSON.stringify(mapCaptionLines(undefined)) === JSON.stringify([MAP_CREDIT]),
)

// ── 이름 맞추기 ──────────────────────────────────────────────────────────────
let n = 0
const P = (name: string, kind: MapPoint['kind'], lng: number, lat: number, region = '원도심'): MapPoint => ({ id: `p${(n += 1)}`, name, kind, lng, lat, region })
const POINTS: MapPoint[] = [
  P('가상공원', 'attraction', 126.7035, 35.9904),
  P('가상해양공원', 'attraction', 126.7175, 35.9893),
  P('가상역사박물관', 'attraction', 126.7121, 35.9908),
  P('가상곰박물관', 'attraction', 126.7146, 35.9897),
  P('군산신흥동일본식가옥(히로쓰가옥)', 'attraction', 126.7062, 35.9863),
  P('가상호수', 'attraction', 126.7172, 35.9781),
  P('군산 제1수원지제방 (가상호수)', 'attraction', 126.7186, 35.9752),
  P('가상호수공원', 'attraction', 126.689, 35.9554, '은파'),
  P('가상호수공원 물빛다리', 'attraction', 126.6937, 35.9507, '은파'),
  P('기지골프장', 'attraction', 126.64, 35.92, '은파'),
  P('이성당', 'food', 126.7112, 35.987),
  P('가상식당', 'food', 126.7082, 35.9874),
  P('가상분식', 'food', 126.714, 35.9888),
  P('가상국수', 'food', 126.7096, 35.9853),
  P('가상횟집', 'food', 126.7089, 35.9849),
  P('가상호텔', 'stay', 126.7101, 35.9881),
  P('가상한옥', 'stay', 126.7069, 35.9858),
  P('달', 'stay', 126.7091, 35.9866),
  P('가상선유도', 'attraction', 126.411, 35.8161, '고군산'),
  P('가상장자도', 'attraction', 126.3973, 35.8101, '고군산'),
]
const names = (list: readonly MapPoint[]) => list.map((p) => p.name).join(',')
ok('이름 맞추기 — 띄어쓰기 무시 · 나온 차례', names(mapNamesIn('가상 해양공원과 가상역사 박물관 위치', POINTS)) === '가상해양공원,가상역사박물관')
ok('이름 맞추기 — 괄호 안 별칭(「히로쓰 가옥」)', names(mapNamesIn('히로쓰 가옥 위치가 표시된 모습', POINTS)) === '군산신흥동일본식가옥(히로쓰가옥)')
ok('이름 맞추기 — 같은 이름 그대로(가상호수)가 별칭(제1수원지제방의 가상호수)보다 먼저', names(mapNamesIn('가상호수 둘레', POINTS)) === '가상호수')
ok('이름 맞추기 — 긴 이름이 같은 자리의 짧은 이름을 묻는다', names(mapNamesIn('가상호수공원 물빛다리에서', POINTS)) === '가상호수공원 물빛다리')
ok('이름 맞추기 — 「○○공원」은 「○○」로도(4자 이상)', names(mapNamesIn('가상해양 산책', POINTS)) === '가상해양공원')
ok('이름 맞추기 — 글자를 한 글자 조각으로 가르면 아니다(「오래된 이 성당」)', mapNamesIn('오래된 이 성당 앞', POINTS).length === 0 && names(mapNamesIn('이성당 빵', POINTS)) === '이성당')
ok('이름 맞추기 — 3자보다 짧은 이름(「달」)은 맞추지 않는다', mapNamesIn('달이 뜨는 밤', POINTS).length === 0)
ok('종류 낱말 — 서비스 소개 문구(관광지·음식점·숙소의 여는 시간)는 빼고 본다', mapKindsIn('군산각은 관광지·음식점·숙소의 여는 시간과 요금, 가는 길을 안내합니다.').length === 0 && mapKindsIn('식당과 주변 관광지').join() === 'attraction,food')

// ── 표지 고르기 ──────────────────────────────────────────────────────────────
const REGIONS = [
  { name: '원도심', words: ['원도심', '구도심', '시간여행'] },
  { name: '은파', words: ['은파'] },
  { name: '고군산', words: ['고군산', '선유도'] },
]
const slot = (key: string, over: Partial<{ caption: string; heading: string; section: string }> = {}) => ({ key, caption: '', heading: '', section: '', ...over })
const pick = (key: string, over: Parameters<typeof slot>[1] = {}) => mapChoiceOf(slot(key, over), POINTS, REGIONS)
const labelsOf = (c: ReturnType<typeof pick>, tier = 0) => ('miss' in c ? `miss:${c.miss}` : c.variants[tier]!.markers.map((m) => m.label).join(','))
const c1 = pick('가상각 웹사이트 지도에서 찾기 화면에 가상역사박물관·가상해양공원·가상곰박물관 위치가 함께 표시된 모습')
ok('이름이 나온 자리 — 그 장소들만, 나온 차례(named)', !('miss' in c1) && c1.by === 'named' && labelsOf(c1) === '가상역사박물관,가상해양공원,가상곰박물관')
ok(
  '이름이 나온 자리 — 넓힌 묶음(tier 1)은 둘레 관광지를 더한 다른 열쇠',
  !('miss' in c1) && c1.variants.length === 2 && c1.variants[1]!.tier === 1 && c1.variants[1]!.key !== c1.variants[0]!.key && c1.variants[1]!.ids.length > c1.variants[0]!.ids.length &&
    c1.variants[0]!.ids.every((id) => c1.variants[1]!.ids.includes(id)),
)
const c2 = pick('지도에서 찾기 화면에 가상역사박물관과 주변 관광지 위치가 표시된 모습')
ok(
  '「○○과 주변 관광지」 — 그 장소 다음 둘레 관광지(named-nearby, 같은 권역 · 2km 안)',
  !('miss' in c2) && c2.by === 'named-nearby' && c2.variants[0]!.markers[0]!.label === '가상역사박물관' && c2.variants[0]!.markers.length > 1 &&
    c2.variants[0]!.markers.every((m) => m.kind === 'attraction') && !c2.variants[0]!.markers.some((m) => ['가상호수공원', '가상선유도'].includes(m.label)),
)
const c3 = pick('지도에서 찾기 화면에 식당과 주변 관광지가 함께 표시된 모습', { caption: '식당 주변의 쉬어 갈 곳', heading: '가족 식사 동선', section: '식사 전후 쉬어 갈 곳의 예로 가상곰박물관은 …' })
ok(
  '이름 없는 「식당 … 관광지」 자리 — 절 글자의 장소(가상곰박물관)를 기준점으로 같은 권역의 음식점 · 관광지(anchor)',
  !('miss' in c3) && c3.by === 'anchor' && c3.anchor?.name === '가상곰박물관' && c3.anchor.from === 'section' && c3.region === '원도심' &&
    c3.kinds.join() === 'attraction,food' && c3.variants[0]!.markers[0]!.label === '가상곰박물관' &&
    c3.variants[0]!.markers.some((m) => m.kind === 'food') && c3.variants[0]!.markers.some((m) => m.kind === 'attraction' && m.label !== '가상곰박물관'),
)
const c4 = pick('지도에서 찾기 화면', { caption: '숙소 후보 주변 관광지를 살펴봅니다', heading: '1박 2일', section: '' })
ok('이름도 장소도 없는 자리 — 설명 줄의 종류(숙소 · 관광지) · 장소가 가장 많은 권역(default-region)', !('miss' in c4) && c4.by === 'default-region' && c4.region === '원도심' && c4.kinds.join() === 'attraction,stay')
const c5 = pick('지도에서 찾기 화면에 관광지 위치가 표시된 모습', { section: '선유도로 가는 날은 …' })
ok(
  '권역 낱말만 있는 자리 — 그 권역의 관광지를 사이트 목록 순서로(region)',
  !('miss' in c5) && c5.by === 'region' && c5.region === '고군산' && labelsOf(c5) === '가상선유도,가상장자도',
)
const c6 = pick('지도에서 찾기 화면', { caption: '군산각은 관광지·음식점·숙소의 여는 시간과 요금, 가는 길을 안내합니다.' })
ok('서비스 소개 문구만 있는 자리 — 종류를 정하지 않아 관광지', !('miss' in c6) && c6.kinds.join() === 'attraction')
const c7 = pick('지도에서 찾기 화면에 기지골프장과 가상호수공원 위치가 표시된 모습')
ok(
  '공군기지 상자 안 장소는 넣지 않는다(avoided) — 까닭 글자는 중립(「표시하지 않은 곳: … (지도에 넣지 않는 구역)」, 시설 이름 없음)',
  !('miss' in c7) && c7.avoided.join() === '기지골프장' && labelsOf(c7) === '가상호수공원' && c7.variants.every((v) => v.markers.every((m) => !inMapAvoid(m))) &&
    c7.why.includes('표시하지 않은 곳: 기지골프장 (지도에 넣지 않는 구역)') && !/공군|군사|상자/.test(c7.why),
)
const c8 = pick('지도에서 찾기 화면에 기지골프장 위치가 표시된 모습')
ok('상자 안 장소만 말한 자리 — 넣을 장소가 없다(no-markers)', 'miss' in c8 && c8.miss === 'no-markers')
ok('장소 목록이 비면 no-points', (() => {
  const r = mapChoiceOf(slot('지도'), [], REGIONS)
  return 'miss' in r && r.miss === 'no-points'
})())
const many = Array.from({ length: 20 }, (_v, i) => P(`가상명소${String.fromCharCode(0xac00 + i * 588)}`, 'attraction', 126.71 + i * 0.0003, 35.99))
const c9 = mapChoiceOf(slot(`지도에 ${many.map((p) => p.name).join('·')} 위치`), many, REGIONS)
ok(`한 장에 ${MAP_MAX_MARKERS}곳까지(넓힌 묶음 없음)`, !('miss' in c9) && c9.variants.length === 1 && c9.variants[0]!.markers.length === MAP_MAX_MARKERS)
ok('같은 입력이면 같은 결과', JSON.stringify(pick('지도에서 찾기 화면에 식당과 주변 관광지', { section: '가상곰박물관' })) === JSON.stringify(pick('지도에서 찾기 화면에 식당과 주변 관광지', { section: '가상곰박물관' })))
ok(
  '절 글자 — 그 절(소제목 사이)에서 그림 줄 · 바로 아랫줄 설명은 빼고',
  mapSectionText(['# 제목', '## 1. 가', '앞 문단', '![지도](#image-slot)', '*설명*', '뒷 문단', '## 2. 나', '다른 절'], 3) === '앞 문단\n뒷 문단',
)
const gunsan = screenProfileFor(['gunsan.webforai.kr'])
const regions = gunsan ? mapRegionsOf(gunsan) : []
ok(
  '군산각 프로필은 장소 목록 출처(/map/)와 권역(지도 권역 변형의 이름 · 장소)을 준다',
  Boolean(gunsan?.mapPoints?.path === '/map/') && regions.map((r) => r.name).join() === '원도심,은파,고군산,금강,새만금·비응' && regions[0]!.words.includes('근대역사박물관'),
)
ok('프로필이 없는 브랜드는 장소 목록 출처가 없다', screenProfileFor(['stay.example']) === null)

// ── 넓힌 묶음(tier 1)은 틀이 달라야 한다 ────────────────────────────────────
// 넓힌 묶음이 tier 0 틀 안의 장소만 더하면 줌 · 중심이 그대로라 같은 작성자의 두 글에 거의 같은 그림이 들어간다(2026-11-05 검토 — 다른
// 픽셀 3%). 넓힌 묶음은 tier 0 틀 밖의 둘레 관광지를 더할 때만 만든다.
const ring: MapPoint[] = [
  P('가상북문', 'attraction', 126.73, 36.0, '성곽'),
  P('가상남문', 'attraction', 126.73, 35.994, '성곽'),
  P('가상안뜰', 'attraction', 126.7302, 35.997, '성곽'),
  P('가상우물', 'attraction', 126.7298, 35.9965, '성곽'),
  P('가상정자', 'attraction', 126.7305, 35.9975, '성곽'),
  P('가상먼탑', 'attraction', 126.745, 35.997, '성곽'),
]
const ringPick = mapChoiceOf(slot('지도에서 찾기 화면에 가상북문·가상남문 위치가 표시된 모습'), ring, REGIONS)
const f0 = 'miss' in ringPick ? null : frameFor(ringPick.variants[0]!.markers)
const f1 = 'miss' in ringPick || !ringPick.variants[1] ? null : frameFor(ringPick.variants[1].markers)
const ringAdded = 'miss' in ringPick || !ringPick.variants[1] ? [] : ringPick.variants[1].markers.filter((m) => !ringPick.variants[0]!.ids.includes(m.id))
ok(
  '넓힌 묶음 — tier 0 틀 안의 장소(가상안뜰 · 가상우물 · 가상정자)는 더하지 않고 틀 밖 둘레 관광지(가상먼탑)를 더해 틀이 달라진다',
  Boolean(f0?.ok && f1?.ok) && ringAdded.length > 0 && ringAdded.every((m) => f0!.ok && !inMapBox(m, f0.bounds)) &&
    !ringAdded.some((m) => ['가상안뜰', '가상우물', '가상정자'].includes(m.label)) && f0!.ok && f1!.ok && f1.zoom < f0.zoom,
)
const ringInside = mapChoiceOf(slot('지도에서 찾기 화면에 가상북문·가상남문 위치가 표시된 모습'), ring.filter((p) => p.name !== '가상먼탑'), REGIONS)
ok('넓힌 묶음 — 틀 밖에 더할 둘레 관광지가 없으면 넓힌 묶음을 만들지 않는다(같은 그림을 두 번 쓰지 않는다)', !('miss' in ringInside) && ringInside.variants.length === 1)
const fitSets = [ring.slice(0, 2), ring, [ring[0]!], POINTS.slice(0, 5), POINTS.filter((p) => p.region === '고군산')]
ok(
  '틀 줌 어림(mapFitZoom)이 서버 틀 정하기(frameFor)의 기본 여백 줌과 같다',
  fitSets.every((s) => {
    const f = frameFor(s.map((p) => ({ lng: p.lng, lat: p.lat })), { avoid: null })
    return f.ok && Math.abs(mapFitZoom(s) - f.fitZoom) < 0.006
  }),
)

// ── 이름 없는 음식 · 숙소 자리 ─────────────────────────────────────────────
// 「빵집·간식 동선」에 갈비집 · 횟집이 들어가고, 고른 기준 관광지는 지도에도 까닭에도 없었다(2026-11-05 검토).
const SNACKS: MapPoint[] = [P('가상빵공방', 'food', 126.7045, 35.99), P('가상호떡', 'food', 126.705, 35.989), P('가상카페', 'food', 126.703, 35.9895)]
const WITH_SNACKS = [...POINTS, ...SNACKS]
const snackPick = mapChoiceOf(slot('지도에서 찾기 화면', { caption: '지도에서 찾기 화면', heading: '이 기준을 적용하면 빵집·간식 동선은 어떻게 짜나요?' }), WITH_SNACKS, REGIONS)
ok(
  '빵집 · 간식 자리 — 이름이 그 갈래(빵 · 호떡 · 카페 …)인 음식점만, 기준 관광지(가상공원)는 표지와 까닭에',
  !('miss' in snackPick) && snackPick.by === 'default-region' && snackPick.variants[0]!.markers[0]!.label === '가상공원' &&
    snackPick.variants[0]!.markers.filter((m) => m.kind === 'food').map((m) => m.label).sort().join() === '가상빵공방,가상카페,가상호떡' && snackPick.why.includes('가상공원 둘레'),
)
const mealPick = mapChoiceOf(slot('지도에서 찾기 화면', { heading: '커플 먹거리 동선은 어떻게 찾나요?' }), WITH_SNACKS, REGIONS)
ok(
  '이름 없는 먹거리 자리 — 기준 관광지를 표지 맨 앞에 넣고 까닭에 「가상공원 둘레」',
  !('miss' in mealPick) && mealPick.variants[0]!.markers[0]!.label === '가상공원' && mealPick.variants[0]!.markers.slice(1).every((m) => m.kind === 'food') && mealPick.why.includes('가상공원 둘레'),
)
const noSnack = mapChoiceOf(slot('지도에서 찾기 화면', { heading: '빵집·간식 동선은 어떻게 짜나요?' }), POINTS, REGIONS)
ok('빵집 · 간식 자리인데 그 갈래 이름의 음식점이 없으면 비운다(no-markers — 다른 음식점으로 채우지 않는다)', 'miss' in noSnack && noSnack.miss === 'no-markers' && noSnack.why.includes('빵'))
const nearbyCafe = mapChoiceOf(slot('지도에서 찾기 화면에 가상공원 주변 카페가 표시된 모습'), WITH_SNACKS, REGIONS)
ok(
  '「○○ 주변 카페」 — 둘레 음식점도 그 갈래 이름만',
  !('miss' in nearbyCafe) && nearbyCafe.by === 'named-nearby' && nearbyCafe.variants[0]!.markers.filter((m) => m.kind === 'food').length > 0 &&
    nearbyCafe.variants[0]!.markers.filter((m) => m.kind === 'food').every((m) => SNACKS.some((s) => s.name === m.label)),
)
// 「이성당 말고 …」 — 소제목이 빼라고 한 장소를 기준점 · 표지로 쓰지 않는다.
ok(
  '이름 맞추기 — 「○○ 말고 · 빼고 · 대신 · 아닌」의 ○○는 빼고, 그냥 이어진 이름은 그대로',
  names(mapNamesIn('이성당 말고 가상분식', POINTS)) === '가상분식' && mapNamesIn('이성당이 아닌 곳', POINTS).length === 0 && mapNamesIn('이성당 대신 갈 곳', POINTS).length === 0 &&
    names(mapNamesIn('이성당과 가상분식', POINTS)) === '이성당,가상분식',
)
const notThis = mapChoiceOf(slot('지도에서 찾기 화면', { heading: '이성당 말고 길거리 간식은 어떻게 찾나요?', section: '이성당 앞 줄이 길면 가상공원 쪽으로 걸어 보세요.' }), WITH_SNACKS, REGIONS)
ok(
  '「이성당 말고 … 간식」 — 이성당은 기준점 · 표지에 넣지 않는다',
  !('miss' in notThis) && notThis.anchor?.name !== '이성당' && notThis.variants.every((v) => v.markers.every((m) => m.label !== '이성당')),
)

// ── 같은 자리의 장소 · 겹치는 줄 이름 ───────────────────────────────────────
// 사이트 목록에는 같은 건물이 두 이름으로 있다(「호남관세박물관」 = 「구 군산세관 본관」, 0m) — 한 점에 이름 둘 · 표지 칸 낭비.
const SAME_SPOT = [...POINTS, P('가상세관 본관', 'attraction', 126.7121, 35.9908)]
const spot = mapChoiceOf(slot('지도에서 찾기 화면에 가상역사박물관과 주변 관광지 위치가 표시된 모습'), SAME_SPOT, REGIONS)
const spotMarkers = 'miss' in spot ? [] : spot.variants.flatMap((v) => v.markers)
ok(
  '같은 자리(10m 안)의 장소는 하나만 — 자리 글자에 나온 장소를 남긴다',
  !('miss' in spot) && spot.variants.every((v) => v.markers.every((a, i) => v.markers.every((b, j) => i === j || mapDistanceM(a, b) > 10))) &&
    spotMarkers.some((m) => m.label === '가상역사박물관') && !spotMarkers.some((m) => m.label === '가상세관 본관'),
)
const lake = mapChoiceOf(slot('지도에서 찾기 화면에 가상호수 주변 관광지가 표시된 모습'), POINTS, REGIONS)
const lakeLabels = 'miss' in lake ? [] : lake.variants[0]!.markers.map((m) => m.label)
ok(
  '줄 이름 — 줄인 이름이 다른 장소 이름과 같으면 줄이지 않는다(대체 텍스트에 「가상호수 · 가상호수」가 생기지 않게)',
  lakeLabels.includes('가상호수') && lakeLabels.includes('군산 제1수원지제방 (가상호수)') && new Set(lakeLabels).size === lakeLabels.length &&
    mapLabelOf('군산 제1수원지제방 (가상호수)', new Set(['가상호수'])) === '군산 제1수원지제방 (가상호수)',
)

// ── 반복 열쇠 · 글에 넣기 · 내보내기 ─────────────────────────────────────────
const VARIANT = mapVariantKey(['p2', 'p3'])
const mapPick = (over: Partial<PhotoPick> = {}): PhotoPick => ({
  slot: '가상각 웹사이트의 지도에서 찾기 화면에 가상역사박물관 위치가 표시된 모습',
  nth: 1,
  same: 1,
  heading: '지도',
  src: mapAppSrc('vmap', MID),
  alt: '군산 지도 — 가상역사박물관 · 가상해양공원 위치',
  pageUrl: 'https://gunsan.webforai.kr/map/',
  confirmedAt: '2026-11-05T00:00:00.000Z',
  auto: true,
  origin: 'osm-map',
  mapId: MID,
  mapVariant: VARIANT,
  caption: '가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.',
  credit: MAP_CREDIT,
  ...over,
})
ok('반복 열쇠 — 지도는 「osm-map:변형」(그린 파일이 달라도 같은 장소 묶음은 같은 지도), 브랜드 상한은 받지 않는다', photoRepeatKey(mapPick()) === `osm-map:${VARIANT}` && brandRepeatExempt(mapPick()))
ok('출처 상태 — 출처 줄이 맞으면 내보낸다(site), 출처가 없거나 다르면 missing', photoCreditState(mapPick()) === 'site' && photoCreditState(mapPick({ credit: undefined })) === 'missing' && photoCreditState(mapPick({ credit: '다른 출처' })) === 'missing')
ok('글에 넣을 주소 — 앱 주소 · 지도 id가 맞을 때만', photoPickSrc(mapPick()) === mapAppSrc('vmap', MID) && photoPickSrc(mapPick({ mapId: 'ffffffffffffffff' })) === null && photoPickSrc(mapPick({ src: 'https://x.example/a.png' })) === null && photoPickSrc(mapPick({ mapVariant: '' })) === null)
const md = ['# 가상 글', '', '## 지도', '', '![가상각 웹사이트의 지도에서 찾기 화면에 가상역사박물관 위치가 표시된 모습](#image-slot)', '*지도에서 찾기로 관광지 위치를 확인할 수 있습니다.*', '', '끝 문단'].join('\n')
const placed = withPhotos(md, [mapPick()])
const lines = placed.markdown.split('\n')
ok(
  '글에 넣기 — 그림 줄은 지도 대체 텍스트 · 앱 주소, 그림 바로 아래 줄은 출처 줄, 그다음 줄은 사이트 기능 문장 대신 위치 문장',
  lines[4] === `![군산 지도 — 가상역사박물관 · 가상해양공원 위치](${mapAppSrc('vmap', MID)})` &&
    lines[5] === `*${MAP_CREDIT}*` &&
    lines[6] === '*가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.*' &&
    lines[7] === '' &&
    !placed.markdown.includes('지도에서 찾기로 관광지 위치를'),
)
ok('글에 넣기 — 넣은 지도는 map 표시(JSON-LD · og:image에서 뺀다) · 공공 사진 출처는 없다', placed.applied.length === 1 && placed.applied[0]!.map?.mapId === MID && placed.applied[0]!.map?.credit === MAP_CREDIT && !placed.applied[0]!.credit)
const noCaption = withPhotos(md.replace('*지도에서 찾기로 관광지 위치를 확인할 수 있습니다.*\n', ''), [mapPick()]).markdown.split('\n')
ok(
  '설명 줄이 없는 자리 — 출처 줄과 위치 문장을 차례로 끼운다',
  noCaption[5] === `*${MAP_CREDIT}*` && noCaption[6] === '*가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.*' && noCaption[8] === '끝 문단',
)
const crlf = withPhotos(md.replace(/\n/g, '\r\n'), [mapPick()]).markdown
ok(
  'CRLF 원고 — 줄 끝을 지킨다(끼운 줄도)',
  crlf.split('\r\n')[5] === `*${MAP_CREDIT}*` && crlf.split('\r\n')[6] === '*가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.*' && !/[^\r]\n/.test(crlf),
)
const crlfNoCaption = withPhotos(md.replace('*지도에서 찾기로 관광지 위치를 확인할 수 있습니다.*\n', '').replace(/\n/g, '\r\n'), [mapPick()]).markdown
ok(
  'CRLF 원고 · 설명 줄 없음 — 끼운 두 줄도 CRLF',
  crlfNoCaption.split('\r\n')[5] === `*${MAP_CREDIT}*` && crlfNoCaption.split('\r\n')[6]!.startsWith('*가상역사박물관') && !/[^\r]\n/.test(crlfNoCaption),
)
const lastLine = withPhotos(['## 지도', '', '![가상각 웹사이트의 지도에서 찾기 화면에 가상역사박물관 위치가 표시된 모습](#image-slot)'].join('\r\n'), [mapPick()]).markdown
ok(
  'CRLF 원고의 마지막 줄 자리 — 끼운 두 줄 사이도 CRLF, 마지막 줄은 줄 끝 없이',
  lastLine.endsWith(`\r\n*${MAP_CREDIT}*\r\n*가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.*`) && !/[^\r]\n/.test(lastLine),
)
ok('출처 줄이 없는 지도는 넣지 않는다', withPhotos(md, [mapPick({ credit: undefined })]).applied.length === 0)
const html = markdownToHtml(placed.markdown)
ok(
  '본문 HTML — 지도 그림은 figure로, figcaption(그림 바로 아래)은 출처 줄, 바로 다음 문단이 위치 문장',
  html.includes(`<figure><img src="${mapAppSrc('vmap', MID)}" alt="군산 지도 — 가상역사박물관 · 가상해양공원 위치"`) &&
    html.includes(`<figcaption>${MAP_CREDIT.replace(/&/g, '&amp;')}</figcaption></figure>\n<p><em>가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.</em></p>`),
)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0x20, 8, 6, 0, 0, 0])
const fetched: string[] = []
const inl = await inlineScreens(html, async (src) => {
  fetched.push(src)
  return new Blob([PNG], { type: 'image/png' })
})
ok('내보낼 HTML — 지도 그림을 문서 안(data:)에 넣고 앱 주소가 남지 않으며 출처 줄은 그대로', inl.inlined === 1 && fetched.join() === mapAppSrc('vmap', MID) && exportLeaks(inl.html).length === 0 && inl.html.includes('OpenStreetMap contributors'))
const dropped = await inlineScreens(html, async () => {
  throw new Error('받지 못함')
})
ok('받지 못한 지도 — 「[지도: …]」 글자로, 앱 주소 없이', dropped.dropped === 1 && dropped.html.includes('[지도: 군산 지도 — 가상역사박물관 · 가상해양공원 위치]') && exportLeaks(dropped.html).length === 0)
ok('글자 내보내기 — 지도 그림 대신 「[지도: …] 출처 줄」 한 줄, 그다음 줄이 위치 문장(출처 줄은 한 번)', (() => {
  const plain = screenPlainText(placed.markdown).split('\n')
  return (
    plain[4] === `[지도: 군산 지도 — 가상역사박물관 · 가상해양공원 위치] ${MAP_CREDIT}` && plain[5] === '*가상역사박물관 · 가상해양공원 위치를 지도에 표시했습니다.*' &&
    plain.join('\n').split(MAP_CREDIT).length === 2 && exportLeaks(plain.join('\n')).length === 0
  )
})())
ok('앱 안 글 미리보기 — 지도 그림도 「[지도: …]」 글자로(앱 주소를 그리지 않는다)', exportLeaks(screenPreviewHtml(html)).length === 0 && screenPreviewHtml(html).includes('[지도: '))
ok('앱 주소 새기 검사는 /api/maps/도 본다', exportLeaks(`a ${mapAppSrc('vmap', MID)}`).includes('/api/maps/'))
const table = photoCreditsTable([{ name: '사진1-지도.png', photo: placed.applied[0]! }], '2026-11-05')
ok('사진 출처 파일 — 지도 그림 줄에 출처 줄(ODbL)이 있다', table.includes('사진1-지도.png') && table.includes(MAP_CREDIT) && table.endsWith('\r\n'))

// ── 실제 지도 자리(선택) ─────────────────────────────────────────────────────
const [slotsFile, pointsFile] = process.argv.slice(2)
if (slotsFile && pointsFile) {
  const real = normalizeMapPoints(JSON.parse(readFileSync(pointsFile, 'utf8')))
  const rows = JSON.parse(readFileSync(slotsFile, 'utf8')) as { writer: string; slot: string; caption: string; heading: string; section: string }[]
  console.log(`\n실제 지도 자리 ${rows.length}곳 · 장소 ${real.points.length}곳(뺀 것 ${real.skipped})`)
  let all = true
  rows.forEach((r, i) => {
    const c = mapChoiceOf({ key: r.slot, caption: r.caption, heading: r.heading, section: r.section }, real.points, regions)
    if ('miss' in c) {
      all = false
      console.log(`${i + 1}. ${r.writer} — 표지 없음(${c.miss}): ${c.why}`)
      return
    }
    const v = c.variants[0]!
    if (v.markers.some((m) => inMapAvoid(m)) || v.markers.length > MAP_MAX_MARKERS || !mapAltOf(v.markers).startsWith('군산 지도 — ')) all = false
    console.log(`${i + 1}. ${r.writer} [${c.by}] ${v.markers.map((m) => m.label).join(' · ')}\n    까닭: ${c.why}`)
  })
  ok(`실제 지도 자리 — 모든 자리에 표지 · 공군기지 상자 밖 · ${MAP_MAX_MARKERS}곳 이하 · 대체 텍스트가 지도`, all && rows.length > 0)
  ok('실제 장소 목록 — 공군기지 상자 안 장소가 있으면 그 장소는 고르지 않는다', real.points.filter((p) => inMapAvoid(p)).every((p) => rows.every((r) => {
    const c = mapChoiceOf({ key: r.slot, caption: r.caption, heading: r.heading, section: r.section }, real.points, regions)
    return 'miss' in c || c.variants.every((v) => !v.ids.includes(p.id))
  })))
}
ok('공군기지 상자 상수', MAP_AVOID.join() === '126.598,35.876,126.656,35.952')

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
