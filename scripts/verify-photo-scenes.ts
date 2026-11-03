/**
 * 사진 장면(src/lib/photoScenes.ts · server/photoScenes.ts · /api/photo-scenes)과 장면으로 고르는 자동 채우기(src/lib/photoAutoPick.ts),
 * 「사람이 뺀 자리도 다시 채우기」(뺀 사진 기록 · 저장 검사)를 확인한다. 가짜 장면 · 가짜 주소 · 가짜 장면 읽기 함수만 쓰고, 비전 모델 ·
 * 바깥 사이트는 부르지 않는다(서버 길 확인은 임시 데이터 폴더로 포트 4104에 띄운다 — 받을 수 없는 사진 주소라 모델까지 가지 않는다).
 *
 * 왜:
 * - 2026-11-03 군산각 — 관광공사 사진(3단계)이 근대역사박물관 외관 자리 13곳을 2013년 실내 전시 · 디오라마 사진으로 채웠다(후보에 장면
 *   정보가 없어 첫 사진을 골랐다). 장면을 알면 외관 자리에 실내 사진을 넣지 않아야 하고(틀린 사진보다 빈자리), 맞는 사진이 뒤에 있으면
 *   찾아야 한다.
 * - 사람을 알아볼 수 있는 사진은 사람이 나오는 장면 자리가 아니면 넣지 않아야 한다(초상권).
 * - 장면은 사진 한 장에 한 번만 읽어야 한다(비용) — 디스크 캐시 · 원자적 쓰기 · 한 번에 읽는 상한 · 동시에 읽는 수.
 * - 키가 없으면 알리고 지금처럼 골라야 하고, 키는 응답 · 로그 어디에도 없어야 한다.
 * - 사람이 뺀 자리를 다시 채울 때 사람이 뺀 그 사진을 다시 넣으면 안 된다.
 *
 *   npx tsx scripts/verify-photo-scenes.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  autoPickPhotos,
  sceneFit,
  slotSceneWants,
  tourPlacesWanted,
  type AutoArticle,
  type AutoCandidate,
  type AutoPickResult,
} from '../src/lib/photoAutoPick'
import { parseScene, scenesToRead, spreadByMonth, validScene, type PhotoScene, type SceneWant } from '../src/lib/photoScenes'
import { TOUR_SOURCES } from '../src/lib/tourPhotos'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const dir = mkdtempSync(path.join(tmpdir(), 'verify-photo-scenes-'))
process.env.APP_DATA_DIR = dir
process.env.BLOB_READ_WRITE_TOKEN = ''
process.env.BLOB_STORE_ID = ''
delete process.env.PHOTO_SCENE_MODEL
const AT = '2026-11-03T00:00:00.000Z'

// 1) 장면 모양 검사
const meta = { model: 'fake-vision', describedAt: AT }
const good = parseScene({ text: '초록 외벽의 박물관 건물과 앞마당, 사람 없음', setting: 'exterior', people: 'none', time: 'day', tags: [' 앞 마당 ', '외관', '외관', 3, ''] }, meta)
ok('장면 — 낱말은 띄어쓰기를 지우고 한 번씩, 글자가 아닌 것은 버린다', JSON.stringify(good?.tags) === JSON.stringify(['앞마당', '외관']) && good?.model === 'fake-vision')
ok('장면 — 종류 · 사람 · 시간이 정해진 값이 아니면 버린다', parseScene({ text: '박물관', setting: 'outdoor', people: 'none', time: 'day', tags: [] }, meta) === null)
ok('장면 — 낱말 목록이 없으면 버린다', parseScene({ text: '박물관', setting: 'exterior', people: 'none', time: 'day' }, meta) === null)
ok('장면 — 모델 · 시각이 없으면 버린다', parseScene({ text: '박물관', setting: 'exterior', people: 'none', time: 'day', tags: [] }, { model: '', describedAt: AT }) === null)
const long = parseScene({ text: '가'.repeat(300), setting: 'other', people: 'none', time: 'unknown', tags: Array.from({ length: 30 }, (_, i) => `낱말${i}`) }, meta)
ok('장면 — 설명은 120자 · 낱말은 12개까지', long?.text.length === 120 && long.tags.length === 12)
ok('저장된 장면 검사(validScene) — 자기 모델 · 시각으로', validScene(good) !== null && validScene({ ...good, setting: 'x' }) === null)

// 2) 읽을 사진 고르기 — 촬영 연월이 고루, 장소마다 · 모두 상한
const MONTHS: [string, number][] = [['201301', 46], ['201411', 7], ['201506', 22], ['202001', 37], ['202112', 3]]
const gallery: SceneWant[] = MONTHS.flatMap(([month, n]) =>
  Array.from({ length: n }, (_, i) => ({ src: `https://tong.visitkorea.or.kr/cms2/website/${month}-${i}.jpg`, source: 'tour' as const, place: '근대역사박물관', month })),
)
ok('군산근대역사박물관 115장 모양', gallery.length === 115)
const spread = spreadByMonth(gallery).slice(0, 40)
const byMonth = (list: readonly SceneWant[]) => list.reduce<Record<string, number>>((m, w) => ({ ...m, [w.month!]: (m[w.month!] ?? 0) + 1 }), {})
ok('연월이 고루 — 앞 40장에 다섯 시기가 다 들어가고 2013-01은 10장', Object.keys(byMonth(spread)).length === 5 && byMonth(spread)['201301'] === 10 && byMonth(spread)['202112'] === 3)
const wanted: SceneWant[] = [
  { src: 'https://gunsan.example/img/h1.jpg', source: 'site' },
  ...gallery,
  { src: 'https://gunsan.example/places/p1.jpg', source: 'public', place: '근대역사박물관' },
]
const plan = scenesToRead(wanted, new Set(wanted.map((w) => w.src)), { perPlace: 40, total: 150 })
ok(
  '새로 읽을 사진 — 홈페이지 → 장소 페이지 → 관광공사 순서, 장소마다 40장(장소 페이지 사진도 셈), 남은 수 · 상한에 걸린 장소',
  plan.read[0] === wanted[0]!.src && plan.read[1] === 'https://gunsan.example/places/p1.jpg' && plan.read.length === 41 && plan.left === 117 - 41 &&
    JSON.stringify(plan.cappedPlaces) === JSON.stringify(['근대역사박물관']),
)
ok(
  '같은 실행에서 이미 읽은 장소별 수(used)도 장소 상한에 센다',
  scenesToRead(gallery, new Set(gallery.map((w) => w.src)), { perPlace: 40, total: 150, used: new Map([['근대역사박물관', 30]]) }).read.length === 10,
)
ok('이미 읽은 사진은 다시 고르지 않고, 모두 합친 상한을 지킨다', scenesToRead(wanted, new Set([wanted[0]!.src]), { perPlace: 40, total: 150 }).read.length === 1 && scenesToRead(wanted, new Set(wanted.map((w) => w.src)), { perPlace: 40, total: 10 }).read.length === 10)

// 3) 자리가 바라는 장면 · 장면 맞추기
const PLACES = ['근대역사박물관', '진포해양공원', '가상근대관']
const wantsOf = (key: string, caption = '') => slotSceneWants({ key, caption }, PLACES.filter((p) => key.includes(p) || caption.includes(p)))
const ext = wantsOf('군산 근대역사박물관 건물 외관과 앞마당')
ok('외관 · 앞마당 자리는 바깥(전경 포함), 장소 이름은 낱말에서 뺀다', ext.settings?.[0] === 'exterior' && ext.settings.includes('aerial') && !ext.settings.includes('interior') && ext.key.includes('외관') && !ext.key.some((w) => w.includes('박물관')))
ok('가족이 걷는 외관 자리는 사람 장면 · 바깥', wantsOf('근대역사박물관 외관과 주변 산책로를 걷는 가족').people && wantsOf('근대역사박물관 외관과 주변 산책로를 걷는 가족').settings?.[0] === 'exterior')
ok('입구 · 안내판 자리는 바깥에 가까이 찍은 사진도', JSON.stringify(wantsOf('근대역사박물관 입구와 이용시간 안내판').settings) === JSON.stringify(['exterior', 'aerial', 'closeup']))
const dusk = wantsOf('해 질 무렵 하늘빛이 남아 있는 진포해양공원 풍경')
ok('해 질 무렵 풍경 자리는 바깥 · 해 질 무렵만', dusk.settings?.[0] === 'exterior' && JSON.stringify(dusk.times) === JSON.stringify(['dusk']))
ok('전시실 내부 자리는 실내', wantsOf('근대역사박물관 전시실 내부').settings?.[0] === 'interior')
ok('장소 이름 속 「공원」은 바깥 낱말이 아니다(진포해양공원 전시관 내부 → 실내)', wantsOf('진포해양공원 전시관 내부 모습').settings?.[0] === 'interior')
ok('낮 자리는 낮 · 시간 모름까지', JSON.stringify(wantsOf('낮 시간에 근대역사박물관 건물 앞을 둘이 걸어가는 장면').times) === JSON.stringify(['day', 'unknown']))
ok('장면 낱말이 없는 자리는 종류 · 시간을 정하지 않는다', wantsOf('군산 여행 이야기').settings === null && wantsOf('군산 여행 이야기').times === null)

const S = (over: Partial<PhotoScene>): PhotoScene => ({
  text: '초록 외벽의 박물관 건물과 앞마당, 사람 없음', setting: 'exterior', people: 'none', time: 'day', tags: ['외관', '앞마당', '건물'], model: 'fake-vision', describedAt: AT, ...over,
})
const DIORAMA = S({ text: '옛 군산 거리를 재현한 실내 디오라마 전시, 사람 없음', setting: 'interior', time: 'unknown', tags: ['전시실', '디오라마', '모형'] })
ok('외관 자리에 실내 디오라마 사진 — 장면 종류가 달라 뺀다', sceneFit(ext, DIORAMA).ok === false && sceneFit(ext, DIORAMA).miss === 'setting')
ok('외관 자리에 가까이 찍은 전시물 — 뺀다(안내판 자리가 아니면)', sceneFit(ext, S({ setting: 'closeup', tags: ['전시물'] })).miss === 'setting')
ok('안내판 자리에는 가까이 찍은 안내판 사진을 받는다', sceneFit(wantsOf('근대역사박물관 입구와 이용시간 안내판'), S({ setting: 'closeup', tags: ['안내판', '이용시간'] })).ok)
ok('외관 사진 — 맞은 낱말(외관 · 앞마당 · 건물)로 점수', sceneFit(ext, S({})).ok && ['외관', '앞마당', '건물'].every((w) => sceneFit(ext, S({})).words.includes(w)) && sceneFit(ext, S({})).score === 2 * 3 + 1)
ok('해 질 무렵 자리에 낮 사진 — 시간대가 달라 뺀다', sceneFit(dusk, S({ tags: ['바다', '공원'] })).miss === 'time')
ok('해 질 무렵 자리에 노을 사진 — 넣고 시간 점수', sceneFit(dusk, S({ time: 'dusk', tags: ['하늘', '노을'] })).ok && sceneFit(dusk, S({ time: 'dusk', tags: ['하늘', '노을'] })).score >= 2 + 1 + 1)
ok('화면 캡처 · 그림은 어느 자리에도 넣지 않는다', sceneFit(wantsOf('군산 여행 이야기'), S({ setting: 'screen' })).miss === 'kind' && sceneFit(wantsOf('군산 여행 이야기'), S({ setting: 'illustration' })).miss === 'kind')
ok('사람을 알아볼 수 있는 사진 — 사람 장면 자리가 아니면 뺀다', sceneFit(ext, S({ people: 'identifiable' })).miss === 'people')
ok('사람을 알아볼 수 있는 사진 — 사람 장면 자리에는 받는다(「확인 필요」)', sceneFit(wantsOf('근대역사박물관 외관과 주변 산책로를 걷는 가족'), S({ people: 'identifiable' })).ok)
ok('멀리 작게 보이는 사람은 받는다', sceneFit(ext, S({ people: 'distant' })).ok)
ok('장면 설명의 「사람 없음」은 자리의 「사람」 낱말과 맞지 않는다', !sceneFit(wantsOf('사람이 오가는 근대역사박물관 앞 거리'), S({ text: '박물관 앞 거리, 사람 없음', tags: ['거리'] })).words.includes('사람'))

// 4) 장면으로 고르기 — 관광공사 사진 · 홈페이지 사진
const tour = (name: string, place: string, month: string): AutoCandidate => ({
  src: `https://tong.visitkorea.or.kr/cms2/website/${name}.jpg`, alt: place === '근대역사박물관' ? '군산근대역사박물관' : place, pageUrl: TOUR_SOURCES.gallery.page,
  origin: 'public', place, license: 'kogl-1', licenseType: 1, creditText: '한국관광공사 김지호', tour: 'gallery', month,
})
const T = {
  t1: tour('t1', '근대역사박물관', '201301'),
  t2: tour('t2', '근대역사박물관', '201301'),
  t3: tour('t3', '근대역사박물관', '201301'),
  t4: tour('t4', '근대역사박물관', '201506'),
  t5: tour('t5', '근대역사박물관', '201411'),
  t6: tour('t6', '근대역사박물관', '202001'),
  t7: tour('t7', '근대역사박물관', '202112'),
  j1: tour('j1', '진포해양공원', '201506'),
  j2: tour('j2', '진포해양공원', '202001'),
}
const scenes = new Map<string, PhotoScene>([
  [T.t1.src, DIORAMA],
  [T.t2.src, S({ setting: 'interior', time: 'unknown', text: '근대 유물이 놓인 전시실, 사람 없음', tags: ['전시실', '유물'] })],
  [T.t3.src, S({ setting: 'interior', time: 'unknown', text: '옛 상점 모형', tags: ['모형', '전시물'] })],
  [T.t4.src, S({ setting: 'closeup', time: 'unknown', text: '전시 유물 근접', tags: ['유물'] })],
  [T.t5.src, S({})],
  [T.t6.src, S({ people: 'identifiable', text: '박물관 외관 앞 산책로를 걷는 사람들', tags: ['외관', '산책로', '사람'] })],
  [T.t7.src, S({ text: '박물관 건물 외관', tags: ['외관', '건물'] })],
  [T.j1.src, S({ text: '바다와 공원 산책로, 낮', tags: ['바다', '공원'] })],
  [T.j2.src, S({ time: 'dusk', text: '노을 진 하늘과 바다', tags: ['노을', '하늘', '바다'] })],
])
const H1: AutoCandidate = { src: 'https://gunsan.example/img/h1.jpg', alt: '근대역사박물관 건물 외관과 앞마당', pageUrl: 'https://gunsan.example/' }
scenes.set(H1.src, DIORAMA)
const doc = (id: string, body: string[], over: Partial<AutoArticle> = {}): AutoArticle => ({ actionId: id, generatedAt: AT, markdown: ['# 가상 글', '', ...body].join('\n'), ...over })
const EXT_SLOT = '군산 근대역사박물관 건물 외관과 앞마당'
const a1 = doc('a1', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`, '', '## 2. 전시', '', '![근대역사박물관 전시실 내부](#image-slot)'], { group: 'w1' })
const a2 = doc('a2', ['## 1. 산책', '', '![근대역사박물관 외관과 주변 산책로를 걷는 가족](#image-slot)'], { group: 'w2' })
const a3 = doc('a3', ['## 1. 바다', '', '![해 질 무렵 하늘빛이 남아 있는 진포해양공원 풍경](#image-slot)'], { group: 'w3' })
const tourAll = Object.values(T)
const run = (articles: AutoArticle[], over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}): AutoPickResult =>
  autoPickPhotos({ articles, candidates: [H1], tourCandidates: tourAll, places: PLACES, brandName: '군산각', ...over })
const rowsOf = (r: AutoPickResult, id: string) => r.articles.find((a) => a.actionId === id)!.rows

const plain = run([a1])
ok('장면 없이 고르면(키가 없을 때) 지금처럼 — 홈페이지 사진은 설명 낱말로', rowsOf(plain, 'a1')[0]!.pick?.src === H1.src)
const plainTour = run([a1], { candidates: [] })
ok('장면 없이 고르면 관광공사 첫 사진(실내 디오라마)이 외관 자리에 — 고치려는 결함', rowsOf(plainTour, 'a1')[0]!.pick?.src === T.t1.src && !rowsOf(plainTour, 'a1')[0]!.scene)

const sc = run([a1, a2, a3], { scenes })
const r1 = rowsOf(sc, 'a1')
ok('장면으로 고르면 — 설명은 맞아도 장면이 실내인 홈페이지 사진은 넣지 않는다', r1[0]!.pick?.src !== H1.src)
ok('장면으로 고르면 — 외관 자리에 뒤쪽의 외관 사진(t5, 사람 없음)', r1[0]!.state === 'filled' && r1[0]!.pick?.src === T.t5.src && r1[0]!.scene?.setting === 'exterior' && r1[0]!.review === true)
ok('넣은 사진의 장면과 맞은 낱말이 줄에 실린다', Boolean(r1[0]!.fit?.words.includes('외관')) && r1[0]!.scene?.text === S({}).text)
ok('전시실 자리에는 실내 사진', r1[1]!.state === 'filled' && scenes.get(r1[1]!.pick!.src)?.setting === 'interior')
const r2 = rowsOf(sc, 'a2')[0]!
ok('가족이 걷는 자리 — 사람이 나오는 외관 사진(산책로까지 맞음)을 「확인 필요」로', r2.state === 'filled' && r2.pick?.src === T.t6.src && r2.review === true)
const r3 = rowsOf(sc, 'a3')[0]!
ok('해 질 무렵 자리 — 노을 사진(낮 사진은 뺌)', r3.state === 'filled' && r3.pick?.src === T.j2.src && r3.sceneSkips?.time === 1)
ok('같은 입력이면 같은 결과', JSON.stringify(run([a1, a2, a3], { scenes }).articles) === JSON.stringify(sc.articles))
ok(
  '장면을 읽을 사진 — 열린 자리의 홈페이지 짝 · 장소 사진(연월과 함께)',
  sc.sceneWanted.some((w) => w.src === H1.src && w.source === 'site') && tourAll.every((c) => sc.sceneWanted.some((w) => w.src === c.src && w.source === 'tour' && w.month === c.month)),
)

const onlyInside = run([doc('a4', [`![${EXT_SLOT}](#image-slot)`])], { candidates: [], tourCandidates: [T.t1, T.t2, T.t3, T.t4], scenes })
const r4 = rowsOf(onlyInside, 'a4')[0]!
ok('실내 · 전시 사진뿐이면 외관 자리는 비워 둔다(장면이 맞는 사진 없음)', r4.state === 'scene' && !r4.pick && r4.sceneSkips?.setting === 4)
const unread = run([a1], { candidates: [], scenes: new Map() })
ok('장면을 아직 읽지 않은 장소 사진은 쓰지 않는다(unread — 다시 누르면 이어서)', rowsOf(unread, 'a1')[0]!.state === 'unread' && rowsOf(unread, 'a1')[0]!.sceneSkips?.unread === tourAll.filter((c) => c.place === '근대역사박물관').length)
const pubInside: AutoCandidate[] = [1, 2].map((i) => ({ ...tour(`p${i}`, '근대역사박물관', '201301'), src: `https://gunsan.example/places/p${i}.jpg`, pageUrl: 'https://gunsan.example/places/근대역사박물관/', tour: undefined, creditText: '한국관광공사' }))
for (const p of pubInside) scenes.set(p.src, DIORAMA)
const pubOnly = run([doc('a5', [`![${EXT_SLOT}](#image-slot)`])], { candidates: [], publicCandidates: pubInside, tourCandidates: [], scenes })
ok('장소 페이지 사진이 장면으로 모두 빠지면 관광공사 사진을 찾을 장소로', rowsOf(pubOnly, 'a5')[0]!.state === 'scene' && tourPlacesWanted(pubOnly, new Set(['근대역사박물관'])).includes('근대역사박물관'))

// 5) 사람이 뺀 자리 다시 채우기
const clearedAt = { slot: EXT_SLOT, nth: 1, heading: '구도심' }
const a6 = doc('a6', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`], { cleared: [{ ...clearedAt, removed: [T.t5.src] }] })
const off = run([a6], { candidates: [], scenes })
ok('켜지 않으면 사람이 뺀 자리는 그대로(cleared)', rowsOf(off, 'a6')[0]!.state === 'cleared' && !rowsOf(off, 'a6')[0]!.pick)
const on = run([a6], { candidates: [], scenes, refillCleared: true })
const r6 = rowsOf(on, 'a6')[0]!
ok('켜면 다시 채우되 사람이 뺀 사진(t5)은 고르지 않는다 — 다음 외관 사진(t7)', r6.refill === true && r6.state === 'filled' && r6.pick?.src === T.t7.src)
const a7 = doc('a7', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`], { cleared: [clearedAt] })
ok('뺀 사진을 적기 전의 옛 기록 — 막을 사진을 몰라 장면으로만 고른다', rowsOf(run([a7], { candidates: [], scenes, refillCleared: true }), 'a7')[0]!.pick?.src === T.t5.src)
const a6only = run([doc('a8', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`], { cleared: [{ ...clearedAt, removed: [T.t5.src, T.t7.src] }] })], { candidates: [], scenes, refillCleared: true })
ok('뺀 사진을 빼면 맞는 사진이 없을 때 — 비워 둔다', rowsOf(a6only, 'a8')[0]!.state === 'scene' && !rowsOf(a6only, 'a8')[0]!.pick)

// 6) 서버 — 장면 읽기 · 캐시 · 원자적 쓰기(가짜 장면 읽기 함수)
const { describePhotoScenes, SCENE_MAX_NEW } = await import('../server/photoScenes')
const { saveAutoPhotoPicks } = await import('../server/contentDraft')
let active = 0
let maxActive = 0
const seenCalls: string[] = []
const fakeDescriber = async (src: string, onCall: () => void) => {
  onCall()
  seenCalls.push(src)
  active += 1
  maxActive = Math.max(maxActive, active)
  await new Promise((r) => setTimeout(r, 5))
  active -= 1
  if (src.includes('bad')) return { raw: { text: '모양이 틀린 답', setting: 'outdoor' }, model: 'fake-vision' }
  return { raw: { text: `가상 장면 ${src.slice(-8)}`, setting: 'exterior', people: 'none', time: 'day', tags: ['외관'] }, model: 'fake-vision' }
}
const photo = (i: number) => `https://photo.example/img/${i}.jpg`
const many = Array.from({ length: 70 }, (_, i) => photo(i))
const first = await describePhotoScenes(many, { describer: fakeDescriber })
const cacheFile = path.join(dir, 'photo-scenes.json')
const cached = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf-8')) as { scenes: Record<string, { scene: PhotoScene; via: string }> }) : null
ok(`한 번에 ${SCENE_MAX_NEW}장까지 새로 읽고 남은 수를 알린다`, first.described === SCENE_MAX_NEW && first.calls === SCENE_MAX_NEW && first.pending === 10 && first.missing.length === 10)
ok('동시에 3장까지만 읽는다', maxActive <= 3 && maxActive >= 2)
ok('읽은 장면은 디스크에(원자적 쓰기 — 임시 파일이 남지 않는다)', Object.keys(cached?.scenes ?? {}).length === 60 && cached?.scenes[photo(0)]?.via === 'claude-sonnet-5-5' && !readdirSync(dir).some((f) => f.endsWith('.tmp')))
const second = await describePhotoScenes(many, { describer: fakeDescriber })
ok('다시 물으면 읽어 둔 장면은 그대로, 남은 것만 읽는다', second.calls === 10 && Object.keys(second.scenes).length === 70 && second.pending === 0)
const third = await describePhotoScenes(many, { describer: fakeDescriber })
ok('모두 읽은 뒤에는 모델을 부르지 않는다', third.calls === 0 && Object.keys(third.scenes).length === 70)
const peek = await describePhotoScenes([photo(0), photo(100)], { describer: fakeDescriber, limit: 0 })
ok('limit 0은 읽어 둔 장면만(새로 읽지 않는다)', peek.calls === 0 && Boolean(peek.scenes[photo(0)]) && JSON.stringify(peek.missing) === JSON.stringify([photo(100)]) && peek.pending === 1)
const bad = 'https://photo.example/img/bad.jpg'
const badOnce = await describePhotoScenes([bad], { describer: fakeDescriber })
const badAgain = await describePhotoScenes([bad], { describer: fakeDescriber })
ok('모양이 틀린 답은 버리고 알리며, 한동안 다시 읽지 않는다', badOnce.calls === 1 && Boolean(badOnce.failed[bad]) && badOnce.pending === 0 && badAgain.calls === 0 && Boolean(badAgain.failed[bad]))
seenCalls.length = 0
const [p1, p2] = await Promise.all([describePhotoScenes([photo(200)], { describer: fakeDescriber }), describePhotoScenes([photo(200)], { describer: fakeDescriber })])
ok('같은 사진을 동시에 물으면 한 번만 읽는다', seenCalls.filter((s) => s === photo(200)).length === 1 && Boolean(p1.scenes[photo(200)]) && Boolean(p2.scenes[photo(200)]))
process.env.PHOTO_SCENE_MODEL = 'claude-other-model'
const switched = await describePhotoScenes([photo(1)], { describer: fakeDescriber })
delete process.env.PHOTO_SCENE_MODEL
ok('모델을 바꾸면 다시 읽는다', switched.calls === 1 && switched.model === 'claude-other-model')
const keyBefore = process.env.ANTHROPIC_API_KEY
process.env.ANTHROPIC_API_KEY = ''
const noKey = await describePhotoScenes([photo(2), photo(300)])
ok('키가 없으면 읽어 둔 장면만 주고 알린다(available false)', !noKey.available && Boolean(noKey.scenes[photo(2)]) && noKey.calls === 0 && noKey.notes.some((n) => n.includes('ANTHROPIC_API_KEY')) && JSON.stringify(noKey.missing) === JSON.stringify([photo(300)]))
if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY
else process.env.ANTHROPIC_API_KEY = keyBefore

// 7) 저장 — 「사람이 뺀 자리도 다시 채우기」도 뺀 사진은 넣지 않는다(서버 쓰기 안에서)
const TENANT = 'vscene'
const tenantDir = path.join(dir, 'data', TENANT)
mkdirSync(tenantDir, { recursive: true })
const SITE = 'https://site.example/img'
const sitePick = (slot: string, heading: string, src: string) => ({ slot, nth: 1, same: 1, heading, src, alt: '박물관 건물 외관', pageUrl: 'https://site.example/', confirmedAt: AT, auto: true as const })
const draftOf = (actionId: string, extra: Record<string, unknown> = {}) => ({ actionId, generatedAt: AT, draft: { format: 'article', title: '가상 글', sections: [], gapCount: 0, usedFacts: [] }, ...extra })
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({
    'content:a': draftOf('content:a', { photoCleared: [{ slot: '외관', nth: 1, heading: '구도심', removed: [`${SITE}/old.jpg`] }] }),
    'content:b': draftOf('content:b', { photoCleared: [{ slot: '외관', nth: 1, heading: '구도심', removed: [`${SITE}/old.jpg`] }] }),
  }),
)
const savedOff = await saveAutoPhotoPicks(TENANT, [{ actionId: 'content:a', generatedAt: AT, picks: [sitePick('외관', '구도심', `${SITE}/new.jpg`)] }], 3)
ok('켜지 않으면 사람이 뺀 자리에 넣지 않는다', savedOff.saved === 0 && savedOff.skipped === 1)
const savedOld = await saveAutoPhotoPicks(TENANT, [{ actionId: 'content:a', generatedAt: AT, picks: [sitePick('외관', '구도심', `${SITE}/old.jpg`)] }], 3, () => undefined, { refillCleared: true })
ok('켜도 그 자리에서 사람이 뺀 사진은 넣지 않는다', savedOld.saved === 0 && savedOld.skipped === 1)
const savedNew = await saveAutoPhotoPicks(TENANT, [{ actionId: 'content:a', generatedAt: AT, picks: [{ ...sitePick('외관', '구도심', `${SITE}/new.jpg`), heading: '구도심 다시' }] }], 3, () => undefined, { refillCleared: true })
const afterNew = (JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: { src: string }[]; photoCleared?: { removed?: string[] }[] }>)['content:a']
ok('켜면 다른 사진은 넣고(소제목이 바뀌어도 같은 자리로 본다), 뺀 기록은 남긴다', savedNew.saved === 1 && afterNew?.photos?.[0]?.src === `${SITE}/new.jpg` && afterNew.photoCleared?.[0]?.removed?.[0] === `${SITE}/old.jpg`)

// 8) 서버 길 — 검사 · 키 없음 · 키 노출 · 뺀 사진 기록
const PORT = 4104
const MOCK_PORT = 4106
const BASE = `http://127.0.0.1:${PORT}`
const FAKE_KEY = 'sk-ant-FAKE-scene-key-0123456789'
const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
writeFileSync(
  path.join(dir, 'tenants.overlay.json'),
  JSON.stringify([
    {
      tenantId: TENANT, brandName: '가상 여행', aliases: ['가상 여행'], ownedDomains: ['site.example'], industry: '관광안내', region: '전북 가상',
      engines: ['gemini'], questionBankSize: 4, questionBankVersion: 'v1', repeatsPerQuestion: 1, factGraph: [], competitors: [],
    },
  ]),
)
writeFileSync(path.join(tenantDir, 'publish-settings.json'), JSON.stringify({ photoRights: { confirmedAt: AT } }))
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({
    'content:r': draftOf('content:r', { photos: [{ ...sitePick('정문', '박물관', `${SITE}/gate.jpg`) }] }),
  }),
)
const anthropicCalls: string[] = []
const mock = http.createServer((req, res) => {
  anthropicCalls.push(req.url ?? '')
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end('{}')
})
let logs = ''
const bodies: string[] = []
const start = async (key: string): Promise<ChildProcess> => {
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
    TOURAPI_SERVICE_KEY: '',
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  }
  delete env.AEO_SERVER_HOST
  delete env.PHOTO_SCENE_MODEL
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
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
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, body: JSON.parse(text || '{}') as Record<string, unknown> }
}
const scenesPost = (body: unknown) => call('POST', '/api/photo-scenes', body)

if (!(await portFree(PORT)) || !(await portFree(MOCK_PORT))) {
  console.error(`포트 ${PORT} · ${MOCK_PORT}을 다른 프로그램이 쓰고 있어 확인하지 못했습니다.`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve))
try {
  const noKeyServer = await start('')
  try {
    ok('키가 없으면 /api/health의 photoScenes는 false', (await call('GET', '/api/health')).body.photoScenes === false)
    ok('사진 주소가 없으면 400', (await scenesPost({})).status === 400 && (await scenesPost({ srcs: [] })).status === 400)
    ok('사진 주소가 너무 많으면 400', (await scenesPost({ srcs: Array.from({ length: 301 }, (_, i) => photo(i)) })).status === 400)
    ok('https가 아닌 주소 · 글자가 아닌 값은 400', (await scenesPost({ srcs: ['http://photo.example/a.jpg'] })).status === 400 && (await scenesPost({ srcs: [1] })).status === 400)
    ok('limit가 맞지 않으면 400', (await scenesPost({ srcs: [photo(0)], limit: -1 })).status === 400 && (await scenesPost({ srcs: [photo(0)], limit: 1.5 })).status === 400)
    const r = await scenesPost({ srcs: [photo(3), photo(400)], limit: 5 })
    const rScenes = r.body.scenes as Record<string, unknown>
    ok(
      '키가 없으면 디스크에 읽어 둔 장면만 주고(서버를 다시 띄워도) 알린다',
      r.status === 200 && validScene(rScenes[photo(3)]) !== null && r.body.available === false && r.body.calls === 0 &&
        JSON.stringify(r.body.missing) === JSON.stringify([photo(400)]) && (r.body.notes as string[]).some((n) => n.includes('키')),
    )
    // 빼기 — 뺀 사진 주소를 적는다
    const removed = await call('PUT', `/api/content-draft/${TENANT}/photos`, { actionId: 'content:r', generatedAt: AT, op: 'remove', place: { slot: '정문', nth: 1, heading: '박물관' } })
    const clearedRec = (removed.body.photoCleared as { removed?: string[] }[] | undefined)?.[0]
    ok('사진을 빼면 그 자리 기록에 뺀 사진 주소를 적는다', removed.status === 200 && clearedRec?.removed?.[0] === `${SITE}/gate.jpg`)
    const refillSame = await call('PUT', `/api/content-draft/${TENANT}/photos`, {
      op: 'auto', refillCleared: true, articles: [{ actionId: 'content:r', generatedAt: AT, picks: [sitePick('정문', '박물관', `${SITE}/gate.jpg`)] }],
    })
    ok('다시 채우기로도 사람이 뺀 그 사진은 저장하지 않는다', refillSame.status === 200 && refillSame.body.saved === 0 && refillSame.body.skipped === 1)
    const refillOther = await call('PUT', `/api/content-draft/${TENANT}/photos`, {
      op: 'auto', refillCleared: true, articles: [{ actionId: 'content:r', generatedAt: AT, picks: [sitePick('정문', '박물관', `${SITE}/gate2.jpg`)] }],
    })
    const stored = (JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: { src: string }[]; photoCleared?: unknown[] }>)['content:r']
    ok('다시 채우기는 다른 사진을 저장하고 뺀 기록은 남긴다', refillOther.body.saved === 1 && stored?.photos?.[0]?.src === `${SITE}/gate2.jpg` && stored.photoCleared?.length === 1)
    const removedAgain = await call('PUT', `/api/content-draft/${TENANT}/photos`, { actionId: 'content:r', generatedAt: AT, op: 'remove', place: { slot: '정문', nth: 1, heading: '박물관' } })
    ok('다시 빼면 뺀 사진이 쌓인다', JSON.stringify((removedAgain.body.photoCleared as { removed?: string[] }[])[0]?.removed) === JSON.stringify([`${SITE}/gate.jpg`, `${SITE}/gate2.jpg`]))
  } finally {
    await stop(noKeyServer)
  }

  const keyServer = await start(FAKE_KEY)
  try {
    ok('키가 있으면 photoScenes는 true(값은 싣지 않는다)', (await call('GET', '/api/health')).body.photoScenes === true)
    const unreachable = 'https://photo.invalid/museum.jpg'
    const r = await scenesPost({ srcs: [unreachable], limit: 1 })
    const failed = r.body.failed as Record<string, string>
    ok('사진을 받지 못하면 모델을 부르지 않고 그 사진만 실패로 알린다', r.status === 200 && r.body.calls === 0 && String(failed[unreachable]).includes('사진을 받지 못했어요') && r.body.pending === 0 && anthropicCalls.length === 0)
  } finally {
    await stop(keyServer)
  }
  const leaks = [...bodies, logs].filter((t) => t.includes(FAKE_KEY))
  ok('응답 · 서버 로그 어디에도 키가 없다', leaks.length === 0 && bodies.length > 5)
} finally {
  mock.close()
  rmSync(dir, { recursive: true, force: true })
}

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
