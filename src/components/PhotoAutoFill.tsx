import { useMemo, useRef, useState } from 'react'
import {
  captureScreen,
  loadMapPoints,
  loadMaps,
  loadOwnerPhotos,
  loadPhotoScenesStatus,
  loadPublishSettings,
  loadRegionTourPhotos,
  loadScreenCaptureStatus,
  loadScreens,
  loadTourApiStatus,
  renderMaps,
  saveDraftPhotosAuto,
  type AutoPhotoSaveResult,
  type MapImageItem,
  type ScreenList,
  type StoredDraft,
  type TenantSummary,
} from '../lib/api'
import { canonicalPhotoSrc, PHOTO_LICENSES, photoCreditState, photosAllowed, publicPhotosAllowed, type PhotoLicense } from '../lib/articlePhotos'
import { publishMarkdownOf } from '../lib/draftGaps'
import { MAP_AREA_NAME, mapDrawFailText, type MapPoint } from '../lib/mapImage'
import {
  AUTO_CANDIDATE_SKIP_TEXT,
  AUTO_SLOT_STATE_TEXT,
  autoPickPhotos,
  autoPreviewCounts,
  findPlace,
  mapMissText,
  mapPickReason,
  otherPhotoUses,
  photoStateKey,
  placesToRead,
  publicCandidateFields,
  regionRowsWanted,
  SCENE_SKIP_TEXT,
  tourPlacesWanted,
  type AutoArticle,
  type AutoCandidate,
  type AutoPickResult,
  type AutoScreenPick,
  type AutoScreenShot,
  type AutoScreenWant,
  type AutoSlotRow,
  type AutoSlotState,
  type SceneSkip,
} from '../lib/photoAutoPick'
import { kstDate } from '../lib/publishedUrl'
import { REGION_SCENE_LIMITS, SCENE_SETTING_TEXT, sceneMeta, type PhotoScene, type SceneWant } from '../lib/photoScenes'
import { isScreenKind, MAP_PREVIEW_ONLY_TEXT, SCREEN_SLOT_KIND_TEXT, screenAspectRatio, screenCaptureOrder, screenProfileFor, screenShotMeta } from '../lib/screenCapture'
import {
  loadPlaceDirectory,
  loadPublicPhotos,
  loadScenesFor,
  loadSitePhotos,
  loadTourPhotosFor,
  newSceneBudget,
  photoPageOf,
  pickReadingScenes,
  publicCandidatesOf,
  regionCandidatesOf,
  siteRootOf,
  tourCandidatesOf,
  type PlaceEntry,
  type PublicPhotoPage,
  type SitePhotoResult,
} from '../lib/sitePhotos'
import { regionPhotoCity, TOUR_PLACE_LIMIT, TOUR_SOURCES, tourSourceOf, type TourSource } from '../lib/tourPhotos'
import MapPickBrief from './MapPickBrief'

/**
 * 사진 자리 자동 채우기 — 단추를 누르면 홈페이지 사진 후보로 빈 사진 자리를 맞추고(1단계), 그래도 빈 자리는 자리 글자에 나온 장소의
 * 공공 사진(자사 사이트 장소 페이지의 공공누리 제1유형 사진 — 2단계, 공공 사진 사용 확인 뒤에만)으로 맞춰(src/lib/photoAutoPick.ts)
 * 미리보기 표를 먼저 보이고, 운영자가 「저장」을 눌러야 저장한다(PUT …/photos op auto). 자리마다 따로 확인받지 않는다 — 대신 저장된
 * 사진에 「자동」 표시가 붙고 글의 「홈페이지 사진」 칸에서 바꾸거나 뺄 수 있다. 이미 고른 출처 없는 공공 사진은 같은 사진이 장소 페이지에
 * 제1유형으로 있으면 같은 저장에서 출처를 붙인다. 고르기 자체는 AI를 부르지 않는다(사진 장면 읽기만 — 아래). 장소 페이지는 빈 자리에 나온 장소만 읽는다(PUBLIC_PAGE_LIMIT곳까지).
 * 장소 페이지에도 쓸 사진이 없던 장소 자리는, 이 PC에 TourAPI 키가 있으면(/api/health tourApi) 한국관광공사의 공공누리 제1유형 사진
 * (관광공사 사진 — 3단계, 서버 /api/tourapi/photos)으로 채운다(TourAPI를 새로 부르는 장소는 TOUR_PLACE_LIMIT곳까지). 장소 페이지를
 * 읽지 못한(일시 실패 · 읽기 상한) 장소의 자리는 3단계로 채우지 않는다. 키가 없으면 건너뛰고, 공공 사진 사용 확인이 있는데 그런 자리가
 * 남을 때만 알린다.
 *
 * 사진 장면 — 이 PC에 Claude 키가 있으면(/api/health photoScenes) 후보를 모은 뒤 아직 고를 자리의 후보 사진 장면을 서버에 묻고(읽어 둔
 * 장면은 그대로, 없는 사진은 비전 모델로 — 「사진 장면 읽는 중 n/m」, src/lib/sitePhotos.ts loadScenesFor) 장면으로 다시 고른다 — 다시
 * 고르면 새로 쓰일 사진(홈페이지 사진의 장면이 어긋나 빠진 자리의 장소 사진)이 생기므로, 새 사진이 없을 때까지 되풀이한다
 * (pickReadingScenes). 장소만 맞고 장면이 어긋난 사진(외관 자리에 실내 전시 사진)은 넣지 않는다 — 틀린 사진보다 빈자리. 장면을 읽지 못한
 * 사진은 장소 사진이면 쓰지 않는다(그 자리는 관광공사 사진을 찾는다). 키가 없으면 알리고 지금처럼 고르되, 서버가 읽어 둔 장면은 받아
 * (새로 읽지 않는다 — knownScenes) 장면이 어긋난 사진은 고르지 않는다(장면 때문에 뺀 자동 사진이 그 자리에 다시 들어가지 않게).
 * 「사람이 뺀 자리도 다시 채우기」(기본 꺼짐)를 켜면 사람이 뺀 자리도 다시 보되, 그 자리에서 뺀 사진은 고르지 않는다(서버도 저장할 때
 * 다시 본다). 뺀 사진을 적어 두기 전에 뺀 자리(옛 기록)는 무엇을 뺐는지 몰라 장면을 읽을 수 있을 때만 다시 채운다.
 * 「이미 넣은 자동 사진도 장면 확인」(기본 켜짐)을 켜면 장면을 읽을 수 있을 때 이미 넣은 자동 사진(「자동」 표시 — 사람이 고른 사진은
 * 보지 않는다)의 장면도 읽어 자리와 견준다 — 맞으면 그대로, 시간만 다르면 맞는 사진이 있을 때만 바꾸고 아니면 비슷한 사진으로 두며,
 * 종류 · 사람이 어긋나면 맞는 사진 → 비슷한 사진으로 바꾸고 둘 다 없으면 뺀다. 미리보기에 「장면 안 맞음 → 바꿈 · 뺌」 · 「비슷한 사진으로
 * 둠」으로 보이고, 저장을 눌러야 바뀐다(서버가 그 자리에 화면이 본 그 자동 사진이 있을 때만 — 그사이 사람이 고른 자리는 건드리지 않는다).
 * 장소 이름이 없는 자리(「군산 원도심 골목을 연인이 나란히 걸어가는 뒷모습」)는 지역형 브랜드(지역이 시 · 군 · 구까지)이고 장면을 읽을 수
 * 있으며 공공 사진 사용 확인 · TourAPI 키가 있을 때, 브랜드 도시로 찾은 관광사진(지역 사진 — /api/tourapi/photos?mode=region)과 이번에
 * 받은 관광공사 사진 가운데 자리 낱말이 맞는 사진만 장면을 읽어 비슷한 장면을 넣는다(「장소 없는 자리 — 비슷한 장면」, 늘 「확인 필요」).
 * 장소 사전(sitemap)을 읽지 못했으면 장소 없는 자리를 알 수 없어 하지 않고, 브랜드 자기 시설(브랜드 이름 · 객실 · 독채 · 매장 · 메뉴)이나
 * 고유한 장소 이름이 나온 자리에는 넣지 않는다(다른 곳의 사진은 틀린 사진이다).
 *
 * 자사 화면 — 브랜드 자사 사이트에 화면 프로필(src/lib/screenCapture.ts)이 있으면 사진을 다 고른 뒤 코스 · 지도 · 장소 안내 · 가이드 화면
 * 자리를 이 PC에 찍어 둔 자사 화면으로 맞춘다(GET /api/screens — 장소 안내는 자리 글자의 장소를 사이트 장소 사전에서 찾는다). 설치한
 * 데스크톱 앱에서 찍을 수 있으면(/api/health screens) 아직 찍지 않은 화면을 한 번 누를 때 SCREEN_CAPTURES_PER_RUN장까지 찍고(글에 넣는
 * 화면 먼저 — 「자사 화면 찍는 중 n/m」) 다시 고른다 — 남은 화면은 다시 누르면 이어서
 * 찍는다. 찍을 수 없으면(웹 · 개발 서버) 찍어 둔 화면만 쓰고 그렇다고 알린다. 지도 화면은 카카오 지도 이용 조건을 확인하기 전이라
 * 미리보기만 하고 저장하지 않는다(결정 4 — 저장 수에 세지 않는다). 코스 · 장소 안내 · 가이드 화면은 사진과 같이 op auto로 저장한다(서버가
 * 다시 본다). 장소 안내 · 가이드는 잘라 찍은 화면이라 자리 글자의 시각 · 요금 · 요일이 찍은 글자에 없으면 「확인 필요」로 보인다.
 *
 * 군산 지도 — 장소 목록 출처가 있는 프로필(군산각)의 지도 자리는 카카오 지도 미리보기 대신 앱이 동봉한 OpenStreetMap 데이터로 그린 지도로
 * 채운다(src/lib/mapImage.ts — 표지는 자사 사이트 /map/의 장소에서 고른다, GET /api/maps · /api/maps/:tenantId/points). 아직 그리지 않은
 * 지도는 미리보기의 「군산 지도 그리기」로 한 번에 그리고(한 장에 1초 안팎 — 「군산 지도 그리는 중 n/m」, POST /api/maps/:tenantId/render),
 * 그린 뒤 같은 입력으로 다시 골라 미리보기를 바꾼다. 지도는 늘 「확인 필요」이고, 까닭 줄에 표지 · 뺀 장소를 중립 글자로 적는다(「표시하지
 * 않은 곳: … (지도에 넣지 않는 구역)」). 그리기는 설치한 데스크톱 앱에서만 — 개발 서버는 그려 둔 지도만 쓰고, 웹은 지도 라우트가 없어
 * 「데스크톱 앱에서만」으로 알린다.
 *
 * 미리보기는 계산한 때의 초안으로 고른다 — 그사이 다른 미리보기 · 사람이 고른 사진이 저장되거나 글이 바뀌면(photoStateKey) 그
 * 미리보기로는 저장하지 않고 다시 맞추게 한다(작성자 · 브랜드 반복 상한이 달라진다). 서버도 쓰기 안에서 상한을 다시 본다.
 *
 * 글 하나(SitePhotoPanel), 작성자 한 명 · 브랜드 전부(GapActions WriterRuns), 작성자 배정이 없는 브랜드의 「① 글 확인」에서 쓴다.
 */

/** 한 번 누를 때 새로 찍는 자사 화면 수 — 한 장에 몇 초(지도는 4초 안팎, 늦으면 45초)라 나머지는 다시 눌러 이어서 찍는다. */
const SCREEN_CAPTURES_PER_RUN = 3

export default function PhotoAutoFill({
  tenantId,
  brand,
  articles,
  drafts,
  groupOf,
  label,
  locked = false,
  onBusyChange,
  onStored,
  source,
  single = false,
}: {
  tenantId: string
  brand: TenantSummary
  /** 채울 글 — 이 순서대로 고른다(작성자 배정 순서). */
  articles: readonly { stored: StoredDraft; title: string }[]
  /** 브랜드의 초안 전부 — 이번에 돌지 않는 글의 사진도 반복 상한에 센다. */
  drafts: Readonly<Record<string, StoredDraft>>
  /** 글의 작성자 — 같은 작성자의 글 사이에 같은 사진을 한 번만 쓴다. */
  groupOf?: (actionId: string) => string | undefined
  label: string
  /** 다른 일괄 실행(초안 만들기 · 사진 저장)이 도는 중 — 단추를 끈다. */
  locked?: boolean
  /** 저장 시작 · 끝 — 화면이 다른 일괄 실행을 잠근다(src/lib/bulkRun.ts photos). */
  onBusyChange?: (busy: boolean) => void
  onStored: (s: StoredDraft) => void
  /** 이미 불러온 홈페이지 사진(글의 「홈페이지 사진」 칸) — 있으면 그 페이지의 사진을 쓴다. */
  source?: SitePhotoResult | null
  /** 글 하나 — 표에서 글 칸을 뺀다. */
  single?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [refill, setRefill] = useState(false)
  const [recheck, setRecheck] = useState(true)
  const [preview, setPreview] = useState<{
    result: AutoPickResult
    pageUrl: string
    key: string
    publicNote: string | null
    /** 사진 장면 — 읽은 수 · 호출 수(비용) · 남은 것. 장면을 쓰지 않았으면 키가 없다는 알림 또는 null. */
    sceneNote: string | null
    /** 「사람이 뺀 자리도 다시 채우기」로 계산했다 — 저장도 같은 뜻으로. */
    refill: boolean
    /** 자사 화면 — 찍은 수 · 남은 화면 · 찍지 못한 화면 · 지도 미리보기. warn이면 찍지 못한 화면이 있다. */
    screenNote: { text: string; warn: boolean } | null
    /**
     * 군산 지도(장소 목록 출처가 있는 브랜드만, 아니면 null) — available 이 실행에서 그릴 수 있는가, drawn 이 PC에 그려 둔 지도(그린 뒤 더한다),
     * notes 장소 목록 · 웹 알림(warn이면 경고), drawNote 마지막 「군산 지도 그리기」 결과(warn이면 그리지 못한 지도가 있다).
     */
    maps: { available: boolean; drawn: MapImageItem[]; notes: string[]; drawNote: { text: string; warn: boolean } | null; warn: boolean } | null
  } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 「군산 지도 그리기」 진행 글자 — 그리는 동안만. */
  const [drawing, setDrawing] = useState<string | null>(null)
  /** 이 화면에서 찍다가 실패한 자사 화면(「화면id:변형id」) — 다음에 누를 때 뒤로 보낸다(같은 화면이 남은 화면을 막지 않게). */
  const captureFailed = useRef<Set<string>>(new Set())
  /** 미리보기 계산 차례 — 지도를 그리는 사이 다시 맞추면 그 그리기 결과로 미리보기를 바꾸지 않는다. */
  const runSeq = useRef(0)
  /**
   * 마지막 미리보기를 계산한 입력으로 다시 고르는 길 — 지도를 그린 뒤 그린 지도만 바꿔 다시 고른다(사진 후보 · 장면 · 화면은 그대로, AI를
   * 부르지 않는다). run이 단다.
   */
  const repick = useRef<{ run: number; pick: (drawn: readonly MapImageItem[]) => AutoPickResult } | null>(null)
  const titleOf = new Map(articles.map((a) => [a.stored.actionId, a.title]))
  const previewIds = useMemo(() => new Set(preview?.result.articles.map((a) => a.actionId) ?? []), [preview])
  const stale = useMemo(() => preview !== null && photoStateKey(drafts, previewIds) !== preview.key, [preview, drafts, previewIds])
  const hasCleared = articles.some((a) => (a.stored.photoCleared?.length ?? 0) > 0)
  // 장면으로 다시 볼 자동 사진 — 자사 화면 · 군산 지도는 장면을 읽지 않는다(photoAutoPick.ts recheckAuto).
  const hasAuto = articles.some((a) => a.stored.photos?.some((p) => p.auto && p.origin !== 'screen' && p.origin !== 'osm-map'))

  const run = async () => {
    const refillOn = refill && hasCleared
    const recheckOn = recheck && hasAuto
    const seq = (runSeq.current += 1)
    repick.current = null
    setLoading(true)
    setProgress(null)
    setError(null)
    setNote(null)
    setPreview(null)
    try {
      const settings = await loadPublishSettings(tenantId)
      if (!settings?.photoRights) throw new Error('먼저 글의 「홈페이지 사진」 칸에서 이 브랜드 홈페이지 사진을 글에 써도 되는지 확인해 주세요.')
      if (!photosAllowed(settings, brand.industry)) throw new Error('의료 업종은 의료광고 확인까지 받아야 사진을 쓸 수 있어요.')
      let found = source ?? null
      if (!found) {
        const page = photoPageOf(brand, settings)
        if (!page) throw new Error('사진을 찾을 홈페이지 주소가 없어요 — 발행 설정에 공식 사이트를 넣어 주세요.')
        found = await loadSitePhotos(/^https?:\/\//i.test(page) ? page : `https://${page}`)
      }
      const pageUrl = found.pageUrl
      const ids = new Set(articles.map((a) => a.stored.actionId))
      const autoArticles: AutoArticle[] = articles.map(({ stored }) => {
        const group = groupOf?.(stored.actionId)
        return {
          actionId: stored.actionId,
          generatedAt: stored.generatedAt,
          markdown: publishMarkdownOf(stored),
          picks: stored.photos,
          cleared: stored.photoCleared,
          ...(group ? { group } : {}),
        }
      })
      const publicOk = publicPhotosAllowed(settings, brand.industry)
      // 사진 장면 — 이 PC에 키가 있으면 장면으로 고른다. 장면을 다 읽지 못해도 장면으로 고른다(읽지 못한 장소 사진은 비워 둔다). 키가 없으면
      // 지금처럼 고르되 읽어 둔 장면만 받아(새로 읽지 않는다) 장면이 어긋난 사진은 고르지 않는다(장면 때문에 뺀 자동 사진 포함).
      const canRead = await loadPhotoScenesStatus()
      const sceneMap = new Map<string, PhotoScene>()
      const scenes = canRead ? sceneMap : null
      // 업주 사진 보관함(src/lib/ownerPhotos.ts) — 이 PC에 올린 업주 사진을 홈페이지 사진과 같은 후보로. 장면은 올릴 때 읽어 둔 것을 쓰고 여기서
      // 새로 읽지 않는다(앱 주소라 장면 읽기 캐시에 없다). 웹(보관함 없음) · 읽기 실패면 없이 고른다.
      let ownerCandidates: AutoCandidate[] = []
      try {
        const box = await loadOwnerPhotos(tenantId)
        for (const p of box?.photos ?? []) {
          if (p.scene) sceneMap.set(p.src, p.scene)
          ownerCandidates.push({ src: p.src, alt: p.alt, pageUrl: brand.brandPageUrl || pageUrl, origin: 'owner', ownerPhotoId: p.id })
        }
      } catch (e) {
        console.warn('[PhotoAutoFill] 업주 사진 목록을 읽지 못했습니다(업주 사진 없이 고릅니다)', e)
        ownerCandidates = []
      }
      const ownerSrcs = new Set(ownerCandidates.map((c) => c.src))
      setProgress('사진 후보 모으는 중…')
      const pub = await publicFor(autoArticles, found, publicOk, refillOn, scenes !== null, recheckOn)
      // 장소 페이지를 읽은 장소 — 읽지 못한(일시 실패 · 읽기 상한) 장소의 자리는 관광공사 사진으로 먼저 채우지 않는다(다음에 눌러 그 페이지부터).
      const pagesRead = new Set(pub.pages.map((p) => p.place))
      // 읽기마다 새로 물은 사진만 묻는다(asked) — 남긴 수는 읽기마다 그 읽기에서 남긴 수를 더하고, 읽지 못한 사진은 한 번씩.
      const sceneSum = { calls: 0, described: 0, cached: 0, left: 0, failed: new Set<string>() }
      const sceneBudget = newSceneBudget()
      const sceneNotes: string[] = []
      const asked = new Set<string>()
      // 키가 없으면 서버가 읽어 둔 장면만 받는다(loadScenesFor — 서버가 새로 읽을 수 없다고 답하면 묻기만 하고 멈춘다).
      const readScenes = async (asking: readonly SceneWant[]) => {
        // 업주 사진의 장면은 올릴 때 읽었다 — 여기서 묻지 않는다(장면이 없으면 설명 글자로만 맞춘다).
        const wanted = asking.filter((w) => !ownerSrcs.has(w.src))
        if (!wanted.length) return
        setProgress(canRead ? '사진 장면 확인 중…' : '읽어 둔 사진 장면 확인 중…')
        try {
          const load = await loadScenesFor(wanted, sceneMap, (n, m) => setProgress(`사진 장면 읽는 중 ${n}/${m}`), sceneBudget)
          sceneSum.calls += load.calls
          sceneSum.described += load.described
          sceneSum.cached += load.cached
          sceneSum.left += load.left
          for (const src of load.failed) sceneSum.failed.add(src)
          if (canRead) for (const n of load.notes) if (!sceneNotes.includes(n)) sceneNotes.push(n)
        } catch (e) {
          if (!canRead) {
            console.warn('[PhotoAutoFill] 읽어 둔 사진 장면을 받지 못했습니다(장면 없이 고릅니다)', e)
            return
          }
          console.warn('[PhotoAutoFill] 사진 장면을 다 읽지 못했습니다', e)
          sceneNotes.push(`사진 장면을 다 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)} 장면을 읽은 사진으로만 골랐어요.`)
        }
      }
      // 관광공사 사진(3단계)과 지역 사진(장소 없는 자리) — 찾은 뒤에 채운다.
      let tourCandidates: AutoCandidate[] = []
      let regionCandidates: AutoCandidate[] | null = null
      // 장소 없는 자리의 지역 사진 — 지역형 브랜드(도시가 정해진 지역) · 공공 사진 사용 확인 · 장면을 읽을 수 있을 때만.
      const cityOf = regionPhotoCity(brand)
      const regionCity = publicOk && scenes ? cityOf : null
      // 자사 화면 — 자사 사이트에 화면 프로필이 있는 브랜드만 이 PC에 찍어 둔 화면 목록을 받는다(웹은 목록이 없어 null — 화면 자리는
      // 비워 둔다). 찍기는 설치한 데스크톱 앱에서만(/api/health screens) — 아니면 찍어 둔 화면만 쓴다.
      const screenProfile = screenProfileFor(brand.ownedDomains, brand.brandPageUrl)
      const screenNotes: string[] = []
      let screenWarn = false
      let screenList: ScreenList | null = null
      let screenListFailed = false
      if (screenProfile) {
        try {
          screenList = await loadScreens(tenantId)
        } catch (e) {
          console.warn('[PhotoAutoFill] 자사 화면 목록을 읽지 못했습니다(화면 자리는 비워 둡니다)', e)
          screenListFailed = true
          screenWarn = true
          screenNotes.push(`자사 화면 목록을 읽지 못해 화면 자리는 비워 뒀어요 — ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const canCapture = screenList !== null && screenList.available && (await loadScreenCaptureStatus())
      let screenShots: AutoScreenShot[] = screenList?.shots ?? []
      // 군산 지도 — 장소 목록 출처가 있는 프로필(군산각)만 이 PC에 그려 둔 지도와 자사 사이트 장소 목록(서버가 /map/에서 점만 받아 둔 것)을
      // 받는다. 웹은 지도 라우트가 없어 null — 지도는 설치한 데스크톱 앱에서만 그린다고 알린다. 그리기는 미리보기의 「군산 지도 그리기」로.
      const mapNotes: string[] = []
      let mapWarn = false
      let mapWeb = false
      let mapsIn: { available: boolean; points: MapPoint[]; pointsVersion: string; drawn: MapImageItem[] } | null = null
      if (screenProfile?.mapPoints) {
        try {
          const list = await loadMaps(tenantId)
          if (!list) mapWeb = true
          else {
            setProgress(`${MAP_AREA_NAME} 지도 장소 목록 확인 중…`)
            const got = await loadMapPoints(tenantId)
            if (got.warning) {
              mapWarn = true
              mapNotes.push(`${got.warning} — 저장해 둔 장소 목록(${kstDate(got.fetchedAt) ?? '날짜 모름'})으로 골랐어요.`)
            }
            mapsIn = { available: list.available, points: got.points, pointsVersion: got.version, drawn: list.maps }
          }
        } catch (e) {
          console.warn('[PhotoAutoFill] 군산 지도 목록 · 장소 목록을 읽지 못했습니다(지도 자리는 비워 둡니다)', e)
          mapWarn = true
          mapNotes.push(`${MAP_AREA_NAME} 지도 장소 목록을 읽지 못해 지도 자리는 비워 뒀어요 — ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const pick = () =>
        autoPickPhotos({
          articles: autoArticles,
          candidates: [...found.photos.map((p) => ({ src: p.src, alt: p.alt, pageUrl, ...(p.credit ? { credit: true } : {}) })), ...ownerCandidates],
          publicCandidates: pub.candidates,
          tourCandidates,
          ...(regionCity ? { regionCity, ...(regionCandidates ? { regionCandidates } : {}) } : {}),
          pagesRead,
          places: pub.places,
          placePages: pub.placePages,
          placesUnknown: pub.placesFailed,
          others: otherPhotoUses(drafts, ids, groupOf),
          brandName: brand.brandName,
          ownedDomains: brand.ownedDomains,
          ...(brand.brandPageUrl ? { brandPageUrl: brand.brandPageUrl } : {}),
          ...(scenes ? { scenes, sceneFailed: sceneSum.failed } : { knownScenes: sceneMap }),
          ...(screenList ? { screens: { available: canCapture, shots: screenShots } } : {}),
          ...(mapsIn ? { maps: mapsIn } : {}),
          refillCleared: refillOn,
          recheckAuto: recheckOn,
        })
      // 장면으로 고르기 — 고르고, 새로 쓰일 사진의 장면을 읽고(키가 없으면 읽어 둔 장면만), 다시 고른다(새 사진이 없을 때까지).
      const pickScenes = () => pickReadingScenes(pick, readScenes, asked)
      let result = await pickScenes()
      // 3단계 — 장소 페이지에 쓸 사진이 없던(또는 장면이 맞지 않던) 장소 자리를 관광공사 사진으로.
      const tourWanted = publicOk ? tourPlacesWanted(result, pagesRead) : []
      const tourNotes: string[] = []
      let morePhotos = false
      if (tourWanted.length) {
        if (await loadTourApiStatus()) {
          setProgress('관광공사 사진 찾는 중…')
          const tour = await loadTourPhotosFor(tenantId, tourWanted, pub.pages)
          tourCandidates = tourCandidatesOf(tour.results)
          morePhotos = true
          const none = tour.results.filter((r) => !r.photos.length && !r.error).map((r) => r.place)
          tourNotes.push(...tour.notes)
          if (none.length) {
            tourNotes.push(`관광공사 자료에 공공누리 제1유형 사진이 없거나 장소를 찾지 못한 곳 ${none.length}곳(${none.slice(0, 6).join(' · ')}${none.length > 6 ? ' …' : ''}).`)
          }
          if (tour.skipped && tour.stopped) tourNotes.push(`남은 ${tour.skipped}곳은 관광공사 사진을 찾지 않았어요.`)
          else if (tour.skipped) {
            tourNotes.push(`관광공사 사진은 한 번에 새 장소 ${TOUR_PLACE_LIMIT}곳까지 찾아요 — 남은 ${tour.skipped}곳은 다시 누르면 이어서 찾아요(이미 찾은 장소는 다시 부르지 않아요).`)
          }
        } else {
          tourNotes.push(`장소 페이지에 쓸 사진이 없는 장소 ${tourWanted.length}곳 — 이 PC에 관광공사 TourAPI 키가 있으면 관광공사 사진(공공누리 제1유형)으로 채울 수 있어요.`)
        }
      }
      // 장소 없는 자리 — 지역형 브랜드(도시가 정해진 지역)이고 장면을 읽을 수 있을 때, 브랜드 도시로 찾은 관광사진에서 비슷한 장면을(장소
      // 사전을 읽지 못했거나 브랜드 자기 시설 · 고유한 장소 이름이 나온 자리만 남으면 부르지 않는다 — regionRowsWanted).
      const regionRows = regionCity ? regionRowsWanted(result) : 0
      if (regionRows && (await loadTourApiStatus())) {
        setProgress('장소 없는 자리의 지역 사진 찾는 중…')
        try {
          const region = await loadRegionTourPhotos(tenantId)
          regionCandidates = regionCandidatesOf(region)
          morePhotos = true
          if (region.note) tourNotes.push(`지역 사진 — ${region.note}`)
        } catch (e) {
          console.warn('[PhotoAutoFill] 지역 사진을 찾지 못했습니다', e)
          tourNotes.push(`장소 없는 자리의 지역 사진을 찾지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (morePhotos) result = await pickScenes()
      // 자사 화면 찍기 — 찍으면 화면 자리에 쓰일 화면 · 변형(screenWanted)을 한 번에 SCREEN_CAPTURES_PER_RUN장까지(글에 넣는 코스 화면
      // 먼저, 이 화면에서 실패한 화면은 뒤로). 서버가 메인 프로세스에 청해 숨긴 창으로 찍고 이 PC에 저장한다. 찍은 뒤 다시 고른다 — 변형은
      // 찍었는지와 상관없이 골랐으므로 같은 자리에 같은 변형이 간다. 남은 화면은 다시 누르면 이어서 찍는다.
      let capturedNow = 0
      if (canCapture && screenList && result.screenWanted.length) {
        const list = screenList
        const nameOf = (w: AutoScreenWant) => {
          const s = list.screens.find((x) => x.id === w.screenId)
          return `${s?.label ?? w.screenId} · ${w.variantLabel ?? s?.variants.find((v) => v.id === w.variantId)?.label ?? w.variantId}`
        }
        const saveAllowedOf = (id: string) => list.screens.find((s) => s.id === id)?.saveAllowed === true
        const batch = screenCaptureOrder(result.screenWanted, saveAllowedOf, captureFailed.current).slice(0, SCREEN_CAPTURES_PER_RUN)
        const failedNow: string[] = []
        for (const [i, w] of batch.entries()) {
          const key = `${w.screenId}:${w.variantId}`
          setProgress(`자사 화면 찍는 중 ${i + 1}/${batch.length} — ${nameOf(w)}`)
          try {
            const got = await captureScreen(tenantId, w.screenId, w.variantId)
            screenShots = [got.shot, ...screenShots.filter((s) => s.id !== got.shot.id)]
            captureFailed.current.delete(key)
            capturedNow += 1
          } catch (e) {
            console.warn(`[PhotoAutoFill] 자사 화면 ${key}를 찍지 못했습니다`, e)
            captureFailed.current.add(key)
            failedNow.push(`${nameOf(w)}(${e instanceof Error ? e.message : String(e)})`)
            // 찍기 자체를 쓸 수 없거나(앱 종료 중) 줄이 찼으면 남은 화면도 찍지 못한다.
            const code = (e as { code?: unknown }).code
            if (code === 'unavailable' || code === 'disposed' || code === 'busy') break
          }
        }
        if (capturedNow) {
          setProgress('찍은 화면으로 다시 맞추는 중…')
          result = await pickScenes()
          screenNotes.push(`자사 화면 ${capturedNow}장을 찍어 이 PC에 저장했어요.`)
        }
        if (failedNow.length) {
          screenWarn = true
          screenNotes.push(`찍지 못한 화면 ${failedNow.length}장 — ${failedNow.join(' · ')}`)
        }
      }
      const screenRows = result.articles.flatMap((a) => a.rows).filter((r) => isScreenKind(r.screenSlot))
      const screenWaiting = screenRows.filter((r) => r.state === 'uncaptured').length
      const screenPreviews = screenRows.filter((r) => r.state === 'preview').length
      if (screenWaiting) {
        screenNotes.push(
          canCapture
            ? `아직 찍지 않은 화면이 들어갈 자리 ${screenWaiting}곳(화면 ${result.screenWanted.length}장) — 다시 눌러 나머지를 찍어요(한 번에 ${SCREEN_CAPTURES_PER_RUN}장까지).`
            : `아직 찍지 않은 화면이 들어갈 자리 ${screenWaiting}곳 — 화면 찍기는 설치한 데스크톱 앱에서만 돼요. 여기서는 이 PC에 찍어 둔 화면만 써요.`,
        )
      }
      // 웹이면 지도 자리는 지도 알림이 따로 말한다.
      const webScreenRows = mapWeb ? screenRows.filter((r) => r.screenSlot !== 'map') : screenRows
      if (screenProfile && !screenList && !screenListFailed && webScreenRows.length) {
        screenNotes.push(`자사 화면 자리 ${webScreenRows.length}곳 — 자사 화면은 설치한 데스크톱 앱에서만 찍고 넣을 수 있어요.`)
      }
      const mapSlots = screenRows.filter((r) => r.screenSlot === 'map').length
      if (mapWeb && mapSlots) {
        mapNotes.push(`${MAP_AREA_NAME} 지도 자리 ${mapSlots}곳 — ${MAP_AREA_NAME} 지도는 설치한 데스크톱 앱에서만 그려 넣을 수 있어요(웹에서는 지도 자리를 비워 둬요).`)
      }
      if (screenPreviews) screenNotes.push(`지도 화면 자리 ${screenPreviews}곳 — 카카오 지도 이용 조건 확인 전이라 미리보기만 하고 저장하지 않아요.`)
      if (result.region) {
        const r = result.region
        tourNotes.push(
          `장소 없는 자리 ${r.rows}곳 — ${regionCity}의 관광사진 ${r.pool}장 가운데 자리 낱말이 맞는 ${r.matched}장에서 자리마다 ${REGION_SCENE_LIMITS.perSlot}장까지 장면을 견줘요(낱말이 맞지 않거나 순서에 밀려 읽지 않은 사진 ${r.pool - r.wanted}장).`,
        )
      }
      const placeRows = autoPreviewCounts(result.articles.flatMap((a) => a.rows)).emptyPlaces
      const notes = [
        ...(pub.note ? [pub.note] : []),
        ...tourNotes,
        ...(pub.off && placeRows > 0 ? [`장소가 나온 빈 자리 ${placeRows}곳은 글의 「홈페이지 사진」 칸에서 공공 사진 사용 확인을 한 뒤 다시 누르면 공공 사진으로 채울 수 있어요.`] : []),
      ]
      const publicNote = notes.length ? notes.join(' ') : null
      const allRows = result.articles.flatMap((a) => a.rows)
      const placeFilled = allRows.some((r) => r.state === 'filled' && r.pick?.origin === 'public')
      // 장면 없이 「사람이 뺀 자리도 다시 채우기」 — 뺀 사진을 적기 전에 뺀 자리는 그대로 둔다(photoAutoPick.ts refills).
      const oldCleared = refillOn && !scenes ? allRows.filter((r) => r.state === 'cleared').length : 0
      const sceneNote = scenes
        ? [
            `사진 장면 — 읽어 둔 장면 ${sceneSum.cached}장 · 새로 읽음 ${sceneSum.described}장(Claude 호출 ${sceneSum.calls}번).`,
            ...(sceneSum.left ? [`이번에 읽지 않고 남긴 사진 ${sceneSum.left}장 — 다시 누르면 이어서 읽어요.`] : []),
            ...(sceneSum.failed.size
              ? [`장면을 읽지 못한 사진 ${sceneSum.failed.size}장(받지 못함 · 형식 · 모델이 읽지 않음) — 장소 사진이면 쓰지 않고, 홈페이지 사진이면 설명 낱말로만 견줬어요.`]
              : []),
            ...sceneNotes,
          ].join(' ')
        : [
            ...(sceneSum.cached ? [`이 PC에 Claude 키가 없어 새 사진의 장면은 읽지 않았어요 — 읽어 둔 장면 ${sceneSum.cached}장으로 장면이 어긋난 사진은 뺐어요.`] : []),
            ...(placeFilled ? ['이 PC에 Claude 키가 없어 사진 장면을 읽지 않고 골랐어요 — 장소 사진(공공 · 관광공사)은 장면까지 맞는지 썸네일로 꼭 확인해 주세요.'] : []),
            ...(oldCleared
              ? [`뺀 사진을 적어 두기 전에 사람이 뺀 자리 ${oldCleared}곳은 무엇을 뺐는지 몰라 다시 채우지 않았어요 — 사진 장면을 읽을 수 있는 PC(Claude 키)에서는 장면으로 걸러 다시 채워요.`]
              : []),
            ...(recheckOn ? ['이 PC에 Claude 키가 없어 이미 넣은 자동 사진은 장면으로 다시 보지 않았어요.'] : []),
          ].join(' ') || null
      setPreview({
        result,
        pageUrl,
        key: photoStateKey(drafts, ids),
        publicNote,
        sceneNote,
        refill: refillOn,
        screenNote: screenNotes.length ? { text: screenNotes.join(' '), warn: screenWarn } : null,
        maps: screenProfile?.mapPoints
          ? { available: mapsIn?.available ?? false, drawn: mapsIn?.drawn ?? [], notes: mapNotes, drawNote: null, warn: mapWarn }
          : null,
      })
      // 지도를 그린 뒤 다시 고르는 길 — 이 미리보기를 계산한 입력 그대로, 그려 둔 지도만 바꾼다.
      repick.current = mapsIn
        ? {
            run: seq,
            pick: (drawn) => {
              mapsIn = { ...mapsIn!, drawn: [...drawn] }
              return pick()
            },
          }
        : null
      setShowAll(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  /**
   * 공공 사진 후보 — 사이트의 장소 사전(sitemap)을 읽고, 공공 사진 사용 확인이 있으면 빈 자리에 나온 장소와 출처 없는 공공 사진의 단서
   * (사진 설명 · 홈페이지에서 그 사진에 붙은 설명)에 나온 장소의 페이지만 읽는다. 사전을 읽지 못해도 홈페이지 사진 맞추기는 그대로 한다 —
   * 그때 알림은 공공 사진 사용 확인이 있을 때만 띄운다(공공 사진을 쓰지 않는 브랜드에 경고를 띄우지 않게).
   */
  const publicFor = async (
    list: readonly AutoArticle[],
    site: SitePhotoResult,
    allowed: boolean,
    refillCleared: boolean,
    withScenes: boolean,
    recheckAuto: boolean,
  ): Promise<{
    candidates: AutoCandidate[]
    places: string[]
    /** 장소 사전(이름 · 주소) — 장소 안내 화면 자리의 장소를 찾는다. */
    placePages: PlaceEntry[]
    placesFailed: boolean
    pages: PublicPhotoPage[]
    off: boolean
    note: string | null
  }> => {
    const root = siteRootOf(site.pageUrl)
    if (!root) return { candidates: [], places: [], placePages: [], placesFailed: true, pages: [], off: !allowed, note: null }
    let directory: PlaceEntry[]
    try {
      directory = await loadPlaceDirectory(root)
    } catch (e) {
      if (!allowed) {
        console.warn('[PhotoAutoFill] 장소 목록(sitemap.xml)을 읽지 못했습니다(공공 사진 사용 확인 전이라 알리지 않음)', e)
        return { candidates: [], places: [], placePages: [], placesFailed: true, pages: [], off: true, note: null }
      }
      return {
        candidates: [],
        places: [],
        placePages: [],
        placesFailed: true,
        pages: [],
        off: false,
        note: `장소 목록(sitemap.xml)을 읽지 못해 공공 사진 · 장소 없는 자리의 지역 사진은 건너뛰었어요 — ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    const places = directory.map((e) => e.name)
    if (!places.length || !allowed) return { candidates: [], places, placePages: directory, placesFailed: false, pages: [], off: !allowed, note: null }
    const siteAlt = new Map(site.photos.map((p) => [p.src, p.alt]))
    const hinted = list.flatMap((a) =>
      (a.picks ?? []).flatMap((p) =>
        photoCreditState(p) === 'missing' ? [p.alt, siteAlt.get(canonicalPhotoSrc(p.src) ?? p.src) ?? ''].flatMap((h) => findPlace(h, places) ?? []) : [],
      ),
    )
    const wanted = [...new Set([...placesToRead(list, places, refillCleared, withScenes, recheckAuto), ...hinted])]
    const load = await loadPublicPhotos(directory, wanted)
    const notes = [
      ...(load.failed.length ? [`장소 페이지 ${load.failed.length}곳을 읽지 못했어요(${load.failed.map((x) => x.place).join(' · ')}).`] : []),
      ...(load.capped ? [`장소 페이지는 한 번에 ${load.pages.length + load.failed.length}곳까지 읽어요 — ${load.capped}곳은 다음에 다시 눌러 주세요.`] : []),
    ]
    return {
      candidates: publicCandidatesOf(load.pages),
      places,
      placePages: directory,
      placesFailed: false,
      pages: load.pages,
      off: false,
      note: notes.length ? notes.join(' ') : null,
    }
  }

  const save = async () => {
    if (!preview || stale) return
    setSaving(true)
    onBusyChange?.(true)
    setError(null)
    const apply = (out: AutoPhotoSaveResult) => {
      for (const d of out.drafts) onStored(d)
    }
    try {
      const out = await saveDraftPhotosAuto(
        tenantId,
        preview.result.articles.map((a) => ({
          actionId: a.actionId,
          generatedAt: a.generatedAt,
          picks: a.picks,
          credits: a.credits.map((c) => ({ place: c.place, src: c.src, pageUrl: c.pageUrl, ...c.fields })),
          replaces: a.replaces,
        })),
        { refillCleared: preview.refill },
      )
      apply(out)
      const parts = [`사진 ${out.saved}장을 넣었어요(글 ${out.drafts.length}편).`]
      if (out.replaced || out.removed) parts.push(`장면이 어긋난 자동 사진 — 바꿈 ${out.replaced}장 · 뺌 ${out.removed}장.`)
      if (out.stale.length) parts.push(`그사이 사람이 고르거나 다른 사진으로 바뀐 자리 ${out.stale.length}곳은 바꾸거나 빼지 않았어요.`)
      if (out.credited) parts.push(`출처 없는 공공 사진 ${out.credited}장에 출처를 붙였어요.`)
      if (out.changed.length) parts.push(`그사이 다시 만들어진 글 ${out.changed.length}편은 건너뛰었어요 — 다시 눌러 주세요.`)
      if (out.missing.length) parts.push(`초안이 없어진 글 ${out.missing.length}편은 건너뛰었어요.`)
      if (out.skipped) parts.push(`그사이 사진이 생긴 자리 · 상한에 걸린 사진 ${out.skipped}장은 넣지 않았어요.`)
      setNote(parts.join(' '))
      setPreview(null)
    } catch (e) {
      const partial = (e as { partial?: AutoPhotoSaveResult }).partial
      if (partial) apply(partial)
      setError(`사진을 다 저장하지 못했어요${partial?.saved ? `(${partial.saved}장은 저장됨)` : ''} — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
      onBusyChange?.(false)
    }
  }

  /**
   * 「군산 지도 그리기」 — 미리보기의 아직 그리지 않은 지도(mapWanted)를 한 번에 그린다(한 장씩 청한다 — 한 장에 1초 안팎, 서버가 메인
   * 프로세스에 맡겨 동봉한 OSM 데이터로 그리고 이 PC에 저장한다). 다 그린 뒤 같은 입력으로 다시 골라 미리보기를 바꾼다. 그리기를 쓸 수 없거나
   * (앱 종료 중) 줄이 차면 남은 지도는 그리지 않는다. 그리지 못한 까닭은 중립 글자로 보인다(mapDrawFailText).
   */
  const drawMaps = async () => {
    const p = preview
    const again = repick.current
    if (!p?.maps?.available || !again || again.run !== runSeq.current || !p.result.mapWanted.length) return
    const wanted = p.result.mapWanted
    const labelsOf = new Map<string, string>()
    for (const a of p.result.articles) for (const r of a.rows) if (r.mapPick) labelsOf.set(r.mapPick.key, r.mapPick.markers.map((m) => m.label).join(' · '))
    const drawn = [...p.maps.drawn]
    const failed: string[] = []
    let made = 0
    let reused = 0
    setError(null)
    setNote(null)
    try {
      for (const [i, w] of wanted.entries()) {
        setDrawing(`${MAP_AREA_NAME} 지도 그리는 중 ${i + 1}/${wanted.length}`)
        const name = labelsOf.get(w.key) ?? w.ids.join(' · ')
        let code: string | null = null
        try {
          const [r] = await renderMaps(tenantId, [{ ids: w.ids }])
          if (r?.ok) {
            drawn.unshift(r.map)
            if (r.reused) reused += 1
            else made += 1
          } else {
            code = r?.code ?? 'failed'
            failed.push(`${name}(${mapDrawFailText(code, r?.message ?? '')})`)
          }
        } catch (e) {
          console.warn(`[PhotoAutoFill] 군산 지도(${w.key})를 그리지 못했습니다`, e)
          code = typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'failed'
          failed.push(`${name}(${mapDrawFailText(code, e instanceof Error ? e.message : String(e))})`)
        }
        // 그리기 자체를 쓸 수 없거나(앱 종료 중 · 설치본에 지도 데이터 파일이 없음) 줄이 찼으면 남은 지도도 그리지 못한다.
        if (code === 'unavailable' || code === 'disposed' || code === 'busy' || code === 'no-map-data') break
      }
      if (again.run !== runSeq.current) return
      setDrawing('그린 지도로 다시 맞추는 중…')
      const result = again.pick(drawn)
      const done = made || reused ? [`${MAP_AREA_NAME} 지도 ${made}장을 그려 이 PC에 저장했어요${reused ? `(이미 그려 둔 지도 ${reused}장은 다시 썼어요)` : ''}.`] : []
      const text = [...done, ...(failed.length ? [`그리지 못한 지도 ${failed.length}장 — ${failed.join(' · ')}`] : [])].join(' ')
      const drawNote = text ? { text, warn: failed.length > 0 } : null
      setPreview((cur) => (cur && cur.maps && again.run === runSeq.current ? { ...cur, result, maps: { ...cur.maps, drawn, drawNote } } : cur))
    } finally {
      setDrawing(null)
    }
  }

  const rows = preview ? preview.result.articles.flatMap((a) => a.rows.map((row) => ({ actionId: a.actionId, row }))) : []
  const count = (state: AutoSlotState) => rows.filter((r) => r.row.state === state).length
  // 채울 자리의 괄호(확인 필요 · 비슷한 사진 · 장소 없는 자리)는 채울 자리만, 바꿀 자리의 것은 바꿈 뒤에 따로 센다.
  const counts = autoPreviewCounts(rows.map((r) => r.row))
  const filled = counts.filled.all
  const credits = preview ? preview.result.articles.reduce((n, a) => n + a.credits.length, 0) : 0
  const replaced = counts.replaced.all
  const removed = counts.removed
  const replacedOf = [
    ...(counts.replaced.review ? [`확인 필요 ${counts.replaced.review}`] : []),
    ...(counts.replaced.similar ? [`비슷한 사진 ${counts.replaced.similar}`] : []),
    ...(counts.replaced.placeless ? [`장소 없는 자리 — 비슷한 장면 ${counts.replaced.placeless}`] : []),
  ]
  const recheckParts = [
    ...(replaced ? [`장면 안 맞음 → 바꿈 ${replaced}${replacedOf.length ? `(${replacedOf.join(' · ')})` : ''}`] : []),
    ...(removed ? [`장면 안 맞음 → 뺌 ${removed}`] : []),
    ...(counts.kept.similar ? [`비슷한 사진으로 둠 ${counts.kept.similar}`] : []),
    ...(counts.kept.fit ? [`장면 맞음(그대로) ${counts.kept.fit}`] : []),
    ...(counts.kept.unknown ? [`장면 모름(그대로) ${counts.kept.unknown}`] : []),
  ]
  // 지도 화면 미리보기(preview)는 저장하지 않으므로 채울 자리 · 저장 수에 세지 않는다(state가 filled가 아니다).
  const changes = filled + replaced + removed
  const filledScreens = rows.filter((r) => r.row.state === 'filled' && r.row.pick?.origin === 'screen').length
  const hasScreenRows = rows.some((r) => r.row.screenPick)
  const filledMaps = rows.filter((r) => r.row.state === 'filled' && r.row.pick?.origin === 'osm-map').length
  const hasMapRows = rows.some((r) => r.row.mapPick)
  // 군산 지도 알림 — 장소 목록 · 웹 알림, 마지막 그리기 결과, 아직 그리지 않은 자리(그릴 수 있으면 「군산 지도 그리기」로).
  const undrawnRows = rows.filter((r) => r.row.state === 'undrawn').length
  const mapNote = preview?.maps
    ? {
        text: [
          ...preview.maps.notes,
          ...(preview.maps.drawNote ? [preview.maps.drawNote.text] : []),
          ...(undrawnRows
            ? [
                preview.maps.available
                  ? `아직 그리지 않은 지도 자리 ${undrawnRows}곳(지도 ${preview.result.mapWanted.length}장) — 「${MAP_AREA_NAME} 지도 그리기」를 누르면 한 번에 그려요(앱에 든 OpenStreetMap 데이터로 이 PC에서 그려요).`
                  : `아직 그리지 않은 지도 자리 ${undrawnRows}곳 — ${MAP_AREA_NAME} 지도 그리기는 설치한 데스크톱 앱에서만 돼요. 여기서는 이 PC에 그려 둔 지도만 써요.`,
              ]
            : []),
        ].join(' '),
        warn: preview.maps.warn || Boolean(preview.maps.drawNote?.warn),
      }
    : null
  const isShown = (row: AutoSlotRow) =>
    row.state === 'filled' ||
    row.state === 'replace' ||
    row.state === 'remove' ||
    row.state === 'preview' ||
    row.state === 'undrawn' ||
    row.recheck === 'similar'
  const shownCount = rows.filter((r) => isShown(r.row)).length
  const shown = showAll ? rows : rows.filter((r) => isShown(r.row))
  const skippedByReason = preview
    ? Object.entries(
        preview.result.skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}),
      ).map(([reason, n]) => `${AUTO_CANDIDATE_SKIP_TEXT[reason as keyof typeof AUTO_CANDIDATE_SKIP_TEXT]} ${n}`)
    : []
  const others = (['kept', 'cleared', 'screen', 'preview', 'uncaptured', 'undrawn', 'nomatch', 'scene', 'unread', 'used', 'full', 'license'] as const)
    .map((s) => [s, s === 'kept' ? rows.filter((r) => r.row.state === 'kept' && !r.row.recheck).length : count(s)] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${AUTO_SLOT_STATE_TEXT[s]} ${n}`)

  return (
    <div className="photo-auto">
      <div className="brief-bar" style={{ margin: 0 }}>
        <button
          type="button"
          className="ghost"
          disabled={locked || loading || saving || drawing !== null}
          onClick={() => void run()}
          title={`사진 설명 · 장소와 사진 자리 글자를 맞춰 빈 자리에 넣을 사진을 고릅니다. 이 PC에 Claude 키가 있으면 후보 사진의 장면을 읽어(사진 한 장에 한 번 — 읽은 장면은 저장해 다시 읽지 않아요) 장면이 맞는 사진만 고릅니다. 자사 웹사이트 화면 자리는 이 PC에 찍어 둔 화면으로 맞추고, 데스크톱 앱에서는 아직 찍지 않은 화면을 한 번에 ${SCREEN_CAPTURES_PER_RUN}장까지 찍어요. 지도 자리는 자사 사이트 장소 목록이 있는 브랜드(군산각)면 표지를 골라 앱이 그린 ${MAP_AREA_NAME} 지도(OpenStreetMap)를 넣어요. 저장 전에 미리보기 표를 보여 줍니다.`}
        >
          {loading ? (progress ?? '사진 맞추는 중…') : label}
        </button>
        {hasAuto && (
          <label
            className="doc-meta"
            title="이미 넣은 자동 사진(「자동」 표시)도 사진 장면을 읽어 자리와 견줍니다 — 장면이 어긋나면 맞는 사진으로 바꾸고, 시간만 다르면 맞는 사진이 없을 때 그대로 둡니다(비슷한 사진). 바꿀 사진이 없고 종류 · 사람이 어긋나면 뺍니다. 사람이 고른 사진은 보지 않아요. 저장을 눌러야 바뀝니다. 이 PC에 Claude 키가 있어야 합니다."
          >
            <input type="checkbox" checked={recheck} disabled={loading || saving} onChange={(e) => setRecheck(e.target.checked)} /> 이미 넣은 자동 사진도 장면 확인
          </label>
        )}
        {hasCleared && (
          <label
            className="doc-meta"
            title="사람이 사진을 뺀 자리도 다시 채웁니다 — 그 자리에서 뺀 사진은 다시 고르지 않아요. 뺀 사진을 적어 두기 전에 뺀 자리는 무엇을 뺐는지 몰라, 사진 장면을 읽을 수 있을 때(이 PC에 Claude 키)만 장면으로 걸러 다시 채워요."
          >
            <input type="checkbox" checked={refill} disabled={loading || saving} onChange={(e) => setRefill(e.target.checked)} /> 사람이 뺀 자리도 다시 채우기
          </label>
        )}
        {!loading && locked && !saving && <span className="doc-meta">다른 일괄 실행이 끝난 뒤에 누를 수 있어요.</span>}
        {note && <span className="doc-meta">{note}</span>}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
      {preview && (
        <div className="photo-auto-preview">
          <p className="doc-meta" style={{ margin: 0 }}>
            {preview.pageUrl}의 사진 {preview.result.usable + preview.result.skipped.filter((x) => x.candidate.origin !== 'public').length}장 중 자동으로 쓸
            수 있는 사진 {preview.result.usable}장
            {preview.result.usablePublic > 0 && ` · 장소 페이지의 공공 사진(공공누리 제1유형) ${preview.result.usablePublic}장`}
            {preview.result.usableTour > 0 && ` · 관광공사 사진(공공누리 제1유형) ${preview.result.usableTour}장`}
            {skippedByReason.length > 0 && ` — 뺀 사진: ${skippedByReason.join(' · ')}`}
          </p>
          <p className="doc-meta" style={{ margin: 0 }}>
            사진 자리 {rows.length}곳 · 채울 자리 <b>{filled}</b>
            {counts.filled.public > 0 && ` (공공 사진 ${counts.filled.public})`}
            {counts.filled.tour > 0 && ` (관광공사 사진 ${counts.filled.tour})`}
            {filledScreens > 0 && ` (자사 화면 ${filledScreens})`}
            {filledMaps > 0 && ` (${MAP_AREA_NAME} 지도 ${filledMaps})`}
            {counts.filled.review > 0 && ` (확인 필요 ${counts.filled.review})`}
            {counts.filled.similar > 0 && ` (비슷한 사진 ${counts.filled.similar})`}
            {counts.filled.placeless > 0 && ` (장소 없는 자리 — 비슷한 장면 ${counts.filled.placeless})`}
            {counts.filled.refill > 0 && ` (사람이 뺀 자리 ${counts.filled.refill})`}
            {recheckParts.length > 0 && ` · 이미 넣은 자동 사진: ${recheckParts.join(' · ')}`}
            {others.length > 0 && ` · ${others.join(' · ')}`}
            {credits > 0 && ` · 출처를 붙일 공공 사진 ${credits}장`}
          </p>
          {preview.publicNote && (
            <p className="hint warn" style={{ margin: 0 }}>
              {preview.publicNote}
            </p>
          )}
          {preview.sceneNote && (
            <p className="doc-meta" style={{ margin: 0 }}>
              {preview.sceneNote}
            </p>
          )}
          {preview.screenNote && (
            <p className={preview.screenNote.warn ? 'hint warn' : 'doc-meta'} style={{ margin: 0 }}>
              {preview.screenNote.text}
            </p>
          )}
          {mapNote?.text && (
            <p className={mapNote.warn ? 'hint warn' : 'doc-meta'} style={{ margin: 0 }}>
              {mapNote.text}
            </p>
          )}
          {preview.maps?.available && preview.result.mapWanted.length > 0 && (
            <div className="brief-bar" style={{ margin: 0 }}>
              <button
                type="button"
                className="ghost"
                disabled={drawing !== null || saving || locked}
                title="표의 「지도를 아직 그리지 않음」 자리에 들어갈 지도를 한 번에 그립니다 — 자사 사이트 장소 목록의 좌표로, 앱에 든 OpenStreetMap 데이터를 이 PC에서 그려요(인터넷 지도 서비스를 부르지 않아요). 한 장에 1초 안팎이고, 그린 지도는 이 PC에 저장해 다시 쓰고 미리보기를 다시 맞춰요."
                onClick={() => void drawMaps()}
              >
                {drawing ?? `${MAP_AREA_NAME} 지도 그리기(${preview.result.mapWanted.length}장)`}
              </button>
            </div>
          )}
          <p className="hint" style={{ margin: 0 }}>
            틀린 사진보다 빈자리가 낫다는 기준으로, 설명이 충분히 맞는 사진만 고릅니다. 공공 사진 · 관광공사 사진은 자리 글자에 나온 장소의
            사진이에요 — 사진 장면을 읽었으면 장면이 자리와 어긋난 사진(외관 자리에 실내 사진 · 사람을 알아볼 수 있는 사진 등)은 빼고 장면이 맞는
            사진을 고르지만, 장면 설명도 AI가 쓴 것이라 늘 「확인 필요」이니 썸네일을 확인해 주세요. 장면이 맞는 사진이 어디에도 없으면 시간만
            다른 사진(낮 사진 · 해 질 무렵 자리)을 「비슷한 사진」으로 넣어요(장면을 아직 읽지 않은 사진이 남은 자리는 다시 눌러 다 읽은 뒤에).
            공공 사진은 내보낼 때 사진 아래에
            출처(공공누리 제1유형 링크)가 붙습니다. 사람이 나오는 장면 자리는 「확인 필요」 — 저장한 뒤 글의 「홈페이지 사진」 칸에서 바꾸거나 빼
            주세요. 사람이 고른 자리는 덮지 않고, 사람이 뺀 자리는 「사람이 뺀 자리도 다시 채우기」를 켰을 때만 다시 채웁니다.
            {hasScreenRows &&
              ' 자사 화면은 브랜드 웹사이트 화면을 이 PC에서 찍은 그림이에요 — 글에는 이 PC의 화면 주소만 적고, 복사 · 홈페이지용 .html로 내보낼 때 그림을 넣어요. 붙여 넣은 글에서 화면이 안 보이면 「사진 N장 받기」로 받은 파일을 그 자리에 올려 주세요.'}
            {hasMapRows &&
              ` ${MAP_AREA_NAME} 지도는 자사 사이트 장소 목록의 장소를 앱이 OpenStreetMap 데이터로 그린 그림이에요(사이트 화면이 아니에요) — 표지와 위치 문장을 자리 글자로 골라 늘 「확인 필요」이니 썸네일과 까닭을 확인해 주세요. 내보낼 때 지도 바로 아래에 출처 줄(지도 데이터 © OpenStreetMap contributors · ODbL)이 붙고, 그 아래 줄이 위치 문장이에요.`}
          </p>
          {shown.length > 0 && (
            <div className="table-wrap">
              <table className="photo-auto-table">
                <thead>
                  <tr>
                    {!single && <th>글</th>}
                    <th>사진 자리</th>
                    <th>고른 사진</th>
                    <th>맞은 낱말 · 점수</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ actionId, row }) => (
                    <PreviewRow
                      key={`${actionId}|${row.slot.line}`}
                      title={single ? null : (titleOf.get(actionId) ?? actionId)}
                      row={row}
                      brandName={brand.brandName}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="brief-bar" style={{ margin: 0 }}>
            <button type="button" disabled={(changes === 0 && credits === 0) || saving || locked || stale || drawing !== null} onClick={() => void save()}>
              {saving
                ? '저장 중…'
                : `저장 — ${filled}자리${replaced ? ` · 바꿈 ${replaced}` : ''}${removed ? ` · 뺌 ${removed}` : ''}${credits ? ` · 출처 ${credits}장` : ''}`}
            </button>
            <button type="button" className="ghost" disabled={saving || drawing !== null} onClick={() => setPreview(null)}>
              닫기
            </button>
            {rows.length > shownCount && (
              <button type="button" className="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? '바뀌는 자리만 보기' : `건너뛴 자리도 보기(${rows.length - shownCount})`}
              </button>
            )}
          </div>
          {stale && !saving && (
            <p className="error" role="alert" style={{ margin: 0 }}>
              그사이 초안이나 고른 사진이 바뀌어 이 미리보기로는 저장하지 않아요 — 위 단추를 다시 눌러 새로 맞춰 주세요.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** 장면이 맞은 까닭 — 「장면: 외관 · 앞마당」(맞은 낱말이 없으면 장면 종류). */
function sceneWhy(row: AutoSlotRow): string | null {
  if (!row.scene || !row.fit) return null
  return `장면: ${row.fit.words.length ? row.fit.words.join(' · ') : `${SCENE_SETTING_TEXT[row.scene.setting]}(맞은 낱말 없음)`}`
}

/** 장면 때문에 뺀 후보 — 「장면 종류가 다름 12 · 시간대가 다름 3」. */
function sceneSkipsText(row: AutoSlotRow): string | null {
  const entries = Object.entries(row.sceneSkips ?? {}) as [SceneSkip, number][]
  return entries.length ? entries.map(([k, n]) => `${SCENE_SKIP_TEXT[k]} ${n}`).join(' · ') : null
}

/** 사진 한 장 — 썸네일 · 공공 사진 표시 · 설명 · 출처 · 장면. */
function PhotoBrief({
  src,
  alt,
  tour,
  publicPhoto,
  credit,
  scene,
}: {
  src: string
  alt: string
  tour?: TourSource
  publicPhoto: boolean
  credit: { credit: string; license: PhotoLicense } | null
  scene?: PhotoScene
}) {
  return (
    <span className="photo-auto-pick">
      <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" />
      <span>
        {publicPhoto && (
          <span className="status-pill st-info no-glyph" title={tour ? TOUR_SOURCES[tour].name : undefined}>
            {tour ? '관광공사 사진' : '공공 사진'}
          </span>
        )}{' '}
        {alt}
        {credit && (
          <span className="doc-meta">
            {' '}
            · 사진: {credit.credit}, {PHOTO_LICENSES[credit.license].name}
          </span>
        )}
        {scene && (
          <span className="doc-meta" style={{ display: 'block' }}>
            장면: {scene.text} ({sceneMeta(scene)})
          </span>
        )}
      </span>
    </span>
  )
}

/** 이미 넣은 자동 사진(다시 본 사진)의 칸. */
function OldBrief({ row }: { row: AutoSlotRow }) {
  const old = row.old!
  const pub = old.origin === 'public'
  const tour = pub ? tourSourceOf(old.pageUrl) : null
  return (
    <PhotoBrief
      src={old.src}
      alt={old.alt || old.slot}
      {...(tour ? { tour } : {})}
      publicPhoto={pub}
      credit={pub && old.credit && old.license ? { credit: old.credit, license: old.license } : null}
      {...(row.oldScene ? { scene: row.oldScene } : {})}
    />
  )
}

/**
 * 화면 자리에 고른 자사 화면 — 썸네일(찍었으면 — 잘라 찍은 화면은 그 비율 그대로) · 「자사 화면」 칩 · 화면 · 변형 이름 · 설명 줄(「군산각
 * 웹사이트 화면 · 주소 · 11-04 캡처」). 지도 화면은 저장하지 않는다는 안내를 붙인다(결정 4).
 */
function ScreenBrief({ brandName, pick }: { brandName: string; pick: AutoScreenPick }) {
  const shot = pick.shot
  const ratio = screenAspectRatio(shot)
  return (
    <span className="photo-auto-pick is-screen">
      {shot && <img src={shot.src} alt="" loading="lazy" style={ratio ? { aspectRatio: ratio } : undefined} />}
      <span>
        <span className="status-pill st-info no-glyph">자사 화면</span> {pick.label} · {pick.variantLabel}
        <span className="doc-meta" style={{ display: 'block' }}>
          {shot ? screenShotMeta(brandName, shot.url, shot.capturedAt) : `${screenShotMeta(brandName, pick.url)} · 아직 찍지 않음`}
        </span>
        {!pick.saveAllowed && (
          <span className="doc-meta" style={{ display: 'block' }}>
            {MAP_PREVIEW_ONLY_TEXT}
          </span>
        )}
      </span>
    </span>
  )
}

/** 화면 자리의 까닭 — 자리 종류(코스 · 지도 · 장소 안내 · 가이드 · 찍지 않는 화면)와 변형을 고른 까닭, 찍은 화면에 없는 자리 글자의 사실. */
function screenWhy(row: AutoSlotRow): string {
  const kind = row.screenSlot!
  const sp = row.screenPick
  if (!sp && row.screenMiss === 'no-place') return `${SCREEN_SLOT_KIND_TEXT[kind]} — 자리 글자 · 소제목에 사이트의 장소 이름이 없어 찍지 않아요(장소 이름을 넣거나 직접 골라요)`
  if (!sp && row.screenMiss === 'no-directory') return `${SCREEN_SLOT_KIND_TEXT[kind]} — 사이트 장소 목록(sitemap.xml)을 읽지 못해 찍을 장소를 정하지 못했어요`
  if (!sp) return isScreenKind(kind) ? SCREEN_SLOT_KIND_TEXT[kind] : `${SCREEN_SLOT_KIND_TEXT[kind]} — 찍지 않아요(직접 찍거나 자리 글자를 고쳐요)`
  const facts = row.factGaps?.length ? ` · 자리 글자의 ${row.factGaps.map((g) => `「${g}」`).join(' ')}이(가) 찍은 화면에 없어요(맞는지 확인)` : ''
  const via = row.viaAction ? ' · 장소를 눌러 보는 화면 자리라 그 장소의 장소 안내로 대신해요(맞는지 확인)' : ''
  return `${SCREEN_SLOT_KIND_TEXT[kind]} · ${screenByText(row, sp)}${via}${facts}`
}

/** 자사 화면의 변형을 고른 까닭 — 장소 안내는 자리 글자 · 소제목의 장소, 가이드는 그 이름, 코스 · 지도는 조건 · 권역. */
function screenByText(row: AutoSlotRow, sp: AutoScreenPick): string {
  if (sp.by === 'place') {
    const many = row.screenPlaces?.length ? `(자리 글자에 장소가 둘 이상 — ${row.screenPlaces.join(' · ')} — 한 곳만 찍혀요, 맞는지 확인)` : ''
    return `자리 글자의 장소 — ${sp.variantLabel}${many}`
  }
  if (sp.by === 'heading') return `소제목의 장소 — ${sp.variantLabel}(맞는지 확인)`
  if (sp.kind === 'guide') return sp.variantLabel
  return sp.by === 'region'
    ? `자리 글자의 권역 — ${sp.variantLabel}`
    : sp.by === 'named'
      ? '자리의 장소가 한 권역으로 정해지지 않아 전체 지도'
      : sp.by === 'prefer'
        ? sp.kind === 'course' && row.review
          ? '자리 글자가 말한 조건의 화면은 이 글 · 작성자에게 이미 써서 다른 변형'
          : `자리 글자가 말한 조건 — ${sp.variantLabel}`
        : sp.by === 'general'
          ? row.review
            ? `자리 글자가 조건을 말하지 않는데 기본 화면을 이 글 · 작성자에게 이미 써서 조건 화면 — ${sp.variantLabel}(맞는지 확인)`
            : `자리 글자가 조건을 말하지 않음 — ${sp.variantLabel}`
          : '브랜드에서 덜 쓴 변형'
}

/** 다시 본 자동 사진의 상태 글자 — 「장면 안 맞음 → 바꿈」 · 「비슷한 사진으로 둠」 · 「장면 맞음 · 그대로」. */
const RECHECK_TEXT: Record<NonNullable<AutoSlotRow['recheck']>, string> = {
  replace: AUTO_SLOT_STATE_TEXT.replace,
  remove: AUTO_SLOT_STATE_TEXT.remove,
  similar: '비슷한 사진으로 둠',
  fit: '장면 맞음 · 그대로',
  unknown: '장면 모름 · 그대로',
}

function PreviewRow({ title, row, brandName }: { title: string | null; row: AutoSlotRow; brandName: string }) {
  const c = row.candidate
  const why = sceneWhy(row)
  /** 장면을 아직 읽지 않은 후보 수 — 있으면 비슷한 사진을 넣지 않는다(맞는 사진이 있는지 모른다). */
  const unread = row.sceneSkips?.unread ?? 0
  const skips = row.state !== 'filled' && row.state !== 'replace' ? sceneSkipsText(row) : null
  const fresh = c ? (
    <PhotoBrief
      src={c.src}
      alt={c.alt}
      {...(c.tour ? { tour: c.tour } : {})}
      publicPhoto={c.origin === 'public'}
      credit={publicCandidateFields(c)}
      {...(row.scene && row.state !== 'kept' ? { scene: row.scene } : {})}
    />
  ) : null
  const screen = row.screenPick ? <ScreenBrief brandName={brandName} pick={row.screenPick} /> : null
  // 앱이 그린 군산 지도 — 그렸으면 썸네일(16:10), 아직이면 빈 자리. 늘 「확인 필요」 칩과 출처 줄.
  const map = row.mapPick ? <MapPickBrief {...(row.mapPick.drawn ? { src: row.mapPick.drawn.src } : {})} alt={row.mapPick.alt} caption={row.mapPick.caption} /> : null
  const warn = row.state === 'replace' || row.state === 'remove' || row.recheck === 'similar' || (row.state === 'filled' && row.review)
  const status = row.recheck
    ? RECHECK_TEXT[row.recheck]
    : row.state === 'filled' && row.review
      ? '확인 필요'
      : row.dropped
        ? '뺀 자리(내보낼 때 뺌)'
        : AUTO_SLOT_STATE_TEXT[row.state]
  const pill = warn
    ? 'st-warn'
    : row.state === 'filled'
      ? 'st-good'
      : row.state === 'preview' || row.state === 'uncaptured' || row.state === 'undrawn'
        ? 'st-info'
        : 'st-ok'
  return (
    <tr>
      {title !== null && <td className="cell-text">{title}</td>}
      <td className="cell-text">
        {row.slot.alt}
        {row.caption && <span className="doc-meta"> · {row.caption}</span>}
      </td>
      <td className="cell-text">
        {row.old && row.state === 'replace' ? (
          <>
            <OldBrief row={row} />
            <span className="doc-meta" style={{ display: 'block' }}>
              ↓ 바꿀 사진
            </span>
            {fresh}
          </>
        ) : row.old ? (
          <OldBrief row={row} />
        ) : (
          (map ?? screen ?? fresh ?? <span className="muted">—</span>)
        )}
      </td>
      <td className="cell-text">
        {row.mapPick ? (
          mapPickReason(row.mapPick).map((line, i) => (
            <span key={line} className={i ? 'doc-meta' : undefined} style={{ display: 'block' }}>
              {line}
            </span>
          ))
        ) : row.mapMiss ? (
          <span className="muted">{mapMissText(row)}</span>
        ) : row.screenSlot ? (
          <span className={row.screenPick ? undefined : 'muted'}>{screenWhy(row)}</span>
        ) : row.placeless && c ? (
          <>
            장소 없는 자리 — 비슷한 장면: 「{c.alt}」{c.location ? ` · ${c.location}` : ''}
            {c.place && <span className="doc-meta"> (관광공사 사진의 장소: {c.place})</span>}
          </>
        ) : c?.origin === 'public' && row.place ? (
          `장소: ${row.place}${c.tour && c.alt !== row.place ? ` → 관광공사 「${c.alt}」` : ''}`
        ) : row.score ? (
          `${row.score.words.join(' · ')} · ${row.score.score}${row.synonym ? ' · 비슷한 말로 맞춘 자기 시설 사진(맞는지 확인)' : ''}`
        ) : row.place ? (
          <span className="muted">장소: {row.place}</span>
        ) : (
          <span className="muted">—</span>
        )}
        {row.oldFit && !row.oldFit.ok && (
          <span className="doc-meta" style={{ display: 'block' }}>
            넣어 둔 자동 사진의 장면이 자리와 어긋남: {SCENE_SKIP_TEXT[row.oldFit.miss!]}
            {row.state === 'remove' &&
              (unread
                ? ` — 장면을 아직 읽지 않은 사진 ${unread}장이 남아 비슷한 사진으로 바꾸지 않고 뺍니다(다시 누르면 이어서 읽고 채워요)`
                : ' — 바꿀 사진이 없어 뺍니다(다음에 다시 채워요)')}
          </span>
        )}
        {why && <span className="doc-meta" style={{ display: 'block' }}>{why}</span>}
        {row.similar && (
          <span className="doc-meta" style={{ display: 'block' }}>
            {row.similar} —{' '}
            {row.state !== 'kept'
              ? '맞는 사진이 없어 넣었어요'
              : unread
                ? `장면을 아직 읽지 않은 사진 ${unread}장이 남아 그대로 둬요(다시 누르면 이어서 읽어요)`
                : '맞는 사진이 없어 그대로 둬요'}
          </span>
        )}
        {skips && <span className="doc-meta" style={{ display: 'block' }}>장면 때문에 뺀 사진: {skips}</span>}
        {row.regionTried === 0 && row.state !== 'filled' && row.state !== 'replace' && (
          <span className="doc-meta" style={{ display: 'block' }}>장소 없는 자리 — 지역 사진 가운데 자리 낱말(거리 · 골목 · 꽃 …)이 맞는 사진이 없어요</span>
        )}
      </td>
      <td className="cell-text">
        <span className={`status-pill ${pill}`}>{status}</span>
        {row.review && row.state !== 'filled' && row.state !== 'preview' && <span className="doc-meta"> 확인 필요</span>}
        {row.refill && <span className="doc-meta"> 사람이 뺀 자리</span>}
      </td>
    </tr>
  )
}
