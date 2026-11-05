/**
 * 군산 지도 그림(OpenStreetMap) — 블로그 글의 지도 자리에 넣을 그림의 표지 고르기 · 대체 텍스트 · 설명 줄 · 출처 줄 · 변형 열쇠 · 앱 주소.
 *
 * 카카오 · 네이버 지도 화면은 이용 조건상 저장 · 재게재하지 않는다(src/lib/screenCapture.ts SCREEN_AUTO_SAVE_KINDS — 지도는 미리보기만).
 * 그래서 지도 자리는 앱이 동봉한 OSM 지도 데이터(map-data/gunsan-20261103.pmtiles)로 직접 그린 그림을 쓴다(2026-11-04 결정). 그리기는
 * 데스크톱 앱의 메인 프로세스(electron/mapRender.cjs)가 하고, 서버가 틀을 정해(server/mapFrame.ts) 청하고 저장한다(server/maps.ts).
 *
 * 표지는 고객 자사 사이트 /map/의 장소 목록(div.map[data-points] — server/mapPoints.ts가 점만 저장)에서만 고른다. 자리 글자에 장소 이름이
 * 나오면 그 장소를, 이름이 없으면 설명 줄 · 소제목 · 절 글자에 나온 장소 둘레나 그 권역에서 고른다(mapChoiceOf). 공군기지 상자(MAP_AVOID)
 * 안의 장소는 넣지 않는다.
 *
 * 글에 넣을 때(src/lib/articlePhotos.ts placePhotos) 대체 텍스트는 「군산 지도 — A · B · C 위치」(사이트 화면이라고 쓰지 않는다), 그림 바로
 * 아래 줄은 출처 줄(MAP_CREDIT), 그다음 줄은 자리의 사이트 기능 문장 대신 장소 위치 문장이다. 출처 줄은 그림이 앱 밖으로 나가는 모든 곳
 * (서식째 복사 · .html · 작성자 묶음 · 글자 내보내기)에서 그림 바로 아래에 붙는다.
 *
 * 서버(server/maps.ts · server/index.ts)와 화면이 함께 쓰므로 DOM에 기대지 않는다.
 */

/** 지도 데이터 판 — 동봉한 .pmtiles(Protomaps 빌드 20261103에서 군산 범위만 잘라 낸 것). */
export const MAP_DATA_VERSION = 'gunsan-20261103'
/**
 * 그림 판 — 지도 데이터 · MapLibre 판 · 스타일(electron/map/style.json)과 덧그림(electron/map/render.js)의 해시(줄 끝 LF로 맞춰 sha256 앞 8자).
 * 저장한 그림의 이름(캐시 열쇠)에 들어가, 스타일이나 덧그림을 고치면 새로 그린다. 고치면 scripts/verify-map-image.ts가 알린다.
 */
export const MAP_STYLE_VERSION = `${MAP_DATA_VERSION}/maplibre-6.15.0/style-4cb727fe`
/** 지도 그림이 그리는 고장 — 대체 텍스트 「군산 지도 — …」. 동봉한 지도 데이터가 군산뿐이다. */
export const MAP_AREA_NAME = '군산'

/**
 * 그림 바로 아래에 붙는 출처 줄 — 그림이 앱 밖으로 나가는 모든 곳(서식째 복사 · .html · 작성자 묶음 · 글자 내보내기)에. OSM 데이터는 ODbL
 * 1.0이고 출처 표시가 이용 조건이다(map-data/NOTICE-OSM.txt).
 */
export const MAP_CREDIT = '지도 데이터 © OpenStreetMap contributors · ODbL · https://www.openstreetmap.org/copyright'

/** 군산 공군기지: OSM landuse airfield + 북쪽 military에 약 1km 여유 — 이 상자 안의 장소는 표지로 넣지 않고, 틀도 겹치지 않게 한다. */
export const MAP_AVOID = [126.598, 35.876, 126.656, 35.952] as const
/** 지도 데이터 범위(잘라 낸 상자) — 장소와 틀은 이 안에 있어야 한다. */
export const MAP_COVER = [126.28, 35.7, 126.92, 36.07] as const

/** 한 장에 넣는 표지의 최대 수 — 이름이 서로 겹치지 않게(electron/map/render.js가 겹치는 이름은 빼고 그린다). */
export const MAP_MAX_MARKERS = 12
/** 대체 텍스트에 적는 장소 수 — 나머지는 「외 n곳」. */
export const MAP_ALT_NAMES = 5
/** 설명 줄에 종류마다 적는 장소 수 — 나머지는 「외 n곳」. */
export const MAP_CAPTION_NAMES = 4

export const MAP_POINT_KINDS = ['attraction', 'food', 'stay'] as const
export type MapPointKind = (typeof MAP_POINT_KINDS)[number]

export const MAP_KIND_TEXT: Record<MapPointKind, string> = { attraction: '관광지', food: '음식점', stay: '숙소' }

/** 자사 사이트 /map/의 장소 하나(server/mapPoints.ts가 검사해 저장한 것). region은 사이트의 권역 이름(「원도심」 · 「새만금·비응」). */
export interface MapPoint {
  id: string
  name: string
  kind: MapPointKind
  lat: number
  lng: number
  region: string
}

/** 저장한 장소 목록(PIPELINE_DATA_DIR/<tenant>/map-points.json). version은 점 목록의 해시 — 그림 이름(캐시 열쇠)에 들어간다. */
export interface MapPointsFile {
  fetchedAt: string
  source: string
  version: string
  points: MapPoint[]
}

/** 지도 그림의 표지 하나 — 장소 · 줄 이름(label). */
export interface MapMarker {
  id: string
  name: string
  label: string
  kind: MapPointKind
  lng: number
  lat: number
}

const NAME_MAX = 40
const REGION_MAX = 20
const ID_MAX = 80
/** 장소 id — 사이트 주소의 장소 이름(slug) 모양(군산각 369곳 모두, 2026-11-05). 변형 열쇠의 「|」와 겹치지 않는다. */
const POINT_ID = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u
/** 이름 · 권역에 두지 않는 글자 — 제어 문자, 마크다운 · HTML을 깨는 글자. */
const BAD_TEXT = /[\p{Cc}\p{Zl}\p{Zp}*_\x60[\]\\<>|]/u

/** 상자 [서, 남, 동, 북] 안인가(경계 포함). */
export function inMapBox(p: { lng: number; lat: number }, box: readonly [number, number, number, number] | readonly number[]): boolean {
  return p.lng >= box[0]! && p.lng <= box[2]! && p.lat >= box[1]! && p.lat <= box[3]!
}

/** 공군기지 상자 안의 장소인가 — 표지로 넣지 않는다. */
export function inMapAvoid(p: { lng: number; lat: number }): boolean {
  return inMapBox(p, MAP_AVOID)
}

/**
 * 사이트가 준 장소 목록(div.map[data-points]의 all)을 검사한다 — id(장소 이름 모양 · 80자) · 이름(1~40자 · 제어 문자 · 마크다운 글자 없음) ·
 * 종류(attraction · stay · food) · 좌표(유한한 숫자, 지도 데이터 범위 MAP_COVER 안) · 권역(1~20자)이 맞는 것만, 같은 id는 처음 것만.
 * 맞지 않은 수는 skipped.
 */
export function normalizeMapPoints(raw: unknown): { points: MapPoint[]; skipped: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { all?: unknown }).all) ? (raw as { all: unknown[] }).all : null
  if (!list) return { points: [], skipped: 0 }
  const points: MapPoint[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const item of list) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.normalize('NFC') : ''
    const name = typeof r.name === 'string' ? r.name.normalize('NFC').replace(/\s+/g, ' ').trim() : ''
    const region = typeof r.r === 'string' ? r.r.normalize('NFC').trim() : typeof r.region === 'string' ? r.region.normalize('NFC').trim() : ''
    const lat = r.lat
    const lng = r.lng
    const ok =
      id.length > 0 &&
      id.length <= ID_MAX &&
      POINT_ID.test(id) &&
      !seen.has(id) &&
      name.length > 0 &&
      name.length <= NAME_MAX &&
      !BAD_TEXT.test(name) &&
      region.length > 0 &&
      region.length <= REGION_MAX &&
      !BAD_TEXT.test(region) &&
      MAP_POINT_KINDS.includes(r.kind as MapPointKind) &&
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      inMapBox({ lat, lng }, MAP_COVER)
    if (!ok) {
      skipped += 1
      continue
    }
    seen.add(id)
    points.push({ id, name, kind: r.kind as MapPointKind, lat: lat as number, lng: lng as number, region })
  }
  return { points, skipped }
}

/**
 * 줄 이름 — 「긴 이름(짧은 이름)」 꼴이고 10자를 넘으면 괄호 안 · 밖 가운데 짧은 쪽(「군산신흥동일본식가옥(히로쓰가옥)」 → 「히로쓰가옥」).
 * 아니면 이름 그대로(electron/map/render.js가 그림에 쓰는 이름 · 대체 텍스트의 이름). names(장소 목록의 이름들)를 주면, 줄인 이름이 다른
 * 장소의 이름과 같을 때는 줄이지 않는다(「군산 제1수원지제방 (월명호수)」과 「월명호수」가 한 지도에 「월명호수」 둘로 나오지 않게).
 */
export function mapLabelOf(name: string, names?: ReadonlySet<string>): string {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name)
  if (!m || name.length <= 10) return name
  const outer = m[1]!.trim()
  const inner = m[2]!.trim()
  const short = inner.length <= outer.length ? inner : outer
  return names?.has(short) ? name : short
}

/** 장소의 표지 — names는 mapLabelOf와 같다(장소 목록 전체의 이름). */
export function mapMarkerOf(p: MapPoint, names?: ReadonlySet<string>): MapMarker {
  return { id: p.id, name: p.name, label: mapLabelOf(p.name, names), kind: p.kind, lng: p.lng, lat: p.lat }
}

/**
 * 변형 열쇠 — 표지 장소 id를 사전순으로 「|」로 이은 것. 같은 장소 묶음이면 같은 그림이다(반복 상한 · 그린 그림 찾기). 글 하나 · 작성자
 * 한 사람에게 한 번(src/lib/screenCapture.ts photoRepeatKey — 브랜드 상한은 받지 않는다).
 */
export function mapVariantKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('|')
}

/** 변형 열쇠의 장소 id들 — 모양이 아니면 null. */
export function mapVariantIds(key: unknown): string[] | null {
  if (typeof key !== 'string' || !key || key.length > ID_MAX * MAP_MAX_MARKERS + MAP_MAX_MARKERS) return null
  const ids = key.split('|')
  if (ids.length > MAP_MAX_MARKERS || !ids.every((id) => id.length <= ID_MAX && POINT_ID.test(id))) return null
  return mapVariantKey(ids) === key ? ids : null
}

/** 그린 지도 id — 그림 이름(캐시 열쇠)의 sha256 앞 16자. */
export const MAP_IMAGE_ID = /^[0-9a-f]{16}$/

export function isMapImageId(v: unknown): v is string {
  return typeof v === 'string' && MAP_IMAGE_ID.test(v)
}

/** 글의 사진 기록에 적는 앱 주소 — 앱 안(같은 출처)에서만 열린다. 내보낼 때 그림으로 바꾼다(src/lib/screenExport.ts). */
export function mapAppSrc(tenantId: string, mapId: string): string {
  return `/api/maps/${encodeURIComponent(tenantId)}/${mapId}.png`
}

const MAP_APP_SRC = /^\/api\/maps\/([^/?#]+)\/([0-9a-f]{16})\.png$/

/** 앱 주소에서 브랜드 · 지도 id를 읽는다. 모양이 다르거나 브랜드 id에 경로 글자가 있으면 null. */
export function parseMapAppSrc(src: unknown): { tenantId: string; mapId: string } | null {
  const m = typeof src === 'string' ? MAP_APP_SRC.exec(src) : null
  if (!m) return null
  let tenantId: string
  try {
    tenantId = decodeURIComponent(m[1]!)
  } catch {
    return null
  }
  if (!tenantId || /[/\\]/.test(tenantId) || tenantId === '.' || tenantId === '..') return null
  return { tenantId, mapId: m[2]! }
}

/**
 * 글에 넣고 내보내도 되는 지도 사진인가 — origin osm-map, 앱 주소 모양이 맞고 주소의 지도 id가 기록(mapId)과 같으며 변형 열쇠가 맞을 때만
 * (src/lib/articlePhotos.ts photoPickSrc). 출처 줄은 photoCreditState가 따로 본다.
 */
export function mapPickExportable(p: { src: string; origin?: string; mapId?: string; mapVariant?: string }): boolean {
  return p.origin === 'osm-map' && parseMapAppSrc(p.src)?.mapId === p.mapId && mapVariantIds(p.mapVariant) !== null
}

// ── 대체 텍스트 · 설명 줄 ─────────────────────────────────────────────────

/** 마지막 글자에 받침이 있는가 — 한글은 음절로, 숫자는 읽는 소리로, 그 밖(영문 등)은 없다고 본다. */
function hasBatchim(word: string): boolean {
  const ch = word.trim().slice(-1)
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (/[0-9]/.test(ch)) return '013678'.includes(ch)
  return false
}

/** 이름 목록 — 「A · B · C」, max를 넘으면 「A · B · C 외 n곳」. */
function nameList(labels: readonly string[], max: number): string {
  const shown = labels.slice(0, max).join(' · ')
  return labels.length > max ? `${shown} 외 ${labels.length - max}곳` : shown
}

/** 지도 그림의 대체 텍스트 — 「군산 지도 — A · B · C 위치」(지도라고 말한다 — 사이트 화면이라고 쓰지 않는다). */
export function mapAltOf(markers: readonly Pick<MapMarker, 'label'>[]): string {
  return `${MAP_AREA_NAME} 지도 — ${nameList(markers.map((m) => m.label), MAP_ALT_NAMES)} 위치`
}

/**
 * 지도 그림의 설명 문장(출처 줄은 넣을 때 붙인다) — 「A · B · C 위치를 지도에 표시했습니다.」. 종류가 둘 이상이면 종류마다 묶는다(「관광지
 * A · B와 음식점 C · D 위치를 지도에 표시했습니다.」).
 */
export function mapCaptionOf(markers: readonly Pick<MapMarker, 'label' | 'kind'>[]): string {
  const groups = MAP_POINT_KINDS.map((kind) => ({ kind, labels: markers.filter((m) => m.kind === kind).map((m) => m.label) })).filter((g) => g.labels.length)
  if (groups.length <= 1) return `${nameList(markers.map((m) => m.label), MAP_CAPTION_NAMES * 2)} 위치를 지도에 표시했습니다.`
  const parts = groups.map((g) => `${MAP_KIND_TEXT[g.kind]} ${nameList(g.labels, MAP_CAPTION_NAMES)}`)
  const head = parts.slice(0, -1)
  const last = parts[parts.length - 1]!
  const lead = head.length > 1 ? `${head.slice(0, -1).join(', ')}, ${head[head.length - 1]!}` : head[0]!
  return `${lead}${hasBatchim(lead) ? '과' : '와'} ${last} 위치를 지도에 표시했습니다.`
}

/**
 * 넣을 때 그림 아래 줄들 — 그림 바로 아래 줄은 출처 줄, 그다음 줄은 위치 문장(설명 문장이 비면 출처 줄만). 출처 줄이 그림에 붙어 있어야
 * 블로그에 붙여 넣거나 글자로 옮겨도 그림과 출처가 떨어지지 않는다(2026-11-05 — 그림 → 출처 줄 → 설명).
 */
export function mapCaptionLines(caption: string | undefined): string[] {
  const c = (caption ?? '').replace(/[*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return c ? [MAP_CREDIT, c] : [MAP_CREDIT]
}

/** 글자만 나가는 곳(서식째 복사의 글자 쪽)의 지도 자리 — 「[지도: 군산 지도 — … 위치] 출처 줄」 한 줄. */
export function mapPlainLine(alt: string): string {
  return `[지도: ${alt.trim() || `${MAP_AREA_NAME} 지도`}] ${MAP_CREDIT}`
}

// ── 화면 글자 ────────────────────────────────────────────────────────────

/** 지도 사진의 칩 — 자동 채우기 미리보기 · 글의 「홈페이지 사진」 칸. 앱이 그린 지도는 표지 · 위치 문장을 자리 글자로 골라 늘 「확인 필요」다. */
export const MAP_PICK_CHIP = `${MAP_AREA_NAME} 지도(OSM) · 확인 필요`

/** 지도에 넣지 않는 구역(MAP_AVOID)을 화면에 적는 말 — 중립으로 쓴다(어떤 시설인지 적지 않는다, 2026-11-05 결정). */
export const MAP_AVOID_TEXT = '지도에 넣지 않는 구역'

/**
 * 지도에서 뺀 장소 — 「표시하지 않은 곳: A · B (지도에 넣지 않는 구역)」. why 'base'는 구역 밖이지만 틀이 구역에 걸리지 않게 뺀 장소
 * (server/mapFrame.ts dropped why 'base').
 */
export function mapLeftOutText(names: readonly string[], why: 'avoid' | 'base' = 'avoid'): string {
  return `표시하지 않은 곳: ${names.join(' · ')} (${why === 'base' ? `${MAP_AVOID_TEXT}을 피해 뺌` : MAP_AVOID_TEXT})`
}

/**
 * 지도를 그리지 못한 까닭(서버 · 메인의 code)을 화면 글자로. 구역 · 틀 문제는 중립 글자로 바꾼다 — 서버 · 메인 프로세스의 글(로그용)은 쓰지
 * 않는다. 그 밖은 서버 글 그대로.
 */
export function mapDrawFailText(code: string, message: string): string {
  if (code === 'no-markers') return `${MAP_AVOID_TEXT}의 장소만 남아 그리지 않았어요`
  if (code === 'avoid-area' || code === 'base-in-frame') return `${MAP_AVOID_TEXT}을 피하는 틀을 만들지 못해 그리지 않았어요`
  if (code === 'out-of-cover' || code === 'too-wide') return '장소가 넓게 퍼져 동봉한 지도 데이터 한 장에 담지 못했어요'
  if (code === 'unavailable' || code === 'disposed') return '이 실행에서는 지도를 그릴 수 없어요 — 설치한 데스크톱 앱에서만 그려요'
  if (code === 'timeout') return '그리는 동안 시간이 다 됐어요 — 다시 눌러 주세요'
  if (code === 'no-map-data') return '지도 데이터 파일(resources/map/gunsan.pmtiles)이 없어 그리지 못했어요 — 설치본으로 다시 설치하거나 patch:asar를 다시 실행해 주세요'
  return message || '지도를 그리지 못했어요'
}

/** 「사진 N장 받기」 · 올리기 목록의 지도 안내 — 지도 파일을 직접 올리면 그림 아래 출처 줄이 따라가지 않을 수 있다. */
export function mapCreditNote(count: number): string {
  return `${MAP_AREA_NAME} 지도 ${count}장은 OpenStreetMap 데이터로 그린 그림이라 출처 표시가 이용 조건이에요 — 지도 파일을 직접 올렸다면 지도 바로 아래에 「${MAP_CREDIT}」를 적어 주세요.`
}

// ── 표지 고르기 ───────────────────────────────────────────────────────────

/** 지도 자리 하나의 글자 — 장면 글자(대체 텍스트) · 바로 아랫줄 설명 · 소제목 · 절 글자(소제목 아래 그 절의 본문, 그림 줄 · 설명 줄 제외). */
export interface MapSlotText {
  key: string
  caption: string
  heading: string
  section: string
}

/** 권역 하나 — 장소 목록의 권역 이름과 그 권역을 말하는 낱말(화면 프로필 지도 변형의 places). */
export interface MapRegion {
  name: string
  words: readonly string[]
}

/**
 * 표지를 고른 까닭 — named 자리 글자에 이름이 나온 장소 · named-nearby 이름이 나온 장소와 그 둘레(「주변」) · anchor 설명 줄 · 소제목 · 절
 * 글자에 나온 장소 둘레 · region 자리 글자가 말한 권역 · default-region 이름도 권역도 없어 장소가 가장 많은 권역.
 */
export type MapChoiceBy = 'named' | 'named-nearby' | 'anchor' | 'region' | 'default-region'

/**
 * 고른 표지 묶음 하나 — tier 0이 먼저, tier 1은 같은 작성자 · 글에 tier 0을 이미 썼거나 사람이 그 자리에서 뺐을 때 쓰는 넓힌 묶음(tier 0 틀
 * 밖의 둘레 관광지를 더해 틀이 달라진다).
 */
export interface MapVariant {
  key: string
  ids: string[]
  markers: MapMarker[]
  tier: number
}

export interface MapChoice {
  by: MapChoiceBy
  /** 자리 글자(장면)에 이름이 나온 장소. */
  named: string[]
  /** 이름이 없는 자리의 기준 장소 — 설명 줄 · 소제목 · 절 글자 차례로 처음 나온 장소. */
  anchor?: { name: string; from: 'caption' | 'heading' | 'section' }
  /** 둘레를 고른 권역. */
  region?: string
  /** 고른 종류(자리 글자가 말한 관광지 · 음식점 · 숙소, 없으면 관광지). */
  kinds: MapPointKind[]
  /** 공군기지 상자 안이라 뺀 장소(이름). */
  avoided: string[]
  variants: MapVariant[]
  /** 사람이 읽는 까닭(미리보기 · 점검표). */
  why: string
}

export type MapChoiceResult = MapChoice | { miss: 'no-points' | 'no-markers'; why: string }

/** 비교용 글자 — 띄어쓰기 · 문장부호를 걷고 소문자로. */
function textKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 이름이 이보다 짧으면(비교용 글자 수) 맞추지 않는다 — 「달」 · 「하늘」 같은 숙소 이름이 아무 글에나 걸린다. */
const MIN_NAME_KEY = 3
/** 「○○공원」은 「○○」로도 맞춘다 — 줄인 이름이 이만큼 길 때만(src/lib/photoAutoPick.ts findPlaces와 같다). */
const MIN_STEM_KEY = 4

/** 장소 이름의 비교 열쇠 — full 이름 그대로, 그 밖은 줄인 이름(괄호 안 · 밖, 「군산」을 뗀 이름, 「○○공원」의 「○○」). */
function nameKeysOf(name: string): { key: string; full: boolean }[] {
  const out: { key: string; full: boolean }[] = [{ key: textKey(name), full: true }]
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name)
  const bases = m ? [m[1]!, m[2]!] : [name]
  for (const b of bases) {
    out.push({ key: textKey(b), full: false })
    const noCity = b.replace(/^군산\s*/, '')
    if (noCity !== b) out.push({ key: textKey(noCity), full: false })
  }
  for (const k of [...out]) {
    const stem = k.key.replace(/공원$/, '')
    if (stem !== k.key && stem.length >= MIN_STEM_KEY) out.push({ key: stem, full: false })
  }
  const seen = new Set<string>()
  return out.filter((k) => {
    if (k.key.length < MIN_NAME_KEY || seen.has(k.key)) return false
    seen.add(k.key)
    return true
  })
}

/** 글자의 비교용 모양 — 비교용 글자와, 낱말(띄어쓰기 · 문장부호로 나뉜 덩어리)이 시작하는 자리. */
function hayOf(text: string): { hay: string; starts: Set<number> } {
  const starts = new Set<number>()
  let hay = ''
  for (const w of text.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    starts.add(hay.length)
    hay += w
  }
  return { hay, starts }
}

/** 열쇠가 글자를 한 글자 조각으로 가르지 않는가(「오래된 이 성당」은 「이성당」이 아니다 — photoAutoPick.ts lastWholeAt과 같은 기준). */
function wholeAt(starts: ReadonlySet<number>, at: number, len: number): boolean {
  let prev = at
  for (let k = at + 1; k <= at + len; k += 1) {
    if (k < at + len && !starts.has(k)) continue
    if (k - prev < 2) return false
    prev = k
  }
  return true
}

interface NameHit {
  point: MapPoint
  at: number
  len: number
  full: boolean
}

/**
 * 이름 바로 뒤(띄어쓰기 · 문장부호를 걷은 글자)에 오면 그 이름을 빼라는 말 — 「이성당 말고」 · 「이성당을 제외하고」 · 「이성당이 아닌」 ·
 * 「이성당 대신」. 「이성당 외에도」처럼 더하는 말은 넣지 않는다.
 */
const NEGATED_AFTER = /^(?:이|가|은|는|을|를|도)?(?:말고|말구|말곤|빼고|제외|대신|아닌|아니라)/u

/** 글자에 나온 장소 이름 자리(나온 차례) — 한 자리에는 한 장소(mapNamesIn의 순서 규칙), negated는 뒤에 빼라는 말이 온 자리. */
function nameHitsIn(text: string, points: readonly MapPoint[]): (NameHit & { negated: boolean })[] {
  const { hay, starts } = hayOf(text)
  if (!hay) return []
  const hits: NameHit[] = []
  for (const point of points) {
    for (const { key, full } of nameKeysOf(point.name)) {
      for (let at = hay.indexOf(key); at >= 0; at = hay.indexOf(key, at + 1)) {
        if (wholeAt(starts, at, key.length)) hits.push({ point, at, len: key.length, full })
      }
    }
  }
  const order = new Map(points.map((p, i) => [p.id, i]))
  hits.sort((a, b) => b.len - a.len || Number(b.full) - Number(a.full) || order.get(a.point.id)! - order.get(b.point.id)! || a.at - b.at)
  const taken: NameHit[] = []
  for (const h of hits) {
    if (taken.some((t) => h.at < t.at + t.len && t.at < h.at + h.len)) continue
    taken.push(h)
  }
  taken.sort((a, b) => a.at - b.at)
  return taken.map((h) => ({ ...h, negated: NEGATED_AFTER.test(hay.slice(h.at + h.len)) }))
}

/**
 * 글자에 나온 장소들(나온 차례) — 띄어쓰기는 무시하고, 같은 자리에서는 긴 이름이 먼저(「은파호수공원 물빛다리」의 「은파호수공원」은 묻힌다),
 * 같은 자리 · 같은 길이면 이름 그대로 맞은 장소가 줄인 이름으로 맞은 장소보다 먼저(같음 → 포함), 그다음 목록 순서. 한 자리에는 한 장소.
 * 「○○ 말고 · 빼고 · 대신 · 아닌」처럼 빼라고 한 이름은 넣지 않는다(NEGATED_AFTER).
 */
export function mapNamesIn(text: string, points: readonly MapPoint[]): MapPoint[] {
  const out: MapPoint[] = []
  for (const h of nameHitsIn(text, points)) if (!h.negated && !out.includes(h.point)) out.push(h.point)
  return out
}

/** 글자가 빼라고 한 장소(「○○ 말고」의 ○○) — 그 자리의 기준점 · 표지로 쓰지 않는다. */
function negatedNamesIn(text: string, points: readonly MapPoint[]): MapPoint[] {
  return nameHitsIn(text, points)
    .filter((h) => h.negated)
    .map((h) => h.point)
}

/** 자리 글자가 말한 종류 — 관광지 · 음식점 · 숙소 낱말. 서비스 소개 문구(「관광지·음식점·숙소의 여는 시간과 요금」)는 빼고 본다. */
const KIND_WORDS: Record<MapPointKind, RegExp> = {
  attraction: /관광지|관람지|명소|볼거리|여행지|관광\s?명소|가\s?볼\s?만한|놀거리/,
  food: /식당|음식점|맛집|먹거리|밥집|빵집|간식|카페|디저트|먹을\s?곳/,
  stay: /숙소|호텔|숙박|펜션|게스트\s?하우스|모텔|민박/,
}
const SERVICE_BLURB = /관광지\s?[·,ㆍ]\s?음식점\s?[·,ㆍ]\s?숙소의?\s?(?:여는\s?시간|정보|안내)[^.!?\n]*/g
/** 「주변」 · 「근처」 — 이름이 나온 장소의 둘레도 넣는다. */
const NEARBY_WORDS = /주변|근처|둘레|가까운|일대/

export function mapKindsIn(text: string): MapPointKind[] {
  const t = text.normalize('NFC').replace(SERVICE_BLURB, ' ')
  return MAP_POINT_KINDS.filter((k) => KIND_WORDS[k].test(t))
}

/**
 * 빵집 · 간식 · 카페 자리 — 종류를 정한 글자가 이 갈래만 말하면(식사 낱말 없이) 음식점은 이름이 그 갈래인 곳만 고른다(「빵집·간식 동선」에
 * 갈비집 · 횟집을 넣지 않는다, 2026-11-05 검토). 장소 목록에는 갈래가 없어 이름으로만 가른다 — 맞는 이름이 없으면 비운다.
 */
const SNACK_WORDS = /빵|베이커리|제과|호떡|간식|디저트|카페|커피/
const MEAL_WORDS = /식당|음식점|맛집|먹거리|밥집|식사|먹을\s?곳/
const SNACK_NAME = /빵|베이커리|제과|호떡|카페|커피|디저트|도넛|케이크|젤라또|아이스크림/

function snackOnlyIn(text: string): boolean {
  const t = text.normalize('NFC').replace(SERVICE_BLURB, ' ')
  return SNACK_WORDS.test(t) && !MEAL_WORDS.test(t)
}

/**
 * 같은 자리로 보는 거리(m) — 사이트 목록에는 같은 건물이 두 이름으로 있다(「호남관세박물관」 = 「구 군산세관 본관」 0m, 같은 건물의 두 가게
 * 5m). 이 안의 장소는 한 지도에 하나만 넣는다(한 점에 이름 둘 · 표지 칸 낭비). 12~17m 떨어진 다른 곳(갤러리와 옆 카페)은 따로 둔다.
 */
const SAME_SPOT_M = 10

/** list에 같은 자리 장소가 이미 있는가. */
function sameSpotIn(list: readonly MapPoint[], p: MapPoint): boolean {
  return list.some((q) => mapDistanceM(p, q) <= SAME_SPOT_M)
}

/** 같은 자리 장소는 앞의 것만 남긴다(자리 글자에 나온 차례 · 사이트 목록 순서). */
function onePerSpot(list: readonly MapPoint[]): MapPoint[] {
  const out: MapPoint[] = []
  for (const p of list) if (!sameSpotIn(out, p)) out.push(p)
  return out
}

/** 두 점 사이 거리(m) — 하버사인. */
export function mapDistanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** 둘레로 볼 거리 — 이보다 먼 장소는 둘레로 넣지 않는다(원도심 핵심부가 약 2km). */
const NEAR_M = 2000
/** 종류마다 넣는 둘레 장소 수 — 종류가 하나 · 둘 · 셋일 때(「식당과 주변 관광지」 → 음식점 4 · 관광지 4). */
const PER_KIND: Record<number, number> = { 1: 6, 2: 4, 3: 3 }
/** 이름이 나온 장소의 「주변」으로 더하는 장소 수 · 넓힌 묶음(tier 1)에 더하는 관광지 수(tier 0 틀 밖의 것만). */
const NEARBY_ADD = 5
const WIDER_ADD = 3

/** 글자가 말한 권역 — 권역 낱말(이름 · 그 권역의 장소 낱말)이 처음 나온 권역. */
function regionIn(text: string, regions: readonly MapRegion[]): string | null {
  const t = textKey(text)
  let best: { name: string; at: number } | null = null
  for (const r of regions) {
    for (const w of [r.name, ...r.words]) {
      const k = textKey(w)
      if (k.length < 2) continue
      const at = t.indexOf(k)
      if (at >= 0 && (!best || at < best.at)) best = { name: r.name, at }
    }
  }
  return best?.name ?? null
}

/** 장소가 가장 많은 권역(관광지 수) — 이름도 권역도 없는 자리의 권역. */
function busiestRegion(points: readonly MapPoint[]): string | null {
  const count = new Map<string, number>()
  for (const p of points) if (p.kind === 'attraction' && !inMapAvoid(p)) count.set(p.region, (count.get(p.region) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * 둘레 장소 — 기준점(center)에서 NEAR_M 안의 그 종류 장소, 가까운 차례(같으면 목록 순서). 같은 권역(region)만, 공군기지 상자 밖만,
 * taken(이미 고른 장소)과 같은 자리(SAME_SPOT_M 안)는 빼고, where를 주면 그것이 참인 장소만.
 */
function nearest(
  points: readonly MapPoint[],
  center: MapPoint | { lat: number; lng: number },
  kind: MapPointKind,
  region: string | null,
  skip: ReadonlySet<string>,
  n: number,
  taken: readonly MapPoint[],
  where?: (p: MapPoint) => boolean,
): MapPoint[] {
  const out: MapPoint[] = []
  const sorted = points
    .map((p, i) => ({ p, i, d: mapDistanceM(center, p) }))
    .filter(({ p, d }) => p.kind === kind && !skip.has(p.id) && !inMapAvoid(p) && d <= NEAR_M && (!region || p.region === region) && (!where || where(p)))
    .sort((a, b) => a.d - b.d || a.i - b.i)
  for (const { p } of sorted) {
    if (out.length >= n) break
    if (!sameSpotIn(taken, p) && !sameSpotIn(out, p)) out.push(p)
  }
  return out
}

/**
 * 지도 그림의 틀 — server/mapFrame.ts(frameFor)와 같은 값: 1280×800, 기본 여백 위아래 120 · 좌우 170px, 가장 크게 볼 줌 16.3, 512px 타일
 * 웹 메르카토르. scripts/verify-map-image.ts가 frameFor의 기본 여백 줌(fitZoom)과 견준다.
 */
const FRAME_W = 1280
const FRAME_H = 800
const FRAME_PAD_X = 170
const FRAME_PAD_Y = 120
const FRAME_MAX_ZOOM = 16.3
const FRAME_TILE = 512
const mercX = (lng: number) => (lng + 180) / 360
const mercY = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
}

/** 장소들이 기본 여백 안에 드는 줌(frameFor의 fitZoom과 같은 계산, 반올림 없음). */
export function mapFitZoom(list: readonly { lng: number; lat: number }[]): number {
  const xs = list.map((p) => mercX(p.lng))
  const ys = list.map((p) => mercY(p.lat))
  const span = (v: number[]) => Math.max(Math.max(...v) - Math.min(...v), 1e-9)
  return Math.min(FRAME_MAX_ZOOM, Math.log2(Math.min((FRAME_W - 2 * FRAME_PAD_X) / (span(xs) * FRAME_TILE), (FRAME_H - 2 * FRAME_PAD_Y) / (span(ys) * FRAME_TILE))))
}

/** 장소들의 기본 틀(가운데 · mapFitZoom)이 덮는 상자 — 이 밖의 장소를 더해야 틀이 달라진다. */
function fitFrameBox(list: readonly { lng: number; lat: number }[]): (p: { lng: number; lat: number }) => boolean {
  const s = FRAME_TILE * 2 ** mapFitZoom(list)
  const xs = list.map((p) => mercX(p.lng))
  const ys = list.map((p) => mercY(p.lat))
  const cx = ((Math.min(...xs) + Math.max(...xs)) / 2) * s
  const cy = ((Math.min(...ys) + Math.max(...ys)) / 2) * s
  return (p) => Math.abs(mercX(p.lng) * s - cx) <= FRAME_W / 2 && Math.abs(mercY(p.lat) * s - cy) <= FRAME_H / 2
}

/** 장소 묶음의 무게중심. */
function centroid(list: readonly MapPoint[]): { lat: number; lng: number } {
  return { lat: list.reduce((s, p) => s + p.lat, 0) / list.length, lng: list.reduce((s, p) => s + p.lng, 0) / list.length }
}

function variantOf(list: readonly MapPoint[], tier: number, names: ReadonlySet<string>): MapVariant {
  const markers = list.slice(0, MAP_MAX_MARKERS).map((p) => mapMarkerOf(p, names))
  const ids = markers.map((m) => m.id)
  return { key: mapVariantKey(ids), ids, markers, tier }
}

/** 종류 이름(까닭 글자) — 빵집 · 간식 자리의 음식점은 그 갈래 이름만 골랐다고 적는다. */
function kindText(k: MapPointKind, snack: boolean): string {
  return k === 'food' && snack ? '음식점(빵집 · 카페 · 간식 이름)' : MAP_KIND_TEXT[k]
}

/**
 * 지도 자리 하나의 표지 — 자사 사이트 장소 목록(points)에서만 고른다. 공군기지 상자 안의 장소는 빼고(avoided), 한 장에 MAP_MAX_MARKERS곳까지,
 * 같은 자리(SAME_SPOT_M 안)의 장소는 하나만. 자리 글자 · 설명 줄 · 소제목이 「○○ 말고」처럼 빼라고 한 장소는 어디에도 넣지 않는다.
 * 1. 장면 글자에 장소 이름이 나오면(띄어쓰기 무시, 같음 → 포함) 그 장소들(named). 「주변」 · 「근처」를 말하거나 종류 낱말(관광지 · 음식점 ·
 *    숙소)이 함께 있으면 그 장소들의 둘레(NEAR_M 안)에서 그 종류(없으면 관광지)를 NEARBY_ADD곳까지 더한다(named-nearby).
 * 2. 이름이 없으면 설명 줄 · 소제목 · 절 글자 차례로 처음 나온 장소를 기준점(anchor)으로, 그 장소의 권역에서 자리 글자가 말한 종류(장면 글자,
 *    없으면 설명 줄 · 소제목 — 서비스 소개 문구는 빼고)를 기준점 가까운 차례로 고른다(종류마다 PER_KIND곳, 기준점 포함). 종류를 말하지
 *    않으면 관광지.
 * 3. 기준점도 없으면 글자가 말한 권역(region), 그것도 없으면 관광지가 가장 많은 권역(default-region)의 첫 관광지(사이트 목록 순서 — 사이트가
 *    앞에 둔 이름난 곳)를 기준점으로 같은 방식. 관광지는 사이트 목록 순서대로.
 * 기준점은 늘 표지 맨 앞에 넣고 까닭에 「○○ 둘레」로 적는다(보이지 않는 기준으로 고른 업소만 지도에 나오지 않게). 종류를 정한 글자가 빵집 ·
 * 간식 · 카페만 말하면 음식점은 그 갈래 이름만(SNACK_NAME). 이름이 없는 자리에서 말한 종류의 장소를 하나도 고르지 못하면 비운다(no-markers).
 * 변형은 tier 0(위 묶음)과 넓힌 tier 1 — tier 0의 기본 틀 밖에 있는 둘레 관광지를 WIDER_ADD곳까지 더한 것(같은 작성자 · 글에 tier 0을 이미
 * 썼거나 사람이 이 자리에서 뺐을 때 쓴다). 틀 밖 관광지가 없으면 tier 1은 없다 — 틀 안 장소만 더하면 같은 그림이 되기 때문이다.
 */
export function mapChoiceOf(slot: MapSlotText, points: readonly MapPoint[], regions: readonly MapRegion[] = []): MapChoiceResult {
  if (!points.length) return { miss: 'no-points', why: '자사 사이트 장소 목록이 비어 있음' }
  const names = new Set(points.map((p) => p.name))
  const negated = new Set([slot.key, slot.caption, slot.heading].flatMap((t) => (t ? negatedNamesIn(t, points) : [])).map((p) => p.id))
  const usable = negated.size ? points.filter((p) => !negated.has(p.id)) : points
  const avoided: string[] = []
  const safe = (list: readonly MapPoint[]) =>
    list.filter((p) => {
      if (!inMapAvoid(p)) return true
      if (!avoided.includes(p.name)) avoided.push(p.name)
      return false
    })
  const namedAll = mapNamesIn(slot.key, usable)
  const named = onePerSpot(safe(namedAll))
  const altKinds = mapKindsIn(slot.key)
  let kinds = altKinds
  let by: MapChoiceBy
  let list: MapPoint[]
  let anchor: MapChoice['anchor']
  let region: string | null = null
  let snack = false
  const why: string[] = []
  if (namedAll.length) {
    const nearby = NEARBY_WORDS.test(slot.key) || altKinds.length > 0
    list = [...named]
    by = 'named'
    why.push(`장면 글자에 나온 장소 ${namedAll.map((p) => p.name).join(' · ')}`)
    if (nearby && named.length) {
      const want = altKinds.length ? altKinds : (['attraction'] as MapPointKind[])
      kinds = want
      snack = want.includes('food') && snackOnlyIn(slot.key)
      const at = centroid(named)
      region = named[0]!.region
      const skip = new Set(list.map((p) => p.id))
      const per = Math.max(1, Math.floor(NEARBY_ADD / want.length))
      for (const k of want) {
        for (const p of nearest(usable, at, k, region, skip, per, list, k === 'food' && snack ? (q) => SNACK_NAME.test(q.name) : undefined)) {
          list.push(p)
          skip.add(p.id)
        }
      }
      by = 'named-nearby'
      why.push(`그 둘레(${NEAR_M / 1000}km 안 · ${region})의 ${want.map((k) => kindText(k, snack)).join(' · ')}`)
    }
  } else {
    const kindFrom = kinds.length ? slot.key : `${slot.caption}\n${slot.heading}`
    if (!kinds.length) kinds = mapKindsIn(kindFrom)
    if (!kinds.length) kinds = ['attraction']
    snack = kinds.includes('food') && snackOnlyIn(kindFrom)
    let center: MapPoint | undefined
    for (const [text, from] of [
      [slot.caption, 'caption'],
      [slot.heading, 'heading'],
      [slot.section, 'section'],
    ] as const) {
      const found = text ? safe(mapNamesIn(text, usable))[0] : undefined
      if (found) {
        anchor = { name: found.name, from }
        region = found.region
        center = found
        break
      }
    }
    if (anchor) {
      by = 'anchor'
      why.push(`이름이 없는 자리 — ${{ caption: '설명 줄', heading: '소제목', section: '절 글자' }[anchor.from]}에 처음 나온 ${anchor.name} 둘레(${region})`)
    } else {
      const said = regionIn(`${slot.key}\n${slot.caption}\n${slot.heading}\n${slot.section}`, regions)
      region = said ?? busiestRegion(usable)
      by = said ? 'region' : 'default-region'
      center = usable.find((p) => p.region === region && p.kind === 'attraction' && !inMapAvoid(p))
      const base = center ? ` · 기준 ${center.name} 둘레` : ''
      why.push(said ? `이름이 없는 자리 — 글자가 말한 권역 ${region}${base}` : `이름도 권역도 없는 자리 — 관광지가 가장 많은 권역 ${region ?? '(없음)'}${base}`)
    }
    if (!center) return { miss: 'no-markers', why: `${why.join(' · ')} — 기준 장소가 없음` }
    // 기준점은 표지 맨 앞 — 둘레를 고른 기준이 지도와 까닭에 보이게(관광지 자리면 사이트 목록의 첫 관광지라 예전과 같은 묶음이다).
    list = [center]
    const skip = new Set<string>([center.id])
    const per = PER_KIND[kinds.length] ?? 3
    for (const k of kinds) {
      const room = center.kind === k ? per - 1 : per
      const picked: MapPoint[] = []
      if (!anchor && k === 'attraction') {
        for (const p of usable) {
          if (picked.length >= room) break
          if (p.kind === 'attraction' && p.region === region && !inMapAvoid(p) && !skip.has(p.id) && mapDistanceM(center, p) <= NEAR_M && !sameSpotIn(list, p) && !sameSpotIn(picked, p)) picked.push(p)
        }
      } else picked.push(...nearest(usable, center, k, region, skip, room, list, k === 'food' && snack ? (q) => SNACK_NAME.test(q.name) : undefined))
      for (const p of picked) {
        list.push(p)
        skip.add(p.id)
      }
    }
    why.push(`${kinds.map((k) => kindText(k, snack)).join(' · ')} ${!anchor && kinds.includes('attraction') ? '(관광지는 사이트 목록 순서)' : '(가까운 차례)'}`)
    if (!kinds.some((k) => list.some((p) => p.kind === k))) {
      if (avoided.length) why.push(mapLeftOutText(avoided))
      const wanted = kinds.map((k) => MAP_KIND_TEXT[k]).join(' · ')
      return { miss: 'no-markers', why: `${why.join(' · ')} — ${snack ? '빵집 · 카페 · 간식 이름의 음식점이 없음' : `둘레에 ${wanted}${hasBatchim(wanted) ? '이' : '가'} 없음`}` }
    }
  }
  if (avoided.length) why.push(mapLeftOutText(avoided))
  if (!list.length) return { miss: 'no-markers', why: `${why.join(' · ')} — 넣을 장소가 없음` }
  const variants = [variantOf(list, 0, names)]
  if (list.length < MAP_MAX_MARKERS) {
    // 넓힌 묶음은 tier 0 기본 틀 밖의 관광지만 더한다 — 틀 안 장소만 더하면 줌 · 중심이 그대로라 거의 같은 그림이다.
    const inFrame = fitFrameBox(list)
    const skip = new Set(list.map((p) => p.id))
    const more = nearest(usable, centroid(list), 'attraction', region ?? list[0]!.region, skip, WIDER_ADD, list, (p) => !inFrame(p))
    if (more.length) variants.push(variantOf([...list, ...more], 1, names))
  }
  return {
    by,
    named: namedAll.map((p) => p.name),
    ...(anchor ? { anchor } : {}),
    ...(region ? { region } : {}),
    kinds,
    avoided,
    variants,
    why: why.join(' · '),
  }
}

/**
 * 절 글자 — 사진 자리 줄이 든 절(앞 소제목 다음 줄부터 다음 소제목 앞까지)의 본문. 그림 줄과 사진 자리 바로 아랫줄 설명은 뺀다.
 * lines는 발행 원고의 줄, line은 사진 자리 줄 번호.
 */
export function mapSectionText(lines: readonly string[], line: number): string {
  let a = line
  while (a > 0 && !/^#{1,6}\s/.test(lines[a - 1]!.trim())) a -= 1
  let b = line + 1
  while (b < lines.length && !/^#{1,6}\s/.test(lines[b]!.trim())) b += 1
  return lines
    .slice(a, b)
    .filter((l, i) => a + i !== line && a + i !== line + 1 && !/^!\[/.test(l.trim()))
    .join('\n')
    .trim()
}
