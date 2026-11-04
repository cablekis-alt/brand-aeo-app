/**
 * 지도 틀 정하기(server/mapFrame.ts frameFor — OSM 시험 frames.cjs를 옮긴 것)를 확인한다. 시험 때 그린 7틀(원도심 · 은파 · 고군산 · 금강 ·
 * 새만금 · 슬롯 · 식당+관광지)의 표지를 그대로 넣어 시험 결과와 같은 줌 · 중심 · 쪽 · 옮긴 거리가 나오는지, 그리고 모든 틀이 공군기지
 * 상자(MAP_AVOID)와 겹치지 않고 지도 데이터 범위(MAP_COVER) 안인지 본다. 메인 프로세스(electron/mapRender.cjs)의 범위 계산 · 틀 검사로도
 * 한 번 더 본다(electron은 가짜로 바꿔 읽는다 — 창을 열지 않는다).
 *
 * 왜: 지도 그림은 공개 블로그에 나간다 — 공군기지가 틀에 들어가면 안 된다. 서버가 정한 틀을 메인이 거절하면 그 자리는 지도를 얻지 못한다
 * (두 계산이 같아야 한다).
 *
 *   npx tsx scripts/verify-map-frame.ts
 */
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import { boxesOverlap, frameFor, mapFrameBounds, MAP_MAX_ZOOM } from '../server/mapFrame'
import { MAP_AVOID, MAP_COVER, inMapBox } from '../src/lib/mapImage'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps
/** 틀 범위가 데이터 범위 안인가 — 부동소수 오차(1e-9도)는 봐준다(메인 assertFrame은 1e-6). */
const inCover = (b: readonly number[]) => b[0]! >= MAP_COVER[0] - 1e-9 && b[1]! >= MAP_COVER[1] - 1e-9 && b[2]! <= MAP_COVER[2] + 1e-9 && b[3]! <= MAP_COVER[3] + 1e-9

type M = { label: string; kind: string; lng: number; lat: number }
const m = (label: string, kind: string, lng: number, lat: number): M => ({ label, kind, lng, lat })

// 시험 때 그린 7틀(scratchpad osm-probe out/v2-final — 표지는 자사 사이트 /map/의 좌표)과 그 결과.
const FRAMES: { name: string; markers: M[]; zoom: number; side: string; shiftPx: number; center: [number, number]; dropped?: string[] }[] = [
  {
    name: 'a 원도심',
    markers: [
      m('월명공원', 'attraction', 126.7035133045, 35.9904315794),
      m('해망굴', 'attraction', 126.7048496204, 35.9913180812),
      m('근대역사박물관', 'attraction', 126.7121231556, 35.9908197098),
      m('진포해양공원', 'attraction', 126.717450815797, 35.9892997236059),
      m('초원사진관', 'attraction', 126.7083709916, 35.9876938877),
      m('히로쓰가옥', 'attraction', 126.7061578421, 35.9863009684),
      m('동국사', 'attraction', 126.7075713729, 35.9829030983),
      m('경암동 철길마을', 'attraction', 126.7362330582, 35.9813520474),
    ],
    zoom: 14.3,
    side: 'east-of-base',
    shiftPx: 0,
    center: [126.71987318135001, 35.9863352216531],
  },
  {
    name: 'b 은파',
    markers: [
      m('은파호수공원', 'attraction', 126.689054418, 35.9553560827),
      m('은파호수공원 물빛다리', 'attraction', 126.6937040928, 35.9507456042),
      m('국립군산대학교 박물관', 'attraction', 126.6851337236, 35.945516022),
      m('군산문화원', 'attraction', 126.693392642605, 35.964932786928),
      m('은적사', 'attraction', 126.6850378051, 35.9748658021),
      m('한길문고', 'attraction', 126.70077976286805, 35.9621896931893),
      m('호텔 은파 팰리스', 'stay', 126.6897998556, 35.9540630789),
      m('라마다 군산호텔', 'stay', 126.6901516474, 35.9589621493),
    ],
    zoom: 13.41,
    side: 'east-of-base',
    shiftPx: 69,
    center: [126.69734283669038, 35.9601922754505],
  },
  {
    name: 'c 고군산',
    markers: [
      m('선유도해수욕장', 'attraction', 126.4110512809, 35.8161291406),
      m('장자도', 'attraction', 126.3973, 35.8101),
      m('대장봉', 'attraction', 126.394605, 35.817354),
      m('무녀도', 'attraction', 126.4178106318, 35.7996423796),
      m('고군산대교', 'attraction', 126.4443606944, 35.8130885149),
      m('신시도 어촌체험마을', 'attraction', 126.4675985243, 35.8209073033),
      m('선유 스카이썬라인', 'attraction', 126.408932082192, 35.8144487505323),
      m('몽돌해변', 'attraction', 126.4022890673, 35.8284888289),
    ],
    zoom: 13.14,
    side: 'west-of-base',
    shiftPx: 0,
    center: [126.43110176214998, 35.81406691423475],
  },
  {
    name: 'd 금강',
    markers: [
      m('금강호 시민공원', 'attraction', 126.764874, 36.020644),
      m('금강하구둑', 'attraction', 126.7496865132, 36.0159483282),
      m('채만식 문학관', 'attraction', 126.757885329316, 36.0085981064483),
      m('진포시비공원', 'attraction', 126.7537664448, 36.0022654615),
      m('금강습지생태공원', 'attraction', 126.7670486805, 36.0224284414),
      m('오성산', 'attraction', 126.7843140363, 36.0134436524),
      m('진포대첩 기념탑', 'attraction', 126.756133279, 36.0113100792),
      m('나포십자뜰철새관찰소', 'attraction', 126.8234, 36.0358),
    ],
    zoom: 13.13,
    side: 'east-of-base',
    shiftPx: 0,
    center: [126.7865432566, 36.019034514510146],
  },
  {
    name: 'e 새만금 · 비응(새만금어린이랜드는 빠진다)',
    markers: [
      m('비응항', 'attraction', 126.53080123680301, 35.93871118923199),
      m('비응도 풍력발전단지', 'attraction', 126.531716, 35.959609),
      m('새만금비응공원', 'attraction', 126.538985937, 35.943885973),
      m('비응 마파지길', 'attraction', 126.5312865479, 35.9448244719),
      m('생말공원', 'attraction', 126.5701955001, 35.9672674923),
      m('군산어린이교통공원', 'attraction', 126.58414164879038, 35.960736545578264),
      m('새만금어린이랜드', 'attraction', 126.5935, 35.9485),
    ],
    zoom: 13.45,
    side: 'west-of-base',
    shiftPx: 0,
    center: [126.55747144279667, 35.952990631102125],
    dropped: ['새만금어린이랜드'],
  },
  {
    name: 'f 슬롯(근대역사박물관 · 진포해양공원 · 초원사진관 · 히로쓰가옥)',
    markers: [
      m('근대역사박물관', 'attraction', 126.7121231556, 35.9908197098),
      m('진포해양공원', 'attraction', 126.717450815797, 35.9892997236059),
      m('초원사진관', 'attraction', 126.7083709916, 35.9876938877),
      m('히로쓰가옥', 'attraction', 126.7061578421, 35.9863009684),
    ],
    zoom: 15.84,
    side: 'east-of-base',
    shiftPx: 0,
    center: [126.71180432894852, 35.98856037145198],
  },
  {
    name: 'g 식당 + 관광지',
    markers: [
      m('초원사진관', 'attraction', 126.7083709916, 35.9876938877),
      m('동국사', 'attraction', 126.7075713729, 35.9829030983),
      m('근대역사박물관', 'attraction', 126.7121231556, 35.9908197098),
      m('히로쓰가옥', 'attraction', 126.7061578421, 35.9863009684),
      m('이성당', 'food', 126.7111681428, 35.9870443303),
      m('한일옥', 'food', 126.7082350808, 35.9874081251),
      m('빈해원', 'food', 126.713962273, 35.9888386077),
      m('대정소바', 'food', 126.7096181, 35.985277),
      m('일해옥', 'food', 126.7089276, 35.9848788),
    ],
    zoom: 15.3,
    side: 'east-of-base',
    shiftPx: 0,
    center: [126.71006005754998, 35.98686150334277],
  },
]

// 메인 프로세스의 범위 계산 · 틀 검사(electron/mapRender.cjs) — 가짜 electron으로 읽는다(함수 안에서만 쓰인다).
interface MapModule {
  frameBounds: (center: [number, number], zoom: number) => number[]
  assertFrame: (bounds: number[], markers?: { lng: number; lat: number }[]) => void
}
const req = createRequire(import.meta.url)
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
const realLoad = loader._load
loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === 'electron' ? { app: { isPackaged: false }, BrowserWindow: class {}, protocol: {}, session: {} } : realLoad.call(this, request, ...rest)
}
let main: MapModule
try {
  main = req(path.join(process.cwd(), 'electron', 'mapRender.cjs')) as MapModule
} finally {
  loader._load = realLoad
}
const mainAccepts = (bounds: number[], markers: { lng: number; lat: number }[]) => {
  try {
    main.assertFrame(bounds, markers)
    return true
  } catch {
    return false
  }
}

for (const f of FRAMES) {
  const r = frameFor(f.markers)
  if (!r.ok) {
    ok(`${f.name} — 틀이 나온다`, false)
    continue
  }
  ok(
    `${f.name} — 시험과 같은 줌 ${f.zoom} · ${f.side} · ${f.shiftPx}px · 중심`,
    r.zoom === f.zoom && r.side === f.side && r.shiftPx === f.shiftPx && near(r.center[0], f.center[0]) && near(r.center[1], f.center[1]),
  )
  ok(`${f.name} — 뺀 표지 ${(f.dropped ?? []).join(' · ') || '없음'}`, JSON.stringify(r.dropped.map((d) => d.marker.label)) === JSON.stringify(f.dropped ?? []))
  ok(`${f.name} — 공군기지 상자와 겹치지 않고 데이터 범위 안`, !boxesOverlap(r.bounds, MAP_AVOID) && inCover(r.bounds))
  ok(`${f.name} — 그릴 표지는 모두 틀 안`, r.markers.every((x) => inMapBox(x, r.bounds)))
  const mb = main.frameBounds(r.center, r.zoom)
  ok(`${f.name} — 메인의 범위 계산과 같고 메인 틀 검사를 통과`, mb.every((v, i) => near(v, r.bounds[i]!, 1e-9)) && mapFrameBounds(r.center, r.zoom).every((v, i) => near(v, r.bounds[i]!)) && mainAccepts(mb, r.markers))
}

// 공군기지 상자 안의 표지는 빠진다(why avoid) — 군산컨트리클럽(은파 쪽, 상자 안).
const inside = frameFor([m('군산컨트리클럽', 'attraction', 126.64, 35.92), ...FRAMES[1]!.markers])
ok(
  '공군기지 상자 안의 표지는 avoid로 빠지고 나머지로 틀을 만든다',
  inside.ok && inside.dropped.length === 1 && inside.dropped[0]!.why === 'avoid' && inside.dropped[0]!.marker.label === '군산컨트리클럽' && !boxesOverlap(inside.bounds, MAP_AVOID),
)
const onlyInside = frameFor([m('상자 안', 'attraction', 126.62, 35.9)])
ok('표지가 모두 상자 안이면 no-markers', !onlyInside.ok && onlyInside.why === 'no-markers' && onlyInside.dropped.length === 1)
ok('표지가 없으면 no-markers', (() => {
  const r = frameFor([])
  return !r.ok && r.why === 'no-markers'
})())

// 기지 양쪽(서 · 동)에 걸친 표지 — 기지에 가까운 표지부터 빼(why base) 한쪽에 놓인다.
const across = frameFor([m('비응항', 'attraction', 126.5308, 35.9387), m('은파호수공원', 'attraction', 126.689, 35.9553), m('근대역사박물관', 'attraction', 126.7121, 35.9908)])
ok(
  '기지 양쪽에 걸친 표지 — 기지에 가까운 것부터 base로 빼고 한쪽(east · west · north · south)에 놓인 틀',
  across.ok && across.dropped.length >= 1 && across.dropped.every((d) => d.why === 'base') && !boxesOverlap(across.bounds, MAP_AVOID) && across.side !== 'none',
)

// 데이터 범위 끝의 표지 — 틀이 범위 안으로 밀린다. 범위 밖으로만 맞는 넓은 표지 묶음은 표지를 빼서라도 범위 안에 둔다.
const edge = frameFor([m('북동 끝', 'attraction', 126.915, 36.065)])
ok('데이터 범위 끝의 표지 하나 — 틀이 범위 안으로 밀리고 표지는 틀 안', edge.ok && inCover(edge.bounds) && inMapBox(edge.markers[0]!, edge.bounds))
const wide = frameFor([m('서쪽 끝', 'attraction', 126.285, 35.71), m('동쪽 끝', 'attraction', 126.915, 36.065)])
ok(
  '데이터 범위 양 끝의 표지 — 범위를 넘는 틀은 만들지 않는다(표지를 빼 맞춘다)',
  wide.ok && wide.markers.length === 1 && wide.dropped.length === 1 && inCover(wide.bounds) && mainAccepts(main.frameBounds(wide.center, wide.zoom), wide.markers),
)
ok('표지 하나는 가장 큰 줌(16.3)', (() => {
  const r = frameFor([FRAMES[0]!.markers[2]!])
  return r.ok && r.zoom === MAP_MAX_ZOOM && r.fitZoom === MAP_MAX_ZOOM
})())
ok('피할 상자 없이(검사용) — side none', (() => {
  const r = frameFor(FRAMES[0]!.markers, { avoid: null })
  return r.ok && r.side === 'none' && r.zoom === 14.3
})())
ok('같은 입력이면 같은 틀', JSON.stringify(frameFor(FRAMES[6]!.markers)) === JSON.stringify(frameFor(FRAMES[6]!.markers)))
ok('표지 순서를 지킨다(그릴 표지 = 받은 순서에서 뺀 것만 없음)', (() => {
  const r = frameFor(FRAMES[4]!.markers)
  return r.ok && JSON.stringify(r.markers.map((x) => x.label)) === JSON.stringify(FRAMES[4]!.markers.slice(0, 6).map((x) => x.label))
})())

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
