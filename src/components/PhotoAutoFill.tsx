import { useMemo, useState } from 'react'
import { loadPublishSettings, saveDraftPhotosAuto, type AutoPhotoSaveResult, type StoredDraft, type TenantSummary } from '../lib/api'
import { canonicalPhotoSrc, PHOTO_LICENSES, photoCreditState, photosAllowed, publicPhotosAllowed } from '../lib/articlePhotos'
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
  type AutoArticle,
  type AutoCandidate,
  type AutoPickResult,
  type AutoSlotRow,
  type AutoSlotState,
} from '../lib/photoAutoPick'
import {
  loadPlaceDirectory,
  loadPublicPhotos,
  loadSitePhotos,
  photoPageOf,
  publicCandidatesOf,
  siteRootOf,
  type SitePhotoResult,
} from '../lib/sitePhotos'

/**
 * 사진 자리 자동 채우기 — 단추를 누르면 홈페이지 사진 후보로 빈 사진 자리를 맞추고(1단계), 그래도 빈 자리는 자리 글자에 나온 장소의
 * 공공 사진(자사 사이트 장소 페이지의 공공누리 제1유형 사진 — 2단계, 공공 사진 사용 확인 뒤에만)으로 맞춰(src/lib/photoAutoPick.ts)
 * 미리보기 표를 먼저 보이고, 운영자가 「저장」을 눌러야 저장한다(PUT …/photos op auto). 자리마다 따로 확인받지 않는다 — 대신 저장된
 * 사진에 「자동」 표시가 붙고 글의 「홈페이지 사진」 칸에서 바꾸거나 뺄 수 있다. 이미 고른 출처 없는 공공 사진은 같은 사진이 장소 페이지에
 * 제1유형으로 있으면 같은 저장에서 출처를 붙인다. AI를 부르지 않는다. 장소 페이지는 빈 자리에 나온 장소만 읽는다(PUBLIC_PAGE_LIMIT곳까지).
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
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<{ result: AutoPickResult; pageUrl: string; key: string; publicNote: string | null } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleOf = new Map(articles.map((a) => [a.stored.actionId, a.title]))
  const previewIds = useMemo(() => new Set(preview?.result.articles.map((a) => a.actionId) ?? []), [preview])
  const stale = useMemo(() => preview !== null && photoStateKey(drafts, previewIds) !== preview.key, [preview, drafts, previewIds])

  const run = async () => {
    setLoading(true)
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
      const pub = await publicFor(autoArticles, found, publicPhotosAllowed(settings, brand.industry))
      const result = autoPickPhotos({
        articles: autoArticles,
        candidates: found.photos.map((p) => ({ src: p.src, alt: p.alt, pageUrl, ...(p.credit ? { credit: true } : {}) })),
        publicCandidates: pub.candidates,
        places: pub.places,
        others: otherPhotoUses(drafts, ids, groupOf),
        brandName: brand.brandName,
      })
      const placeRows = result.articles.flatMap((a) => a.rows).filter((r) => r.place && r.state !== 'filled').length
      const publicNote =
        pub.note ?? (pub.off && placeRows > 0 ? `장소가 나온 빈 자리 ${placeRows}곳은 글의 「홈페이지 사진」 칸에서 공공 사진 사용 확인을 한 뒤 다시 누르면 공공 사진으로 채울 수 있어요.` : null)
      setPreview({ result, pageUrl, key: photoStateKey(drafts, ids), publicNote })
      setShowAll(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  /**
   * 공공 사진 후보 — 사이트의 장소 사전(sitemap)을 읽고, 공공 사진 사용 확인이 있으면 빈 자리에 나온 장소와 출처 없는 공공 사진의 단서
   * (사진 설명 · 홈페이지에서 그 사진에 붙은 설명)에 나온 장소의 페이지만 읽는다. 사전을 읽지 못해도 홈페이지 사진 맞추기는 그대로 한다.
   */
  const publicFor = async (
    list: readonly AutoArticle[],
    site: SitePhotoResult,
    allowed: boolean,
  ): Promise<{ candidates: AutoCandidate[]; places: string[]; off: boolean; note: string | null }> => {
    const root = siteRootOf(site.pageUrl)
    if (!root) return { candidates: [], places: [], off: !allowed, note: null }
    let places: string[]
    try {
      places = (await loadPlaceDirectory(root)).map((e) => e.name)
    } catch (e) {
      return { candidates: [], places: [], off: !allowed, note: `장소 목록(sitemap.xml)을 읽지 못해 공공 사진은 건너뛰었어요 — ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!places.length || !allowed) return { candidates: [], places, off: !allowed, note: null }
    const siteAlt = new Map(site.photos.map((p) => [p.src, p.alt]))
    const hinted = list.flatMap((a) =>
      (a.picks ?? []).flatMap((p) =>
        photoCreditState(p) === 'missing' ? [p.alt, siteAlt.get(canonicalPhotoSrc(p.src) ?? p.src) ?? ''].flatMap((h) => findPlace(h, places) ?? []) : [],
      ),
    )
    const wanted = [...new Set([...placesToRead(list, places), ...hinted])]
    const directory = await loadPlaceDirectory(root)
    const load = await loadPublicPhotos(directory, wanted)
    const notes = [
      ...(load.failed.length ? [`장소 페이지 ${load.failed.length}곳을 읽지 못했어요(${load.failed.map((x) => x.place).join(' · ')}).`] : []),
      ...(load.capped ? [`장소 페이지는 한 번에 ${load.pages.length + load.failed.length}곳까지 읽어요 — ${load.capped}곳은 다음에 다시 눌러 주세요.`] : []),
    ]
    return { candidates: publicCandidatesOf(load.pages), places, off: false, note: notes.length ? notes.join(' ') : null }
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
        })),
      )
      apply(out)
      const parts = [`사진 ${out.saved}장을 넣었어요(글 ${out.drafts.length}편).`]
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
  const filledPublic = rows.filter((r) => r.row.state === 'filled' && r.row.pick?.origin === 'public').length
  const credits = preview ? preview.result.articles.reduce((n, a) => n + a.credits.length, 0) : 0
  const review = rows.filter((r) => r.row.review).length
  const shown = showAll ? rows : rows.filter((r) => r.row.state === 'filled')
  const skippedByReason = preview
    ? Object.entries(
        preview.result.skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}),
      ).map(([reason, n]) => `${AUTO_CANDIDATE_SKIP_TEXT[reason as keyof typeof AUTO_CANDIDATE_SKIP_TEXT]} ${n}`)
    : []
  const others = (['kept', 'cleared', 'screen', 'nomatch', 'used', 'full', 'license'] as const)
    .map((s) => [s, count(s)] as const)
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
          title="홈페이지 사진 설명과 사진 자리 글자를 맞춰 빈 자리에 넣을 사진을 고릅니다. 저장 전에 미리보기 표를 보여 줍니다(AI 호출 없음)."
        >
          {loading ? '사진 맞추는 중…' : label}
        </button>
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
            {skippedByReason.length > 0 && ` — 뺀 사진: ${skippedByReason.join(' · ')}`}
          </p>
          <p className="doc-meta" style={{ margin: 0 }}>
            사진 자리 {rows.length}곳 · 채울 자리 <b>{filled}</b>
            {filledPublic > 0 && ` (공공 사진 ${filledPublic})`}
            {review > 0 && ` (확인 필요 ${review})`}
            {others.length > 0 && ` · ${others.join(' · ')}`}
            {credits > 0 && ` · 출처를 붙일 공공 사진 ${credits}장`}
          </p>
          {preview.publicNote && (
            <p className="hint warn" style={{ margin: 0 }}>
              {preview.publicNote}
            </p>
          )}
          <p className="hint" style={{ margin: 0 }}>
            틀린 사진보다 빈자리가 낫다는 기준으로, 설명이 충분히 맞는 사진만 고릅니다. 공공 사진은 자리 글자에 나온 장소의 사진이라 장면까지
            맞는지는 보지 않아요 — 썸네일을 확인해 주세요. 공공 사진은 내보낼 때 사진 아래에 출처(공공누리 제1유형 링크)가 붙습니다. 사람이
            나오는 장면 자리는 「확인 필요」 — 저장한 뒤 글의 「홈페이지 사진」 칸에서 바꾸거나 빼 주세요. 사람이 고르거나 뺀 자리는 덮지 않습니다.
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
            <button type="button" disabled={(filled === 0 && credits === 0) || saving || locked || stale} onClick={() => void save()}>
              {saving ? '저장 중…' : `저장 — ${filled}자리${credits ? ` · 출처 ${credits}장` : ''}`}
            </button>
            <button type="button" className="ghost" disabled={saving} onClick={() => setPreview(null)}>
              닫기
            </button>
            {rows.length > filled && (
              <button type="button" className="ghost" onClick={() => setShowAll((v) => !v)}>
                {showAll ? '채울 자리만 보기' : `건너뛴 자리도 보기(${rows.length - filled})`}
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

function PreviewRow({ title, row }: { title: string | null; row: AutoSlotRow }) {
  const c = row.candidate
  const credit = c ? publicCandidateFields(c) : null
  return (
    <tr>
      {title !== null && <td className="cell-text">{title}</td>}
      <td className="cell-text">
        {row.slot.alt}
        {row.caption && <span className="doc-meta"> · {row.caption}</span>}
      </td>
      <td className="cell-text">
        {c ? (
          <span className="photo-auto-pick">
            <img src={c.src} alt="" referrerPolicy="no-referrer" loading="lazy" />
            <span>
              {c.origin === 'public' && <span className="status-pill st-info no-glyph">공공 사진</span>} {c.alt}
              {credit && (
                <span className="doc-meta">
                  {' '}
                  · 사진: {credit.credit}, {PHOTO_LICENSES[credit.license].name}
                </span>
              )}
            </span>
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="cell-text">
        {c?.origin === 'public' && row.place ? (
          `장소: ${row.place}`
        ) : row.score ? (
          `${row.score.words.join(' · ')} · ${row.score.score}`
        ) : row.place ? (
          <span className="muted">장소: {row.place}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="cell-text">
        <span className={`status-pill ${row.state === 'filled' ? (row.review ? 'st-warn' : 'st-good') : 'st-ok'}`}>
          {row.state === 'filled' && row.review ? '확인 필요' : AUTO_SLOT_STATE_TEXT[row.state]}
        </span>
      </td>
    </tr>
  )
}
