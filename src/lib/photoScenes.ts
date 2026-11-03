/**
 * 사진 장면 — 비전 모델(기본 Claude Sonnet 5.5, server/photoScenes.ts)이 사진 한 장을 보고 적은 장면 설명. 자동 채우기
 * (src/lib/photoAutoPick.ts)가 사진 자리 글자와 장면을 맞춰, 장소만 맞고 장면이 어긋난 사진(외관 자리에 실내 전시 · 디오라마 사진)을
 * 넣지 않게 한다(2026-11-03 군산각 — 관광공사 사진 3단계가 근대역사박물관 외관 자리 13곳을 2013년 실내 전시 사진으로 채웠다).
 *
 * 이 파일은 장면의 모양 · 검사 · 표시 글자와 읽을 사진 고르기만 한다(서버 · 화면 · 검증 스크립트가 함께 쓴다 — DOM을 쓰지 않는다).
 * 부르기 · 캐시 · 키는 서버(server/photoScenes.ts)가 한다.
 */
import { cleanPhotoAlt, normSlotAlt } from './articlePhotos.js'

/** 장면의 종류 — exterior 건물 바깥 · 거리 · 풍경 · 야외, interior 건물 안, aerial 높은 곳에서 내려다본 전경, closeup 음식 · 소품 · 안내판처럼 가까이, screen 화면 캡처, illustration 그림 · 지도 · 포스터. */
export const SCENE_SETTINGS = ['exterior', 'interior', 'aerial', 'closeup', 'screen', 'illustration', 'other'] as const
export type SceneSetting = (typeof SCENE_SETTINGS)[number]
/** 사람 — none 없음, distant 작게 · 멀리 보여 누군지 알아볼 수 없음, identifiable 얼굴 · 모습으로 알아볼 수 있음(초상권). */
export const SCENE_PEOPLE = ['none', 'distant', 'identifiable'] as const
export type ScenePeople = (typeof SCENE_PEOPLE)[number]
export const SCENE_TIMES = ['day', 'night', 'dusk', 'unknown'] as const
export type SceneTime = (typeof SCENE_TIMES)[number]

export interface PhotoScene {
  /** 한국어 한 줄 — 보이는 것만(「초록 외벽의 박물관 건물과 앞마당, 사람 없음」). */
  text: string
  setting: SceneSetting
  people: ScenePeople
  time: SceneTime
  /** 보이는 것을 가리키는 한국어 명사(외관 · 입구 · 안내판 · 전시실 · 디오라마 …). */
  tags: string[]
  /** 실제로 답한 모델(서버 쪽 대체 모델이 답했으면 그 모델). */
  model: string
  /** 읽은 때(서버 시각, ISO). */
  describedAt: string
}

export const SCENE_SETTING_TEXT: Record<SceneSetting, string> = {
  exterior: '바깥',
  interior: '실내',
  aerial: '전경(높은 곳)',
  closeup: '가까이',
  screen: '화면',
  illustration: '그림',
  other: '기타',
}
export const SCENE_PEOPLE_TEXT: Record<ScenePeople, string> = { none: '사람 없음', distant: '사람 멀리', identifiable: '사람 알아볼 수 있음' }
export const SCENE_TIME_TEXT: Record<SceneTime, string> = { day: '낮', night: '밤', dusk: '해 질 무렵', unknown: '시간 모름' }

export const SCENE_LIMITS = { text: 120, tags: 12, tag: 16, model: 80 } as const

/** 모델에게 받을 JSON 모양(structured outputs). 길이 · 개수는 받은 뒤 parseScene이 자른다. */
export const SCENE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '보이는 것만 적은 한국어 한 줄(60자 안팎)' },
    setting: { type: 'string', enum: [...SCENE_SETTINGS] },
    people: { type: 'string', enum: [...SCENE_PEOPLE] },
    time: { type: 'string', enum: [...SCENE_TIMES] },
    tags: { type: 'array', items: { type: 'string' }, description: '보이는 것을 가리키는 한국어 명사 3~10개' },
  },
  required: ['text', 'setting', 'people', 'time', 'tags'],
  additionalProperties: false,
} as const

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

/** 낱말 하나 — 한글 · 영문 · 숫자만 남기고(띄어쓰기는 지운다) SCENE_LIMITS.tag자까지. 못 쓰면 ''. */
function cleanTag(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const t = normSlotAlt(raw).replace(/[^\p{L}\p{N}]+/gu, '')
  return t.length >= 1 && t.length <= SCENE_LIMITS.tag ? t : ''
}

/** 모델 출력 하나를 장면으로 — 모양이 틀리면 null(그 사진은 장면 없이 둔다). */
export function parseScene(raw: unknown, meta: { model: string; describedAt: string }): PhotoScene | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = cleanPhotoAlt(typeof r.text === 'string' ? r.text : '').slice(0, SCENE_LIMITS.text).trim()
  if (text.length < 2 || !isOneOf(SCENE_SETTINGS, r.setting) || !isOneOf(SCENE_PEOPLE, r.people) || !isOneOf(SCENE_TIMES, r.time)) return null
  if (!Array.isArray(r.tags)) return null
  const tags = [...new Set(r.tags.map(cleanTag).filter(Boolean))].slice(0, SCENE_LIMITS.tags)
  const model = typeof meta.model === 'string' ? meta.model.trim().slice(0, SCENE_LIMITS.model) : ''
  if (!model || typeof meta.describedAt !== 'string' || Number.isNaN(Date.parse(meta.describedAt))) return null
  return { text, setting: r.setting, people: r.people, time: r.time, tags, model, describedAt: meta.describedAt }
}

/** 저장된 장면(캐시 · 서버 응답)을 검사한다 — 틀리면 null. */
export function validScene(raw: unknown): PhotoScene | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return parseScene(raw, { model: typeof r.model === 'string' ? r.model : '', describedAt: typeof r.describedAt === 'string' ? r.describedAt : '' })
}

/** 장면의 종류 · 사람 · 시간 — 「바깥 · 사람 없음 · 낮」. */
export function sceneMeta(s: Pick<PhotoScene, 'setting' | 'people' | 'time'>): string {
  return `${SCENE_SETTING_TEXT[s.setting]} · ${SCENE_PEOPLE_TEXT[s.people]} · ${SCENE_TIME_TEXT[s.time]}`
}

/** 장면을 읽을 사진 하나 — 자동 채우기가 자리에 견줄 후보(src/lib/photoAutoPick.ts sceneWanted). */
export interface SceneWant {
  src: string
  /** 사진이 어디서 왔나 — site 홈페이지 · public 장소 페이지 · tour 관광공사. */
  source: 'site' | 'public' | 'tour'
  /** 공공 사진 · 관광공사 사진의 장소(사이트 장소 이름). */
  place?: string
  /** 촬영 연월(YYYYMM, 관광사진 정보) — 같은 장소에서 여러 시기의 사진을 고루 읽는다. */
  month?: string
}

/**
 * 촬영 연월이 고루 섞이게 늘어놓는다 — 연월마다(빠른 연월부터, 모르면 맨 뒤) 한 장씩 돌아가며, 같은 연월 안에서는 받은 순서. 관광사진
 * 정보는 같은 날 찍은 실내 사진이 수십 장씩 이어져(군산근대역사박물관 115장 — 2013-01 46장 · 2014-11 7장 · 2015-06 22장 · 2020-01 37장 ·
 * 2021-12 3장), 앞에서부터 읽으면 한 시기의 사진만 읽는다.
 */
export function spreadByMonth<T extends { month?: string }>(list: readonly T[]): T[] {
  const groups = new Map<string, T[]>()
  for (const x of list) {
    const k = x.month && /^\d{6}$/.test(x.month) ? x.month : '~'
    groups.set(k, [...(groups.get(k) ?? []), x])
  }
  const lanes = [...groups.keys()].sort().map((k) => groups.get(k)!)
  const out: T[] = []
  for (let i = 0; out.length < list.length; i += 1) for (const lane of lanes) if (i < lane.length) out.push(lane[i]!)
  return out
}

/**
 * 새로 읽을 사진 — 장면이 없는(missing) 사진 가운데, 장소마다 perPlace장까지(관광공사 사진은 촬영 연월이 고루 섞이게 — spreadByMonth),
 * 모두 합쳐 total장까지. 홈페이지 사진 → 장소 페이지 사진 → 관광공사 사진 순서(앞 단계가 먼저 쓰인다). used는 같은 실행에서 이미 읽은
 * 장소별 수(장소 상한에 함께 센다). left는 읽지 않고 남긴 수, cappedPlaces는 장소 상한에 걸린 장소.
 */
export function scenesToRead(
  wanted: readonly SceneWant[],
  missing: ReadonlySet<string>,
  limits: { perPlace: number; total: number; used?: ReadonlyMap<string, number> },
): { read: string[]; left: number; cappedPlaces: string[] } {
  const seen = new Set<string>()
  const todo: SceneWant[] = []
  for (const w of wanted) {
    if (!missing.has(w.src) || seen.has(w.src)) continue
    seen.add(w.src)
    todo.push(w)
  }
  const order: SceneWant['source'][] = ['site', 'public', 'tour']
  const read: string[] = []
  const perPlace = new Map<string, number>(limits.used ?? [])
  const capped = new Set<string>()
  for (const source of order) {
    const mine = todo.filter((w) => w.source === source)
    const byPlace = new Map<string, SceneWant[]>()
    for (const w of mine) byPlace.set(w.place ?? '', [...(byPlace.get(w.place ?? '') ?? []), w])
    for (const [place, list] of byPlace) {
      for (const w of source === 'tour' ? spreadByMonth(list) : list) {
        if (read.length >= limits.total) break
        const n = perPlace.get(place) ?? 0
        if (place && n >= limits.perPlace) {
          capped.add(place)
          continue
        }
        perPlace.set(place, n + 1)
        read.push(w.src)
      }
    }
  }
  return { read, left: todo.length - read.length, cappedPlaces: [...capped] }
}
