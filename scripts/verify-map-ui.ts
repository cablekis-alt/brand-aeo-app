/**
 * 군산 지도 그림의 화면 쪽을 확인한다 — 자동 채우기 미리보기 · 글의 「홈페이지 사진」 칸이 함께 쓰는 지도 칸(src/components/MapPickBrief.tsx),
 * 지도 자리의 까닭 줄(src/lib/photoAutoPick.ts mapPickReason · mapMissText), 그리지 못한 까닭 · 출처 안내 글자(src/lib/mapImage.ts), 화면이
 * 부르는 지도 API(src/lib/api.ts loadMaps · loadMapPoints · renderMaps — 가짜 fetch). 서버 · 메인 프로세스 · 바깥 주소는 부르지 않는다.
 *
 * 왜:
 * - 앱이 그린 지도는 늘 「확인 필요」다(표지 · 위치 문장을 자리 글자로 골랐다) — 어디서 보든 같은 칩 「군산 지도(OSM) · 확인 필요」와 출처 줄이
 *   보여야 운영자가 사이트 화면으로 착각하지 않는다. 썸네일은 그린 크기(1280×800) 그대로 16:10.
 * - 지도에서 뺀 장소의 까닭은 중립 글자로만 보인다 — 「표시하지 않은 곳: … (지도에 넣지 않는 구역)」. 어떤 시설인지 적지 않는다.
 * - 웹(Vercel)에는 지도 라우트가 없다 — 화면은 그것을 「데스크톱 앱에서만」으로 알아야 하고(null), 다른 실패와 섞지 않는다.
 *
 *   npx tsx scripts/verify-map-ui.ts
 */
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MapPickBrief, { MapDraftFigure } from '../src/components/MapPickBrief'
import { loadMapPoints, loadMaps, renderMaps } from '../src/lib/api'
import { MAP_CREDIT, MAP_PICK_CHIP, mapAppSrc, mapCreditNote, mapDrawFailText, mapLeftOutText, mapVariantKey, type MapPoint } from '../src/lib/mapImage'
import { autoPickPhotos, mapMissText, mapPickReason, type AutoMapDrawn } from '../src/lib/photoAutoPick'

// 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다(verify-post-edits.ts와 같다).
Object.assign(globalThis, { React })

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const NOT_NEUTRAL = /공군|군사|군부대|비행장|기지 상자|military|air ?base/i

// ── 지도 칸(MapPickBrief) ────────────────────────────────────────────────────
const SRC = mapAppSrc('fake-gunsan', '00000000000000ef')
const drawnHtml = renderToStaticMarkup(
  React.createElement(MapPickBrief, { src: SRC, alt: '군산 지도 — 가상역사관 · 가상바다공원 위치', caption: '가상역사관 · 가상바다공원 위치를 지도에 표시했습니다.', auto: true }),
)
ok('칩 글자는 「군산 지도(OSM) · 확인 필요」', MAP_PICK_CHIP === '군산 지도(OSM) · 확인 필요')
ok(
  '그린 지도 — 썸네일은 앱 주소 · 16:10, 「자동」 · 지도 칩(확인 필요 색) · 대체 텍스트 · 위치 문장 · 출처 줄',
  drawnHtml.includes(`<img src="${SRC}"`) && drawnHtml.includes('aspect-ratio:16 / 10') && drawnHtml.includes('is-map') && drawnHtml.includes('>자동<') &&
    drawnHtml.includes(`<span class="status-pill st-warn no-glyph">${MAP_PICK_CHIP}</span>`) && drawnHtml.includes('군산 지도 — 가상역사관 · 가상바다공원 위치') &&
    drawnHtml.includes('가상역사관 · 가상바다공원 위치를 지도에 표시했습니다.') && drawnHtml.includes(MAP_CREDIT),
)
ok(
  '그린 지도 — 출처 줄이 위치 문장보다 먼저(내보낼 때 그림 아래 차례와 같다)',
  drawnHtml.indexOf(MAP_CREDIT) > 0 && drawnHtml.indexOf(MAP_CREDIT) < drawnHtml.indexOf('가상역사관 · 가상바다공원 위치를 지도에 표시했습니다.'),
)
const pendingHtml = renderToStaticMarkup(React.createElement(MapPickBrief, { alt: '군산 지도 — 가상역사관 위치', caption: '가상역사관 위치를 지도에 표시했습니다.' }))
ok(
  '아직 그리지 않은 지도 — 그림 대신 「아직 그리지 않음」 자리(16:10) · 칩 · 출처 줄, 「자동」은 주지 않으면 없다',
  !pendingHtml.includes('<img') && pendingHtml.includes('아직 그리지 않음') && pendingHtml.includes(MAP_PICK_CHIP) && pendingHtml.includes(MAP_CREDIT) && !pendingHtml.includes('>자동<'),
)
const childHtml = renderToStaticMarkup(React.createElement(MapPickBrief, { src: SRC, alt: '군산 지도 — 가 위치', className: 'photo-picked' }, React.createElement('b', null, '빼기')))
ok('글의 사진 칸 — 바깥 틀 이름을 받고 단추(자식)를 글 끝에 둔다', childHtml.startsWith('<span class="photo-picked is-map">') && childHtml.includes('<b>빼기</b>'))
// 글 보기(DraftPanel)의 사진 자리 — 지도면 「홈페이지 사진」이 아니라 지도 칩, 자리의 사이트 기능 문장 대신 출처 줄 다음 위치 문장(내보낼 때와 같은 차례).
const figureHtml = renderToStaticMarkup(
  React.createElement(MapDraftFigure, { src: SRC, alt: '군산 지도 — 가상역사관 위치', caption: '가상역사관 위치를 지도에 표시했습니다.' }),
)
const creditAt = figureHtml.indexOf(MAP_CREDIT)
ok(
  '글 보기의 지도 자리 — 큰 그림(16:10) · 지도 칩 · 대체 텍스트, 그림 설명은 출처 줄 다음 위치 문장, 「홈페이지 사진」이라고 하지 않는다',
  figureHtml.startsWith('<figure class="draft-image-slot is-picked is-map">') && figureHtml.includes('class="draft-image-photo"') &&
    figureHtml.includes(`src="${SRC}"`) && figureHtml.includes('alt="군산 지도 — 가상역사관 위치"') && figureHtml.includes('aspect-ratio:16 / 10') &&
    figureHtml.includes(`<span class="status-pill st-warn no-glyph">${MAP_PICK_CHIP}</span>`) && creditAt > figureHtml.indexOf('<figcaption>') &&
    creditAt < figureHtml.indexOf('가상역사관 위치를 지도에 표시했습니다.') && !figureHtml.includes('홈페이지 사진'),
)
ok(
  '글 보기의 지도 자리 — 위치 문장이 없으면 출처 줄만',
  renderToStaticMarkup(React.createElement(MapDraftFigure, { src: SRC, alt: '군산 지도 — 가 위치' })).includes(`<figcaption><span style="display:block">${MAP_CREDIT}</span></figcaption>`),
)

// ── 까닭 줄(mapPickReason · mapMissText) ───────────────────────────────────
const MP = (id: string, name: string, kind: MapPoint['kind'], lng: number, lat: number, region = '원도심'): MapPoint => ({ id, name, kind, lng, lat, region })
const POINTS = [
  MP('m1', '가상역사관', 'attraction', 126.7121, 35.9908),
  MP('m2', '가상바다공원', 'attraction', 126.7175, 35.9893),
  MP('m3', '가상곰전시관', 'attraction', 126.7146, 35.9897),
  MP('m5', '가상빵집', 'food', 126.7112, 35.987),
  MP('m7', '기지옆골프장', 'attraction', 126.64, 35.92, '은파'),
]
const VERSION = 'v-points-ui'
const SLOT = (text: string) => ['## 1. 지도', '', `![군산각 웹사이트의 지도에서 찾기 화면에 ${text} 표시된 모습](#image-slot)`, '*지도에서 찾기로 위치를 확인할 수 있습니다.*'].join('\n')
const drawnOf = (ids: string[], over: Partial<AutoMapDrawn> = {}): AutoMapDrawn => {
  const markers = ids.map((x) => POINTS.find((p) => p.id === x)!).map((p) => ({ id: p.id, label: p.name, kind: p.kind }))
  return {
    id: '00000000000000ef',
    src: SRC,
    variant: mapVariantKey(ids),
    pointsVersion: VERSION,
    alt: `군산 지도 — ${markers.map((m) => m.label).join(' · ')} 위치`,
    caption: `${markers.map((m) => m.label).join(' · ')} 위치를 지도에 표시했습니다.`,
    source: 'https://gunsan.webforai.kr/map/',
    drawnAt: '2026-11-05T01:00:00.000Z',
    markers,
    ...over,
  }
}
const run = (text: string, drawn: AutoMapDrawn[], points = POINTS) =>
  autoPickPhotos({
    articles: [{ actionId: 'a1', generatedAt: '2026-11-05T00:00:00.000Z', markdown: SLOT(text) }],
    candidates: [],
    brandName: '군산각',
    ownedDomains: ['gunsan.webforai.kr'],
    screens: { available: false, shots: [] },
    maps: { available: true, points, pointsVersion: VERSION, drawn },
  }).articles[0]!.rows[0]!
const withAvoid = run('가상역사관 · 기지옆골프장 위치가', [])
const avoidLines = withAvoid.mapPick ? mapPickReason(withAvoid.mapPick) : []
ok(
  '까닭 — 자리 글자에 나온 장소 · 표지 목록 · 뺀 장소는 「표시하지 않은 곳: … (지도에 넣지 않는 구역)」',
  withAvoid.state === 'undrawn' && avoidLines.some((l) => l.includes('가상역사관')) && avoidLines.includes('표지 1곳: 가상역사관') &&
    avoidLines.some((l) => l.includes('표시하지 않은 곳: 기지옆골프장 (지도에 넣지 않는 구역)')),
)
ok('까닭 — 시설 이름을 쓰지 않는다(중립 글자)', avoidLines.length > 0 && avoidLines.every((l) => !NOT_NEUTRAL.test(l)))
const drawnRow = run('가상역사관 · 가상바다공원 위치가', [
  drawnOf(['m1', 'm2'], { markers: [{ id: 'm1', label: '가상역사관', kind: 'attraction' }], dropped: [{ id: 'm2', name: '가상바다공원', why: 'base' }], labelsDropped: ['가상역사관'] }),
])
const drawnLines = drawnRow.mapPick ? mapPickReason(drawnRow.mapPick) : []
ok(
  '그린 지도 — 실제로 그린 표지, 틀에서 뺀 장소(지도에 넣지 않는 구역을 피해 뺌), 이름이 겹쳐 표지만 넣은 곳',
  drawnRow.state === 'filled' && drawnLines.includes('표지 1곳: 가상역사관') &&
    drawnLines.includes(mapLeftOutText(['가상바다공원'], 'base')) && drawnLines.includes('이름이 겹쳐 표지만 넣은 곳: 가상역사관') && drawnLines.every((l) => !NOT_NEUTRAL.test(l)),
)
ok(
  '뺀 까닭 글자 — 구역 안은 「(지도에 넣지 않는 구역)」, 틀에서 뺀 곳은 「(지도에 넣지 않는 구역을 피해 뺌)」',
  mapLeftOutText(['가', '나']) === '표시하지 않은 곳: 가 · 나 (지도에 넣지 않는 구역)' && mapLeftOutText(['다'], 'base') === '표시하지 않은 곳: 다 (지도에 넣지 않는 구역을 피해 뺌)',
)
const onlyAvoid = run('기지옆골프장 위치가', [])
ok(
  '넣을 장소가 없는 자리 — 비워 두고 까닭은 중립 글자(뺀 장소 이름과 구역)',
  onlyAvoid.mapMiss === 'no-markers' && mapMissText(onlyAvoid).includes('표시하지 않은 곳: 기지옆골프장 (지도에 넣지 않는 구역)') && !NOT_NEUTRAL.test(mapMissText(onlyAvoid)),
)
const noPoints = run('가상역사관 위치가', [], [])
ok('장소 목록이 빈 자리 — 장소 목록이 비었다고 알린다', noPoints.mapMiss === 'no-points' && mapMissText(noPoints).includes('장소 목록'))

// ── 그리지 못한 까닭 · 출처 안내 ───────────────────────────────────────────
const areaCodes = ['no-markers', 'avoid-area', 'base-in-frame']
ok(
  '그리지 못한 까닭 — 구역 · 틀 문제는 중립 글자(메인 · 서버의 글은 쓰지 않는다), 그 밖은 서버 글',
  areaCodes.every((c) => mapDrawFailText(c, '군산 공군기지 주변과 겹칩니다.').includes('지도에 넣지 않는 구역') && !NOT_NEUTRAL.test(mapDrawFailText(c, '공군기지'))) &&
    mapDrawFailText('unavailable', 'x').includes('데스크톱 앱') && mapDrawFailText('bad-png', '그린 지도가 1280×800 PNG가 아니에요.') === '그린 지도가 1280×800 PNG가 아니에요.',
)
ok('출처 안내 — 지도 파일을 직접 올리면 지도 바로 아래에 적을 출처 줄', mapCreditNote(2).includes('군산 지도 2장') && mapCreditNote(2).includes(MAP_CREDIT))

// ── 화면이 부르는 지도 API(가짜 fetch) ───────────────────────────────────────
const g = globalThis as Record<string, unknown>
const calls: { url: string; init?: RequestInit }[] = []
let reply: () => Response = () => new Response('{}', { status: 200 })
g.fetch = async (url: string, init?: RequestInit) => {
  calls.push({ url, init })
  return reply()
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

reply = json({ error: 'Not Found' }, 404)
ok('웹(지도 라우트 없음, 404) — null(「데스크톱 앱에서만」으로 알린다)', (await loadMaps('gunsan')) === null && calls.at(-1)?.url === '/api/maps/gunsan')
reply = () => new Response('<!doctype html><title>404</title>', { status: 404 })
ok('웹의 404 HTML도 null', (await loadMaps('gunsan')) === null)
reply = json({ error: 'tenant not found: nope' }, 404)
const unknownTenant = await loadMaps('nope').then(
  () => 'resolved',
  (e: unknown) => (e instanceof Error ? e.message : String(e)),
)
ok('없는 브랜드는 null이 아니라 오류', unknownTenant.startsWith('tenant not found'))
const good = drawnOf(['m1', 'm2'])
reply = json({
  available: true,
  source: true,
  points: { fetchedAt: '2026-11-05T00:00:00.000Z', source: 'https://gunsan.webforai.kr/map/', version: VERSION, count: 5 },
  maps: [good, { ...good, id: '00000000000000aa' }, { ...good, src: 'https://evil.example/x.png' }, { id: 'x' }],
})
const list = await loadMaps('gunsan')
ok(
  '지도 목록 — 그릴 수 있는지 · 장소 목록 판, 앱 주소의 id가 기록과 맞는 지도만 받는다',
  list?.available === true && list.source && list.points?.version === VERSION && list.maps.length === 1 && list.maps[0]!.id === good.id,
)
reply = json({ fetchedAt: '2026-11-05T00:00:00.000Z', source: 'https://gunsan.webforai.kr/map/', version: VERSION, fetched: false, stale: true, warning: '받지 못했어요', points: [...POINTS, { id: '나쁜 id', name: 'x', kind: 'food', lat: 1, lng: 1, region: '원도심' }] })
const pts = await loadMapPoints('gunsan')
ok('장소 목록 — 모양이 맞는 장소만, 판 · 오래된 목록 알림', pts.points.length === POINTS.length && pts.version === VERSION && pts.stale && pts.warning === '받지 못했어요' && calls.at(-1)?.url === '/api/maps/gunsan/points')
reply = json({ available: true, results: [{ ids: ['m1', 'm2'], ok: true, reused: false, map: good }, { ids: ['m7'], ok: false, code: 'no-markers', status: 422, message: '공군기지' }] })
const drawn = await renderMaps('gunsan', [{ ids: ['m1', 'm2'] }, { ids: ['m7'] }])
const sent = JSON.parse(String(calls.at(-1)?.init?.body ?? '{}')) as { maps?: { ids: string[] }[] }
ok(
  '그리기 — 장소 id만 보내고(좌표 · 이름은 서버가), 장마다 결과(그린 지도 · code)',
  calls.at(-1)?.url === '/api/maps/gunsan/render' && calls.at(-1)?.init?.method === 'POST' && JSON.stringify(sent) === JSON.stringify({ maps: [{ ids: ['m1', 'm2'] }, { ids: ['m7'] }] }) &&
    drawn.length === 2 && drawn[0]!.ok === true && drawn[0]!.ok && drawn[0]!.map.id === good.id && drawn[1]!.ok === false && !drawn[1]!.ok && drawn[1]!.code === 'no-markers',
)
reply = json({ error: '이 실행에서는 지도를 그릴 수 없어요', code: 'unavailable', results: [] }, 503)
const unavailable = await renderMaps('gunsan', [{ ids: ['m1'] }]).then(
  () => 'resolved',
  (e: unknown) => (e as { code?: string }).code ?? 'other',
)
ok('그릴 수 없는 실행(503) — code unavailable로 던진다', unavailable === 'unavailable')
reply = json({ available: true, results: [{ ids: ['m1'], ok: true, reused: true, map: { ...good, src: '/api/maps/gunsan/00000000000000aa.png' } }] })
const badMap = await renderMaps('gunsan', [{ ids: ['m1'] }])
ok('그린 지도의 앱 주소 id가 기록과 다르면 실패로 받는다', badMap.length === 1 && badMap[0]!.ok === false)

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
