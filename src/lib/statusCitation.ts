import type { ExternalHistory, PostHistory, PublishedHistory } from './api'
import { kstDate } from './publishedUrl'
import type { PublishStatusRow } from './publishStatus'
import { INDEXING_GRACE_DAYS, summarizePost, type PostSummary, type PostTier } from './publishTracking'
import { externalMovedOf } from './useExternalHistory'

/**
 * 발행 현황 「AI 인용」 칸 — 올린 글이 측정한 AI 답변에 출처로 인용됐는지(2026-11-11 사용자 「인용 칸 더하기」). 「구글 색인」(검색엔진이 글을
 * 아는가)과 다른 것이다: 색인은 사람 · 자동 확인으로 적고, 인용은 측정마다 셈한다.
 *
 * 판단은 퍼포먼스 「올린 글 인용 추적」 · 「앱 밖 글 인용 추적」과 같은 계산이다 — 그 브랜드의 인용 이력(server/publishedHistory.ts ·
 * server/externalPosts.ts)을 받아 글마다 summarizePost(src/lib/publishTracking.ts)로 본다. 두 화면이 같은 글을 다르게 말하지 않게, 단계 이름만
 * 이 표에 맞게 고친다: 올린 지 14일 안 측정만 있는 「색인 대기」는 옆 「구글 색인」 칸과 헷갈리지 않게 「판단 전」이라 부른다.
 *
 * 이력을 읽는 중이면 「읽는 중」, 못 읽었거나 이 환경에 없으면(웹) 「확인 불가」다 — 0이나 「인용 없음」으로 채우지 않는다(memory
 * aeo-unmeasured-metric-policy). 앱 밖 글을 같은 브랜드에서 앱 글로 옮겼으면 그 뒤 측정은 앱 글 줄이 센다(두 표가 같은 측정을 두 번 세지 않는다 — D12).
 */

/** 한 브랜드의 이력 — 읽는 중 · 못 읽은 까닭 · 이 환경에 없음(null) · 읽은 이력. */
export type HistoryLoad<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; value: T | null }

export interface TenantCitationSource {
  app: HistoryLoad<PublishedHistory>
  external: HistoryLoad<ExternalHistory>
}

export type CitationKind = 'na' | 'loading' | 'unknown' | 'moved' | PostTier

export interface CitationCell {
  kind: CitationKind
  /** 칸 글자. */
  label: string
  /** 칸 아래 작은 글자. */
  sub: string[]
  /** 칩 색 — good 여러 주 · info 한 주 · 나머지는 칩 없이 글자만. */
  tone: 'good' | 'info' | null
  /** CSV 한 칸. */
  csv: string
  summary: PostSummary | null
}

export const CITATION_LABEL: Record<PostTier, string> = {
  repeated: '여러 주 인용',
  once: '한 주 인용 · 판단 보류',
  none: '인용 없음',
  indexing: '판단 전',
  waiting: '올린 뒤 측정 없음',
  undated: '올린 날 모름',
  removed: '내림',
}

const TIER_SUB: Partial<Record<PostTier, string>> = {
  once: '측정은 한 번씩 흔들려 2주 이상 인용돼야 판단해요',
  indexing: `올린 지 ${INDEXING_GRACE_DAYS}일 안 측정만 있어요`,
  waiting: '다음 측정부터 셉니다',
  undated: '발행일을 적으면 판단해요',
  removed: '올린 뒤 판단할 측정 없이 내렸어요',
}

const cellOf = (kind: CitationKind, label: string, sub: string[] = [], csv = label): CitationCell => ({ kind, label, sub, tone: null, csv, summary: null })

/** 줄의 인용 이력 — 대표 줄 id로 찾는다(앱 밖 글은 x- id). */
function historyOf(posts: readonly PostHistory[], row: PublishStatusRow): PostHistory | null {
  return posts.find((p) => p.post.id === row.postId) ?? null
}

/** 발행 현황 한 줄의 「AI 인용」 칸. source는 그 줄 브랜드의 이력(아직 읽기 시작 전이면 undefined — 읽는 중). */
export function citationCellOf(row: PublishStatusRow, source: TenantCitationSource | undefined): CitationCell {
  if (row.kind !== 'posted' || !row.postId) return cellOf('na', '-', [], '')
  // 「잘못 적은 주소」로 뺀 줄은 인용 이력에서도 빠진다(server/publishedHistory.ts shownPosts) — 셀 글이 아니다.
  if (row.removed?.reason === 'mistake') return cellOf('na', '-', ['잘못 적은 주소로 뺀 줄'], '')
  const load = row.origin === 'external' ? source?.external : source?.app
  if (!load || load.state === 'loading') return cellOf('loading', '읽는 중', [], '')
  if (load.state === 'error') return cellOf('unknown', '확인 불가', [`인용 이력을 읽지 못했어요 — ${load.error}`])
  if (load.value === null) return cellOf('unknown', '확인 불가', ['이 환경에는 인용 이력이 없어요(데스크톱 앱에서만)'])
  const history: PublishedHistory = load.value
  const ph = historyOf(history.posts, row)
  if (!ph) return cellOf('unknown', '확인 불가', ['인용 이력에서 이 글을 찾지 못했어요'])
  const removedOn = ph.post.removedAt ? kstDate(ph.post.removedAt) : null
  const summary = summarizePost(ph.cells, history.weeks, removedOn)
  const moved = row.origin === 'external' ? externalMovedOf(load.value as ExternalHistory)(ph.post) : null
  if (moved && summary.tier === 'removed') {
    return { ...cellOf('moved', '앱 글 줄에서 셈', ['앱 글로 옮겨 그 뒤 측정은 앱 글 줄이 셉니다']), summary }
  }
  const sub: string[] = []
  if (summary.measuredAfter > 0) {
    sub.push(
      `올린 뒤 측정 ${summary.measuredAfter}주 중 ${summary.citedWeeks}주 인용` +
        (summary.measuredRuns !== summary.measuredAfter ? ` (회차 ${summary.citedRuns}/${summary.measuredRuns})` : ''),
    )
  }
  const tierSub = TIER_SUB[summary.tier]
  if (tierSub) sub.push(tierSub)
  if (summary.lapsed) sub.push('최근 측정에는 인용 없음')
  if (summary.conditionMixed) sub.push('그사이 측정 조건이 바뀌었거나 확인할 수 없음')
  if (summary.citedBeforePublish) sub.push('올리기 전 측정에서 이미 인용됨 — 발행일을 확인하세요')
  if (moved) sub.push('앱 글로 옮겨 그 뒤 측정은 앱 글 줄이 셉니다')
  const label = CITATION_LABEL[summary.tier]
  return {
    kind: summary.tier,
    label,
    sub,
    tone: summary.tier === 'repeated' ? 'good' : summary.tier === 'once' ? 'info' : null,
    csv: summary.measuredAfter > 0 ? `${label} (${summary.citedWeeks}/${summary.measuredAfter}주)` : label,
    summary,
  }
}

/** 인용 이력을 읽어야 하는 브랜드 — 올린 줄이 있는 브랜드마다 앱 글 · 앱 밖 글 가운데 줄이 있는 쪽만. */
export function citationTargets(rows: readonly PublishStatusRow[]): { tenantId: string; app: boolean; external: boolean }[] {
  const by = new Map<string, { tenantId: string; app: boolean; external: boolean }>()
  for (const r of rows) {
    if (r.kind !== 'posted' || !r.postId) continue
    const t = by.get(r.tenantId) ?? { tenantId: r.tenantId, app: false, external: false }
    if (r.origin === 'external') t.external = true
    else t.app = true
    by.set(r.tenantId, t)
  }
  return [...by.values()]
}
