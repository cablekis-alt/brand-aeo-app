import { AEO_SCORE_WEIGHTS, normalizeRank, type WeeklyScorecard } from '../prompts/b8-report'
import type { CitationSourceAnalysis } from '../prompts/b7-citation-sources'
import type { SiteScoreRecord } from './api'
import { ENGINE_LABEL } from './format'
import { computeGapActions } from './gapActions'
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
}

const SHOW = 5

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
      ? [{ w: w.avgRecommendationRank, v: normalizeRank(card.avgRecommendationRank) }]
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
    const plan = computeGapActions(analyses, questions, citations, {})
    const listing = plan.actions.filter((a) => a.kind === 'listing' && !a.satisfied).sort((a, b) => b.reach - a.reach)
    if (listing.length > 0) {
      citationBlocks.push({
        heading: 'AI가 인용했지만 우리를 뒷받침하지 않은 출처',
        items: listing.slice(0, 4).map((a) => ({ text: `${a.title} (${a.badge})`, detail: `${a.evidence} 완료 기준: ${a.doneSignal}` })),
        more: Math.max(0, listing.length - 4),
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
  const rankedResponses = general.filter((a) => a.brandRank !== null).length
  const notFirst = rows.filter((r) => r.mentionedRate > 0 && (r.avgRank === null || r.avgRank > 1))
  if (notFirst.length > 0) {
    out.rank = {
      blocks: [
        {
          heading:
            card.avgRecommendationRank === null
              ? `순위가 매겨진 답변 ${rankedResponses}건(3건 이상이어야 점수에 들어간다) — 불렸지만 1순위가 아닌 질문`
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
