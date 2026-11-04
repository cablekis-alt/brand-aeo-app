import { useMemo, useState } from 'react'
import {
  loadPhotoScenesStatus,
  loadPublishSettings,
  loadTourApiStatus,
  saveDraftPhotosAuto,
  type AutoPhotoSaveResult,
  type StoredDraft,
  type TenantSummary,
} from '../lib/api'
import { canonicalPhotoSrc, PHOTO_LICENSES, photoCreditState, photosAllowed, publicPhotosAllowed, type PhotoLicense } from '../lib/articlePhotos'
import { publishMarkdownOf } from '../lib/draftGaps'
import {
  AUTO_CANDIDATE_SKIP_TEXT,
  AUTO_SLOT_STATE_TEXT,
  autoPickPhotos,
  findPlace,
  otherPhotoUses,
  photoStateKey,
  placesToRead,
  publicCandidateFields,
  SCENE_SKIP_TEXT,
  tourPlacesWanted,
  type AutoArticle,
  type AutoCandidate,
  type AutoPickResult,
  type AutoSlotRow,
  type AutoSlotState,
  type SceneSkip,
} from '../lib/photoAutoPick'
import { SCENE_SETTING_TEXT, sceneMeta, type PhotoScene, type SceneWant } from '../lib/photoScenes'
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
  siteRootOf,
  tourCandidatesOf,
  type PublicPhotoPage,
  type SitePhotoResult,
} from '../lib/sitePhotos'
import { TOUR_PLACE_LIMIT, TOUR_SOURCES, tourSourceOf, type TourSource } from '../lib/tourPhotos'

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
 * 사진은 장소 사진이면 쓰지 않는다(그 자리는 관광공사 사진을 찾는다). 키가 없으면 알리고 지금처럼 고른다.
 * 「사람이 뺀 자리도 다시 채우기」(기본 꺼짐)를 켜면 사람이 뺀 자리도 다시 보되, 그 자리에서 뺀 사진은 고르지 않는다(서버도 저장할 때
 * 다시 본다). 뺀 사진을 적어 두기 전에 뺀 자리(옛 기록)는 무엇을 뺐는지 몰라 장면을 읽을 수 있을 때만 다시 채운다.
 * 「이미 넣은 자동 사진도 장면 확인」(기본 켜짐)을 켜면 장면을 읽을 수 있을 때 이미 넣은 자동 사진(「자동」 표시 — 사람이 고른 사진은
 * 보지 않는다)의 장면도 읽어 자리와 견준다 — 맞으면 그대로, 시간만 다르면 맞는 사진이 있을 때만 바꾸고 아니면 비슷한 사진으로 두며,
 * 종류 · 사람이 어긋나면 맞는 사진 → 비슷한 사진으로 바꾸고 둘 다 없으면 뺀다. 미리보기에 「장면 안 맞음 → 바꿈 · 뺌」 · 「비슷한 사진으로
 * 둠」으로 보이고, 저장을 눌러야 바뀐다(서버가 그 자리에 화면이 본 그 자동 사진이 있을 때만 — 그사이 사람이 고른 자리는 건드리지 않는다).
 *
 * 미리보기는 계산한 때의 초안으로 고른다 — 그사이 다른 미리보기 · 사람이 고른 사진이 저장되거나 글이 바뀌면(photoStateKey) 그
 * 미리보기로는 저장하지 않고 다시 맞추게 한다(작성자 · 브랜드 반복 상한이 달라진다). 서버도 쓰기 안에서 상한을 다시 본다.
 *
 * 글 하나(SitePhotoPanel), 작성자 한 명 · 브랜드 전부(GapActions WriterRuns), 작성자 배정이 없는 브랜드의 「① 글 확인」에서 쓴다.
 */
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
  } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleOf = new Map(articles.map((a) => [a.stored.actionId, a.title]))
  const previewIds = useMemo(() => new Set(preview?.result.articles.map((a) => a.actionId) ?? []), [preview])
  const stale = useMemo(() => preview !== null && photoStateKey(drafts, previewIds) !== preview.key, [preview, drafts, previewIds])
  const hasCleared = articles.some((a) => (a.stored.photoCleared?.length ?? 0) > 0)
  const hasAuto = articles.some((a) => a.stored.photos?.some((p) => p.auto))

  const run = async () => {
    const refillOn = refill && hasCleared
    const recheckOn = recheck && hasAuto
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
      // 사진 장면 — 이 PC에 키가 있으면 장면으로 고른다(없으면 지금처럼). 장면을 다 읽지 못해도 장면으로 고른다(읽지 못한 장소 사진은 비워 둔다).
      const scenes = (await loadPhotoScenesStatus()) ? new Map<string, PhotoScene>() : null
      setProgress('사진 후보 모으는 중…')
      const pub = await publicFor(autoArticles, found, publicOk, refillOn, scenes !== null, recheckOn)
      // 장소 페이지를 읽은 장소 — 읽지 못한(일시 실패 · 읽기 상한) 장소의 자리는 관광공사 사진으로 먼저 채우지 않는다(다음에 눌러 그 페이지부터).
      const pagesRead = new Set(pub.pages.map((p) => p.place))
      // 읽기마다 새로 물은 사진만 묻는다(asked) — 남긴 수는 읽기마다 그 읽기에서 남긴 수를 더하고, 읽지 못한 사진은 한 번씩.
      const sceneSum = { calls: 0, described: 0, cached: 0, left: 0, failed: new Set<string>() }
      const sceneBudget = newSceneBudget()
      const sceneNotes: string[] = []
      const asked = new Set<string>()
      const readScenes = async (wanted: readonly SceneWant[]) => {
        if (!scenes || !wanted.length) return
        setProgress('사진 장면 확인 중…')
        try {
          const load = await loadScenesFor(wanted, scenes, (n, m) => setProgress(`사진 장면 읽는 중 ${n}/${m}`), sceneBudget)
          sceneSum.calls += load.calls
          sceneSum.described += load.described
          sceneSum.cached += load.cached
          sceneSum.left += load.left
          for (const src of load.failed) sceneSum.failed.add(src)
          for (const n of load.notes) if (!sceneNotes.includes(n)) sceneNotes.push(n)
        } catch (e) {
          console.warn('[PhotoAutoFill] 사진 장면을 다 읽지 못했습니다', e)
          sceneNotes.push(`사진 장면을 다 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)} 장면을 읽은 사진으로만 골랐어요.`)
        }
      }
      const pick = (tourCandidates: AutoCandidate[] = []) =>
        autoPickPhotos({
          articles: autoArticles,
          candidates: found.photos.map((p) => ({ src: p.src, alt: p.alt, pageUrl, ...(p.credit ? { credit: true } : {}) })),
          publicCandidates: pub.candidates,
          tourCandidates,
          pagesRead,
          places: pub.places,
          others: otherPhotoUses(drafts, ids, groupOf),
          brandName: brand.brandName,
          ownedDomains: brand.ownedDomains,
          ...(scenes ? { scenes, sceneFailed: sceneSum.failed } : {}),
          refillCleared: refillOn,
          recheckAuto: recheckOn,
        })
      // 장면으로 고르기 — 고르고, 새로 쓰일 사진의 장면을 읽고, 다시 고른다(새 사진이 없을 때까지).
      const pickScenes = (tourCandidates: AutoCandidate[] = []) =>
        scenes ? pickReadingScenes(() => pick(tourCandidates), readScenes, asked) : Promise.resolve(pick(tourCandidates))
      let result = await pickScenes()
      // 3단계 — 장소 페이지에 쓸 사진이 없던(또는 장면이 맞지 않던) 장소 자리를 관광공사 사진으로.
      const tourWanted = publicOk ? tourPlacesWanted(result, pagesRead) : []
      const tourNotes: string[] = []
      if (tourWanted.length) {
        if (await loadTourApiStatus()) {
          setProgress('관광공사 사진 찾는 중…')
          const tour = await loadTourPhotosFor(tenantId, tourWanted, pub.pages)
          result = await pickScenes(tourCandidatesOf(tour.results))
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
      const placeRows = result.articles.flatMap((a) => a.rows).filter((r) => r.place && r.state !== 'filled').length
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
            ...(placeFilled ? ['이 PC에 Claude 키가 없어 사진 장면을 읽지 않고 골랐어요 — 장소 사진(공공 · 관광공사)은 장면까지 맞는지 썸네일로 꼭 확인해 주세요.'] : []),
            ...(oldCleared
              ? [`뺀 사진을 적어 두기 전에 사람이 뺀 자리 ${oldCleared}곳은 무엇을 뺐는지 몰라 다시 채우지 않았어요 — 사진 장면을 읽을 수 있는 PC(Claude 키)에서는 장면으로 걸러 다시 채워요.`]
              : []),
            ...(recheckOn ? ['이 PC에 Claude 키가 없어 이미 넣은 자동 사진은 장면으로 다시 보지 않았어요.'] : []),
          ].join(' ') || null
      setPreview({ result, pageUrl, key: photoStateKey(drafts, ids), publicNote, sceneNote, refill: refillOn })
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
  ): Promise<{ candidates: AutoCandidate[]; places: string[]; pages: PublicPhotoPage[]; off: boolean; note: string | null }> => {
    const root = siteRootOf(site.pageUrl)
    if (!root) return { candidates: [], places: [], pages: [], off: !allowed, note: null }
    let places: string[]
    try {
      places = (await loadPlaceDirectory(root)).map((e) => e.name)
    } catch (e) {
      if (!allowed) {
        console.warn('[PhotoAutoFill] 장소 목록(sitemap.xml)을 읽지 못했습니다(공공 사진 사용 확인 전이라 알리지 않음)', e)
        return { candidates: [], places: [], pages: [], off: true, note: null }
      }
      return { candidates: [], places: [], pages: [], off: false, note: `장소 목록(sitemap.xml)을 읽지 못해 공공 사진은 건너뛰었어요 — ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!places.length || !allowed) return { candidates: [], places, pages: [], off: !allowed, note: null }
    const siteAlt = new Map(site.photos.map((p) => [p.src, p.alt]))
    const hinted = list.flatMap((a) =>
      (a.picks ?? []).flatMap((p) =>
        photoCreditState(p) === 'missing' ? [p.alt, siteAlt.get(canonicalPhotoSrc(p.src) ?? p.src) ?? ''].flatMap((h) => findPlace(h, places) ?? []) : [],
      ),
    )
    const wanted = [...new Set([...placesToRead(list, places, refillCleared, withScenes, recheckAuto), ...hinted])]
    const directory = await loadPlaceDirectory(root)
    const load = await loadPublicPhotos(directory, wanted)
    const notes = [
      ...(load.failed.length ? [`장소 페이지 ${load.failed.length}곳을 읽지 못했어요(${load.failed.map((x) => x.place).join(' · ')}).`] : []),
      ...(load.capped ? [`장소 페이지는 한 번에 ${load.pages.length + load.failed.length}곳까지 읽어요 — ${load.capped}곳은 다음에 다시 눌러 주세요.`] : []),
    ]
    return { candidates: publicCandidatesOf(load.pages), places, pages: load.pages, off: false, note: notes.length ? notes.join(' ') : null }
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

  const rows = preview ? preview.result.articles.flatMap((a) => a.rows.map((row) => ({ actionId: a.actionId, row }))) : []
  const count = (state: AutoSlotState) => rows.filter((r) => r.row.state === state).length
  const filled = count('filled')
  const filledPublic = rows.filter((r) => r.row.state === 'filled' && r.row.pick?.origin === 'public' && !r.row.candidate?.tour).length
  const filledTour = rows.filter((r) => r.row.state === 'filled' && r.row.candidate?.tour).length
  const credits = preview ? preview.result.articles.reduce((n, a) => n + a.credits.length, 0) : 0
  const review = rows.filter((r) => r.row.review).length
  const similar = rows.filter((r) => r.row.state === 'filled' && r.row.similar).length
  const refilled = rows.filter((r) => r.row.state === 'filled' && r.row.refill).length
  const replaced = count('replace')
  const removed = count('remove')
  const rechecked = (k: NonNullable<AutoSlotRow['recheck']>) => rows.filter((r) => r.row.state === 'kept' && r.row.recheck === k).length
  const recheckParts = [
    ...(replaced ? [`장면 안 맞음 → 바꿈 ${replaced}`] : []),
    ...(removed ? [`장면 안 맞음 → 뺌 ${removed}`] : []),
    ...(rechecked('similar') ? [`비슷한 사진으로 둠 ${rechecked('similar')}`] : []),
    ...(rechecked('fit') ? [`장면 맞음(그대로) ${rechecked('fit')}`] : []),
    ...(rechecked('unknown') ? [`장면 모름(그대로) ${rechecked('unknown')}`] : []),
  ]
  const changes = filled + replaced + removed
  const isShown = (row: AutoSlotRow) => row.state === 'filled' || row.state === 'replace' || row.state === 'remove' || row.recheck === 'similar'
  const shownCount = rows.filter((r) => isShown(r.row)).length
  const shown = showAll ? rows : rows.filter((r) => isShown(r.row))
  const skippedByReason = preview
    ? Object.entries(
        preview.result.skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}),
      ).map(([reason, n]) => `${AUTO_CANDIDATE_SKIP_TEXT[reason as keyof typeof AUTO_CANDIDATE_SKIP_TEXT]} ${n}`)
    : []
  const others = (['kept', 'cleared', 'screen', 'nomatch', 'scene', 'unread', 'used', 'full', 'license'] as const)
    .map((s) => [s, s === 'kept' ? rows.filter((r) => r.row.state === 'kept' && !r.row.recheck).length : count(s)] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${AUTO_SLOT_STATE_TEXT[s]} ${n}`)

  return (
    <div className="photo-auto">
      <div className="brief-bar" style={{ margin: 0 }}>
        <button
          type="button"
          className="ghost"
          disabled={locked || loading || saving}
          onClick={() => void run()}
          title="사진 설명 · 장소와 사진 자리 글자를 맞춰 빈 자리에 넣을 사진을 고릅니다. 이 PC에 Claude 키가 있으면 후보 사진의 장면을 읽어(사진 한 장에 한 번 — 읽은 장면은 저장해 다시 읽지 않아요) 장면이 맞는 사진만 고릅니다. 저장 전에 미리보기 표를 보여 줍니다."
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
            {filledPublic > 0 && ` (공공 사진 ${filledPublic})`}
            {filledTour > 0 && ` (관광공사 사진 ${filledTour})`}
            {review > 0 && ` (확인 필요 ${review})`}
            {similar > 0 && ` (비슷한 사진 ${similar})`}
            {refilled > 0 && ` (사람이 뺀 자리 ${refilled})`}
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
          <p className="hint" style={{ margin: 0 }}>
            틀린 사진보다 빈자리가 낫다는 기준으로, 설명이 충분히 맞는 사진만 고릅니다. 공공 사진 · 관광공사 사진은 자리 글자에 나온 장소의
            사진이에요 — 사진 장면을 읽었으면 장면이 자리와 어긋난 사진(외관 자리에 실내 사진 · 사람을 알아볼 수 있는 사진 등)은 빼고 장면이 맞는
            사진을 고르지만, 장면 설명도 AI가 쓴 것이라 늘 「확인 필요」이니 썸네일을 확인해 주세요. 장면이 맞는 사진이 어디에도 없으면 시간만
            다른 사진(낮 사진 · 해 질 무렵 자리)을 「비슷한 사진」으로 넣어요. 공공 사진은 내보낼 때 사진 아래에
            출처(공공누리 제1유형 링크)가 붙습니다. 사람이 나오는 장면 자리는 「확인 필요」 — 저장한 뒤 글의 「홈페이지 사진」 칸에서 바꾸거나 빼
            주세요. 사람이 고른 자리는 덮지 않고, 사람이 뺀 자리는 「사람이 뺀 자리도 다시 채우기」를 켰을 때만 다시 채웁니다.
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
                    <PreviewRow key={`${actionId}|${row.slot.line}`} title={single ? null : (titleOf.get(actionId) ?? actionId)} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="brief-bar" style={{ margin: 0 }}>
            <button type="button" disabled={(changes === 0 && credits === 0) || saving || locked || stale} onClick={() => void save()}>
              {saving
                ? '저장 중…'
                : `저장 — ${filled}자리${replaced ? ` · 바꿈 ${replaced}` : ''}${removed ? ` · 뺌 ${removed}` : ''}${credits ? ` · 출처 ${credits}장` : ''}`}
            </button>
            <button type="button" className="ghost" disabled={saving} onClick={() => setPreview(null)}>
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

/** 다시 본 자동 사진의 상태 글자 — 「장면 안 맞음 → 바꿈」 · 「비슷한 사진으로 둠」 · 「장면 맞음 · 그대로」. */
const RECHECK_TEXT: Record<NonNullable<AutoSlotRow['recheck']>, string> = {
  replace: AUTO_SLOT_STATE_TEXT.replace,
  remove: AUTO_SLOT_STATE_TEXT.remove,
  similar: '비슷한 사진으로 둠',
  fit: '장면 맞음 · 그대로',
  unknown: '장면 모름 · 그대로',
}

function PreviewRow({ title, row }: { title: string | null; row: AutoSlotRow }) {
  const c = row.candidate
  const why = sceneWhy(row)
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
  const warn = row.state === 'replace' || row.state === 'remove' || row.recheck === 'similar' || (row.state === 'filled' && row.review)
  const status = row.recheck ? RECHECK_TEXT[row.recheck] : row.state === 'filled' && row.review ? '확인 필요' : AUTO_SLOT_STATE_TEXT[row.state]
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
          (fresh ?? <span className="muted">—</span>)
        )}
      </td>
      <td className="cell-text">
        {c?.origin === 'public' && row.place ? (
          `장소: ${row.place}${c.tour && c.alt !== row.place ? ` → 관광공사 「${c.alt}」` : ''}`
        ) : row.score ? (
          `${row.score.words.join(' · ')} · ${row.score.score}`
        ) : row.place ? (
          <span className="muted">장소: {row.place}</span>
        ) : (
          <span className="muted">—</span>
        )}
        {row.oldFit && !row.oldFit.ok && (
          <span className="doc-meta" style={{ display: 'block' }}>
            넣어 둔 자동 사진의 장면이 자리와 어긋남: {SCENE_SKIP_TEXT[row.oldFit.miss!]}
            {row.state === 'remove' && ' — 바꿀 사진이 없어 뺍니다(다음에 다시 채워요)'}
          </span>
        )}
        {why && <span className="doc-meta" style={{ display: 'block' }}>{why}</span>}
        {row.similar && (
          <span className="doc-meta" style={{ display: 'block' }}>
            {row.similar} — {row.state === 'kept' ? '맞는 사진이 없어 그대로 둬요' : '맞는 사진이 없어 넣었어요'}
          </span>
        )}
        {skips && <span className="doc-meta" style={{ display: 'block' }}>장면 때문에 뺀 사진: {skips}</span>}
      </td>
      <td className="cell-text">
        <span className={`status-pill ${warn ? 'st-warn' : row.state === 'filled' ? 'st-good' : 'st-ok'}`}>{status}</span>
        {row.review && row.state !== 'filled' && <span className="doc-meta"> 확인 필요</span>}
        {row.refill && <span className="doc-meta"> 사람이 뺀 자리</span>}
      </td>
    </tr>
  )
}
