import { AEO_SCORE_WEIGHTS, normalizeRank, rankWeightFactor, RANK_FULL_WEIGHT_RESPONSES, type WeeklyScorecard } from '../prompts/b8-report'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { ActionStateMap, PublishedPost, SiteScoreRecord } from './api'
import { ENGINE_LABEL, weekLabel } from './format'
import { computeGapActions, type GapAction } from './gapActions'
import { monthDay, postWeekOf } from './publishTracking'
import { isoWeekOf, kstDate } from './publishedUrl'
import { computeQuestionWinLoss } from './questionWinLoss'
import type { QuestionRepeatAnalysis, QuestionSpec } from './types'

/**
 * 개선제안의 「이번 주 데이터로 본 실행 항목」 — 일반론이 아니라 이 브랜드의 실제 질문·출처·감점을 짚는다.
 *
 * 전에는 개선제안이 모든 브랜드에 같은 문장("업종·지역·니즈 기반 FAQ 콘텐츠를 확충합니다")을 냈다.
 * 무엇부터 할지는 결국 사람이 화면 여러 곳을 돌며 찾아야 했다. 여기서는 측정 기록에서 바로 꺼낸다 —
 * 밀린 질문과 그때 대신 불린 곳, AI가 인용했지만 우리를 뒷받침하지 않은 출처, 사이트 진단의 감점 영역.
 * 수치는 저장된 측정값 그대로이고 문장은 코드 템플릿이다. 계산 예시는 같은 점수 산식으로 낸 값이며
 * 약속이 아님을 문장에 밝힌다.
 */

export interface EvidenceItem {
  text: string
  detail?: string
  /** 질문에서 나온 항목이면 그 질문 — 화면이 AI 답변(/answers?q=)으로 잇는다. */
  questionId?: string
}

export interface EvidenceBlock {
  heading: string
  items: EvidenceItem[]
  /** 보여 주지 않은 나머지 개수. */
  more?: number
}

export interface RecommendationEvidence {
  blocks: EvidenceBlock[]
  /** 같은 점수 산식으로 낸 계산 예시(약속 아님). */
  estimate?: string
  link?: { label: string; to: string }
}

export interface EvidenceInput {
  card: WeeklyScorecard
  analyses: QuestionRepeatAnalysis[]
  questions: QuestionSpec[]
  citations: CitationSourceAnalysis | null
  site: SiteScoreRecord | null
  /**
   * 집행 상태 · 올린 글 기록(데스크톱 — 웹은 없다). 주면 이미 집행한 등재 항목을 다시 권하지 않고 「집행함 · 인용 대기」로 따로
   * 적는다(언급률 2번 P4). 그 주차 뒤의 집행은 보지 않는다 — 지난 주차 보고서가 그 뒤 일을 집행했다고 말하지 않게. 없으면 전과 같다.
   */
  states?: ActionStateMap
  posts?: PublishedPost[]
  /**
   * 보고 주 칸(그 주 회차를 합친 올린 글 이력, server/publishedHistory.ts)에서 올린 뒤 인용된 기록 id. 주면 마지막 저장 측정에는 없고
   * 같은 주 다른 회차에서만 인용된 글도 「인용됨」으로 적되 그 기준을 밝힌다 — 집행 표와 말이 어긋나지 않게. 없으면 전과 같다.
   */
  citedPostIds?: ReadonlySet<string>
}

const SHOW = 5

/**
 * 집행 상태 — 집행함으로 표시했거나 올린 주소를 적은(내린 글 포함) 항목만. 이번 주 결과(publishedHits)와 보고 주차까지의 기록으로
 * 정한다.
 */
interface Execution {
  /** 「집행함 10/19」의 날짜 부분(앞 공백 포함). */
  when: string
  /** 보고 주차에 올라가 있던 글이 있다. */
  live: boolean
  /** 보고 주차까지 내린 마지막 날 — 올라가 있는 글이 없으면 「다시 올릴 곳」이다. */
  lastDown?: string
  cited: boolean
  /** 마지막 저장 측정에는 없고 같은 주 다른 회차에서만 인용됐다 — 지분 · 충족 숫자는 마지막 측정 기준이라 따로 밝힌다. */
  citedOtherRun: boolean
}

function executionOf(a: GapAction, posts: PublishedPost[], asOf: string, citedPostIds?: ReadonlySet<string>): Execution | null {
  const hits = a.publishedHits ?? []
  const downs = posts
    .filter((p) => p.targetActionId === a.id && p.removedReason === 'taken-down' && p.removedAt)
    .map((p) => ({ post: p, on: kstDate(p.removedAt!) }))
    .filter((d): d is { post: PublishedPost; on: string } => Boolean(d.on) && (isoWeekOf(d.on!) ?? '') <= asOf)
  if (a.status !== 'done' && a.publishedUrls.length === 0 && downs.length === 0) return null
  const dated = (hits.length > 0 ? hits.map((h) => h.post) : downs.map((d) => d.post))
    .map((p) => p.publishedOn)
    .filter((d): d is string => Boolean(d))
    .sort()
  const when = dated.length > 0 ? ` ${monthDay(dated.at(-1)!)}` : a.markedWeek ? ` (${weekLabel(a.markedWeek)}에 표시)` : ''
  // 보고 주차 뒤에 내린 글은 그 주차에는 올라가 있었다.
  const live = hits.filter((h) => !h.takenDownOn || (isoWeekOf(h.takenDownOn) ?? '') > asOf)
  const lastDown = [...downs.map((d) => d.on), ...hits.map((h) => h.takenDownOn).filter((d): d is string => Boolean(d) && (isoWeekOf(d!) ?? '') <= asOf)]
    .sort()
    .at(-1)
  const lastRunCited = a.citedPublishedUrls.length > 0
  const otherRunCited = !lastRunCited && Boolean(citedPostIds) && posts.some((p) => p.targetActionId === a.id && citedPostIds!.has(p.id))
  return {
    when,
    live: live.length > 0,
    ...(lastDown ? { lastDown } : {}),
    cited: lastRunCited || otherRunCited,
    citedOtherRun: otherRunCited,
  }
}

/** 「올린 글이 이번 주 인용됨」 — 다른 회차에서만 인용됐으면 그 기준을 밝힌다. */
const citedText = (e: Execution) => (e.citedOtherRun ? '올린 글이 이번 주 다른 회차에서 인용됨(마지막 저장 측정에서는 없음)' : '올린 글이 이번 주 인용됨')

/** 블로그 플랫폼 — 「충족」이 없는 지분 자리라 한 편 올렸다고 끝나지 않는다(더 올리면 지분이 오른다). */
const isPlatform = (a: GapAction) => a.id.startsWith('listing:platform:')

/**
 * 글을 모두 내렸다 — 다음 측정이 인용할 글이 없으니 다시 권한다. 내리기 전 같은 주 다른 회차에서 인용됐어도(citedOtherRun) 다시
 * 권한다 — 이미 내린 글은 다음 측정이 인용할 수 없다.
 */
const allTakenDown = (e: Execution) => !e.live && (!e.cited || e.citedOtherRun) && Boolean(e.lastDown)

/** 「집행함 10/19 · 인용 대기」 — 다시 권하지 않는 항목의 꼬리표. */
function executedNote(e: Execution): string {
  const result = e.cited ? `${citedText(e)} · 아직 충족 전` : e.live ? '인용 대기' : '올린 주소 기록 없음'
  return `집행함${e.when} · ${result}`
}

/**
 * 다시 권하는 집행 항목의 머리말 — 블로그 플랫폼은 「집행함 10/1 · 지분 1/2 — 더 올리면 지분이 오른다」, 글을 모두 내렸으면 「올린 글
 * 10/8 내림 — 다시 올릴 곳」.
 */
function reRecommendNote(a: GapAction, e: Execution): string {
  if (!isPlatform(a)) return `올린 글 ${monthDay(e.lastDown!)} 내림 — 다시 올릴 곳`
  const result = e.cited ? citedText(e) : e.live ? '인용 대기' : e.lastDown ? `올린 글 ${monthDay(e.lastDown)} 내림` : '올린 주소 기록 없음'
  const share = a.progress ? ` · 지분 ${a.progress.supporting}/${a.progress.total}${e.citedOtherRun ? '(마지막 측정 기준)' : ''}` : ''
  return `집행함${e.when} · ${result}${share} — 더 올리면 지분이 오른다`
}

/** 상태 · 기록의 주 — 한 가지 달력 시계(한국 날짜)로 자른다. 상태는 마지막으로 고친 때(늦은 쪽 — 지난 보고서에서는 덜 집행한 것으로 본다). */
const stampWeek = (iso: string | undefined) => {
  const d = iso ? kstDate(iso) : null
  return (d ? isoWeekOf(d) : null) ?? ''
}

/** 사이트 진단 영역 → 그 영역 감점을 줄이는 구체 조치. 영역 id는 src/lib/aeo/scoreMeta.ts와 같다. */
const SITE_FIX: Record<string, string> = {
  crawler: 'robots.txt·사이트맵에서 AI 크롤러(GPTBot·PerplexityBot 등) 접근을 막지 않았는지 확인한다',
  content: '페이지 첫 문단에 질문의 답을 바로 쓰고, 자주 묻는 질문을 Q&A 블록으로 정리한다',
  eeat: '글쓴이·담당 전문가 이름과 게시·갱신일을 붙이고, 수치에는 출처를 단다',
  structured: '업체 정보(이름·주소·연락처·분야)를 구조화 데이터(JSON-LD)로 넣는다',
  technical: 'HTTPS 연결, 공유 미리보기(Open Graph), 이미지 대체 텍스트를 갖춘다',
  agent: '본문 영역(main) 표시와 입력 폼 라벨을 갖춰 에이전트가 페이지를 읽게 한다',
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/**
 * 언급률이 오를 때의 점수 계산 예시 — 실제 점수와 같은 산식(가중치·재정규화)으로 낸다.
 *
 * 감성 계수는 카드에 남지 않아, 지금 점수에서 거꾸로 푼다(언급이 없으면 중립 0.7). 반올림 탓에 1점
 * 안팎 어긋날 수 있다.
 */
function estimateScore(card: WeeklyScorecard, mentionRate: number): number {
  const w = AEO_SCORE_WEIGHTS
  const parts = [
    { w: w.brandOwnedCitationRate, v: card.brandOwnedCitationRate },
    ...(card.avgRecommendationRank !== null
      ? [{ w: w.avgRecommendationRank * rankWeightFactor(card.rankedResponses, card.avgRecommendationRank), v: normalizeRank(card.avgRecommendationRank) }]
      : []),
  ]
  const total = w.mentionRate + parts.reduce((s, p) => s + p.w, 0)
  const fixed = parts.reduce((s, p) => s + p.w * p.v, 0)
  const implied =
    card.mentionRate > 0 ? ((card.aeoScore.current / 100) * total - fixed) / (w.mentionRate * card.mentionRate) : 0.7
  const sentiment = Math.min(1, Math.max(0.2, Number.isFinite(implied) ? implied : 0.7))
  return Math.round(((w.mentionRate * mentionRate * sentiment + fixed) / total) * 100)
}

export function buildRecommendationEvidence(input: EvidenceInput): Record<string, RecommendationEvidence> {
  const { card, analyses, questions, citations, site } = input
  const out: Record<string, RecommendationEvidence> = {}
  if (analyses.length === 0 || questions.length === 0) return out

  const byId = new Map(questions.map((q) => [q.questionId, q]))
  const general = analyses.filter((a) => byId.get(a.questionId)?.category === 'category-agnostic')
  const generalQuestions = questions.filter((q) => q.category === 'category-agnostic')
  const rows = computeQuestionWinLoss(general, generalQuestions)

  // 한 질문에서 대신 불린 곳 — 경쟁사 언급과, 추천 1순위로 판정된 이름(우리 제외).
  const othersFor = (questionId: string): string[] => {
    const names = new Map<string, number>()
    for (const a of general.filter((x) => x.questionId === questionId)) {
      for (const c of a.competitorMentions) names.set(c.name, (names.get(c.name) ?? 0) + c.mentionCount)
      if (a.topRecommendation && a.topRecommendation !== card.brandName) {
        names.set(a.topRecommendation, (names.get(a.topRecommendation) ?? 0) + 1)
      }
    }
    return [...names.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n)
  }

  // ── 언급률: 밀린 일반 질문과 그때 대신 불린 곳
  // 다른 업체가 불린 추천형 질문을 위로 — 우리가 들어갈 자리가 실제로 있는 질문이다. 아무 업체도
  // 추천하지 않은 정보형 답변은 뒤로 보내고, 무엇을 노릴지(인용 출처가 되기)를 따로 적는다.
  const lost = rows
    .filter((r) => r.verdict === 'loss')
    .map((r) => ({ row: r, others: othersFor(r.questionId) }))
    .sort((a, b) => Number(b.others.length > 0) - Number(a.others.length > 0) || b.others.length - a.others.length)
    .map((x) => x.row)
  if (lost.length > 0) {
    const zero = lost.filter((r) => r.mentionedRate === 0).length
    const mentioned = general.filter((a) => a.mentioned).length
    const gain = Math.min(SHOW, lost.reduce((s, r) => s + Math.max(0, r.answered - Math.round(r.mentionedRate * r.answered)), 0))
    const nextRate = general.length > 0 ? (mentioned + gain) / general.length : card.mentionRate
    out.mention = {
      blocks: [
        {
          heading: `이번 주 밀린 일반 질문 ${lost.length}개(그중 ${zero}개는 한 번도 안 불림) — 대신 불린 곳`,
          items: lost.slice(0, SHOW).map((r) => {
            const others = othersFor(r.questionId)
            return {
              text: r.text,
              questionId: r.questionId,
              detail:
                others.length > 0
                  ? `대신 불린 곳: ${others.slice(0, 3).join(' · ')}`
                  : '업체 추천 없는 정보형 답변 — 이 질문에 답하는 가이드 글로 인용 출처가 되는 것이 목표',
            }
          }),
          more: Math.max(0, lost.length - SHOW),
        },
      ],
      estimate:
        gain > 0
          ? `계산 예시 — 밀린 질문의 답변 ${gain}건에서 불리면 언급률 ${pct(card.mentionRate)} → ${pct(nextRate)}, 점수 약 ${card.aeoScore.current} → ${estimateScore(card, nextRate)}점(같은 산식으로 낸 값이며 약속이 아니다).`
          : undefined,
      link: { label: '실행 계획에서 이 질문들로 글 만들기', to: '/gap-actions' },
    }
  }

  // ── 자사 인용률: 인용했지만 우리를 뒷받침하지 않은 출처, 이미 인용되는 자사 페이지, 사이트 감점
  const citationBlocks: EvidenceBlock[] = []
  if (citations) {
    const asOf = card.weekOf
    // 보고 주차 뒤의 일은 보지 않는다 — 글은 올린 날(모르면 기록한 날), 상태는 고친 날의 주로. markedWeek(그때 보던 주차)는 쓰지
    // 않는다: 「올렸어요」는 최신 주차를 보며 다음 주에 누르는 일이 흔해, 글은 다음 주인데 상태만 이번 주로 남는다.
    const posts = (input.posts ?? []).filter((p) => postWeekOf(p) <= asOf)
    const states = Object.fromEntries(Object.entries(input.states ?? {}).filter(([, s]) => stampWeek(s.updatedAt) <= asOf))
    const plan = computeGapActions(analyses, questions, citations, states, posts, asOf)
    const open = plan.actions.filter((a) => a.kind === 'listing' && !a.satisfied).sort((a, b) => b.reach - a.reach)
    // 이미 집행한 일은 다시 권하지 않는다 — 집행함으로 표시했거나 올린 주소를 적은 항목. 충족은 다음 측정이 말한다. 다만 블로그
    // 플랫폼(지분 자리)과 글을 모두 내린 항목은 할 일이 남아 계속 권하고, 집행했다는 사실을 머리말로 단다.
    const exec = new Map(open.map((a) => [a.id, executionOf(a, posts, asOf, input.citedPostIds)]))
    const stays = (a: GapAction) => {
      const e = exec.get(a.id)
      return !e || isPlatform(a) || allTakenDown(e)
    }
    const listing = open.filter(stays)
    const done = open.filter((a) => !stays(a))
    if (listing.length > 0) {
      citationBlocks.push({
        // 「충족」은 브랜드 이름 없는 질문으로 정한다(gapActions.ts) — 이름을 댄 질문에서만 뒷받침한 출처도 여기 온다.
        heading: 'AI가 인용했지만 브랜드 이름 없는 질문에서는 우리를 뒷받침하지 않은 출처',
        items: listing.slice(0, 4).map((a) => {
          const e = exec.get(a.id)
          return { text: `${a.title} (${a.badge})`, detail: `${e ? `[${reRecommendNote(a, e)}] ` : ''}${a.evidence} 완료 기준: ${a.doneSignal}` }
        }),
        more: Math.max(0, listing.length - 4),
      })
    }
    if (done.length > 0) {
      citationBlocks.push({
        heading: '이미 집행한 출처 — 다시 권하지 않음(다음 측정에서 인용을 확인)',
        items: done.slice(0, 4).map((a) => ({ text: `${a.title} (${a.badge})`, detail: executedNote(exec.get(a.id)!) })),
        more: Math.max(0, done.length - 4),
      })
    }
    const owned = citations.urls
      .filter((u) => u.ownerType === 'brand-owned')
      .sort((a, b) => b.citationCount - a.citationCount)
    if (owned.length > 0) {
      citationBlocks.push({
        heading: '이미 인용되는 자사 페이지 — 같은 형식으로 늘린다',
        items: owned.slice(0, 3).map((u) => ({
          text: u.raw,
          detail: `${u.citationCount}회 인용 · ${u.engines.map((e) => ENGINE_LABEL[e] ?? e).join('·')}`,
        })),
        more: Math.max(0, owned.length - 3),
      })
    }
  }
  if (site) {
    const weak = site.categories
      .filter((c) => c.score !== null && c.score < c.maxScore && SITE_FIX[c.id])
      .sort((a, b) => (a.score! / a.maxScore) - (b.score! / b.maxScore))
    if (weak.length > 0) {
      citationBlocks.push({
        heading: `사이트 진단(${site.score}점) 감점 영역 — 낮은 순`,
        items: weak.slice(0, 3).map((c) => ({ text: `${c.name} ${c.score}/${c.maxScore}`, detail: SITE_FIX[c.id] })),
      })
    }
  }
  if (citationBlocks.length > 0) {
    out.citation = { blocks: citationBlocks, link: { label: '인용 갭 분석', to: '/citation-gap' } }
  }

  // ── 추천 순위: 불렸지만 1순위가 아닌 질문과 그때 1순위
  // 점수와 같은 기준 — 언급된 응답의 순위만 센다(server/aggregate.ts rankOf).
  const rankedResponses = general.filter((a) => a.mentioned && a.brandRank !== null).length
  const notFirst = rows.filter((r) => r.mentionedRate > 0 && (r.avgRank === null || r.avgRank > 1))
  if (notFirst.length > 0) {
    out.rank = {
      blocks: [
        {
          heading:
            card.avgRecommendationRank === null
              ? '순위가 매겨진 답변이 없다 — 불렸지만 추천 순서가 매겨지지 않은 질문'
              : rankedResponses < RANK_FULL_WEIGHT_RESPONSES
                ? `순위가 매겨진 답변 ${rankedResponses}건(점수에는 비중 ${rankedResponses}/${RANK_FULL_WEIGHT_RESPONSES}) — 불렸지만 1순위가 아닌 질문`
                : '불렸지만 1순위가 아닌 질문',
          items: notFirst.slice(0, SHOW).map((r) => {
            const top = general
              .filter((a) => a.questionId === r.questionId && a.topRecommendation && a.topRecommendation !== card.brandName)
              .map((a) => a.topRecommendation!)
            return {
              text: r.text,
              detail: `${r.avgRank === null ? '불렸지만 추천 순서가 매겨지지 않음' : `평균 ${r.avgRank.toFixed(1)}위`}${top.length > 0 ? ` · 1순위로 추천된 곳: ${[...new Set(top)].slice(0, 2).join(' · ')}` : ''}`,
            }
          }),
          more: Math.max(0, notFirst.length - SHOW),
        },
      ],
    }
  }

  // ── 사실성: AI가 실제로 다르게 말한 내용
  const contradicted = analyses.flatMap((a) =>
    a.factualityClaims
      .filter((c) => c.verdict === 'contradicted')
      .map((c) => ({
        text: byId.get(a.questionId)?.text ?? a.questionId,
        detail: `${ENGINE_LABEL[a.engine] ?? a.engine}: “${c.responseValue ?? c.claimText}” · 등록: “${c.factGraphValue ?? '—'}” — 판정 오류일 수도 있어 원문을 확인한 뒤 공식 페이지·외부 출처를 고친다`,
      })),
  )
  if (contradicted.length > 0) {
    out.fact = { blocks: [{ heading: '「틀림」으로 판정된 답변', items: contradicted.slice(0, SHOW), more: Math.max(0, contradicted.length - SHOW) }] }
  }

  return out
}
