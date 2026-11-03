import { useState } from 'react'
import { loadPublishSettings, saveDraftPhotosAuto, type AutoPhotoSaveResult, type StoredDraft, type TenantSummary } from '../lib/api'
import { photosAllowed } from '../lib/articlePhotos'
import { publishMarkdownOf } from '../lib/draftGaps'
import {
  AUTO_CANDIDATE_SKIP_TEXT,
  AUTO_SLOT_STATE_TEXT,
  autoPickPhotos,
  otherPhotoUses,
  type AutoPickResult,
  type AutoSlotRow,
  type AutoSlotState,
} from '../lib/photoAutoPick'
import { loadSitePhotos, photoPageOf, type SitePhotoResult } from '../lib/sitePhotos'

/**
 * 사진 자리 자동 채우기(1단계 — 홈페이지 사진) — 단추를 누르면 홈페이지 사진 후보로 빈 사진 자리를 맞춰(src/lib/photoAutoPick.ts)
 * 미리보기 표를 먼저 보이고, 운영자가 「저장」을 눌러야 저장한다(PUT …/photos op auto). 자리마다 따로 확인받지 않는다 — 대신 저장된
 * 사진에 「자동」 표시가 붙고 글의 「홈페이지 사진」 칸에서 바꾸거나 뺄 수 있다. AI를 부르지 않는다.
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
  const [preview, setPreview] = useState<{ result: AutoPickResult; pageUrl: string } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const titleOf = new Map(articles.map((a) => [a.stored.actionId, a.title]))

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
      const result = autoPickPhotos({
        articles: articles.map(({ stored }) => {
          const group = groupOf?.(stored.actionId)
          return {
            actionId: stored.actionId,
            generatedAt: stored.generatedAt,
            markdown: publishMarkdownOf(stored),
            picks: stored.photos,
            cleared: stored.photoCleared,
            ...(group ? { group } : {}),
          }
        }),
        candidates: found.photos.map((p) => ({ src: p.src, alt: p.alt, pageUrl, ...(p.credit ? { credit: true } : {}) })),
        others: otherPhotoUses(drafts, ids, groupOf),
        brandName: brand.brandName,
      })
      setPreview({ result, pageUrl })
      setShowAll(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    if (!preview) return
    setSaving(true)
    onBusyChange?.(true)
    setError(null)
    const apply = (out: AutoPhotoSaveResult) => {
      for (const d of out.drafts) onStored(d)
    }
    try {
      const out = await saveDraftPhotosAuto(
        tenantId,
        preview.result.articles.map((a) => ({ actionId: a.actionId, generatedAt: a.generatedAt, picks: a.picks })),
      )
      apply(out)
      const parts = [`사진 ${out.saved}장을 넣었어요(글 ${out.drafts.length}편).`]
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
  const review = rows.filter((r) => r.row.review).length
  const shown = showAll ? rows : rows.filter((r) => r.row.state === 'filled')
  const skippedByReason = preview
    ? Object.entries(
        preview.result.skipped.reduce<Record<string, number>>((m, s) => ({ ...m, [s.reason]: (m[s.reason] ?? 0) + 1 }), {}),
      ).map(([reason, n]) => `${AUTO_CANDIDATE_SKIP_TEXT[reason as keyof typeof AUTO_CANDIDATE_SKIP_TEXT]} ${n}`)
    : []
  const others = (['kept', 'cleared', 'screen', 'nomatch', 'used', 'full'] as const)
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
            {preview.pageUrl}의 사진 {preview.result.usable + preview.result.skipped.length}장 중 자동으로 쓸 수 있는 사진 {preview.result.usable}장
            {skippedByReason.length > 0 && ` — 뺀 사진: ${skippedByReason.join(' · ')}`}
          </p>
          <p className="doc-meta" style={{ margin: 0 }}>
            사진 자리 {rows.length}곳 · 채울 자리 <b>{filled}</b>
            {review > 0 && ` (확인 필요 ${review})`}
            {others.length > 0 && ` · ${others.join(' · ')}`}
          </p>
          <p className="hint" style={{ margin: 0 }}>
            틀린 사진보다 빈자리가 낫다는 기준으로, 설명이 충분히 맞는 사진만 고릅니다. 사람이 나오는 장면 자리는 「확인 필요」 — 저장한 뒤 글의
            「홈페이지 사진」 칸에서 바꾸거나 빼 주세요. 사람이 고르거나 뺀 자리는 덮지 않습니다.
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
            <button type="button" disabled={filled === 0 || saving || locked} onClick={() => void save()}>
              {saving ? '저장 중…' : `저장 — ${filled}자리`}
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
        </div>
      )}
    </div>
  )
}

function PreviewRow({ title, row }: { title: string | null; row: AutoSlotRow }) {
  const c = row.candidate
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
            <span>{c.alt}</span>
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="cell-text">{row.score ? `${row.score.words.join(' · ')} · ${row.score.score}` : <span className="muted">—</span>}</td>
      <td className="cell-text">
        <span className={`status-pill ${row.state === 'filled' ? (row.review ? 'st-warn' : 'st-good') : 'st-ok'}`}>
          {row.state === 'filled' && row.review ? '확인 필요' : AUTO_SLOT_STATE_TEXT[row.state]}
        </span>
      </td>
    </tr>
  )
}
