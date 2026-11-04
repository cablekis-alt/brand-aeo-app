import { useEffect, useMemo, useState } from 'react'
import {
  captureScreen,
  loadPhotoScenes,
  loadPhotoScenesStatus,
  loadPublishSettings,
  loadScreenCaptureStatus,
  loadScreens,
  loadTourApiStatus,
  saveDraftPhoto,
  savePhotoRights,
  type PhotoPlace,
  type ScreenList,
  type StoredDraft,
  type TenantSummary,
} from '../lib/api'
import {
  canonicalPhotoSrc,
  isPhotoMedical,
  matchPhotos,
  needsPhotoCredit,
  PHOTO_LICENSES,
  photoCreditState,
  photoSlotsOf,
  publicPhotoFields,
  publicPhotosAllowed,
  type PhotoPick,
  type PhotoSlot,
  type PublicPhotoFields,
} from '../lib/articlePhotos'
import { publishMarkdownOf } from '../lib/draftGaps'
import type { PublishSettings } from '../lib/publishSettings'
import { findPlace, findPlaces, isPeopleScene, isScreenSlot, publicCandidateFields } from '../lib/photoAutoPick'
import { sceneMeta, type PhotoScene } from '../lib/photoScenes'
import { kstDate, todayKst } from '../lib/publishedUrl'
import {
  latestScreenShots,
  MAP_PREVIEW_ONLY_TEXT,
  parseScreenAppSrc,
  photoRepeatKey,
  placeScreenVariant,
  placeVariantOfSlug,
  screenAlt,
  screenAspectRatio,
  screenKindOf,
  screenProfileFor,
  screenShotDay,
  screenShotMeta,
  type ScreenKind,
  type ScreenShotView,
} from '../lib/screenCapture'
import {
  findPublicCredit,
  loadPlaceDirectory,
  loadPublicPhotos,
  loadSitePhotos,
  loadTourPhotosFor,
  photoPageOf,
  publicCandidatesOf,
  siteRootOf,
  tourCandidatesOf,
  type PlaceEntry,
  type SitePhotoResult,
} from '../lib/sitePhotos'
import { isTourSourcePage, TOUR_SOURCES, type TourSource } from '../lib/tourPhotos'
import PhotoAutoFill from './PhotoAutoFill'

/**
 * 글 확인 화면의 「홈페이지 사진」 — 글의 사진 자리마다 브랜드 홈페이지 사진을 사람이 한 장씩 고른다(src/lib/articlePhotos.ts).
 *
 * 고른 사진은 본문에 넣지 않고 내보낼 때(복사 · .html)만 사진 자리에 들어간다. 홈페이지 사진도 예약 플랫폼 · 사진작가의
 * 사진이거나 사람이 찍혀 있을 수 있어, 브랜드마다 한 번 「써도 된다」는 확인을 받고(서버가 확인 없이 고르기를 막는다) 사진마다
 * 썸네일을 보고 고르게 한다 — 미리 골라 두지 않는다. 의료 업종은 기본으로 꺼 두고 의료광고 확인을 따로 받는다.
 *
 * 「자동 채우기」(PhotoAutoFill)는 빈 자리에 맞는 사진을 미리보기 표로 보이고 저장하면 「자동」 표시로 넣는다 — 여기서 바꾸거나 빼면
 * 사람이 고른 자리가 되어 자동 채우기가 다시 덮지 않는다.
 *
 * 공공 사진 — 자사 사이트에 장소 페이지(sitemap의 /places/{이름}/)가 있으면, 브랜드마다 한 번 「공공 사진 사용 확인」(출처 표시 의무 등)을
 * 받은 뒤 사진 자리에 나온 장소의 공공누리 제1유형 사진을 고를 수 있다(출처와 함께 저장하고, 내보낼 때 사진 아래에 출처 줄이 붙는다).
 * 공공 사진 호스트의 사진을 출처 없이 고른 옛 기록은 「출처 없음」으로 알리고 내보내지 않는다 — 「출처 붙이기」로 장소 페이지에서 같은
 * 사진의 제1유형 표시를 찾으면 출처를 붙인다. 지우지는 않는다.
 *
 * 관광공사 사진 — 이 PC에 TourAPI 키가 있으면(/api/health tourApi) 사진 자리에 나온 장소의 한국관광공사 공공누리 제1유형 사진(국문
 * 관광정보 · 관광사진 정보)도 불러와 같은 방법으로 고른다(공공 사진 사용 확인 뒤, 출처와 함께).
 *
 * 사진 장면 — 이 PC에 Claude 키가 있으면(/api/health photoScenes) 고를 사진 아래에 읽어 둔 장면(자동 채우기가 읽은 것 — 여기서는 새로
 * 읽지 않는다)을 함께 보인다.
 *
 * 자사 화면 — 자사 사이트에 화면 프로필(src/lib/screenCapture.ts)이 있는 브랜드는 웹사이트 화면 자리에 「화면 고르기」로 이 PC에 찍어 둔
 * 화면(썸네일 · 변형 · 찍은 날)을 고른다(열 때마다 GET /api/screens로 다시 읽는다). 설치한 데스크톱 앱에서 찍을 수 있으면(/api/health
 * screens) 아직 찍지 않았거나 오늘 찍지 않은 화면에 「찍기」 · 「다시 찍기」를 둔다(서버가 숨긴 창으로 찍는다). 지도 화면은 카카오 지도
 * 이용 조건을 확인하기 전이라 크게 보기만 하고 넣는 단추를 두지 않는다(결정 4 — 서버도 거절한다). 빼기 · 바꾸기는 사진과 같다. 장소 안내는
 * 사이트 장소마다 한 장이라, 자리 글자(장면 · 설명 줄 · 소제목)에 나온 장소(사이트 장소 사전)와 이 PC에 찍어 둔 장소만 보인다. 잘라 찍은
 * 화면(장소 안내 · 가이드)의 썸네일은 그 비율 그대로다.
 */

/** 「화면 고르기」의 화면 · 변형 하나와 가장 늦게 찍은 화면. */
interface ScreenOption {
  /** 「화면id:변형id」. */
  key: string
  screenId: string
  variantId: string
  kind: ScreenKind
  label: string
  variantLabel: string
  saveAllowed: boolean
  /** 장소 안내 — 변형이 사이트 장소(대체 텍스트에 장소 이름을 넣는다). */
  placePages?: true
  shot?: ScreenShotView
}

/** 고를 수 있는 사진 하나 — 홈페이지 사진 또는 공공 사진(pub: 출처 · 이용 허락, place: 장소). */
interface PhotoOption {
  src: string
  alt: string
  pageUrl: string
  where?: string
  pub?: PublicPhotoFields
  /** 관광공사 사진이면 그 서비스. */
  tour?: TourSource
}

/** 사진 자리 바로 아랫줄의 설명(`*설명*`) — 장소를 찾을 때 쓴다. */
function captionAt(md: string, slot: PhotoSlot): string {
  return /^\*(?!\*)(.+?)\*$/.exec((md.split('\n')[slot.line + 1] ?? '').trim())?.[1] ?? ''
}

export default function SitePhotoPanel({
  tenantId,
  brand,
  stored,
  disabled,
  onStored,
  onSettings,
  photoContext,
}: {
  tenantId: string
  brand: TenantSummary
  stored: StoredDraft
  /** 초안을 만들거나 다시 쓰는 중 — 그사이 고른 사진은 새 초안에 붙지 못한다. */
  disabled: boolean
  onStored: (s: StoredDraft) => void
  /** 발행 설정을 읽거나 사진 사용 확인을 바꿨다 — 초안 패널의 「사진 받기」가 같은 확인을 본다. */
  onSettings?: (s: PublishSettings | null) => void
  /** 자동 채우기의 반복 상한에 셀 브랜드의 초안 전부와 글의 작성자 — 없으면 이 글만 본다(브랜드 상한은 서버가 지킨다). */
  photoContext?: { drafts: Readonly<Record<string, StoredDraft>>; groupOf?: (actionId: string) => string | undefined }
}) {
  const md = useMemo(() => publishMarkdownOf(stored), [stored])
  const slots = useMemo(() => photoSlotsOf(md), [md])
  const match = useMemo(() => matchPhotos(md, stored.photos ?? []), [md, stored.photos])
  const medical = isPhotoMedical(brand.industry)

  const [settings, setSettings] = useState<PublishSettings | null | undefined>(undefined)
  const [agree, setAgree] = useState(false)
  const [agreeMedical, setAgreeMedical] = useState(false)
  const [pageUrl, setPageUrl] = useState('')
  const [found, setFound] = useState<SitePhotoResult | null>(null)
  const [loading, setLoading] = useState(false)
  /** 사진을 고르고 있는 자리(slotId — 장면 글자 · 몇 번째 · 소제목)와 고른 사진. 자리를 바꾸면 고른 사진은 비운다. */
  const [openSlot, setOpenSlot] = useState<string | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** 사이트의 장소 사전(sitemap /places/) — null은 아직 모름. 비면 공공 사진 칸을 그리지 않는다. */
  const [places, setPlaces] = useState<string[] | null>(null)
  /** 장소 사전의 이름 · 주소 — 장소 안내 화면의 장소를 고른다. */
  const [placePages, setPlacePages] = useState<PlaceEntry[]>([])
  const [agreePublic, setAgreePublic] = useState(false)
  const [publicFound, setPublicFound] = useState<{ options: PhotoOption[]; other: number; places: string[] } | null>(null)
  const [publicLoading, setPublicLoading] = useState(false)
  /** 이 PC에서 관광공사 사진(TourAPI)을 쓸 수 있는가 — null은 아직 모름. */
  const [tourOn, setTourOn] = useState<boolean | null>(null)
  const [tourFound, setTourFound] = useState<{ options: PhotoOption[]; places: string[]; notes: string[] } | null>(null)
  const [tourLoading, setTourLoading] = useState(false)
  /** 이 PC에서 사진 장면을 읽을 수 있는가 · 고를 사진의 읽어 둔 장면(사진 주소 → 장면). */
  const [scenesOn, setScenesOn] = useState(false)
  const [sceneOf, setSceneOf] = useState<Readonly<Record<string, PhotoScene>>>({})
  /** 고르는 칸 — 홈페이지 · 공공 사진(photo) 또는 자사 화면(screen). */
  const [openMode, setOpenMode] = useState<'photo' | 'screen'>('photo')
  /**
   * 자사 화면 목록(「화면 고르기」를 열 때마다 다시 읽는다) — list null은 이 환경에 화면 기능이 없다(웹). canCapture는 이 실행에서 찍을 수
   * 있는가(설치한 데스크톱 앱). key는 브랜드.
   */
  const [screenState, setScreenState] = useState<{
    key: string
    loading: boolean
    list: ScreenList | null
    canCapture: boolean
    error: string | null
  } | null>(null)
  /** 찍는 중인 화면 · 변형(「화면id:변형id」). */
  const [capturing, setCapturing] = useState<string | null>(null)
  const screenProfile = useMemo(() => screenProfileFor(brand.ownedDomains), [brand.ownedDomains])

  useEffect(() => {
    let alive = true
    loadPublishSettings(tenantId).then(
      (s) => {
        if (!alive) return
        setSettings(s)
        onSettings?.(s)
        setPageUrl((cur) => cur || photoPageOf(brand, s) || '')
      },
      (e: unknown) => {
        console.error('[SitePhotoPanel] 발행 설정을 읽지 못했습니다', e)
        if (alive) setSettings(null)
      },
    )
    return () => {
      alive = false
    }
    // onSettings는 부모의 상태 설정 함수라 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, brand])

  const siteRoot = settings === undefined ? null : siteRootOf(photoPageOf(brand, settings))
  const rights = settings?.photoRights
  const allowed = Boolean(rights) && (!medical || Boolean(rights?.medical))
  const hasPhotoWork = slots.length > 0 || (stored.photos ?? []).length > 0
  // 장소 사전(sitemap.xml)은 사진 사용 확인(의료 업종은 의료광고 확인까지)이 있고 사진 자리나 고른 사진이 있을 때만 받는다 — 사진을 쓰지
  // 않는 브랜드의 카드를 펼칠 때마다 고객 사이트에 요청하지 않게.
  const wantPlaces = Boolean(siteRoot) && allowed && hasPhotoWork
  useEffect(() => {
    if (!siteRoot || !wantPlaces) return
    let alive = true
    loadPlaceDirectory(siteRoot).then(
      (dir) => {
        if (!alive) return
        setPlaces(dir.map((e) => e.name))
        setPlacePages(dir)
      },
      (e: unknown) => {
        console.warn('[SitePhotoPanel] 장소 목록(sitemap.xml)을 읽지 못해 공공 사진 칸을 숨깁니다', e)
        if (alive) setPlaces([])
      },
    )
    return () => {
      alive = false
    }
  }, [siteRoot, wantPlaces])

  const publicOk = publicPhotosAllowed(settings, brand.industry)
  const wantTour = publicOk && (places?.length ?? 0) > 0 && slots.length > 0
  useEffect(() => {
    if (!wantTour) return
    let alive = true
    void loadTourApiStatus().then((on) => {
      if (alive) setTourOn(on)
    })
    return () => {
      alive = false
    }
  }, [wantTour])

  // 고를 사진의 읽어 둔 장면 — 새로 읽지 않는다(비용 없음). 후보가 바뀔 때만 다시 묻는다.
  useEffect(() => {
    if (!allowed || !hasPhotoWork) return
    let alive = true
    void loadPhotoScenesStatus().then((on) => {
      if (alive) setScenesOn(on)
    })
    return () => {
      alive = false
    }
  }, [allowed, hasPhotoWork])
  const optionKey = [...(found?.photos ?? []), ...(publicFound?.options ?? []), ...(tourFound?.options ?? [])].map((p) => p.src).join('\n')
  useEffect(() => {
    if (!scenesOn || !optionKey) return
    let alive = true
    const srcs = [...new Set(optionKey.split('\n'))]
    const load = async () => {
      const got: Record<string, PhotoScene> = {}
      for (let i = 0; i < srcs.length; i += 300) Object.assign(got, (await loadPhotoScenes(srcs.slice(i, i + 300), 0)).scenes)
      if (alive) setSceneOf(got)
    }
    load().catch((e: unknown) => console.warn('[SitePhotoPanel] 사진 장면을 읽지 못해 장면 없이 보입니다', e))
    return () => {
      alive = false
    }
  }, [scenesOn, optionKey])

  if (!hasPhotoWork) return null

  const noCredit = (stored.photos ?? []).filter((p) => photoCreditState(p) === 'missing')
  const showPublic = allowed && ((places?.length ?? 0) > 0 || noCredit.length > 0)
  // 홈페이지 사진 가운데 출처 표시가 필요한 사진(공공누리 표시 · 공공 사진 호스트)은 여기서 고르지 않는다 — 공공 사진으로 출처와 함께.
  // 자사 사이트 주소의 사진은 공공 사진 호스트여도 홈페이지 사진이다(자사 사이트가 visitkorea.or.kr · go.kr인 브랜드).
  const siteOptions: PhotoOption[] = (found?.photos ?? [])
    .filter((p) => !p.credit && !needsPhotoCredit(p.src, brand.ownedDomains))
    .map((p) => ({ src: p.src, alt: p.alt, pageUrl: found!.pageUrl, ...(p.where ? { where: p.where } : {}) }))
  const creditSkipped = (found?.photos.length ?? 0) - siteOptions.length
  const options: PhotoOption[] = [...siteOptions]
  for (const o of publicOk ? [...(publicFound?.options ?? []), ...(tourFound?.options ?? [])] : []) {
    if (!options.some((x) => x.src === o.src)) options.push(o)
  }
  const pickAt = (slot: PhotoSlot) => match.applied.find((a) => a.slot.line === slot.line)?.pick
  const slotId = (slot: PhotoSlot) => `${slot.key}|${slot.nth}|${slot.heading}`
  /** 자사 화면 목록과 찍을 수 있는지를 다시 읽는다 — 자동 채우기가 그사이 찍은 화면도 보이게 열 때마다. */
  const loadScreenState = async () => {
    const key = tenantId
    setScreenState((cur) => ({
      key,
      loading: true,
      list: cur?.key === key ? cur.list : null,
      canCapture: cur?.key === key ? cur.canCapture : false,
      error: null,
    }))
    try {
      const [list, on] = await Promise.all([loadScreens(tenantId), loadScreenCaptureStatus()])
      setScreenState({ key, loading: false, list, canCapture: Boolean(list?.available) && on, error: null })
    } catch (e) {
      console.warn('[SitePhotoPanel] 자사 화면 목록을 읽지 못했습니다', e)
      setScreenState({ key, loading: false, list: null, canCapture: false, error: `자사 화면 목록을 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  const openFor = (id: string | null, mode: 'photo' | 'screen' = 'photo') => {
    setOpenSlot(id)
    setOpenMode(mode)
    setChoice(null)
    if (id && mode === 'screen') void loadScreenState()
  }
  const screens = screenState?.key === tenantId ? screenState : null
  /** 화면을 고를 수 있는 자리 — 사진 사용 확인 뒤, 자사 사이트에 화면 프로필이 있고 웹사이트 화면 자리이거나 이미 화면이 들어간 자리. */
  const screenable = (slot: PhotoSlot, picked?: PhotoPick) => allowed && screenProfile !== null && (isScreenSlot(slot.key) || picked?.origin === 'screen')
  /**
   * 장소 안내 화면의 변형 — 자리 글자(장면 · 설명 줄 · 소제목)에 나온 사이트 장소(장소 사전의 주소로 만든 변형)와 이 PC에 찍어 둔 장소.
   * 자리 글자로 주소를 만들지 않는다(사전에 있는 장소만).
   */
  const placeVariantsFor = (slot: PhotoSlot, screenId: string, shots: readonly ScreenShotView[]): { id: string; label: string }[] => {
    const out: { id: string; label: string }[] = []
    const add = (v: { id: string; label: string } | null) => {
      if (v && !out.some((x) => x.id === v.id)) out.push({ id: v.id, label: v.label })
    }
    if (screenProfile && placePages.length) {
      const names = placePages.map((e) => e.name)
      for (const text of [slot.key, captionAt(md, slot), slot.heading]) {
        for (const name of findPlaces(text, names)) {
          const entry = placePages.find((e) => e.name === name)
          add(entry ? placeScreenVariant(screenProfile, entry.url) : null)
        }
      }
    }
    for (const shot of shots) if (shot.screenId === screenId) add(placeVariantOfSlug(shot.variantId))
    return out
  }
  /** 그 자리의 화면 · 변형 — 자리 글자가 말한 화면(screenKindOf)을 앞에. */
  const screenOptionsFor = (slot: PhotoSlot): ScreenOption[] => {
    const list = screens?.list
    if (!list) return []
    const latest = latestScreenShots(list.shots)
    const all = list.screens.flatMap((s) =>
      (s.placePages ? placeVariantsFor(slot, s.id, list.shots) : s.variants).map((v): ScreenOption => {
        const key = `${s.id}:${v.id}`
        const shot = latest.get(key)
        return {
          key,
          screenId: s.id,
          variantId: v.id,
          kind: s.kind,
          label: s.label,
          variantLabel: v.label,
          saveAllowed: s.saveAllowed,
          ...(s.placePages ? { placePages: true as const } : {}),
          ...(shot ? { shot } : {}),
        }
      }),
    )
    const first = screenKindOf(slot.key, screenProfile, brand.brandName).screen?.id
    return first ? [...all.filter((o) => o.screenId === first), ...all.filter((o) => o.screenId !== first)] : all
  }

  /** 화면 한 장 찍기(서버가 메인 프로세스에 청해 숨긴 창으로 찍고 이 PC에 저장한다) — 찍은 화면을 골라 둔다. */
  const capture = async (o: ScreenOption) => {
    setCapturing(o.key)
    setError(null)
    setNote(null)
    try {
      const got = await captureScreen(tenantId, o.screenId, o.variantId)
      setScreenState((cur) =>
        cur?.key === tenantId && cur.list ? { ...cur, list: { ...cur.list, shots: [got.shot, ...cur.list.shots.filter((s) => s.id !== got.shot.id)] } } : cur,
      )
      setChoice(o.key)
      setNote(got.reused ? `오늘 찍어 둔 「${o.label} · ${o.variantLabel}」 화면을 다시 썼어요.` : `「${o.label} · ${o.variantLabel}」 화면을 찍어 이 PC에 저장했어요.`)
    } catch (e) {
      setError(`「${o.label} · ${o.variantLabel}」 화면을 찍지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCapturing(null)
    }
  }

  const confirmRights = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await savePhotoRights(tenantId, { medical })
      setSettings(next)
      onSettings?.(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirmPublic = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await savePhotoRights(tenantId, { public: true })
      setSettings(next)
      onSettings?.(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 이 글의 사진 자리(장면 · 설명 줄 · 소제목)에 나온 장소. */
  const slotPlaceNames = (dir: readonly string[]) => [
    ...new Set(slots.flatMap((slot) => [slot.key, captionAt(md, slot), slot.heading].flatMap((t) => (t ? (findPlace(t, dir) ?? []) : [])))),
  ]

  /** 이 글의 사진 자리(장면 · 설명 줄 · 소제목)에 나온 장소의 공공 사진 — 제1유형 · 출처가 있는 사진만 고를 수 있다. */
  const loadPublic = async () => {
    if (!siteRoot || !places?.length) return
    setPublicLoading(true)
    setError(null)
    try {
      const names = slotPlaceNames(places)
      const load = await loadPublicPhotos(await loadPlaceDirectory(siteRoot), names)
      const all = publicCandidatesOf(load.pages)
      const usable = all.flatMap((c): PhotoOption[] => {
        const pub = publicCandidateFields(c)
        return pub ? [{ src: c.src, alt: c.alt, pageUrl: c.pageUrl, ...(c.place ? { where: c.place } : {}), pub }] : []
      })
      setPublicFound({ options: usable, other: all.length - usable.length, places: names })
      if (load.failed.length) setError(`장소 페이지 ${load.failed.length}곳을 읽지 못했어요 — ${load.failed.map((x) => x.place).join(' · ')}`)
    } catch (e) {
      setError(`공공 사진을 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPublicLoading(false)
    }
  }

  /**
   * 이 글의 사진 자리에 나온 장소의 관광공사 사진(TourAPI) — 장소 페이지의 다른 이름 · 주소 · 좌표로 찾는다(장소 페이지는 화면 캐시).
   * 서버가 공공누리 제1유형 · 출처가 맞는 사진만 돌려준다.
   */
  const loadTour = async () => {
    if (!siteRoot || !places?.length) return
    setTourLoading(true)
    setError(null)
    try {
      const names = slotPlaceNames(places)
      const pages = names.length ? (await loadPublicPhotos(await loadPlaceDirectory(siteRoot), names)).pages : []
      const tour = names.length ? await loadTourPhotosFor(tenantId, names, pages) : { results: [], notes: [], skipped: 0 }
      const usable = tourCandidatesOf(tour.results).flatMap((c): PhotoOption[] => {
        const pub = publicCandidateFields(c)
        return pub ? [{ src: c.src, alt: c.alt, pageUrl: c.pageUrl, ...(c.place ? { where: c.place } : {}), pub, ...(c.tour ? { tour: c.tour } : {}) }] : []
      })
      const none = tour.results.filter((r) => !r.photos.length && r.note && !r.error).map((r) => r.note!)
      setTourFound({ options: usable, places: names, notes: [...tour.notes, ...none] })
    } catch (e) {
      setError(`관광공사 사진을 불러오지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTourLoading(false)
    }
  }

  /** 출처 없는 공공 사진에 출처를 붙인다 — 단서(사진 설명 · 홈페이지에서 그 사진에 붙은 설명)의 장소 페이지에서 같은 사진의 제1유형 표시를 찾는다. */
  const attachCredit = async (p: PhotoPick) => {
    if (!siteRoot) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const src = canonicalPhotoSrc(p.src) ?? p.src
      const home = found ?? (await loadSitePhotos(p.pageUrl))
      const hints = [p.alt, home.photos.find((x) => x.src === src)?.alt ?? '']
      const hit = await findPublicCredit(siteRoot, p.src, hints)
      if (!hit) {
        setError('사이트의 장소 페이지에서 이 사진의 공공누리 제1유형 표시를 찾지 못했어요 — 출처 없는 사진은 내보내지 않아요. 빼거나 다른 사진으로 바꿔 주세요.')
        return
      }
      const next = await saveDraftPhoto(tenantId, {
        actionId: stored.actionId,
        generatedAt: stored.generatedAt,
        op: 'credit',
        place: placeOf(p),
        src: p.src,
        pageUrl: hit.pageUrl,
        ...hit.fields,
      })
      onStored(next)
      setNote(`「${hit.place}」 페이지에서 출처를 찾아 붙였어요 — 사진: ${hit.fields.credit}, ${PHOTO_LICENSES[hit.fields.license].name}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const load = async (fresh: boolean) => {
    const url = pageUrl.trim()
    if (!url) return
    setLoading(true)
    setError(null)
    try {
      setFound(await loadSitePhotos(/^https?:\/\//i.test(url) ? url : `https://${url}`, fresh))
      setChoice(null)
    } catch (e) {
      setFound(null)
      setError(`홈페이지를 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const save = async (body: Parameters<typeof saveDraftPhoto>[1]) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const next = await saveDraftPhoto(tenantId, body)
      setNote(next.photoNote ?? null)
      onStored(next)
      openFor(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const placeOf = (p: PhotoPick): PhotoPlace => ({ slot: p.slot, nth: p.nth, heading: p.heading })
  const putPhoto = (slot: PhotoSlot, src: string, alt: string, page: string, replaces?: PhotoPick, pub?: PublicPhotoFields) =>
    save({
      actionId: stored.actionId,
      generatedAt: stored.generatedAt,
      op: 'pick',
      pick: { slot: slot.key, nth: slot.nth, same: slot.same, heading: slot.heading, src, alt, pageUrl: page, ...(pub ?? {}) },
      ...(replaces ? { replaces: placeOf(replaces) } : {}),
    })
  /**
   * 자사 화면 넣기 — 화면 id · 변형 id · 찍은 화면 id만 믿고 서버가 이 PC의 목록에서 앱 주소 · 찍은 주소 · 대체 텍스트를 단다(보내는 src ·
   * alt · pageUrl은 쓰지 않는다). 지도 화면은 서버가 거절한다 — 화면도 넣는 단추를 두지 않는다.
   */
  const putScreen = (
    slot: PhotoSlot,
    ref: { screenId: string; variantId: string; shotId: string; src: string; url: string; alt: string },
    replaces?: PhotoPick,
  ) =>
    save({
      actionId: stored.actionId,
      generatedAt: stored.generatedAt,
      op: 'pick',
      pick: {
        slot: slot.key,
        nth: slot.nth,
        same: slot.same,
        heading: slot.heading,
        src: ref.src,
        alt: ref.alt,
        pageUrl: ref.url,
        origin: 'screen',
        screenId: ref.screenId,
        variantId: ref.variantId,
        shotId: ref.shotId,
      },
      ...(replaces ? { replaces: placeOf(replaces) } : {}),
    })
  /** 옮기기 — 고른 사진의 출처 표시를 그대로 가져간다(출처 없는 공공 사진은 서버가 거절한다). */
  const pubOf = (p: PhotoPick) => {
    const f = publicPhotoFields(p)
    return f && typeof f === 'object' ? f : undefined
  }
  /** 찾지 못한 자리의 사진을 이 자리로 옮긴다 — 자사 화면은 화면 · 변형 · 찍은 화면 id로(서버가 목록에서 다시 찾는다). */
  const movePick = (slot: PhotoSlot, pick: PhotoPick) => {
    const shotId = pick.origin === 'screen' ? parseScreenAppSrc(pick.src)?.shotId : undefined
    if (pick.origin === 'screen' && pick.screenId && pick.variantId && shotId) {
      return putScreen(slot, { screenId: pick.screenId, variantId: pick.variantId, shotId, src: pick.src, url: pick.pageUrl, alt: pick.alt }, pick)
    }
    return putPhoto(slot, pick.src, pick.alt, pick.pageUrl, pick, pubOf(pick))
  }
  const remove = (p: PhotoPick) => save({ actionId: stored.actionId, generatedAt: stored.generatedAt, op: 'remove', place: placeOf(p) })
  const off = disabled || busy

  /** 한 자리의 「화면 고르기」 — 화면 · 변형마다 썸네일 · 찍은 날, 고르면 크게 보이고 코스 화면만 넣는다(지도는 미리보기만). */
  const screenChooser = (slot: PhotoSlot, picked: PhotoPick | undefined) => {
    if (!screens || (screens.loading && !screens.list && !screens.error)) return <p className="hint">자사 화면 불러오는 중…</p>
    if (screens.error) {
      return (
        <p className="error" role="alert">
          {screens.error}
        </p>
      )
    }
    if (!screens.list) return <p className="hint">이 환경에서는 자사 화면을 쓸 수 없어요 — 설치한 데스크톱 앱에서 찍고 고를 수 있어요.</p>
    const opts = screenOptionsFor(slot)
    if (!opts.length) return <p className="hint">이 브랜드에는 찍을 자사 화면이 없어요.</p>
    const chosen = opts.find((o) => o.key === choice)
    const today = todayKst()
    // 이 글의 다른 자리에 이미 넣은 화면 · 변형(같은 화면은 글 하나에 한 번이 자동 채우기의 기준이다).
    const usedHere = new Set((stored.photos ?? []).filter((x) => x !== picked && x.origin === 'screen').map(photoRepeatKey))
    return (
      <fieldset className="photo-choose" disabled={off || capturing !== null}>
        <legend className="sr-only">「{slot.alt}」 자리에 넣을 자사 화면</legend>
        <ul className="photo-grid">
          {opts.map((o) => {
            const day = screenShotDay(o.shot?.capturedAt)
            // 서버는 같은 날 찍은 화면을 다시 쓴다 — 오늘 찍은 화면에는 「다시 찍기」를 두지 않는다.
            const canShoot = screens.canCapture && (!o.shot || kstDate(o.shot.capturedAt) !== today)
            return (
              <li key={o.key}>
                <label className={`photo-option is-screen${choice === o.key ? ' is-chosen' : ''}`}>
                  <input
                    type="radio"
                    name={`screen-${stored.actionId}-${slot.line}`}
                    checked={choice === o.key}
                    disabled={!o.shot}
                    onChange={() => setChoice(o.key)}
                  />
                  {o.shot ? (
                    <img src={o.shot.src} alt="" loading="lazy" style={screenAspectRatio(o.shot) ? { aspectRatio: screenAspectRatio(o.shot) } : undefined} />
                  ) : (
                    <span className="photo-option-empty">아직 찍지 않음</span>
                  )}
                  <span>
                    {o.label} · {o.variantLabel}
                  </span>
                  {(day || !o.saveAllowed) && (
                    <span className="doc-meta">{[...(day ? [`${day} 캡처`] : []), ...(o.saveAllowed ? [] : ['미리보기만'])].join(' · ')}</span>
                  )}
                  {usedHere.has(`screen:${o.screenId}:${o.variantId}`) && <span className="doc-meta">다른 자리에 씀</span>}
                </label>
                {canShoot && (
                  <button type="button" className="link-btn" onClick={() => void capture(o)}>
                    {capturing === o.key ? '찍는 중…' : o.shot ? '다시 찍기' : '찍기'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {chosen?.shot && (
          <figure className="screen-preview">
            <img src={chosen.shot.src} alt={screenAlt(brand.brandName, chosen, { label: chosen.variantLabel })} />
            <figcaption className="doc-meta">{screenShotMeta(brand.brandName, chosen.shot.url, chosen.shot.capturedAt)}</figcaption>
          </figure>
        )}
        {chosen && !chosen.saveAllowed && (
          <p className="hint warn" style={{ margin: 0 }}>
            {MAP_PREVIEW_ONLY_TEXT}
          </p>
        )}
        {!screens.canCapture && (
          <p className="hint" style={{ margin: 0 }}>
            화면 찍기는 설치한 데스크톱 앱에서만 돼요 — 여기서는 이 PC에 찍어 둔 화면만 고를 수 있어요.
          </p>
        )}
        {chosen?.shot && chosen.saveAllowed && (
          <div className="brief-bar">
            <button
              type="button"
              onClick={() => {
                const shot = chosen.shot!
                // 이 자리에 이미 들어간 사진 · 화면이 있으면 바꾼다(소제목을 고쳐 자리 열쇠가 달라졌어도 옛 사진이 남지 않게).
                void putScreen(
                  slot,
                  {
                    screenId: chosen.screenId,
                    variantId: chosen.variantId,
                    shotId: shot.id,
                    src: shot.src,
                    url: shot.url,
                    alt: screenAlt(brand.brandName, chosen, { label: chosen.variantLabel }),
                  },
                  picked,
                )
              }}
            >
              이 화면 넣기
            </button>
          </div>
        )}
      </fieldset>
    )
  }

  return (
    <section className="evidence-panel photo-panel">
      <h4>
        홈페이지 사진 <span className="muted">— 사진 자리 {slots.length}곳 · 고른 사진은 복사 · 내려받기 때만 들어갑니다</span>
      </h4>

      {settings === undefined && <p className="hint">불러오는 중…</p>}

      {settings !== undefined && !allowed && (
        <div className="fact-sheet">
          {medical && (
            <p className="hint warn" style={{ margin: 0 }}>
              의료 업종이라 기본으로 꺼 두었어요 — 환자 · 시술 전후 사진은 의료광고 심의 대상입니다.
            </p>
          )}
          <label>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 이 브랜드 홈페이지 사진을 글에 써도
            됩니다 — 사진을 찍은 사람 · 업체에게 쓸 권리가 있는지 확인했어요(예약 플랫폼 · 사진작가 사진일 수 있어요).
          </label>
          {medical && (
            <label>
              <input type="checkbox" checked={agreeMedical} onChange={(e) => setAgreeMedical(e.target.checked)} /> 환자 · 시술 전후 사진을
              쓰지 않고, 의료광고 기준을 확인했어요.
            </label>
          )}
          <div className="brief-bar">
            <button type="button" disabled={off || !agree || (medical && !agreeMedical)} onClick={() => void confirmRights()}>
              {busy ? '저장 중…' : '확인'}
            </button>
          </div>
        </div>
      )}

      {allowed && (
        <>
          <div className="gap-url">
            <input
              type="text"
              inputMode="url"
              aria-label="사진을 찾을 페이지 주소"
              placeholder="사진을 찾을 페이지 주소"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
            />
            <button type="button" className="ghost" disabled={loading || !pageUrl.trim()} onClick={() => void load(Boolean(found))}>
              {loading ? '읽는 중…' : found ? '다시 읽기' : '홈페이지 사진 불러오기'}
            </button>
          </div>
          {found && (
            <p className="doc-meta" style={{ margin: 0 }}>
              {found.pageUrl}에서 사진 {found.photos.length}장
              {found.photos.length === 0 &&
                (found.skippedHttp > 0
                  ? ` — 사진 ${found.skippedHttp}장이 https가 아니라 뺐어요(블로그에서 깨집니다).`
                  : ' — 이 페이지에는 업체 사진으로 표시된 사진이 없어요. 사진이 있는 페이지 주소를 넣어 보세요.')}
            </p>
          )}
          {found && found.photos.length > 0 && (
            <p className="hint" style={{ margin: 0 }}>
              사람이 찍힌 사진은 초상권을 확인한 뒤 고르세요. 사진 아래 설명 줄이 사진과 어긋나면 「본문 편집」에서 고치세요.
              {creditSkipped > 0 && ` 출처 표시가 필요한 공공 사진 ${creditSkipped}장은 여기서 고르지 않아요 — 「공공 사진」에서 출처와 함께 고르세요.`}
            </p>
          )}
          {showPublic && !publicOk && (
            <div className="fact-sheet">
              <p className="hint" style={{ margin: 0 }}>
                공공 사진 — 자사 사이트 장소 페이지의 공공누리 제1유형 사진(예: 한국관광공사)과, 이 PC에 키가 있으면 한국관광공사 TourAPI(국문
                관광정보 · 관광사진 정보 「포토코리아」)의 공공누리 제1유형 사진을 출처와 함께 쓸 수 있어요. 브랜드마다 한 번 확인해 주세요.
              </p>
              <label>
                <input type="checkbox" checked={agreePublic} onChange={(e) => setAgreePublic(e.target.checked)} /> 공공 사진 사용 확인 — 공공누리
                제1유형 사진만 쓰고, 사진마다 바로 아래에 출처(예: 「사진: 한국관광공사, 공공누리 제1유형」 링크)를 반드시 적습니다. 제1유형은
                변경(크기 조정 등)이 금지되지 않지만, 「제공」 · 「협찬」 · 「공식」처럼 공공기관과 특별한 관계로 보이게 쓰지 않습니다. 피사체의
                명예를 훼손하는 용도나 기업 CI · BI로 쓰지 않습니다. 사진 속 인물의 초상권은 이 이용 허락에 들어 있지 않아, 사람이 알아볼 수 있게
                나온 사진은 쓰지 않거나 따로 확인합니다.
              </label>
              <div className="brief-bar">
                <button type="button" disabled={off || !agreePublic} onClick={() => void confirmPublic()}>
                  {busy ? '저장 중…' : '공공 사진 사용 확인'}
                </button>
              </div>
            </div>
          )}
          {publicOk && (places?.length ?? 0) > 0 && slots.length > 0 && (
            <div className="brief-bar" style={{ margin: 0 }}>
              <button type="button" className="ghost" disabled={publicLoading || off} onClick={() => void loadPublic()}>
                {publicLoading ? '장소 페이지 읽는 중…' : publicFound ? '공공 사진 다시 불러오기' : '공공 사진 불러오기'}
              </button>
              {publicFound && (
                <span className="doc-meta">
                  {publicFound.places.length === 0
                    ? '이 글의 사진 자리에 사이트의 장소 이름이 나오지 않아요.'
                    : `${publicFound.places.join(' · ')} — 공공 사진 ${publicFound.options.length}장${publicFound.other ? ` (제1유형이 아니거나 출처가 없어 뺀 사진 ${publicFound.other}장)` : ''}`}
                </span>
              )}
              {tourOn && (
                <button type="button" className="ghost" disabled={tourLoading || off} onClick={() => void loadTour()}>
                  {tourLoading ? '관광공사 사진 찾는 중…' : tourFound ? '관광공사 사진 다시 불러오기' : '관광공사 사진 불러오기'}
                </button>
              )}
              {tourOn && tourFound && (
                <span className="doc-meta">
                  {tourFound.places.length === 0
                    ? '이 글의 사진 자리에 사이트의 장소 이름이 나오지 않아요.'
                    : `관광공사 사진(공공누리 제1유형) ${tourFound.options.length}장`}
                  {tourFound.notes.length > 0 && ` — ${tourFound.notes.join(' ')}`}
                </span>
              )}
            </div>
          )}
          {slots.length > 0 && (
            <PhotoAutoFill
              tenantId={tenantId}
              brand={brand}
              articles={[{ stored, title: '' }]}
              drafts={photoContext?.drafts ?? { [stored.actionId]: stored }}
              groupOf={photoContext?.groupOf}
              label="자동 채우기"
              locked={off}
              onStored={onStored}
              source={found}
              single
            />
          )}
        </>
      )}

      {slots.map((slot) => {
        const picked = pickAt(slot)
        const id = slotId(slot)
        const open = openSlot === id
        const isScreen = picked?.origin === 'screen'
        const canScreen = screenable(slot, picked)
        return (
          <div key={slot.line} className="photo-slot">
            <p className="doc-meta" style={{ margin: 0 }}>
              {slot.heading && <b>{slot.heading}</b>}
              {slot.heading && ' · '}사진 자리: {slot.alt}
            </p>
            {picked ? (
              <div className={`photo-picked${isScreen ? ' is-screen' : ''}`}>
                <img src={picked.src} alt={picked.alt || slot.alt} referrerPolicy="no-referrer" loading="lazy" />
                <span>
                  {picked.auto && <span className="status-pill st-info no-glyph">자동</span>}
                  {isScreen && <span className="status-pill st-info no-glyph">자사 화면</span>}
                  {photoCreditState(picked) === 'public' && (
                    <span className="status-pill st-info no-glyph">{isTourSourcePage(picked.pageUrl) ? '관광공사 사진' : '공공 사진'}</span>
                  )}
                  {photoCreditState(picked) === 'missing' && <span className="status-pill st-warn">출처 없음</span>}
                  {/* 사람 장면 규칙은 자사 화면에 쓰지 않는다(화면이다). */}
                  {picked.auto && !isScreen && (isPeopleScene(slot.key, findPlaces(slot.key, places ?? [])) || photoCreditState(picked) === 'public') && (
                    <span className="status-pill st-warn">확인 필요</span>
                  )}
                  {(picked.auto || isScreen || photoCreditState(picked) !== 'site') && ' '}
                  {picked.alt || <span className="muted">(설명은 사진 자리 글자로)</span>}
                  {photoCreditState(picked) === 'public' && picked.license && (
                    <span className="doc-meta">
                      {' '}
                      · 사진: {picked.credit}, {PHOTO_LICENSES[picked.license].name}
                    </span>
                  )}
                  <br />
                  {photoCreditState(picked) === 'missing' && (
                    <span className="hint warn">
                      출처 표시가 필요한 공공 사진인데 출처가 없어 내보내지 않아요.{' '}
                      {publicOk ? (
                        <button type="button" className="link-btn" disabled={off} onClick={() => void attachCredit(picked)}>
                          출처 붙이기
                        </button>
                      ) : (
                        '공공 사진 사용 확인 뒤 「출처 붙이기」를 할 수 있어요.'
                      )}
                      <br />
                    </span>
                  )}
                  <span className="doc-meta">
                    {isScreen ? screenShotMeta(brand.brandName, picked.pageUrl, picked.capturedAt) : picked.pageUrl} ·{' '}
                    <button type="button" className="link-btn" disabled={off} onClick={() => void remove(picked)}>
                      빼기
                    </button>
                    {allowed && options.length > 0 && (
                      <>
                        {' · '}
                        <button type="button" className="link-btn" disabled={off} onClick={() => openFor(open && openMode === 'photo' ? null : id)}>
                          바꾸기
                        </button>
                      </>
                    )}
                    {canScreen && (
                      <>
                        {' · '}
                        <button type="button" className="link-btn" disabled={off} onClick={() => openFor(open && openMode === 'screen' ? null : id, 'screen')}>
                          {isScreen ? '화면 바꾸기' : '화면 고르기'}
                        </button>
                      </>
                    )}
                  </span>
                </span>
              </div>
            ) : (
              allowed &&
              (options.length > 0 || canScreen) && (
                <div className="brief-bar" style={{ margin: 0 }}>
                  {options.length > 0 && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={off}
                      aria-expanded={open && openMode === 'photo'}
                      onClick={() => openFor(open && openMode === 'photo' ? null : id)}
                    >
                      {open && openMode === 'photo' ? '닫기' : '사진 고르기'}
                    </button>
                  )}
                  {canScreen && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={off}
                      aria-expanded={open && openMode === 'screen'}
                      title="이 PC에 찍어 둔 자사 웹사이트 화면을 고릅니다 — 데스크톱 앱에서는 여기서 찍을 수도 있어요."
                      onClick={() => openFor(open && openMode === 'screen' ? null : id, 'screen')}
                    >
                      {open && openMode === 'screen' ? '닫기' : '화면 고르기'}
                    </button>
                  )}
                </div>
              )
            )}
            {open && openMode === 'screen' && screenChooser(slot, picked)}
            {open && openMode === 'photo' && options.length > 0 && (
              <fieldset className="photo-choose" disabled={off}>
                <legend className="sr-only">「{slot.alt}」 자리에 넣을 사진</legend>
                <ul className="photo-grid">
                  {options.map((p) => (
                    <li key={p.src}>
                      <label className={`photo-option${choice === p.src ? ' is-chosen' : ''}`}>
                        <input type="radio" name={`photo-${stored.actionId}-${slot.line}`} checked={choice === p.src} onChange={() => setChoice(p.src)} />
                        <img src={p.src} alt="" referrerPolicy="no-referrer" loading="lazy" />
                        <span>
                          {p.pub && (
                            <span className="status-pill st-info no-glyph" title={p.tour ? TOUR_SOURCES[p.tour].name : undefined}>
                              {p.tour ? '관광공사 사진' : '공공 사진'}
                            </span>
                          )}{' '}
                          {p.alt || <span className="muted">설명 없음</span>}
                        </span>
                        {p.where && <span className="doc-meta">{p.where}</span>}
                        <SceneLine scene={sceneOf[canonicalPhotoSrc(p.src) ?? p.src]} />
                        {p.pub && (
                          <span className="doc-meta">
                            사진: {p.pub.credit}, {PHOTO_LICENSES[p.pub.license].name}
                          </span>
                        )}
                        {(stored.photos ?? []).some((x) => x.src === p.src && x !== picked) && (
                          <span className="doc-meta">다른 자리에 씀</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="brief-bar">
                  <button
                    type="button"
                    disabled={!options.some((x) => x.src === choice)}
                    onClick={() => {
                      const p = options.find((x) => x.src === choice)
                      // 이 자리에 이미 들어간 사진이 있으면 그 사진을 바꾼다 — 소제목을 고쳐 자리 열쇠가 달라졌어도 옛 사진이 남지 않게.
                      if (p) void putPhoto(slot, p.src, p.alt, p.pageUrl, picked, p.pub)
                    }}
                  >
                    이 사진 넣기
                  </button>
                </div>
              </fieldset>
            )}
          </div>
        )
      })}

      {match.suggested.map(({ pick, slot }) => {
        // 출처 없는 공공 사진은 그대로 옮길 수 없다(서버가 거절한다) — 출처를 먼저 붙이면 출처와 함께 옮긴다.
        const missing = photoCreditState(pick) === 'missing'
        return (
          <p key={`s-${pick.slot}-${pick.nth}-${pick.heading}`} className="hint warn">
            「{pick.heading}」의 사진 자리({pick.slot})를 찾지 못했어요 — 「{slot.heading || slot.alt}」의 「{slot.alt}」 자리로 옮길까요?{' '}
            {missing ? (
              <>
                <span className="status-pill st-warn">출처 없음</span> 출처 표시가 필요한 공공 사진인데 출처가 없어, 출처를 붙인 뒤에 옮길 수
                있어요.{' '}
                {publicOk ? (
                  <button type="button" className="link-btn" disabled={off} onClick={() => void attachCredit(pick)}>
                    출처 붙이기
                  </button>
                ) : (
                  '공공 사진 사용 확인 뒤 「출처 붙이기」를 할 수 있어요.'
                )}
              </>
            ) : (
              <button type="button" className="link-btn" disabled={off} onClick={() => void movePick(slot, pick)}>
                이 자리로 옮기기
              </button>
            )}{' '}
            ·{' '}
            <button type="button" className="link-btn" disabled={off} onClick={() => void remove(pick)}>
              빼기
            </button>
          </p>
        )
      })}
      {match.unmatched.map((pick) => (
        <p key={`u-${pick.slot}-${pick.nth}-${pick.heading}`} className="hint warn">
          「{pick.slot}」 자리를 찾지 못해 넣지 않는 사진이 있어요(글을 고치며 자리가 바뀌었어요).{' '}
          <button type="button" className="link-btn" disabled={off} onClick={() => void remove(pick)}>
            빼기
          </button>
        </p>
      ))}
      {medical && rights && !rights.medical && (stored.photos ?? []).length > 0 && (
        <p className="hint warn">의료 업종인데 의료광고 확인 없이 고른 사진이 있어요. 사진을 확인하거나 빼 주세요.</p>
      )}
      {note && <p className="hint">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** 고를 사진 아래의 장면 줄 — 읽어 둔 장면이 있을 때만. */
function SceneLine({ scene }: { scene: PhotoScene | undefined }) {
  return scene ? (
    <span className="doc-meta">
      장면: {scene.text} ({sceneMeta(scene)})
    </span>
  ) : null
}
