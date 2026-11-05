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
import Anthropic from '@anthropic-ai/sdk'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  autoPickPhotos,
  autoPreviewCounts,
  isPeopleScene,
  placesToRead,
  regionRowsWanted,
  sceneFit,
  slotSceneWants,
  tourPlacesWanted,
  type AutoArticle,
  type AutoCandidate,
  type AutoPickResult,
} from '../src/lib/photoAutoPick'
import { parseScene, REGION_SCENE_LIMITS, REGION_SCENE_PLACE, scenesToRead, spreadByMonth, validScene, type PhotoScene, type SceneWant } from '../src/lib/photoScenes'
import { loadScenesFor, newSceneBudget, pickReadingScenes } from '../src/lib/sitePhotos'
import { TOUR_SOURCES } from '../src/lib/tourPhotos'
import { PHOTO_LICENSES, type PhotoPick } from '../src/lib/articlePhotos'

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
const withCaption = wantsOf('낮 시간에 근대역사박물관 건물 앞을 둘이 걸어가는 장면', '입장 마감이 있는 실내 명소는 낮 일정의 앞쪽에 둡니다.')
ok(
  '장면 글자가 종류를 정하면 설명 줄의 「실내」는 보지 않는다(2026-11-04 실데이터 — 실내 디오라마가 들어간 자리)',
  withCaption.settings?.[0] === 'exterior' && !withCaption.settings.includes('interior') && sceneFit(withCaption, { text: '실내 전시관에 재현된 목조 건물과 벤치, 입구로 걸어 나오는 두 사람', setting: 'interior', people: 'distant', time: 'unknown', tags: ['전시실', '목조건물'] }).miss === 'setting',
)
ok('장면 글자에 장면 낱말이 없으면 설명 줄이 정한다', wantsOf('근대역사박물관 이야기', '근대역사박물관 전시실 내부 모습').settings?.[0] === 'interior')
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
  origin: 'public', place, license: 'kogl-1', licenseType: 1, creditText: '한국관광공사 가상촬영', tour: 'gallery', month,
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
// 장면을 읽지 못하면(키 없음) 옛 기록 자리는 다시 채우지 않는다 — 무엇을 뺐는지 몰라 v0.4.52가 넣었던 그 사진(관광공사 첫 사진)을 다시 고른다.
const oldNoScenes = run([a7], { candidates: [], tourCandidates: [T.t1, T.t2, T.t5], refillCleared: true })
ok('장면 없이 다시 채우기 — 뺀 사진을 적기 전의 옛 기록 자리는 그대로(사람이 뺀 그 사진을 다시 넣지 않게)', rowsOf(oldNoScenes, 'a7')[0]!.state === 'cleared' && !rowsOf(oldNoScenes, 'a7')[0]!.pick)
ok('장면 없이 다시 채우기 — 뺀 사진을 아는 기록 자리는 다시 채운다(그 사진은 빼고)', rowsOf(run([a6], { candidates: [], tourCandidates: [T.t5, T.t7], refillCleared: true }), 'a6')[0]!.pick?.src === T.t7.src)
ok('장면 없이 다시 채우기 — 옛 기록 자리의 장소 페이지는 읽지 않는다', placesToRead([a7], PLACES, true, false).length === 0 && placesToRead([a7], PLACES, true, true).includes('근대역사박물관'))

// 5b) 2026-11-04 검토 — 장면으로 고르기의 빈틈
const freshScenes = (pairs: [AutoCandidate, PhotoScene][]) => new Map(pairs.map(([c, s]) => [c.src, s]))
// 안내판 자리 — 가까이 찍은 사진은 안내판 · 간판만, 실내 전시물 · 설명판은 아니다.
const SIGN_SLOT = '근대역사박물관 입구와 이용시간 안내판'
const TICKET_SLOT = '근대역사박물관 매표소 앞에 붙은 요금과 이용시간 안내판'
const DIORAMA_CLOSE = S({ setting: 'closeup', time: 'unknown', text: '옛 군산 거리를 재현한 디오라마 모형 근접', tags: ['디오라마', '모형', '전시물'] })
const RELIC_CLOSE = S({ setting: 'closeup', time: 'unknown', text: '전시 유물 근접', tags: ['유물'] })
const PANEL_INSIDE = S({ setting: 'closeup', time: 'unknown', text: '전시실 벽에 붙은 전시 설명 안내판', tags: ['안내판', '전시', '설명'] })
const GATE_SIGN = S({ setting: 'closeup', text: '박물관 입구 옆 이용시간 안내판', tags: ['안내판', '입구', '이용시간'] })
const signWants = [wantsOf(SIGN_SLOT), wantsOf(TICKET_SLOT)]
ok('안내판 자리 — 가까이 찍은 디오라마 · 유물 사진은 뺀다', signWants.every((w) => sceneFit(w, DIORAMA_CLOSE).miss === 'setting' && sceneFit(w, RELIC_CLOSE).miss === 'setting'))
ok('안내판 자리 — 실내 전시 설명판 근접도 뺀다', signWants.every((w) => !sceneFit(w, PANEL_INSIDE).ok))
ok('안내판 자리 — 입구 안내판 근접 · 외관 사진은 받는다', signWants.every((w) => sceneFit(w, GATE_SIGN).ok && sceneFit(w, S({})).ok))
const signDoc = doc('s1', ['## 1. 관람', '', `![${SIGN_SLOT}](#image-slot)`, '', '## 2. 요금', '', `![${TICKET_SLOT}](#image-slot)`])
const sd = tour('sd1', '근대역사박물관', '201506')
const sdRows = rowsOf(run([signDoc], { candidates: [], tourCandidates: [sd], scenes: freshScenes([[sd, DIORAMA_CLOSE]]) }), 's1')
ok('안내판 자리 두 곳 — 디오라마 근접 사진뿐이면 비워 둔다', sdRows.every((r) => r.state === 'scene' && !r.pick))
const sp = tour('sp1', '근대역사박물관', '201301')
const se = tour('se1', '근대역사박물관', '201411')
const spRow = rowsOf(run([doc('s2', [`![${SIGN_SLOT}](#image-slot)`])], { candidates: [], tourCandidates: [sp, se], scenes: freshScenes([[sp, PANEL_INSIDE], [se, S({ tags: ['외관', '건물'] })]]) }), 's2')[0]!
ok('안내판 자리 — 실내 설명판보다 외관 사진', spRow.state === 'filled' && spRow.pick?.src === se.src)
// 2026-11-04 결정 — 「전시」만으로는 빼지 않는다: 박물관 앞에 세운 특별전시 안내 표지판은 바깥 안내판이다. 전시물 · 전시실 안의 안내판은 그대로 뺀다.
const SPECIAL_SIGN = S({ setting: 'closeup', text: '박물관 앞마당에 세워진 특별전시 안내 표지판', tags: ['표지판', '특별전시', '안내'] })
const EXHIBIT_PANEL = S({ setting: 'closeup', time: 'unknown', text: '전시물 옆에 놓인 설명 안내판 근접', tags: ['안내판', '전시물', '설명'] })
ok('안내판 자리 두 곳 — 바깥 「특별전시 안내 표지판」 근접은 받는다', signWants.every((w) => sceneFit(w, SPECIAL_SIGN).ok))
ok('안내판 자리 두 곳 — 전시물 설명 안내판 근접은 그대로 뺀다', signWants.every((w) => sceneFit(w, EXHIBIT_PANEL).miss === 'setting'))
const ssp = tour('ssp1', '근대역사박물관', '202112')
const signDocs = [SIGN_SLOT, TICKET_SLOT].map((slot, i) => doc(`s${i + 3}`, ['## 1. 관람', '', `![${slot}](#image-slot)`], { group: `sg${i}` }))
const sspPick = run(signDocs, { candidates: [], tourCandidates: [sd, ssp], scenes: freshScenes([[sd, DIORAMA_CLOSE], [ssp, SPECIAL_SIGN]]) })
ok('안내판 자리 두 곳 — 디오라마 근접은 빼고 특별전시 안내 표지판으로 채운다', signDocs.every((d) => rowsOf(sspPick, d.actionId)[0]!.state === 'filled' && rowsOf(sspPick, d.actionId)[0]!.pick?.src === ssp.src))

// 사람 장면 — 장소 이름 속 「어린이 · 친구」는 사람이 아니다.
const kids = slotSceneWants({ key: '새만금어린이랜드 입구와 놀이기구', caption: '' }, ['새만금어린이랜드'])
ok(
  '장소 이름 속 「어린이 · 친구」로 사람 장면 자리가 되지 않는다 — 사람을 알아볼 수 있는 사진은 뺀다',
  !kids.people && sceneFit(kids, S({ people: 'identifiable', tags: ['입구', '놀이기구'] })).miss === 'people' &&
    !slotSceneWants({ key: '먹방이와 친구들 매장 외관', caption: '' }, ['먹방이와 친구들']).people && !isPeopleScene('새만금어린이랜드 입구', ['새만금어린이랜드']),
)
ok('장소 이름을 걷어도 사람 낱말이 남으면 사람 장면', slotSceneWants({ key: '새만금어린이랜드에서 뛰노는 아이', caption: '' }, ['새만금어린이랜드']).people && isPeopleScene('가족이 걷는 장면', []))

// 종류를 정하지 못하는 자리 — 「전시관」은 건물 이름, 장소 이름 바로 뒤의 「앞 · 밖」은 바깥.
ok('「전시관 입구 · 전시관 앞 광장」은 바깥', wantsOf('진포해양공원 전시관 입구').settings?.[0] === 'exterior' && wantsOf('근대역사박물관 전시관 앞 광장').settings?.[0] === 'exterior')
ok('장소 이름 바로 뒤의 「앞 · 밖」은 바깥', wantsOf('근대역사박물관 앞에서 기념사진을 찍는 가족').settings?.[0] === 'exterior' && wantsOf('근대역사박물관 앞').settings?.[0] === 'exterior' && wantsOf('근대역사박물관 밖으로 나온 길').settings?.[0] === 'exterior')
const vd = tour('vd1', '근대역사박물관', '201301')
const ve = tour('ve1', '근대역사박물관', '201411')
const vagueDoc = doc('v1', ['## 1. 건물', '', '![근대역사박물관 건물](#image-slot)'])
const vagueOnly = rowsOf(run([vagueDoc], { candidates: [], tourCandidates: [vd], scenes: freshScenes([[vd, DIORAMA]]) }), 'v1')[0]!
// 2026-11-04 결정으로 기대가 바뀌었다(옛 확인: 「맞는 낱말이 없는 장소 사진(실내 디오라마)은 넣지 않는다」) — 빈자리보다 비슷한 사진.
ok('종류를 정하지 못한 자리 — 화면 · 그림이 아니면 맞는 낱말이 없는 장소 사진(실내 디오라마)도 넣는다', vagueOnly.state === 'filled' && vagueOnly.pick?.src === vd.src)
const vagueStory = rowsOf(run([doc('v2', ['## 1. 박물관', '', '![근대역사박물관 이야기](#image-slot)'])], { candidates: [], tourCandidates: [vd], scenes: freshScenes([[vd, DIORAMA]]) }), 'v2')[0]!
ok('「근대역사박물관 이야기」 자리도 장면이 맞는 장소 사진으로 채운다', vagueStory.state === 'filled' && vagueStory.pick?.src === vd.src)
const vagueScreen = rowsOf(run([vagueDoc], { candidates: [], tourCandidates: [vd], scenes: freshScenes([[vd, S({ setting: 'screen' })]]) }), 'v1')[0]!
ok('종류를 정하지 못한 자리 — 화면 캡처 · 그림은 그래도 넣지 않는다', vagueScreen.state === 'scene' && vagueScreen.sceneSkips?.kind === 1)
const vagueBoth = rowsOf(run([vagueDoc], { candidates: [], tourCandidates: [vd, ve], scenes: freshScenes([[vd, DIORAMA], [ve, S({})]]) }), 'v1')[0]!
ok('종류를 정하지 못한 자리 — 낱말이 맞는 외관 사진', vagueBoth.state === 'filled' && vagueBoth.pick?.src === ve.src)

// 시간 낱말 — 저녁 · 해가 진 뒤 · 해 진 직후, 실내 자리의 불빛 · 조명.
const DAY_WALK = S({ text: '낮의 바닷가 산책로', tags: ['산책로', '바다', '바닷가'] })
ok('「저녁 · 해가 진 뒤 · 해 진 직후」 자리에 낮 사진 — 시간대가 달라 뺀다', ['저녁 무렵 은파호수 산책로', '해가 진 뒤 진포해양공원 산책로', '해 진 직후 바닷가 풍경'].every((k) => sceneFit(wantsOf(k), DAY_WALK).miss === 'time'))
ok('「해가 진 뒤」 자리에 밤 사진은 받는다', sceneFit(wantsOf('해가 진 뒤 진포해양공원 산책로'), S({ time: 'night', tags: ['산책로', '야경'] })).ok)
ok(
  '불빛 · 조명이 켜진 실내 자리 — 시간 모름(실내) 사진도 받는다',
  sceneFit(wantsOf('조명이 켜진 근대역사박물관 전시실 내부'), DIORAMA).ok && sceneFit(wantsOf('은은한 불빛이 비치는 객실'), S({ setting: 'interior', time: 'unknown', tags: ['객실'] })).ok,
)

// 5c) 2026-11-04 결정 — 비슷한 사진(시간만 다름)은 맞는 사진이 어디에도 없을 때만, 「확인 필요」로. 종류 · 사람이 어긋난 사진은 쓰지 않는다.
const DUSK_SLOT = '해 질 무렵 하늘빛이 남아 있는 진포해양공원 풍경'
const DAY_SEA = S({ text: '바다와 공원 산책로, 낮', tags: ['바다', '공원', '하늘'] })
const DUSK_SEA = S({ time: 'dusk', text: '노을 진 하늘과 바다', tags: ['노을', '하늘', '바다'] })
const softFit = sceneFit(wantsOf(DUSK_SLOT), DAY_SEA)
ok('시간만 다른 사진은 soft(비슷한 사진 후보)로 — 점수 · 맞은 낱말도 낸다', !softFit.ok && softFit.miss === 'time' && softFit.soft === true && softFit.words.includes('하늘빛') && softFit.score >= 2)
ok(
  '종류 · 사람 · 화면이 어긋난 사진은 soft가 아니다(시간도 다를 때도)',
  !sceneFit(wantsOf(DUSK_SLOT), DIORAMA).soft && !sceneFit(wantsOf(DUSK_SLOT), S({ people: 'identifiable' })).soft && !sceneFit(wantsOf(DUSK_SLOT), S({ setting: 'screen' })).soft &&
    sceneFit(wantsOf(DUSK_SLOT), S({ people: 'identifiable' })).miss === 'people',
)
const jpPub = (i: number): AutoCandidate => ({ ...pubInside[0]!, src: `https://gunsan.example/places/jp${i}.jpg`, place: '진포해양공원', pageUrl: 'https://gunsan.example/places/진포해양공원/' })
const jt = (i: number) => tour(`jt${i}`, '진포해양공원', '202001')
const duskDoc = doc('d1', ['## 1. 바다', '', `![${DUSK_SLOT}](#image-slot)`], { group: 'dw' })
const homeDay: AutoCandidate = { src: 'https://gunsan.example/img/jinpo-day.jpg', alt: '진포해양공원 바다 풍경', pageUrl: 'https://gunsan.example/' }
const fullLater = rowsOf(
  run([duskDoc], { candidates: [homeDay], publicCandidates: [jpPub(1)], tourCandidates: [jt(1)], scenes: freshScenes([[homeDay, DAY_SEA], [jpPub(1), DAY_SEA], [jt(1), DUSK_SEA]]), pagesRead: new Set(['진포해양공원']) }),
  'd1',
)[0]!
ok('맞는 사진이 뒤 단계(관광공사)에 있으면 앞 단계의 비슷한 사진(홈페이지 · 장소 페이지 낮 사진)보다 그쪽', fullLater.state === 'filled' && fullLater.pick?.src === jt(1).src && !fullLater.similar)
const onlySoft = run([duskDoc], { candidates: [homeDay], publicCandidates: [jpPub(1)], tourCandidates: [jt(2)], scenes: freshScenes([[homeDay, DAY_SEA], [jpPub(1), S({ ...DAY_SEA, tags: ['바다', '공원', '하늘', '풍경'] })], [jt(2), DIORAMA]]), pagesRead: new Set(['진포해양공원']) })
const softRow = rowsOf(onlySoft, 'd1')[0]!
ok(
  '맞는 사진이 어디에도 없으면 시간만 다른 사진을 「비슷한 사진」으로 — 까닭 · 「확인 필요」',
  softRow.state === 'filled' && softRow.similar === '비슷한 사진 — 시간이 다름: 낮 사진 · 해 질 무렵 자리' && softRow.review === true && softRow.scene?.time === 'day' && onlySoft.articles[0]!.picks.length === 1,
)
ok('비슷한 사진은 장면 점수가 높은 것부터(같으면 홈페이지 → 장소 페이지)', softRow.pick?.src === homeDay.src || softRow.pick?.src === jpPub(1).src)
ok('비슷한 사진으로 채운 자리도 관광공사 사진을 찾는다(맞는 사진이 나오면 그쪽)', tourPlacesWanted(onlySoft, new Set(['진포해양공원'])).includes('진포해양공원'))
const hardOnly = rowsOf(run([duskDoc], { candidates: [], publicCandidates: [jpPub(2)], tourCandidates: [jt(3)], scenes: freshScenes([[jpPub(2), DIORAMA], [jt(3), S({ time: 'dusk', people: 'identifiable', tags: ['노을', '바다'] })]]), pagesRead: new Set(['진포해양공원']) }), 'd1')[0]!
ok('종류 · 사람이 어긋난 사진뿐이면 비슷한 사진으로도 넣지 않는다(빈자리)', hardOnly.state === 'scene' && !hardOnly.pick && !hardOnly.similar)
const softRank = rowsOf(
  run([duskDoc], { candidates: [], publicCandidates: [jpPub(3), jpPub(4)], tourCandidates: [], scenes: freshScenes([[jpPub(3), S({ text: '공원 잔디밭', tags: ['잔디'] })], [jpPub(4), DAY_SEA]]), pagesRead: new Set(['진포해양공원']) }),
  'd1',
)[0]!
ok('비슷한 사진 — 장면 점수가 높은 것(바다 · 하늘이 맞는 사진)부터', softRank.similar !== undefined && softRank.pick?.src === jpPub(4).src)
const softDocs = ['dx', 'dy', 'dz', 'dq'].map((id) => doc(id, ['## 1. 바다', '', `![${DUSK_SLOT}](#image-slot)`], { group: id }))
const softCap = run(softDocs, { candidates: [], publicCandidates: [jpPub(4), jpPub(5)], tourCandidates: [], scenes: freshScenes([[jpPub(4), DAY_SEA], [jpPub(5), S({ text: '공원 잔디밭', tags: ['잔디'] })]]), pagesRead: new Set(['진포해양공원']) })
ok(
  '비슷한 사진도 반복 상한(브랜드 3번)을 지킨다 — 넷째 글은 다음 비슷한 사진',
  softDocs.slice(0, 3).every((d) => rowsOf(softCap, d.actionId)[0]!.pick?.src === jpPub(4).src) && rowsOf(softCap, 'dq')[0]!.pick?.src === jpPub(5).src && Boolean(rowsOf(softCap, 'dq')[0]!.similar),
)
const plainSoft = rowsOf(run([duskDoc], { candidates: [], publicCandidates: [jpPub(1)], tourCandidates: [] }), 'd1')[0]!
ok('장면 없이 고르면(키 없음) 지금처럼 — 비슷한 사진 표시 없이 장소 사진', plainSoft.state === 'filled' && plainSoft.pick?.src === jpPub(1).src && !plainSoft.similar)

// 5d) 2026-11-04 결정 — 「이미 넣은 자동 사진도 장면 확인」: 자동 사진(auto)만 다시 보고, 사람이 고른 사진은 보지 않는다.
const KOGL1 = PHOTO_LICENSES['kogl-1'].url
const pickOfCand = (slot: string, heading: string, c: AutoCandidate, over: Partial<PhotoPick> = {}): PhotoPick => ({
  slot, nth: 1, same: 1, heading, src: c.src, alt: c.alt, pageUrl: c.pageUrl, confirmedAt: AT, auto: true,
  ...(c.origin === 'public' ? { origin: 'public' as const, license: 'kogl-1' as const, credit: c.creditText!, creditUrl: KOGL1 } : {}),
  ...over,
})
const duskWith = (id: string, picks: PhotoPick[], group = id) => doc(id, ['## 1. 바다', '', `![${DUSK_SLOT}](#image-slot)`], { group, picks })
const recheckRun = (articles: AutoArticle[], tourList: AutoCandidate[], pairs: [AutoCandidate, PhotoScene][], over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}) =>
  run(articles, { candidates: [], publicCandidates: [], tourCandidates: tourList, scenes: freshScenes(pairs), pagesRead: new Set(['진포해양공원']), recheckAuto: true, ...over })
const dayOld = jt(10)
const duskNew = jt(12)
const inside = jt(13)
const softKeep = recheckRun([duskWith('k1', [pickOfCand(DUSK_SLOT, '바다', dayOld)])], [dayOld, jt(11)], [[dayOld, DAY_SEA], [jt(11), DIORAMA]])
const softKeepRow = rowsOf(softKeep, 'k1')[0]!
ok(
  '다시 보기 — 시간만 다른 자동 사진(낮 사진 · 해 질 무렵 자리)은 맞는 사진이 없으면 비슷한 사진으로 그대로(저장해도 바뀌지 않는다)',
  softKeepRow.state === 'kept' && softKeepRow.recheck === 'similar' && softKeepRow.similar === '비슷한 사진 — 시간이 다름: 낮 사진 · 해 질 무렵 자리' && softKeepRow.review === true &&
    softKeep.articles[0]!.replaces.length === 0 && softKeep.articles[0]!.picks.length === 0,
)
ok('비슷한 사진으로 둔 자리도 관광공사 사진을 찾는다', tourPlacesWanted(softKeep, new Set(['진포해양공원'])).includes('진포해양공원'))
const softSwap = recheckRun([duskWith('k2', [pickOfCand(DUSK_SLOT, '바다', dayOld)])], [dayOld, duskNew], [[dayOld, DAY_SEA], [duskNew, DUSK_SEA]])
const softSwapRow = rowsOf(softSwap, 'k2')[0]!
const softSwapRep = softSwap.articles[0]!.replaces[0]
ok(
  '다시 보기 — 시간만 다른 자동 사진은 맞는 사진(노을)이 있으면 바꾼다(같은 자리 열쇠 · 자동 표시 · 출처)',
  softSwapRow.state === 'replace' && softSwapRow.recheck === 'replace' && softSwapRow.pick?.src === duskNew.src && !softSwapRow.similar && softSwapRow.old?.src === dayOld.src &&
    softSwapRep?.src === dayOld.src && softSwapRep.pick?.src === duskNew.src && softSwapRep.place.slot === DUSK_SLOT && softSwapRep.place.heading === '바다' &&
    softSwapRep.pick.auto === true && softSwapRep.pick.license === 'kogl-1' && softSwap.articles[0]!.picks.length === 0,
)
const hardFull = rowsOf(recheckRun([duskWith('k3', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, dayOld, duskNew], [[inside, DIORAMA], [dayOld, DAY_SEA], [duskNew, DUSK_SEA]]), 'k3')[0]!
ok('다시 보기 — 종류가 어긋난 자동 사진(실내 디오라마)은 맞는 사진으로 바꾼다(비슷한 사진보다 맞는 사진)', hardFull.state === 'replace' && hardFull.pick?.src === duskNew.src && !hardFull.similar && hardFull.oldFit?.miss === 'setting')
const hardSimilar = rowsOf(recheckRun([duskWith('k4', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, dayOld], [[inside, DIORAMA], [dayOld, DAY_SEA]]), 'k4')[0]!
ok('다시 보기 — 맞는 사진이 없으면 비슷한 사진으로 바꾼다(「확인 필요」)', hardSimilar.state === 'replace' && hardSimilar.pick?.src === dayOld.src && Boolean(hardSimilar.similar) && hardSimilar.review === true)
const hardRemove = recheckRun([duskWith('k5', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, jt(11)], [[inside, DIORAMA], [jt(11), DIORAMA]])
const hardRemoveRow = rowsOf(hardRemove, 'k5')[0]!
ok(
  '다시 보기 — 바꿀 사진(맞는 · 비슷한)이 없으면 뺀다(바꿀 사진 없이)',
  hardRemoveRow.state === 'remove' && hardRemoveRow.recheck === 'remove' && JSON.stringify(hardRemove.articles[0]!.replaces) === JSON.stringify([{ place: { slot: DUSK_SLOT, nth: 1, heading: '바다' }, src: inside.src }]),
)
const unknownRun = recheckRun([duskWith('k6', [pickOfCand(DUSK_SLOT, '바다', jt(14))])], [duskNew], [[duskNew, DUSK_SEA]])
const unknownRow = rowsOf(unknownRun, 'k6')[0]!
ok(
  '다시 보기 — 장면을 모르는 자동 사진은 그대로 두고 알리며, 그 사진의 장면을 먼저 읽는다',
  unknownRow.state === 'kept' && unknownRow.recheck === 'unknown' && unknownRun.articles[0]!.replaces.length === 0 && unknownRun.sceneWanted[0]?.src === jt(14).src && unknownRun.sceneWanted[0]?.existing === true,
)
const fitRow = rowsOf(recheckRun([duskWith('k7', [pickOfCand(DUSK_SLOT, '바다', duskNew)])], [duskNew], [[duskNew, DUSK_SEA]]), 'k7')[0]!
ok('다시 보기 — 장면이 맞는 자동 사진은 그대로(장면 · 맞은 낱말과 함께)', fitRow.state === 'kept' && fitRow.recheck === 'fit' && fitRow.scene?.time === 'dusk')
const manual = recheckRun([duskWith('k8', [pickOfCand(DUSK_SLOT, '바다', inside, { auto: undefined })])], [inside, duskNew], [[inside, DIORAMA], [duskNew, DUSK_SEA]])
ok('다시 보기 — 사람이 고른 사진(auto 없음 · 옛 기록)은 장면이 어긋나도 건드리지 않는다', rowsOf(manual, 'k8')[0]!.state === 'kept' && !rowsOf(manual, 'k8')[0]!.recheck && manual.articles[0]!.replaces.length === 0)
const off2 = recheckRun([duskWith('k9', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, duskNew], [[inside, DIORAMA], [duskNew, DUSK_SEA]], { recheckAuto: false })
ok('「이미 넣은 자동 사진도 장면 확인」을 끄면 다시 보지 않는다', rowsOf(off2, 'k9')[0]!.state === 'kept' && !rowsOf(off2, 'k9')[0]!.recheck && off2.articles[0]!.replaces.length === 0 && !off2.sceneWanted.some((w) => w.existing))
const noScene = run([duskWith('k10', [pickOfCand(DUSK_SLOT, '바다', inside)])], { candidates: [], tourCandidates: [inside, duskNew], recheckAuto: true })
ok('장면 없이 고르면(키 없음) 다시 보지 않는다', rowsOf(noScene, 'k10')[0]!.state === 'kept' && !rowsOf(noScene, 'k10')[0]!.recheck)
// 글에 사진 3장이 다 차 있어도 그 자리의 자동 사진은 바꾼다(나가는 사진 자리) — 빈 자리는 채우지 않는다.
const fullDoc = doc('k11', ['## 1. 바다', '', `![${DUSK_SLOT}](#image-slot)`, '', '## 2. 거리', '', '![진포해양공원 옆 거리](#image-slot)', '', '## 3. 다리', '', '![진포해양공원 다리](#image-slot)', '', '## 4. 빈 자리', '', '![진포해양공원 바다 풍경](#image-slot)'], {
  group: 'k11',
  picks: [pickOfCand(DUSK_SLOT, '바다', inside), pickOfCand('진포해양공원 옆 거리', '거리', jt(20), { auto: undefined }), pickOfCand('진포해양공원 다리', '다리', jt(21), { auto: undefined })],
})
const fullRun = recheckRun([fullDoc], [inside, duskNew, jt(22)], [[inside, DIORAMA], [duskNew, DUSK_SEA], [jt(22), DAY_SEA]])
ok(
  '사진 3장이 다 찬 글 — 장면이 어긋난 자동 사진 자리는 바꾸고, 빈 자리는 그대로(다 참)',
  rowsOf(fullRun, 'k11')[0]!.state === 'replace' && rowsOf(fullRun, 'k11')[0]!.pick?.src === duskNew.src && rowsOf(fullRun, 'k11')[3]!.state !== 'filled' && fullRun.articles[0]!.picks.length === 0,
)
// 나간 사진은 상한에서 덜어 낸다 — 브랜드에서 3번 쓴 사진(X)을 뺀 뒤 다음 글의 맞는 자리에 쓸 수 있다.
const INSIDE_SLOT = '진포해양공원 전시관 내부 모습'
const SEA_SLOT = '진포해양공원 바다 산책로 풍경'
const xPhoto = jt(30)
const xa = doc('ka', ['## 1. 전시', '', `![${INSIDE_SLOT}](#image-slot)`], { group: 'ga', picks: [pickOfCand(INSIDE_SLOT, '전시', xPhoto)] })
const xb = doc('kb', ['## 1. 바다', '', `![${SEA_SLOT}](#image-slot)`], { group: 'gb' })
const xOthers = [{ src: xPhoto.src, group: 'gx' }, { src: xPhoto.src, group: 'gy' }]
const capRun = recheckRun([xa, xb], [xPhoto], [[xPhoto, DAY_SEA]], { others: xOthers })
ok('브랜드에서 3번 쓴 자동 사진이 장면이 어긋나 빠지면(뺌) 뒤 글의 맞는 자리에 쓸 수 있다', rowsOf(capRun, 'ka')[0]!.state === 'remove' && rowsOf(capRun, 'kb')[0]!.state === 'filled' && rowsOf(capRun, 'kb')[0]!.pick?.src === xPhoto.src)
ok('다시 보지 않으면 그 사진은 상한에 걸린 그대로', rowsOf(recheckRun([xa, xb], [xPhoto], [[xPhoto, DAY_SEA]], { others: xOthers, recheckAuto: false }), 'kb')[0]!.state !== 'filled')
// 장면 때문에 뺀 자리는 사람이 뺀 자리가 아니다 — 다음에 다시 채우되, 읽어 둔 장면이 같은 사진을 다시 고르지 않게 막는다.
const nextRun = recheckRun([doc('ka', ['## 1. 전시', '', `![${INSIDE_SLOT}](#image-slot)`], { group: 'ga' })], [xPhoto], [[xPhoto, DAY_SEA]])
ok('뺀 다음 번 — 그 자리는 다시 채울 빈자리지만, 읽어 둔 장면 때문에 같은 사진은 다시 고르지 않는다', rowsOf(nextRun, 'ka')[0]!.state === 'scene' && !rowsOf(nextRun, 'ka')[0]!.pick)
ok('뺀 다음 번 — 사람이 그 자리에서 뺀 사진은 바꿀 사진으로도 고르지 않는다', rowsOf(recheckRun([duskWith('k12', [pickOfCand(DUSK_SLOT, '바다', inside)])].map((a) => ({ ...a, cleared: [{ slot: DUSK_SLOT, nth: 1, heading: '바다', removed: [duskNew.src] }] })), [inside, duskNew], [[inside, DIORAMA], [duskNew, DUSK_SEA]]), 'k12')[0]!.pick?.src !== duskNew.src)
ok('다시 볼 자동 사진의 장소 페이지도 읽는다(맨 뒤)', JSON.stringify(placesToRead([duskWith('k13', [pickOfCand(DUSK_SLOT, '바다', inside)])], PLACES, false, true, true)) === JSON.stringify(['진포해양공원']) && placesToRead([duskWith('k13', [pickOfCand(DUSK_SLOT, '바다', inside)])], PLACES).length === 0)
const existingFirst = scenesToRead([{ src: 'https://x.example/a.jpg', source: 'site' }, { src: 'https://x.example/old.jpg', source: 'public', existing: true }], new Set(['https://x.example/a.jpg', 'https://x.example/old.jpg']), { perPlace: 40, total: 1 })
ok('이미 넣은 자동 사진의 장면을 다른 사진보다 먼저 읽는다(상한에 밀리지 않게)', JSON.stringify(existingFirst.read) === JSON.stringify(['https://x.example/old.jpg']) && existingFirst.left === 1)

// 5e) 2026-11-04 결정 — 장소 없는 자리(자리 글자에 장소 이름이 없다)는 지역 사진(브랜드 도시로 찾은 관광사진)에서 비슷한 장면을.
const reg = (name: string, title: string, keywords: string, month = '202104'): AutoCandidate => ({
  src: `https://tong.visitkorea.or.kr/cms2/website/region/${name}.jpg`, alt: title, pageUrl: TOUR_SOURCES.gallery.page, origin: 'public', license: 'kogl-1', licenseType: 1,
  creditText: '한국관광공사 가상촬영', tour: 'gallery', month, keywords, location: '전라북도 군산시',
})
const ALLEY_SLOT = '군산 원도심 골목을 연인이 나란히 걸어가는 뒷모습'
const FLOWER_SLOT = '꽃이 핀 산책로를 두 사람이 나란히 걷는 뒷모습'
const NIGHT_SEA_SLOT = '해가 진 뒤 조명이 켜진 군산 바닷가 산책로와 난간'
const STREET_SLOT = '군산 구도심 거리를 가족이 걸어서 이동하는 장면'
const alley = reg('alley', '군산 월명동 골목', '군산, 월명동, 골목, 근대')
const flower = reg('flower', '은파호수공원 벚꽃', '군산, 은파호수공원, 벚꽃, 산책로')
const nightSea = reg('nightsea', '군산 비응항 야경', '군산, 비응항, 야경, 바다, 바닷가')
const daySea = reg('daysea', '군산 선유도 해변', '군산, 선유도, 바다, 바닷가, 해변')
const market = reg('market', '군산 공설시장 거리', '군산, 시장, 거리')
const kwOnly = reg('kwonly', '군산 근대 건축물', '군산, 골목')
const lovers = reg('lovers', '군산 월명동 풍경', '군산, 연인')
const regionScenes = freshScenes([
  [alley, S({ text: '낡은 담장 사이 좁은 골목길, 사람 없음', tags: ['골목', '담장', '거리'] })],
  [flower, S({ text: '벚꽃이 핀 호숫가 산책로', tags: ['벚꽃', '산책로', '호수'] })],
  [nightSea, S({ time: 'night', text: '조명이 켜진 항구와 바다, 밤', tags: ['야경', '항구', '바다', '조명'] })],
  [daySea, S({ text: '맑은 날 바닷가 해변과 난간', tags: ['해변', '바다', '난간'] })],
  [market, S({ setting: 'interior', time: 'unknown', text: '시장 안 상점들', tags: ['시장', '상점', '거리'] })],
  [kwOnly, S({ text: '붉은 벽돌 건물 외관', tags: ['건물', '외관'] })],
  [lovers, S({ text: '연인 조형물이 있는 골목', tags: ['연인', '골목'] })],
])
const placeless = (id: string, slot: string) => doc(id, ['## 1. 산책', '', `![${slot}](#image-slot)`], { group: id })
const regionAll = [alley, flower, nightSea, daySea, market, kwOnly, lovers]
const regionRun = (articles: AutoArticle[], over: Partial<Parameters<typeof autoPickPhotos>[0]> = {}) =>
  run(articles, { candidates: [], publicCandidates: [], tourCandidates: [], scenes: regionScenes, regionCandidates: regionAll, regionCity: '군산', ...over })
const rr = regionRun([placeless('r1', ALLEY_SLOT), placeless('r2', FLOWER_SLOT), placeless('r3', NIGHT_SEA_SLOT), placeless('r4', STREET_SLOT)])
const rRow = (id: string) => rowsOf(rr, id)[0]!
ok(
  '장소 없는 자리 — 골목 자리에 골목 사진(장소 없는 자리 · 확인 필요 · 공공누리 출처)',
  rRow('r1').state === 'filled' && rRow('r1').pick?.src === alley.src && rRow('r1').placeless === true && rRow('r1').review === true && rRow('r1').pick?.license === 'kogl-1' && rRow('r1').pick?.credit === '한국관광공사 가상촬영',
)
ok('장소 없는 자리 — 「꽃이 핀 산책로」에 벚꽃 산책로 사진(한 글자 낱말 「꽃」도 맞춘다)', rRow('r2').pick?.src === flower.src && Boolean(rRow('r2').fit?.words.length))
ok('장소 없는 자리 — 「해가 진 뒤 조명이 켜진 바닷가」에 밤 사진(낮 해변 사진보다)', rRow('r3').pick?.src === nightSea.src && !rRow('r3').similar)
ok(
  '장소 없는 자리 — 「구도심 거리」에 실내 시장 사진은 넣지 않는다(종류가 다름 — 비슷한 사진으로도) · 골목 사진을 고른다(두 방향)',
  rRow('r4').pick?.src === alley.src && !rRow('r4').similar && rRow('r4').sceneSkips?.setting === 1,
)
const noNight = rowsOf(regionRun([placeless('r5', NIGHT_SEA_SLOT)], { regionCandidates: [daySea, market] }), 'r5')[0]!
ok(
  '장소 없는 자리 — 맞는 사진이 없으면 시간만 다른 사진(낮 바닷가)을 비슷한 사진으로',
  noNight.state === 'filled' && noNight.pick?.src === daySea.src && noNight.placeless === true && noNight.similar === '비슷한 사진 — 시간이 다름: 낮 사진 · 밤 자리',
)
const kwRow = rowsOf(regionRun([placeless('r6', ALLEY_SLOT)], { regionCandidates: [kwOnly] }), 'r6')[0]!
ok('장소 없는 자리 — 검색 낱말만 맞고 장면 · 제목에 자리 낱말이 없는 사진은 넣지 않는다', kwRow.state === 'scene' && kwRow.sceneSkips?.words === 1 && !kwRow.pick)
const loversRun = regionRun([placeless('r7', ALLEY_SLOT)], { regionCandidates: [lovers] })
ok('장소 없는 자리 — 사람 낱말(연인 · 가족)로는 견주지 않는다(장면을 읽을 사진으로도 고르지 않는다)', rowsOf(loversRun, 'r7')[0]!.regionTried === 0 && !loversRun.sceneWanted.some((w) => w.src === lovers.src))
ok('장소 없는 자리 — 자리 낱말이 맞는 사진이 없으면 빈자리 · 까닭(regionTried 0)', rowsOf(loversRun, 'r7')[0]!.state === 'nomatch' && !rowsOf(loversRun, 'r7')[0]!.pick)
const capDocs = ['c1', 'c2', 'c3', 'c4'].map((id) => placeless(id, ALLEY_SLOT))
const alley2 = reg('alley2', '군산 신흥동 골목', '군산, 골목')
const capR = regionRun(capDocs, { regionCandidates: [alley, alley2], scenes: freshScenes([[alley, regionScenes.get(alley.src)!], [alley2, S({ text: '골목과 담장', tags: ['골목'] })]]) })
ok('장소 없는 자리 — 반복 상한(브랜드 3번)을 지킨다', capDocs.slice(0, 3).every((d) => rowsOf(capR, d.actionId)[0]!.pick?.src === alley.src) && rowsOf(capR, 'c4')[0]!.pick?.src === alley2.src)
ok('지역 사진을 주지 않으면(전국형 · B2B형 · 공공 사진 확인 전 · 키 없음) 장소 없는 자리는 그대로', rowsOf(run([placeless('r8', ALLEY_SLOT)], { candidates: [], scenes: regionScenes }), 'r8')[0]!.state === 'nomatch' && rowsOf(run([placeless('r8', ALLEY_SLOT)], { candidates: [], scenes: regionScenes }), 'r8')[0]!.regionTried === undefined)
ok('장면 없이 고르면(키 없음) 지역 사진을 쓰지 않는다', rowsOf(run([placeless('r9', ALLEY_SLOT)], { candidates: [], regionCandidates: regionAll, regionCity: '군산' }), 'r9')[0]!.state === 'nomatch')
const tourAlley: AutoCandidate = { ...tour('ta1', '근대역사박물관', '201411'), keywords: '군산, 근대역사박물관, 골목' }
const reuse = regionRun([placeless('r10', ALLEY_SLOT)], { regionCandidates: [], tourCandidates: [tourAlley], scenes: freshScenes([[tourAlley, S({ text: '박물관 옆 좁은 골목길', tags: ['골목', '거리'] })]]) })
ok('장소 없는 자리 — 이번에 받은 다른 장소의 관광공사 사진도 지역 사진으로 견준다', rowsOf(reuse, 'r10')[0]!.pick?.src === tourAlley.src && rowsOf(reuse, 'r10')[0]!.placeless === true)
const ok2 = regionRun([placeless('r11', ALLEY_SLOT), placeless('r12', FLOWER_SLOT)], { scenes: new Map() })
const regionWanted = ok2.sceneWanted.filter((w) => w.source === 'region')
ok(
  '장소 없는 자리 — 낱말이 맞는 사진만 장면을 읽으려고 고르고(지역 사진 열쇠), 장면을 읽기 전에는 넣지 않는다',
  regionWanted.length > 0 && regionWanted.every((w) => w.place === REGION_SCENE_PLACE) && !regionWanted.some((w) => w.src === nightSea.src || w.src === lovers.src) &&
    rowsOf(ok2, 'r11')[0]!.state === 'unread' && ok2.region?.rows === 2 && ok2.region.pool === regionAll.length,
)
const manyAlley = Array.from({ length: 30 }, (_, i) => reg(`m${i}`, `군산 골목 ${i}`, '군산, 골목'))
const manyFlower = Array.from({ length: 30 }, (_, i) => reg(`f${i}`, `군산 벚꽃 ${i}`, '군산, 벚꽃, 산책로'))
const manyRun = regionRun([placeless('m1', ALLEY_SLOT), placeless('m2', FLOWER_SLOT)], { regionCandidates: [...manyAlley, ...manyFlower], scenes: new Map() })
const manyWanted = manyRun.sceneWanted.filter((w) => w.source === 'region')
ok(
  `장소 없는 자리 — 자리마다 ${REGION_SCENE_LIMITS.perSlot}장까지, 자리를 돌아가며 읽을 사진을 고른다`,
  manyWanted.length === 2 * REGION_SCENE_LIMITS.perSlot && manyWanted[0]!.src === manyAlley[0]!.src && manyWanted[1]!.src === manyFlower[0]!.src && manyRun.region?.matched === 60 && manyRun.region.wanted === 40,
)
const regionPlan = scenesToRead(
  Array.from({ length: 100 }, (_, i) => ({ src: `https://tong.visitkorea.or.kr/r/${i}.jpg`, source: 'region' as const, place: REGION_SCENE_PLACE })),
  new Set(Array.from({ length: 100 }, (_, i) => `https://tong.visitkorea.or.kr/r/${i}.jpg`)),
  { perPlace: 40, total: 150, caps: { [REGION_SCENE_PLACE]: REGION_SCENE_LIMITS.perRun } },
)
ok(`지역 사진은 한 번 누를 때 ${REGION_SCENE_LIMITS.perRun}장까지 장면을 읽는다(남은 수 · 상한에 걸림)`, regionPlan.read.length === REGION_SCENE_LIMITS.perRun && regionPlan.left === 40 && regionPlan.cappedPlaces.includes(REGION_SCENE_PLACE))
ok('지역 사진을 찾을 장소 없는 자리 수', regionRowsWanted(run([placeless('w1', ALLEY_SLOT), duskDoc], { candidates: [], scenes: regionScenes })) === 1)
// 2026-11-04 요청 — 골목 자리는 거리도 같이 찾는다(군산 지역 사진 500장의 제목 · 검색 낱말에 「골목」 · 「원도심」은 0장, 「근대문화유산거리」 ·
// 「이색거리」는 있다). 같은 날 요청으로 두 방향 — 거리 자리도 골목을 같이 찾는다(아래). 골목 · 거리가 없는 자리는 그대로. 골목이 맞는 사진이 거리만 맞는 사진보다 먼저.
const street = reg('street', '군산 근대문화유산거리', '군산, 근대문화유산거리, 근대')
const STREET_SCENE = S({ text: '근대 건물이 늘어선 거리, 사람 없음', tags: ['근대건물', '보도'] })
const streetRow = rowsOf(regionRun([placeless('s1', ALLEY_SLOT)], { regionCandidates: [street], scenes: freshScenes([[street, STREET_SCENE]]) }), 's1')[0]!
ok(
  '골목 자리 — 골목 사진이 없으면 거리 사진을 장소 없는 자리 · 비슷한 장면 · 확인 필요로(맞은 낱말 「거리」)',
  streetRow.state === 'filled' && streetRow.pick?.src === street.src && streetRow.placeless === true && streetRow.review === true && Boolean(streetRow.fit?.words.includes('거리')),
)
const streetInside = rowsOf(
  regionRun([placeless('s2', ALLEY_SLOT)], { regionCandidates: [street], scenes: freshScenes([[street, S({ setting: 'interior', time: 'unknown', text: '옛 거리를 재현한 실내 전시', tags: ['거리', '전시실'] })]]) }),
  's2',
)[0]!
ok('골목 자리 — 거리 사진이라도 장면 종류가 다르면(실내) 넣지 않는다(비슷한 사진으로도)', streetInside.state === 'scene' && !streetInside.pick && streetInside.sceneSkips?.setting === 1)
const oneWay = regionRun([placeless('s3', FLOWER_SLOT), placeless('s4', STREET_SLOT)], { regionCandidates: [street, alley], scenes: freshScenes([[street, STREET_SCENE], [alley, regionScenes.get(alley.src)!]]) })
ok(
  '골목 · 거리가 없는 자리는 더하지 않는다 — 꽃 산책로 자리는 거리 사진을 찾지 않고, 거리 자리는 골목 사진도 읽되 거리가 맞는 사진을 고른다(두 방향)',
  rowsOf(oneWay, 's3')[0]!.regionTried === 0 && rowsOf(oneWay, 's3')[0]!.state === 'nomatch' && rowsOf(oneWay, 's4')[0]!.regionTried === 2 && rowsOf(oneWay, 's4')[0]!.pick?.src === street.src,
)
const alleyFirst = regionRun([placeless('s5', ALLEY_SLOT)], { regionCandidates: [street, alley], scenes: new Map() }).sceneWanted.filter((w) => w.source === 'region').map((w) => w.src)
const alleyBoth = rowsOf(regionRun([placeless('s6', ALLEY_SLOT)], { regionCandidates: [street, alley], scenes: freshScenes([[street, STREET_SCENE], [alley, regionScenes.get(alley.src)!]]) }), 's6')[0]!
ok('골목 자리 — 골목이 맞는 사진을 거리만 맞는 사진보다 먼저 읽고(받은 순서가 뒤여도) 먼저 고른다', JSON.stringify(alleyFirst) === JSON.stringify([alley.src, street.src]) && alleyBoth.pick?.src === alley.src)
// 2026-11-04 검토 — 더한 낱말 「거리」는 낱말이 같거나 「거리」로 끝날 때만 맞는다(「이색거리」 · 「길거리」). 「먹거리」 · 「볼거리」는 거리가 아니다.
const sights = reg('sights', '군산 볼거리', '군산, 볼거리, 근대건축')
const foodMarket = reg('foodmarket', '군산 야시장', '군산, 야시장, 먹거리')
const foodKw = reg('foodkw', '군산 야시장', '군산, 야시장, 이색거리')
const STALLS = S({ text: '천막 아래 먹거리 노점이 늘어선 장터, 사람 없음', tags: ['노점', '천막', '먹거리', '장터'] })
const thingRun = regionRun([placeless('s7', ALLEY_SLOT)], { regionCandidates: [sights, foodMarket], scenes: freshScenes([[sights, S({ text: '붉은 벽돌 건물 외관, 사람 없음', tags: ['건물', '외관', '벽돌'] })], [foodMarket, STALLS]]) })
ok('골목 자리 — 「볼거리」 · 「먹거리」 사진은 거리 사진이 아니다(장면을 읽을 사진으로도 고르지 않는다)', rowsOf(thingRun, 's7')[0]!.regionTried === 0 && rowsOf(thingRun, 's7')[0]!.state === 'nomatch' && !rowsOf(thingRun, 's7')[0]!.pick)
const thingScene = rowsOf(regionRun([placeless('s8', ALLEY_SLOT)], { regionCandidates: [foodKw], scenes: freshScenes([[foodKw, STALLS]]) }), 's8')[0]!
ok('골목 자리 — 검색 낱말 「이색거리」로 장면을 읽었어도 장면 · 제목의 거리 낱말이 「먹거리」뿐이면 넣지 않는다', thingScene.regionTried === 1 && thingScene.state === 'scene' && thingScene.sceneSkips?.words === 1 && !thingScene.pick)
// 더한 낱말은 자리 낱말이 장면 · 제목에 하나도 맞지 않을 때만 쓰고 장면 점수에 더하지 않는다 — 골목 사진끼리는 「거리」가 더 맞아도 고르는 사진 · 맞은 낱말이 그대로.
const alleyA = reg('alleya', '군산 신흥동 골목', '군산, 신흥동, 골목')
const alleyB = reg('alleyb', '군산 월명동 골목', '군산, 월명동, 골목')
const twoAlley = rowsOf(
  regionRun([placeless('s9', ALLEY_SLOT)], {
    regionCandidates: [alleyA, alleyB],
    scenes: freshScenes([[alleyA, S({ text: '좁은 골목길과 담장, 사람 없음', tags: ['골목', '담장'] })], [alleyB, S({ text: '상점이 늘어선 거리 옆 골목, 사람 없음', tags: ['골목', '거리', '상점'] })]]),
  }),
  's9',
)[0]!
ok('골목 자리 — 골목 사진끼리는 「거리」가 더 맞아도 점수가 같다(먼저 받은 골목 사진 · 맞은 낱말 「골목」만)', twoAlley.pick?.src === alleyA.src && JSON.stringify(twoAlley.fit?.words) === JSON.stringify(['골목']))
// 2026-11-04 요청 — 거리 자리도 골목을 같이 찾는다(「군산 구도심 거리를 가족이 걸어서 이동하는 장면」 — 경암동 철길마을 사진은 검색 낱말이
// 「이색거리」라 읽혔지만 장면 낱말이 「골목」뿐이라 빠졌다). 골목 자리와 같은 규칙 — 더한 「골목」은 자리 낱말이 장면 · 제목에 하나도 맞지 않을 때만,
// 장면 점수에 더하지 않고, 낱말이 같거나 골목으로 끝날 때만. 「먹거리」 · 「볼거리」 자리는 거리 자리가 아니다.
const railAlley = reg('railalley', '군산 철길마을', '군산, 철길마을, 이색거리, 기찻길')
const RAIL_ALLEY = S({ text: '낮은 건물 사이 좁은 골목에 놓인 철길, 사람 없음', tags: ['골목', '철길', '건물', '자갈'] })
const railRow = rowsOf(regionRun([placeless('t1', STREET_SLOT)], { regionCandidates: [railAlley], scenes: freshScenes([[railAlley, RAIL_ALLEY]]) }), 't1')[0]!
ok(
  '거리 자리 — 장면이 골목인 사진(검색 낱말 「이색거리」)을 장소 없는 자리 · 비슷한 장면 · 확인 필요로(맞은 낱말 「골목」)',
  railRow.state === 'filled' && railRow.pick?.src === railAlley.src && railRow.placeless === true && railRow.review === true && !railRow.similar && Boolean(railRow.fit?.words.includes('골목')),
)
const railInside = rowsOf(
  regionRun([placeless('t2', STREET_SLOT)], { regionCandidates: [railAlley], scenes: freshScenes([[railAlley, S({ setting: 'interior', time: 'unknown', text: '옛 골목을 재현한 실내 전시', tags: ['골목', '전시실'] })]]) }),
  't2',
)[0]!
ok('거리 자리 — 골목 사진이라도 장면 종류가 다르면(실내) 넣지 않는다(비슷한 사진으로도)', railInside.state === 'scene' && !railInside.pick && railInside.sceneSkips?.setting === 1)
const railScreen = rowsOf(regionRun([placeless('t3', STREET_SLOT)], { regionCandidates: [railAlley], scenes: freshScenes([[railAlley, S({ setting: 'screen', text: '골목 지도가 뜬 휴대폰 화면', tags: ['골목', '지도'] })]]) }), 't3')[0]!
ok('거리 자리 — 골목 낱말이 있어도 화면 캡처는 넣지 않는다', railScreen.state === 'scene' && !railScreen.pick && railScreen.sceneSkips?.kind === 1)
const alleyOnly = reg('alleyonly', '군산 신흥동 골목', '군산, 신흥동, 골목')
const ALLEY_ONLY = S({ text: '낡은 담장 사이 좁은 골목, 사람 없음', tags: ['골목', '담장'] })
const noStreet = regionRun([placeless('t4', FLOWER_SLOT), placeless('t5', '군산 먹거리 노점이 늘어선 장터')], {
  regionCandidates: [alleyOnly],
  scenes: freshScenes([[alleyOnly, ALLEY_ONLY]]),
})
ok(
  '골목 · 거리가 없는 자리(꽃 산책로)와 거리가 「먹거리」뿐인 자리는 골목을 더하지 않는다(장면을 읽을 사진으로도 고르지 않는다)',
  ['t4', 't5'].every((id) => rowsOf(noStreet, id)[0]!.regionTried === 0 && rowsOf(noStreet, id)[0]!.state === 'nomatch' && !rowsOf(noStreet, id)[0]!.pick),
)
const streetFirst = regionRun([placeless('t6', STREET_SLOT)], { regionCandidates: [alleyOnly, street], scenes: new Map() }).sceneWanted.filter((w) => w.source === 'region').map((w) => w.src)
const streetBoth = rowsOf(regionRun([placeless('t7', STREET_SLOT)], { regionCandidates: [alleyOnly, street], scenes: freshScenes([[alleyOnly, ALLEY_ONLY], [street, STREET_SCENE]]) }), 't7')[0]!
ok(
  '거리 자리 — 거리가 맞는 사진을 골목만 맞는 사진보다 먼저 읽고(받은 순서가 뒤여도) 먼저 고른다',
  JSON.stringify(streetFirst) === JSON.stringify([street.src, alleyOnly.src]) && streetBoth.pick?.src === street.src && JSON.stringify(streetBoth.fit?.words) === JSON.stringify(['거리']),
)
const streetA = reg('streeta', '군산 이색거리', '군산, 이색거리')
const streetB = reg('streetb', '군산 근대문화유산거리', '군산, 근대문화유산거리')
const twoStreet = rowsOf(
  regionRun([placeless('t8', STREET_SLOT)], {
    regionCandidates: [streetA, streetB],
    scenes: freshScenes([[streetA, S({ text: '상점이 늘어선 거리, 사람 없음', tags: ['거리', '상점'] })], [streetB, S({ text: '상점이 늘어선 거리 옆 골목, 사람 없음', tags: ['거리', '골목', '상점'] })]]),
  }),
  't8',
)[0]!
ok('거리 자리 — 거리 사진끼리는 「골목」이 더 맞아도 점수가 같다(먼저 받은 거리 사진 · 맞은 낱말 「거리」만)', twoStreet.pick?.src === streetA.src && JSON.stringify(twoStreet.fit?.words) === JSON.stringify(['거리']))
const alleyStill = rowsOf(regionRun([placeless('t9', ALLEY_SLOT)], { regionCandidates: [street, alley], scenes: freshScenes([[street, STREET_SCENE], [alley, regionScenes.get(alley.src)!]]) }), 't9')[0]!
ok('골목 자리 — 두 방향이 되어도 골목 사진을 먼저 고르고 맞은 낱말에 「거리」를 더하지 않는다', alleyStill.pick?.src === alley.src && !alleyStill.fit?.words.includes('거리'))
// 2026-11-04 검토 — 걸리는 시간 · 길이를 말하는 「거리」(「걸어서 10분 거리」 · 「걸어갈 수 있는 거리」)와 거리로 끝나지 않는 낱말(「먹거리들」 ·
// 「볼거리마다」 · 「거리두기」 · 「거리감」)은 길이 아니라 골목을 더하지 않는다(자리 낱말이 하나도 맞지 않는 철길 골목 사진이 바닷가 산책로 자리에 들어갔다).
const placelessCap = (id: string, slot: string, caption: string) => doc(id, ['## 1. 산책', '', `![${slot}](#image-slot)`, `*${caption}*`], { group: id })
const distanceRun = regionRun(
  [
    placelessCap('u1', '바닷가 산책로를 가족이 걷는 모습', '숙소에서 걸어서 10분 거리'),
    placeless('u2', '터미널에서 걸어갈 수 있는 거리의 바닷가 풍경'),
    placeless('u3', '역에서 걸어서 갈 수 있는 거리'),
  ],
  { regionCandidates: [railAlley], scenes: freshScenes([[railAlley, RAIL_ALLEY]]) },
)
ok(
  '걸리는 시간 · 길이를 말하는 거리(「걸어서 10분 거리」 설명 줄 · 「걸어갈 수 있는 거리」) 자리에는 골목 사진을 넣지 않는다',
  ['u1', 'u2', 'u3'].every((id) => !rowsOf(distanceRun, id)[0]!.pick && rowsOf(distanceRun, id)[0]!.sceneSkips?.words === 1),
)
const bothStreet = rowsOf(regionRun([placeless('u4', '역에서 10분 거리의 구도심 거리')], { regionCandidates: [railAlley], scenes: freshScenes([[railAlley, RAIL_ALLEY]]) }), 'u4')[0]!
ok('길을 말하는 거리가 따로 있으면(「10분 거리의 구도심 거리」) 골목 사진을 넣는다', bothStreet.pick?.src === railAlley.src)
const notStreetSlots = ['군산 먹거리들이 놓인 장터 풍경', '다양한 먹거리랑 볼거리 장터 풍경', '군산 볼거리마다 붙은 안내판 풍경', '거리두기 안내판이 붙은 장터 입구', '거리감이 느껴지는 풍경']
const notStreetRun = regionRun(
  notStreetSlots.map((slot, i) => placeless(`u${i + 5}`, slot)),
  { regionCandidates: [alleyOnly], scenes: freshScenes([[alleyOnly, ALLEY_ONLY]]) },
)
ok(
  '거리로 끝나지 않는 낱말(먹거리들 · 먹거리랑 · 볼거리마다 · 거리두기 · 거리감)뿐인 자리는 골목을 더하지 않는다(장면을 읽을 사진으로도 고르지 않는다)',
  notStreetSlots.every((_, i) => rowsOf(notStreetRun, `u${i + 5}`)[0]!.regionTried === 0 && rowsOf(notStreetRun, `u${i + 5}`)[0]!.state === 'nomatch'),
)
const alleyRoad = rowsOf(regionRun([placeless('u10', '벽화가 그려진 골목길')], { regionCandidates: [street], scenes: freshScenes([[street, STREET_SCENE]]) }), 'u10')[0]!
ok('골목 자리 — 「골목길」처럼 골목이 낱말 안에 있어도 거리 사진을 같이 찾는다(전과 같다)', alleyRoad.pick?.src === street.src && alleyRoad.placeless === true)

// 읽지 못한 사진(failed)은 「아직 읽지 않음」이 아니다 — 장면이 맞는 사진 없음으로 관광공사 사진을 찾는다.
const fa = pubInside[0]!
const fb = pubInside[1]!
const fc: AutoCandidate = { ...fb, src: 'https://gunsan.example/places/p3.jpg' }
const failedPick = run([doc('f1', [`![${EXT_SLOT}](#image-slot)`])], {
  candidates: [], publicCandidates: [fa, fb, fc], tourCandidates: [], scenes: freshScenes([[fa, DIORAMA], [fb, DIORAMA]]), sceneFailed: new Set([fc.src]),
})
const fRow = rowsOf(failedPick, 'f1')[0]!
ok(
  '장면을 읽지 못한 사진은 「아직 읽지 않음」으로 세지 않는다 — 장면이 맞는 사진 없음 · 관광공사 사진을 찾을 장소',
  fRow.state === 'scene' && fRow.sceneSkips?.failed === 1 && !fRow.sceneSkips.unread && tourPlacesWanted(failedPick, new Set(['근대역사박물관'])).includes('근대역사박물관'),
)

// 장면이 맞는 장소 사진이 반복 상한에 걸린 자리(used)도 관광공사 사진을 찾는다(장면으로 고를 때).
const ue: AutoCandidate = { ...pubInside[0]!, src: 'https://gunsan.example/places/ext.jpg' }
const usedScenes = freshScenes([[ue, S({})], [pubInside[0]!, DIORAMA], [pubInside[1]!, DIORAMA], [T.t5, S({})], [T.t7, S({ text: '박물관 건물 외관', tags: ['외관', '건물'] })]])
const usedDocs = ['ua', 'ub', 'uc', 'ud', 'ue'].map((id) => doc(id, [`![${EXT_SLOT}](#image-slot)`], { group: id }))
const usedPick = run(usedDocs, { candidates: [], publicCandidates: [ue, ...pubInside], tourCandidates: [], scenes: usedScenes, pagesRead: new Set(['근대역사박물관']) })
ok(
  '장면이 맞는 장소 페이지 사진이 상한에 걸린 자리 — 관광공사 사진을 찾을 장소로',
  usedDocs.map((d) => rowsOf(usedPick, d.actionId)[0]!.state).join(',') === 'filled,filled,filled,used,used' && tourPlacesWanted(usedPick, new Set(['근대역사박물관'])).includes('근대역사박물관'),
)
const usedTour = run(usedDocs, { candidates: [], publicCandidates: [ue, ...pubInside], tourCandidates: [T.t5, T.t7], scenes: usedScenes, pagesRead: new Set(['근대역사박물관']) })
ok('그 자리는 관광공사 외관 사진으로 채운다', ['ud', 'ue'].every((id) => rowsOf(usedTour, id)[0]!.state === 'filled' && rowsOf(usedTour, id)[0]!.candidate?.tour === 'gallery'))
const sameWriter = run([doc('wx', [`![${EXT_SLOT}](#image-slot)`], { group: 'w' }), doc('wy', [`![${EXT_SLOT}](#image-slot)`], { group: 'w' })], {
  candidates: [], publicCandidates: [ue, ...pubInside], tourCandidates: [], scenes: usedScenes, pagesRead: new Set(['근대역사박물관']),
})
ok('같은 작성자의 둘째 글도 관광공사 사진을 찾는다', rowsOf(sameWriter, 'wy')[0]!.state === 'used' && tourPlacesWanted(sameWriter, new Set(['근대역사박물관'])).includes('근대역사박물관'))

// 홈페이지 사진으로 채운 자리 — 그 사진의 장면이 어긋나 빠지면 장소 사진의 장면도 이어서 읽는다(다시 고르기를 되풀이).
const homeArt: AutoCandidate = { src: 'https://gunsan.example/assets/art/museum.png', alt: '근대역사박물관 건물 외관과 앞마당', pageUrl: 'https://gunsan.example/' }
const placePhoto: AutoCandidate = { ...pubInside[0]!, src: 'https://gunsan.example/places/m1.jpg' }
const fixture = freshScenes([[homeArt, S({ setting: 'illustration', text: '박물관 그림', tags: ['그림'] })], [placePhoto, S({})]])
const readLive = new Map<string, PhotoScene>()
const readRounds: string[][] = []
const homeDoc = doc('h1', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`])
const pickHome = () => autoPickPhotos({ articles: [homeDoc], candidates: [homeArt], publicCandidates: [placePhoto], places: PLACES, brandName: '군산각', scenes: readLive })
const readFake = async (wanted: readonly SceneWant[]) => {
  readRounds.push(wanted.map((w) => w.src))
  for (const w of wanted) {
    const s = fixture.get(w.src)
    if (s) readLive.set(w.src, s)
  }
}
const homeOnce = pickHome()
ok('(재현) 첫 고르기는 홈페이지 짝으로 채워 장소 사진 장면을 묻지 않는다', homeOnce.sceneWanted.length === 1 && homeOnce.sceneWanted[0]!.src === homeArt.src)
const homeResult = await pickReadingScenes(pickHome, readFake)
const homeRow = rowsOf(homeResult, 'h1')[0]!
ok(
  '홈페이지 사진의 장면이 어긋나 빠지면 그 자리의 장소 사진 장면도 읽어 채운다',
  homeRow.state === 'filled' && homeRow.pick?.src === placePhoto.src && readRounds.length === 2 && readRounds[1]!.includes(placePhoto.src) && !readRounds[1]!.includes(homeArt.src),
)
const neverRead: string[][] = []
await pickReadingScenes(
  () => autoPickPhotos({ articles: [homeDoc], candidates: [homeArt], publicCandidates: [placePhoto], places: PLACES, brandName: '군산각', scenes: new Map() }),
  async (wanted) => {
    neverRead.push(wanted.map((w) => w.src))
  },
)
ok('장면을 읽지 못해도 같은 사진을 두 번 묻지 않고 끝난다', neverRead.length >= 1 && neverRead.length <= 3 && neverRead.flat().length === new Set(neverRead.flat()).size)

// 장면 묶음 하나가 실패해도(시간 초과) 앞 묶음의 호출 수 · 읽은 수는 남긴다.
const realFetch = globalThis.fetch
let sceneRequests = 0
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { srcs: string[]; limit: number }
  if (body.limit === 0) {
    return Response.json({ scenes: {}, missing: body.srcs, failed: {}, described: 0, calls: 0, pending: body.srcs.length, available: true, model: 'fake-vision', notes: [] })
  }
  sceneRequests += 1
  if (sceneRequests === 2) throw new Error('사진 장면 요청이 180초 안에 끝나지 않았어요.')
  return Response.json({
    scenes: Object.fromEntries(body.srcs.map((s) => [s, S({})])), missing: [], failed: {}, described: body.srcs.length, calls: body.srcs.length, pending: 0, available: true, model: 'fake-vision', notes: [],
  })
}) as typeof fetch
let partialLoad: Awaited<ReturnType<typeof loadScenesFor>> | null = null
try {
  partialLoad = await loadScenesFor(Array.from({ length: 30 }, (_, i) => ({ src: `https://gunsan.example/img/c${i}.jpg`, source: 'site' as const })), new Map(), undefined, newSceneBudget())
} catch (e) {
  console.warn('loadScenesFor가 던졌습니다', e)
} finally {
  globalThis.fetch = realFetch
}
ok(
  '장면 묶음 하나가 실패해도 앞 묶음의 호출 수는 비용 안내에 남고, 남은 사진 · 이유를 알린다',
  partialLoad?.calls === 12 && partialLoad.described === 12 && partialLoad.left === 18 && partialLoad.notes.some((n) => n.includes('180초')),
)
ok('dev 실행의 장면 캐시(server/photo-scenes.json)는 저장소에 올리지 않는다', spawnSync('git', ['check-ignore', '-q', 'server/photo-scenes.json']).status === 0)

// 5f) 2026-11-04 검토 2 — 장소 없는 자리 · 비슷한 사진 · 다시 보기의 빈틈
// (1) 장소 사전이 없거나 읽지 못했을 때, 브랜드 자기 시설 자리 — 다른 곳의 지역 사진은 분명히 틀린 사진이다.
const parkWalk = reg('parkwalk', '군산 월명공원 산책로', '군산, 월명공원, 산책로, 공원')
const hanokRoom = reg('hanokroom', '군산 고우당 한옥 객실', '군산, 고우당, 한옥, 객실')
const hiroGarden = reg('hirogarden', '군산 히로쓰 가옥 정원', '군산, 히로쓰가옥, 일본식, 가옥, 정원')
const namedScenes = freshScenes([
  [parkWalk, S({ text: '나무가 늘어선 공원 산책로', tags: ['공원', '산책로', '나무'] })],
  [hanokRoom, S({ setting: 'interior', time: 'unknown', text: '한옥 객실 내부, 이불과 창호', tags: ['한옥', '객실', '창호'] })],
  [hiroGarden, S({ text: '일본식 가옥 앞 정원', tags: ['일본식', '가옥', '정원', '외관'] })],
  [alley, regionScenes.get(alley.src)!],
])
const noDir = regionRun([placeless('n1', '은파호수공원 둘레 산책로'), placeless('n2', ALLEY_SLOT)], { places: [], regionCandidates: [parkWalk, alley], scenes: namedScenes })
ok(
  '장소 사전이 없는 브랜드 — 고유한 장소 이름(은파호수공원)이 나온 자리에는 다른 곳의 지역 사진을 넣지 않는다(장소 이름이 없는 골목 자리는 넣는다)',
  rowsOf(noDir, 'n1')[0]!.state !== 'filled' && !rowsOf(noDir, 'n1')[0]!.regionSlot && rowsOf(noDir, 'n2')[0]!.pick?.src === alley.src,
)
const dirFailed = regionRun([placeless('n3', ALLEY_SLOT)], { places: [], placesUnknown: true, regionCandidates: [parkWalk, alley], scenes: namedScenes })
ok(
  '장소 사전을 읽지 못했으면 — 장소 없는 자리인지 알 수 없어 지역 사진을 넣지 않고 부르지도 않는다',
  rowsOf(dirFailed, 'n3')[0]!.state !== 'filled' && !rowsOf(dirFailed, 'n3')[0]!.placeless && regionRowsWanted(dirFailed) === 0,
)
const staySlots = ['스테이,머뭄 일본식 가옥 독채의 외관', '스테이,머뭄 독채 앞의 독립된 아담한 정원 풍경', '스테이머뭄 한옥 객실 내부', '한옥 독채의 아담한 정원']
const stayRun = regionRun(staySlots.map((s, i) => placeless(`st${i}`, s)), { brandName: '스테이,머뭄', places: ['근대역사박물관'], regionCandidates: [hiroGarden, hanokRoom], scenes: namedScenes })
ok(
  '브랜드 자기 시설 자리(브랜드 이름 · 독채 · 객실) — 장소 사전이 있어도 다른 숙소 · 장소의 지역 사진을 넣지 않는다',
  staySlots.every((_, i) => rowsOf(stayRun, `st${i}`)[0]!.state !== 'filled' && !rowsOf(stayRun, `st${i}`)[0]!.regionSlot) && regionRowsWanted(stayRun) === 0,
)
// (1-b) 2026-11-05 결정 D4 — 설명 줄의 자기 시설 낱말도 본다, 「숙소 · 브랜드 근처 골목」은 동네 자리다.
const captioned = (id: string, slot: string, caption: string) => doc(id, ['## 1. 머무는 곳', '', `![${slot}](#image-slot)`, `*${caption}*`], { group: id })
const ownCaption = regionRun([captioned('oc1', '일본식 가옥 앞에 펼쳐진 아담한 정원과 툇마루가 보이는 장면', '독채의 툇마루에 앉으면 정원이 보입니다.')], {
  brandName: '스테이,머뭄', places: ['근대역사박물관'], regionCandidates: [hiroGarden], scenes: namedScenes,
})
ok(
  '설명 줄만 독채를 말하는 자리 — 장면 글자에 자기 시설 낱말이 없어도 다른 건물(히로쓰가옥) 지역 사진을 넣지 않는다',
  rowsOf(ownCaption, 'oc1')[0]!.state !== 'filled' && !rowsOf(ownCaption, 'oc1')[0]!.regionSlot && regionRowsWanted(ownCaption) === 0,
)
const nearSlots = [
  ['스테이,머뭄 근처 히로쓰 가옥으로 이어지는 구도심 골목', '숙소에서 걸어서 5분이면 닿습니다.'],
  ['숙소 근처 근대 건축물이 늘어선 군산 옛 골목을 걷는 장면', '스테이,머뭄 독채에서 나와 골목을 걷습니다.'],
  ['한옥과 일본식 가옥이 이어진 조용한 골목을 걷는 여행자의 뒷모습', '숙소에서 걸어서 10분 거리입니다.'],
] as const
const nearRun = regionRun(nearSlots.map(([s, c], i) => captioned(`nr${i}`, s, c)), { brandName: '스테이,머뭄', places: ['근대역사박물관'], regionCandidates: [alley], scenes: namedScenes })
ok(
  '숙소 · 브랜드 「근처」 골목 자리와 설명 줄만 숙소를 말하는 골목 자리 — 동네 자리라 지역 사진을 견준다(작성자마다 골목 사진)',
  nearSlots.every((_, i) => rowsOf(nearRun, `nr${i}`)[0]!.regionSlot === true && rowsOf(nearRun, `nr${i}`)[0]!.pick?.src === alley.src),
)
// (1-c) 2026-11-05 결정 D5(b) — 자기 시설 자리는 비슷한 말로 홈페이지 사진을 맞춘다(장면 종류가 맞을 때만 · 확인 필요).
const STAY_PAGE = 'https://stay.example/'
const living: AutoCandidate = { src: 'https://stay.example/img/living.jpg', alt: '목재 서까래 천장과 미닫이창, 테이블이 있는 거실 공간', pageUrl: STAY_PAGE }
const nightGarden: AutoCandidate = { src: 'https://stay.example/img/night.jpg', alt: '창밖으로 조명을 비춘 정원 나무와 석등이 보이는 풍경', pageUrl: STAY_PAGE }
const stayScenes = freshScenes([
  [living, S({ setting: 'interior', time: 'unknown', text: '서까래 천장 아래 거실', tags: ['거실', '서까래'] })],
  [nightGarden, S({ setting: 'interior', time: 'dusk', text: '창밖으로 보이는 조명 켠 정원', tags: ['정원', '창'] })],
])
const stayDoc = (id: string, slot: string, caption = '', group = id) => doc(id, ['## 1. 머무는 곳', '', `![${slot}](#image-slot)`, ...(caption ? [`*${caption}*`] : [])], { group })
const synRun = (articles: AutoArticle[], sceneMap: Map<string, PhotoScene> | undefined = stayScenes) =>
  autoPickPhotos({ articles, candidates: [living, nightGarden], brandName: '스테이,머뭄', places: [], ...(sceneMap ? { scenes: sceneMap } : {}) })
const syn = synRun([
  stayDoc('sy1', '스테이,머뭄 독채 내부 공간 모습'),
  stayDoc('sy2', '오래된 일본식 가옥의 목조 창호와 실내가 보이는 장면', '스테이,머뭄 독채는 1920년대 가옥을 고쳤습니다.'),
  stayDoc('sy3', '스테이,머뭄 독채 앞의 아담한 정원 풍경'),
])
ok(
  '자기 시설 자리 — 「독채 내부」 · 「목조 창호와 실내」 자리에 거실 사진(비슷한 말 · 장면 실내 · 확인 필요)',
  rowsOf(syn, 'sy1')[0]!.pick?.src === living.src && rowsOf(syn, 'sy1')[0]!.synonym === true && rowsOf(syn, 'sy1')[0]!.review === true &&
    rowsOf(syn, 'sy2')[0]!.pick?.src === living.src && rowsOf(syn, 'sy2')[0]!.synonym === true,
)
ok('자기 시설 정원(바깥) 자리에 창 너머 정원(실내 · 해 질 무렵) 사진은 넣지 않는다 — 장면 종류가 다르다', rowsOf(syn, 'sy3')[0]!.state !== 'filled')
const synUnread = synRun([stayDoc('su1', '스테이,머뭄 독채 내부 공간 모습')], new Map())
ok(
  '장면을 아직 읽지 않은 사진은 비슷한 말로 넣지 않고 읽기를 청한다',
  rowsOf(synUnread, 'su1')[0]!.state !== 'filled' && synUnread.sceneWanted.some((w) => w.src === living.src),
)
// 2026-11-05 실데이터 사본 점검 — 「독채 내부」 자리에 창밖 정원(실내 장면) 사진이 덧붙인 「독채」만으로 들어갔다. 비슷한 말이 장면 글자와
// 맞아야 한다(창밖 정원의 비슷한 말 「정원」은 「독채 내부」에 없다). 「창 너머로 정원이 보이는」 실내 자리에는 그 사진이 맞다.
const gardenOnly = autoPickPhotos({
  articles: [stayDoc('go1', '스테이,머뭄 독채 내부 공간 모습'), stayDoc('go2', '독채 실내에서 창 너머로 정원이 보이는 앉을 자리')],
  candidates: [nightGarden],
  brandName: '스테이,머뭄',
  places: [],
  scenes: stayScenes,
})
ok(
  '덧붙인 「독채」만으로는 맞추지 않는다 — 「독채 내부」 자리에 창밖 정원 사진 없음 · 「창 너머 정원이 보이는 실내」 자리에는 넣음(확인 필요)',
  rowsOf(gardenOnly, 'go1')[0]!.state !== 'filled' && rowsOf(gardenOnly, 'go2')[0]!.pick?.src === nightGarden.src && rowsOf(gardenOnly, 'go2')[0]!.review === true,
)
const notOwn = synRun([stayDoc('no1', '군산 구도심 카페 내부 공간 모습')])
ok('자기 시설 자리가 아니면 비슷한 말을 쓰지 않는다(다른 곳의 「내부」 자리에 숙소 거실 사진 안 넣음)', rowsOf(notOwn, 'no1')[0]!.state !== 'filled')
const frontAlley = regionRun([captioned('fa1', '스테이,머뭄 독채 앞 골목', '대문을 나서면 바로 골목입니다.')], { brandName: '스테이,머뭄', places: ['근대역사박물관'], regionCandidates: [alley], scenes: namedScenes })
ok('「독채 앞 골목」은 숙소 앞이라 자기 시설 그대로(근처 · 주변만 동네 자리)', !rowsOf(frontAlley, 'fa1')[0]!.regionSlot && rowsOf(frontAlley, 'fa1')[0]!.state !== 'filled')
// (2) 장면을 아직 읽지 않은 후보가 남으면 비슷한 사진을 넣지 않는다 — 맞는 사진이 있는지 모른다.
const dayRead = jt(40)
const notRead = jt(41)
const halfRead = run([duskDoc], { candidates: [], publicCandidates: [], tourCandidates: [dayRead, notRead], scenes: freshScenes([[dayRead, DAY_SEA]]), pagesRead: new Set(['진포해양공원']) })
const halfRow = rowsOf(halfRead, 'd1')[0]!
ok('읽지 않은 사진이 남은 자리 — 비슷한 사진을 넣지 않고 「장면을 아직 읽지 않음」(다시 누르면 이어서)', halfRow.state === 'unread' && !halfRow.similar && !halfRow.pick && halfRead.articles[0]!.picks.length === 0)
const allRead = rowsOf(run([duskDoc], { candidates: [], publicCandidates: [], tourCandidates: [dayRead, notRead], scenes: freshScenes([[dayRead, DAY_SEA], [notRead, DIORAMA]]), pagesRead: new Set(['진포해양공원']) }), 'd1')[0]!
ok('모두 읽었는데 맞는 사진이 없으면 그때 비슷한 사진', allRead.state === 'filled' && allRead.pick?.src === dayRead.src && Boolean(allRead.similar))
const keepUnread = rowsOf(recheckRun([duskWith('k20', [pickOfCand(DUSK_SLOT, '바다', dayOld)])], [dayOld, notRead], [[dayOld, DAY_SEA]]), 'k20')[0]!
ok('다시 보기 — 시간만 다른 자동 사진은 읽지 않은 사진이 남아도 그대로(비슷한 사진으로 둠 · 읽지 않은 사진 수)', keepUnread.state === 'kept' && keepUnread.recheck === 'similar' && keepUnread.sceneSkips?.unread === 1)
const hardUnread = recheckRun([duskWith('k21', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, dayOld, notRead], [[inside, DIORAMA], [dayOld, DAY_SEA]])
const hardUnreadRow = rowsOf(hardUnread, 'k21')[0]!
ok(
  '다시 보기 — 종류가 어긋난 자동 사진은 읽지 않은 사진이 남으면 비슷한 사진으로 바꾸지 않고 뺀다',
  hardUnreadRow.state === 'remove' && !hardUnreadRow.pick && !hardUnreadRow.similar && hardUnread.articles[0]!.replaces.length === 1 && !hardUnread.articles[0]!.replaces[0]!.pick,
)
// (3) 나가는 자동 사진은 나가기로 정해진 때 상한에서 덜어 낸다 — 같은 글의 다른 자리 · 뒤 글이 쓸 수 있다(앞 글은 아니다 — 서버가 글 순서대로 저장).
const SEA_PLAIN = '진포해양공원 바다 풍경'
const xDay = jt(42)
const yDusk = jt(43)
const sameDoc = doc('k22', ['## 1. 노을', '', `![${DUSK_SLOT}](#image-slot)`, '', '## 2. 바다', '', `![${SEA_PLAIN}](#image-slot)`], { group: 'W', picks: [pickOfCand(DUSK_SLOT, '노을', xDay)] })
const sameRows = rowsOf(recheckRun([sameDoc], [xDay, yDusk], [[xDay, DAY_SEA], [yDusk, DUSK_SEA]]), 'k22')
ok(
  '같은 글 — 시간만 다른 자동 사진을 맞는 사진으로 바꾸면 그 사진은 같은 글의 맞는 빈 자리에 쓴다',
  sameRows[0]!.state === 'replace' && sameRows[0]!.pick?.src === yDusk.src && sameRows[1]!.state === 'filled' && sameRows[1]!.pick?.src === xDay.src,
)
const zIn = jt(44)
const hardDoc = (id: string, insideFirst: boolean) => {
  const parts = [
    { title: '노을', slot: DUSK_SLOT },
    { title: '전시', slot: INSIDE_SLOT },
  ]
  const ordered = insideFirst ? [...parts].reverse() : parts
  return doc(id, ordered.flatMap((p, i) => [`## ${i + 1}. ${p.title}`, '', `![${p.slot}](#image-slot)`, '']), { group: `W-${id}`, picks: [pickOfCand(DUSK_SLOT, '노을', zIn)] })
}
for (const insideFirst of [false, true]) {
  const id = insideFirst ? 'k23b' : 'k23a'
  const hardRows = rowsOf(recheckRun([hardDoc(id, insideFirst)], [zIn, yDusk], [[zIn, DIORAMA], [yDusk, DUSK_SEA]]), id)
  const duskRow = hardRows.find((r) => r.slot.key === DUSK_SLOT)!
  const innerRow = hardRows.find((r) => r.slot.key === INSIDE_SLOT)!
  ok(
    `같은 글 — 종류가 어긋난 자동 사진은 반드시 나가므로 같은 글의 맞는 빈 자리(${insideFirst ? '앞' : '뒤'})에 쓴다`,
    duskRow.state === 'replace' && duskRow.pick?.src === yDusk.src && innerRow.state === 'filled' && innerRow.pick?.src === zIn.src,
  )
}
const backDocs = [
  doc('kb1', ['## 1. 전시', '', `![${INSIDE_SLOT}](#image-slot)`], { group: 'W3' }),
  doc('kb2', ['## 1. 노을', '', `![${DUSK_SLOT}](#image-slot)`], { group: 'W3', picks: [pickOfCand(DUSK_SLOT, '노을', zIn)] }),
]
const backRun = recheckRun(backDocs, [zIn, yDusk], [[zIn, DIORAMA], [yDusk, DUSK_SEA]])
ok('뒤 글이 내보내는 자동 사진은 앞 글에 넣지 않는다(서버가 글 순서대로 저장해 걸린다)', rowsOf(backRun, 'kb1')[0]!.pick?.src !== zIn.src && rowsOf(backRun, 'kb2')[0]!.state === 'replace')
const fwdRun = recheckRun([...backDocs].reverse(), [zIn, yDusk], [[zIn, DIORAMA], [yDusk, DUSK_SEA]])
ok('앞 글이 내보내는 자동 사진은 뒤 글의 맞는 자리에 쓴다', rowsOf(fwdRun, 'kb1')[0]!.pick?.src === zIn.src && rowsOf(fwdRun, 'kb2')[0]!.state === 'replace')
// (4) 비슷한 사진은 모든 글의 맞는 사진을 고른 뒤에 — 앞 글의 비슷한 사진이 뒤 글의 맞는 사진을 막지 않는다.
const qDay = jpPub(20)
const orderDocs = [doc('e1', ['## 1. 노을', '', `![${DUSK_SLOT}](#image-slot)`], { group: 'WE' }), doc('e2', ['## 1. 바다', '', `![${SEA_PLAIN}](#image-slot)`], { group: 'WE' })]
const orderRun = run(orderDocs, { candidates: [], publicCandidates: [qDay], tourCandidates: [], scenes: freshScenes([[qDay, DAY_SEA]]), pagesRead: new Set(['진포해양공원']) })
ok(
  '비슷한 사진은 맞는 사진 다음 — 같은 작성자의 뒤 글이 맞는 자리에 그 사진을 쓴다(앞 글은 빈자리)',
  rowsOf(orderRun, 'e2')[0]!.state === 'filled' && rowsOf(orderRun, 'e2')[0]!.pick?.src === qDay.src && !rowsOf(orderRun, 'e2')[0]!.similar && !rowsOf(orderRun, 'e1')[0]!.pick,
)
// (5) 이미 넣은 자동 사진은 앞 글의 후보로 먼저 줄에 섰어도 먼저 읽는다.
const autoP: AutoCandidate = { ...pubInside[0]!, src: 'https://gunsan.example/places/auto-p.jpg' }
const exDocs = [doc('x1', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`]), doc('x2', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`], { picks: [pickOfCand(EXT_SLOT, '구도심', autoP)] })]
const exRun = run(exDocs, { candidates: [], publicCandidates: [autoP], tourCandidates: [], scenes: new Map(), recheckAuto: true })
ok('이미 넣은 자동 사진 — 앞 글의 후보로 먼저 줄에 섰어도 먼저 읽는다(existing)', exRun.sceneWanted.find((w) => w.src === autoP.src)?.existing === true && exRun.sceneWanted[0]?.src === autoP.src)
// (6) 사진이 다 찬 글의 장소 없는 자리 — 지역 사진 장면을 청하지 않는다.
const fullPlaceless = doc('fp', ['## 1. 바다', '', `![${DUSK_SLOT}](#image-slot)`, '', '## 2. 거리', '', '![진포해양공원 옆 거리](#image-slot)', '', '## 3. 다리', '', '![진포해양공원 다리](#image-slot)', '', '## 4. 골목', '', `![${ALLEY_SLOT}](#image-slot)`], {
  group: 'fp',
  picks: [pickOfCand(DUSK_SLOT, '바다', jt(50), { auto: undefined }), pickOfCand('진포해양공원 옆 거리', '거리', jt(51), { auto: undefined }), pickOfCand('진포해양공원 다리', '다리', jt(52), { auto: undefined })],
})
const fullRegion = regionRun([fullPlaceless], { scenes: new Map() })
const fpRow = rowsOf(fullRegion, 'fp')[3]!
ok(
  '사진이 다 찬 글의 장소 없는 자리 — 지역 사진 장면을 청하지 않고 「사진 3장이 다 참」',
  fpRow.state === 'full' && !fpRow.regionTried && !fullRegion.sceneWanted.some((w) => w.source === 'region') && regionRowsWanted(fullRegion) === 0,
)
// (7) 키가 없는 PC — 읽어 둔 장면(knownScenes)으로 장면이 어긋난 사진을 뺀다(장면 때문에 뺀 자동 사진을 다시 넣지 않게). 읽지 않은 사진은 지금처럼.
const kp1: AutoCandidate = { ...pubInside[0]!, src: 'https://gunsan.example/places/k1.jpg' }
const kp2: AutoCandidate = { ...pubInside[0]!, src: 'https://gunsan.example/places/k2.jpg' }
const kExt = doc('kn', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`])
const knownRow = rowsOf(run([kExt], { candidates: [], publicCandidates: [kp1, kp2], tourCandidates: [], knownScenes: freshScenes([[kp1, DIORAMA]]) }), 'kn')[0]!
ok('키가 없어도 읽어 둔 장면이 어긋난 사진(실내 디오라마)은 외관 자리에 넣지 않고 다음 사진(장면 모름 — 지금처럼)을', knownRow.state === 'filled' && knownRow.pick?.src === kp2.src)
const knownNext = rowsOf(run([doc('ka', ['## 1. 전시', '', `![${INSIDE_SLOT}](#image-slot)`], { group: 'ga' })], { candidates: [], tourCandidates: [xPhoto], knownScenes: freshScenes([[xPhoto, DAY_SEA]]) }), 'ka')[0]!
ok('키가 없어도 — 장면 때문에 뺀 자리에 같은 사진을 다시 고르지 않는다(읽어 둔 장면)', !knownNext.pick && knownNext.state === 'scene')
ok('읽어 둔 장면이 없으면(키 없음) 지금처럼 고른다', rowsOf(run([kExt], { candidates: [], publicCandidates: [kp1], tourCandidates: [] }), 'kn')[0]!.pick?.src === kp1.src)
const knownSoft = rowsOf(run([duskDoc], { candidates: [], publicCandidates: [jpPub(30)], tourCandidates: [], knownScenes: freshScenes([[jpPub(30), DAY_SEA]]) }), 'd1')[0]!
ok('키가 없어도 읽어 둔 장면이 시간만 다르면 「비슷한 사진」으로 표시한다', knownSoft.state === 'filled' && knownSoft.pick?.src === jpPub(30).src && Boolean(knownSoft.similar) && knownSoft.review === true)
// (8) 미리보기 요약 — 채울 자리의 「확인 필요」 · 비슷한 사진은 채울 자리만, 바꾸는 자리의 것은 바꿈에, 장소가 나온 빈 자리는 빈 자리만.
const rowsAll = (r: AutoPickResult) => r.articles.flatMap((a) => a.rows)
const keptCounts = autoPreviewCounts(rowsAll(softKeep))
ok(
  '요약 — 비슷한 사진으로 둔 자리는 채울 자리의 「확인 필요」에 세지 않는다(옛 셈은 1)',
  rowsAll(softKeep).filter((r) => r.review).length === 1 && keptCounts.filled.all === 0 && keptCounts.filled.review === 0 && keptCounts.kept.similar === 1,
)
const hardSimilarRun = recheckRun([duskWith('k4b', [pickOfCand(DUSK_SLOT, '바다', inside)])], [inside, dayOld], [[inside, DIORAMA], [dayOld, DAY_SEA]])
const swapCounts = autoPreviewCounts(rowsAll(hardSimilarRun))
ok(
  '요약 — 비슷한 사진으로 바꾸는 자리는 바꿈에(비슷한 사진 · 확인 필요), 채울 자리에는 세지 않는다',
  swapCounts.replaced.all === 1 && swapCounts.replaced.similar === 1 && swapCounts.replaced.review === 1 && swapCounts.filled.similar === 0 && swapCounts.filled.review === 0,
)
const regionSwap = regionRun([doc('rs', ['## 1. 산책', '', `![${ALLEY_SLOT}](#image-slot)`], { group: 'rs', picks: [pickOfCand(ALLEY_SLOT, '산책', market)] })], { recheckAuto: true })
const regionSwapCounts = autoPreviewCounts(rowsAll(regionSwap))
ok(
  '요약 — 장소 없는 자리의 지역 사진으로 바꾸는 자리는 바꿈의 「장소 없는 자리」에(옛 셈은 어디에도 없음)',
  rowsOf(regionSwap, 'rs')[0]!.state === 'replace' && rowsOf(regionSwap, 'rs')[0]!.pick?.src === alley.src && regionSwapCounts.replaced.placeless === 1 && regionSwapCounts.filled.placeless === 0,
)
const homeExt: AutoCandidate = { src: 'https://gunsan.example/img/ext.jpg', alt: '근대역사박물관 건물 외관', pageUrl: 'https://gunsan.example/' }
const keptPlaceRows = rowsAll(
  run([doc('pc', ['## 1. 구도심', '', `![${EXT_SLOT}](#image-slot)`], { picks: [pickOfCand(EXT_SLOT, '구도심', homeExt)] })], {
    candidates: [], publicCandidates: [], tourCandidates: [], scenes: freshScenes([[homeExt, S({})]]), recheckAuto: true,
  }),
)
ok(
  '요약 — 장면이 맞아 그대로 둔 자동 사진 자리는 「장소가 나온 빈 자리」에 세지 않는다(옛 셈은 1)',
  keptPlaceRows[0]!.recheck === 'fit' && keptPlaceRows.filter((r) => r.place && r.state !== 'filled').length === 1 && autoPreviewCounts(keptPlaceRows).emptyPlaces === 0,
)

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

// 6b) 오류 — 일시 · 계정 단위 오류(과부하 · 연결 · 크레딧 · 모델 없음)는 사진 한 장의 실패로 6시간 남기지 않고 멈춘다(다시 물으면 읽는다).
// 사진 한 장의 문제(모델이 그 사진을 받지 않음)만 실패로 둔다.
const sdkError = (status: number, type: string, message: string) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers())
const errorCase = async (tag: string, make: () => unknown) => {
  const srcs = Array.from({ length: 12 }, (_, i) => `https://photo.example/err/${tag}-${i}.jpg`)
  const tries: string[] = []
  const r = await describePhotoScenes(srcs, {
    describer: async (src) => {
      tries.push(src)
      throw make()
    },
  })
  const again = await describePhotoScenes(srcs, { describer: fakeDescriber })
  return { r, tries, again }
}
const busy = await errorCase('busy', () => sdkError(529, 'overloaded_error', 'Overloaded'))
ok(
  'Claude 과부하(529) — 멈추고(동시에 시작한 3장까지만) 실패로 남기지 않아, 다시 물으면 읽는다',
  busy.tries.length <= 3 && Object.keys(busy.r.failed).length === 0 && busy.r.pending === 12 && busy.r.calls === 0 && busy.r.notes.some((n) => n.includes('잠시 뒤')) && busy.again.described === 12,
)
const conn = await errorCase('conn', () => new Anthropic.APIConnectionError({ message: 'Connection error.' }))
ok(
  'Claude 연결 끊김 — 「연결하지 못했어요」로 알리고 멈춘다(실패로 남기지 않는다)',
  conn.tries.length <= 3 && Object.keys(conn.r.failed).length === 0 && conn.r.notes.some((n) => n.includes('연결하지 못했')) && !conn.r.notes.some((n) => n.includes('HTTP ?')) && conn.again.described === 12,
)
const credit = await errorCase('credit', () => sdkError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))
ok(
  '크레딧 부족(400) — 멈추고 알린다(사진마다 실패로 남기지 않는다)',
  credit.tries.length <= 3 && Object.keys(credit.r.failed).length === 0 && credit.r.pending === 12 && credit.r.notes.some((n) => n.includes('크레딧')) && credit.again.described === 12,
)
const model404 = await errorCase('model', () => sdkError(404, 'not_found_error', 'model: claude-typo'))
ok('모델 없음(404) — 멈추고 PHOTO_SCENE_MODEL을 알린다', model404.tries.length <= 3 && Object.keys(model404.r.failed).length === 0 && model404.r.notes.some((n) => n.includes('PHOTO_SCENE_MODEL')))
const imgSrcs = Array.from({ length: 4 }, (_, i) => `https://photo.example/err/img-${i}.jpg`)
const img = await describePhotoScenes(imgSrcs, {
  describer: async (src, onCall) => {
    if (src === imgSrcs[1]) throw sdkError(400, 'invalid_request_error', 'Could not process image')
    return fakeDescriber(src, onCall)
  },
})
ok('모델이 사진 한 장을 받지 않으면(400 이미지) 그 사진만 실패로 두고 나머지는 읽는다', Object.keys(img.failed).length === 1 && Boolean(img.failed[imgSrcs[1]!]) && img.described === 3 && img.pending === 0)
const gone = new AbortController()
gone.abort()
const abandoned = await describePhotoScenes(Array.from({ length: 5 }, (_, i) => `https://photo.example/err/gone-${i}.jpg`), { describer: fakeDescriber, signal: gone.signal })
ok('화면이 요청을 버리면(연결 끊김) 새 사진을 읽기 시작하지 않는다', abandoned.calls === 0 && abandoned.described === 0)
const { imageSourceOf } = await import('../server/photoScenes')
let askedAccept: string | undefined
const AVIF = Uint8Array.from([0, 0, 0, 0x1c, ...Buffer.from('ftypavif')])
const WEBP = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])
const formatHost = async (_src: string, opts?: { accept?: string }) => {
  askedAccept = opts?.accept
  return (opts?.accept ?? 'image/avif').includes('image/avif') ? { bytes: AVIF, type: 'image/avif' as const, ext: 'avif' as const } : { bytes: WEBP, type: 'image/webp' as const, ext: 'webp' as const }
}
const fmt = await (async () => imageSourceOf('https://res.cdn.example/image/upload/f_auto/a.jpg', formatHost))().catch((e: unknown) => e)
ok(
  '장면 읽기용 사진은 avif를 청하지 않는다(형식을 고르는 CDN은 webp를 준다)',
  !(fmt instanceof Error) && (fmt as { media_type?: string }).media_type === 'image/webp' && askedAccept !== undefined && !askedAccept.includes('avif'),
)

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

// 7b) 저장 — 장면으로 다시 본 자동 사진 바꾸기 · 빼기(쓰는 때에 그 자리에 화면이 본 그 자동 사진이 있을 때만)
type Stored = Record<string, { photos?: (PhotoPick & { auto?: true })[]; photoCleared?: { slot: string; removed?: string[] }[] }>
const readStored = () => JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Stored
const manualPick = (slot: string, heading: string, src: string) => ({ ...sitePick(slot, heading, src), auto: undefined })
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({
    'content:s': draftOf('content:s', {
      photos: [sitePick('정문', '박물관', `${SITE}/inside.jpg`), manualPick('거리', '거리', `${SITE}/manual.jpg`), sitePick('바다', '바다', `${SITE}/day.jpg`)],
      photoCleared: [{ slot: '정문', nth: 1, heading: '박물관', removed: [`${SITE}/person-removed.jpg`] }],
    }),
    'content:o1': draftOf('content:o1', { photos: [sitePick('다른', '다른', `${SITE}/busy.jpg`)] }),
    'content:o2': draftOf('content:o2', { photos: [sitePick('다른', '다른', `${SITE}/busy.jpg`)] }),
    'content:o3': draftOf('content:o3', { photos: [sitePick('다른', '다른', `${SITE}/busy.jpg`)] }),
  }),
)
const placeOfPick = (slot: string, heading: string) => ({ slot, nth: 1, heading })
const swapSaved = await saveAutoPhotoPicks(
  TENANT,
  [
    {
      actionId: 'content:s',
      generatedAt: AT,
      picks: [],
      replaces: [
        { place: placeOfPick('정문', '박물관'), src: `${SITE}/inside.jpg`, pick: sitePick('정문', '박물관', `${SITE}/outside.jpg`) },
        { place: placeOfPick('바다', '바다'), src: `${SITE}/day.jpg` },
        { place: placeOfPick('거리', '거리'), src: `${SITE}/manual.jpg` },
      ],
    },
  ],
  3,
)
const afterSwap = readStored()['content:s']!
ok(
  '바꾸기 · 빼기 — 화면이 본 자동 사진만 바꾸고 빼며, 사람이 고른 사진은 건드리지 않고 stale로 알린다',
  swapSaved.replaced === 1 && swapSaved.removed === 1 && swapSaved.stale.length === 1 && swapSaved.stale[0]?.slot === '거리' &&
    JSON.stringify(afterSwap.photos?.map((p) => [p.slot, p.src.split('/').pop(), p.auto ?? null])) === JSON.stringify([['정문', 'outside.jpg', true], ['거리', 'manual.jpg', null]]),
)
ok('장면 때문에 뺀 자리는 사람이 뺀 자리로 적지 않는다(뺀 기록은 그대로)', JSON.stringify(afterSwap.photoCleared) === JSON.stringify([{ slot: '정문', nth: 1, heading: '박물관', removed: [`${SITE}/person-removed.jpg`] }]))
const staleSrc = await saveAutoPhotoPicks(TENANT, [{ actionId: 'content:s', generatedAt: AT, picks: [], replaces: [{ place: placeOfPick('정문', '박물관'), src: `${SITE}/inside.jpg` }] }], 3)
ok('그사이 다른 사진으로 바뀐 자리 — 건드리지 않고 stale로 알린다', staleSrc.removed === 0 && staleSrc.stale.length === 1 && readStored()['content:s']!.photos?.[0]?.src === `${SITE}/outside.jpg`)
const blockedPerson = await saveAutoPhotoPicks(
  TENANT,
  [{ actionId: 'content:s', generatedAt: AT, picks: [], replaces: [{ place: placeOfPick('정문', '박물관'), src: `${SITE}/outside.jpg`, pick: sitePick('정문', '박물관', `${SITE}/person-removed.jpg`) }] }],
  3,
)
ok('바꿀 사진이 그 자리에서 사람이 뺀 사진이면 바꾸지 않고 그대로 둔다', blockedPerson.replaced === 0 && blockedPerson.skipped === 1 && readStored()['content:s']!.photos?.[0]?.src === `${SITE}/outside.jpg`)
const blockedCap = await saveAutoPhotoPicks(
  TENANT,
  [{ actionId: 'content:s', generatedAt: AT, picks: [], replaces: [{ place: placeOfPick('정문', '박물관'), src: `${SITE}/outside.jpg`, pick: sitePick('정문', '박물관', `${SITE}/busy.jpg`) }] }],
  3,
)
ok('바꿀 사진이 브랜드 반복 상한에 걸리면 바꾸지 않는다', blockedCap.replaced === 0 && blockedCap.skipped === 1 && readStored()['content:s']!.photos?.[0]?.src === `${SITE}/outside.jpg`)
const roomSwap = await saveAutoPhotoPicks(
  TENANT,
  [{ actionId: 'content:s', generatedAt: AT, picks: [sitePick('새 자리', '새', `${SITE}/fresh.jpg`)], replaces: [{ place: placeOfPick('정문', '박물관'), src: `${SITE}/outside.jpg` }] }],
  3,
)
ok('빼기는 새 사진보다 먼저 — 나간 자리만큼 새 사진을 넣을 수 있다', roomSwap.removed === 1 && roomSwap.saved === 1 && readStored()['content:s']!.photos?.map((p) => p.src.split('/').pop()).join(',') === 'manual.jpg,fresh.jpg')
// 같은 글 안에서는 나가는 자동 사진을 모두 먼저 비운다 — 앞에 적힌 바꾸기가 뒤 자리의 나가는 사진을 받아도 걸리지 않는다.
writeFileSync(
  path.join(tenantDir, 'drafts.json'),
  JSON.stringify({ 'content:v': draftOf('content:v', { photos: [sitePick('전시', '전시', `${SITE}/sea.jpg`), sitePick('노을', '노을', `${SITE}/diorama.jpg`)] }) }),
)
const vacateFirst = await saveAutoPhotoPicks(
  TENANT,
  [
    {
      actionId: 'content:v',
      generatedAt: AT,
      picks: [],
      replaces: [
        { place: placeOfPick('전시', '전시'), src: `${SITE}/sea.jpg`, pick: sitePick('전시', '전시', `${SITE}/diorama.jpg`) },
        { place: placeOfPick('노을', '노을'), src: `${SITE}/diorama.jpg`, pick: sitePick('노을', '노을', `${SITE}/dusk.jpg`) },
      ],
    },
  ],
  3,
)
ok(
  '같은 글 — 나가는 자동 사진을 먼저 비우므로 다른 자리가 그 사진으로 바뀌어도(앞에 적혀도) 둘 다 바꾼다',
  vacateFirst.replaced === 2 && vacateFirst.skipped === 0 && readStored()['content:v']!.photos?.map((p) => `${p.slot}=${p.src.split('/').pop()}`).join(',') === '전시=diorama.jpg,노을=dusk.jpg',
)

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
    'content:q': draftOf('content:q', { photos: [sitePick('정문', '박물관', `${SITE}/q-inside.jpg`), manualPick('거리', '거리', `${SITE}/q-manual.jpg`)] }),
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
    // 바꾸기 · 빼기 — 서버 길(검사 · stale)
    const badReplace = await call('PUT', `/api/content-draft/${TENANT}/photos`, { op: 'auto', articles: [{ actionId: 'content:q', generatedAt: AT, picks: [], replaces: [{ src: `${SITE}/q-inside.jpg` }] }] })
    ok('바꾸거나 뺄 자동 사진의 자리가 없으면 400', badReplace.status === 400)
    const swapHttp = await call('PUT', `/api/content-draft/${TENANT}/photos`, {
      op: 'auto',
      articles: [
        {
          actionId: 'content:q',
          generatedAt: AT,
          picks: [],
          replaces: [
            { place: { slot: '정문', nth: 1, heading: '박물관' }, src: `${SITE}/q-inside.jpg`, pick: sitePick('정문', '박물관', `${SITE}/q-outside.jpg`) },
            { place: { slot: '거리', nth: 1, heading: '거리' }, src: `${SITE}/q-manual.jpg` },
          ],
        },
      ],
    })
    const storedQ = (JSON.parse(readFileSync(path.join(tenantDir, 'drafts.json'), 'utf-8')) as Record<string, { photos?: { src: string; auto?: true; confirmedAt: string }[]; photoCleared?: unknown[] }>)['content:q']
    ok(
      '서버 길 — 자동 사진은 바꾸고(확인 시각 · 자동 표시) 사람이 고른 사진은 stale로 알리며, 뺀 기록을 만들지 않는다',
      swapHttp.status === 200 && swapHttp.body.replaced === 1 && (swapHttp.body.stale as unknown[]).length === 1 &&
        storedQ?.photos?.[0]?.src === `${SITE}/q-outside.jpg` && storedQ.photos[0]!.auto === true && storedQ.photos[0]!.confirmedAt !== AT && storedQ.photos[1]?.src === `${SITE}/q-manual.jpg` && !storedQ.photoCleared,
    )
    const swapBadPick = await call('PUT', `/api/content-draft/${TENANT}/photos`, {
      op: 'auto',
      articles: [{ actionId: 'content:q', generatedAt: AT, picks: [], replaces: [{ place: { slot: '정문', nth: 1, heading: '박물관' }, src: `${SITE}/q-outside.jpg`, pick: { ...sitePick('정문', '박물관', `${SITE}/q-illust.jpg`), alt: '일러스트 박물관' } }] }],
    })
    ok('서버 길 — 바꿀 사진이 자동 후보 검사(일러스트)에 걸리면 그대로 두고 센다', swapBadPick.status === 200 && swapBadPick.body.replaced === 0 && swapBadPick.body.skipped === 1)
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
