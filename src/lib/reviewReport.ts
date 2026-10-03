import type { WeeklyScorecard } from '../prompts/b8-report'
import type { PeriodicReport, Priority } from './b9-report'
import type { RecommendationEvidence } from './recommendationEvidence'
import type { SiteScoreRecord } from './api'
import { ENGINE_LABEL, measureConditionText, OWNER_TYPE_LABEL, weekLabel } from './format'
import type { CitationBreakdownRow, QuestionBank, QuestionRepeatAnalysis } from './types'

/**
 * 검토 리포트 — 정기진단 보고서를 고객·팀에 그대로 넘길 수 있는 문서로 묶는다.
 *
 * 모든 문장은 코드 템플릿이고 수치는 저장된 측정값 그대로다(LLM이 쓰지 않는다). 손으로 쓴 검토
 * 문서(옥수 본 정형외과 W40)에서 가장 값진 부분은 숫자가 아니라 **그 숫자를 믿어도 되는지**였다 —
 * 병원마다 질문지가 달랐고, 한 번만 쟀고, 사실성 「틀림」이 판정 오류였다. 그 점검을 맨 앞에 둔다
 * (trustChecks). 점검에 걸리면 문서가 그렇다고 먼저 말한다.
 */

export type CheckStatus = 'ok' | 'warn' | 'review'

export interface TrustCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface CohortRow {
  tenantId: string
  brandName: string
  isSelf: boolean
  score: number
  position: number
  tied: boolean
  mentionRate: number
  ownedRate: number
  bankVersion: string | null
  /** 이 브랜드와 같은 일반 질문을 받았는지. 은행을 읽지 못하면 null. */
  sameQuestions: boolean | null
  engines: string
}

export interface CategoryRow {
  category: string
  label: string
  mentioned: number
  total: number
}

export interface MentionedQuestion {
  text: string
  engines: string[]
}

export interface CitationRow {
  domain: string
  owner: string
  count: number
  isOwned: boolean
}

export interface ReviewReport {
  brandName: string
  tenantId: string
  weekOf: string
  industry: string
  region: string
  score: number
  ciLow: number
  ciHigh: number
  cohortPosition: number
  cohortTotal: number
  cohortTied: boolean
  /** 수집 엔진(모델) · 판단 엔진(모델) · 반복 횟수 — 문서 머리에 적는다. */
  conditions: { collect: string; judge: string; repeats: string }
  site: SiteScoreRecord | null
  checks: TrustCheck[]
  cohort: CohortRow[]
  general: { questions: number; responses: number; mentioned: number; clarifying: number }
  mentionedQuestions: MentionedQuestion[]
  categories: CategoryRow[]
  citations: { total: number; owned: number; ownedRate: number; ownedRank: number | null; top: CitationRow[] }
  /** 「틀림」 판정 — 질문·엔진·AI가 말한 값·등록된 값. 사람이 원문을 보고 판정 오류인지 가린다. */
  factuality: { score: number | null; contradicted: { question: string; engine: string; said: string; registered: string }[] }
  recommendations: { title: string; priority: Priority; basis: string; evidence?: RecommendationEvidence }[]
}

export interface ReviewReportInput {
  card: WeeklyScorecard
  history: WeeklyScorecard[]
  /** 같은 주차 코호트 다른 브랜드의 카드(이 브랜드 제외). 카드가 없는 브랜드는 빼고 넘긴다. */
  members: WeeklyScorecard[]
  /** tenantId → 그 주차 은행(이 브랜드 포함). 읽지 못하면 null. */
  banks: Record<string, QuestionBank | null>
  analyses: QuestionRepeatAnalysis[]
  citationRows: CitationBreakdownRow[]
  site: SiteScoreRecord | null
  periodic: PeriodicReport
}

const CATEGORY_LABEL: Record<string, string> = {
  'brand-direct': '브랜드 직접',
  comparison: '비교',
  'price-spec': '가격·사양',
  'local-regional': '지역',
  'troubleshooting-review': '후기·문제 해결',
}

/** 되물은 응답이 이 비율을 넘으면 질문에 조건(지역 등)이 모자란다고 본다 — 옥수 본 1차는 27건 중 19건. */
const CLARIFYING_WARN = 0.2

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const engineSet = (c: WeeklyScorecard) => [...(c.enginesUsed ?? [])].sort().join('+')
const engineText = (c: WeeklyScorecard) => (c.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join(' · ') || '기록 없음'

/** 은행의 일반 질문(브랜드 이름 없는 질문) 텍스트 집합. 은행이 없으면 null. */
function generalQuestionTexts(bank: QuestionBank | null | undefined): Set<string> | null {
  if (!bank) return null
  return new Set(bank.questions.filter((q) => q.category === 'category-agnostic').map((q) => q.text.trim()))
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}

/** 표준 경쟁 랭킹(1-2-2-4) — 코호트 순위와 같은 규칙. */
function positionOf(score: number, all: number[]): { position: number; tied: boolean } {
  return { position: all.filter((s) => s > score).length + 1, tied: all.filter((s) => s === score).length > 1 }
}

export function buildReviewReport(input: ReviewReportInput): ReviewReport {
  const { card, history, members, banks, analyses, citationRows, site, periodic } = input
  const cohortCards = [card, ...members]
  const scores = cohortCards.map((c) => c.aeoScore.current)
  const ownedRates = cohortCards.map((c) => c.brandOwnedCitationRate)
  const selfGeneral = generalQuestionTexts(banks[card.tenantId])

  const cohort: CohortRow[] = cohortCards
    .map((c) => {
      const general = generalQuestionTexts(banks[c.tenantId])
      const { position, tied } = positionOf(c.aeoScore.current, scores)
      return {
        tenantId: c.tenantId,
        brandName: c.brandName,
        isSelf: c.tenantId === card.tenantId,
        score: c.aeoScore.current,
        position,
        tied,
        mentionRate: c.mentionRate,
        ownedRate: c.brandOwnedCitationRate,
        bankVersion: c.questionBankVersion ?? null,
        sameQuestions: selfGeneral && general ? sameSet(selfGeneral, general) : null,
        engines: engineText(c),
      }
    })
    .sort((a, b) => a.position - b.position || Number(b.isSelf) - Number(a.isSelf))

  // 이 브랜드 응답 — 일반 질문과 브랜드 이름이 든 질문을 나눈다.
  const bankById = new Map((banks[card.tenantId]?.questions ?? []).map((q) => [q.questionId, q]))
  const generalAnalyses = analyses.filter((a) => bankById.get(a.questionId)?.category === 'category-agnostic')
  const mentionedByText = new Map<string, Set<string>>()
  for (const a of generalAnalyses) {
    if (!a.mentioned) continue
    const text = bankById.get(a.questionId)?.text ?? a.questionId
    mentionedByText.set(text, (mentionedByText.get(text) ?? new Set()).add(ENGINE_LABEL[a.engine] ?? a.engine))
  }
  const categories: CategoryRow[] = Object.entries(CATEGORY_LABEL)
    .map(([category, label]) => {
      const rows = analyses.filter((a) => bankById.get(a.questionId)?.category === category)
      return { category, label, mentioned: rows.filter((a) => a.mentioned).length, total: rows.length }
    })
    .filter((r) => r.total > 0)
  const general = {
    questions: new Set(generalAnalyses.map((a) => a.questionId)).size,
    responses: generalAnalyses.length,
    mentioned: generalAnalyses.filter((a) => a.mentioned).length,
    clarifying: generalAnalyses.filter((a) => a.clarifying).length,
  }

  const sortedCitations = [...citationRows].sort((a, b) => b.citationCount - a.citationCount)
  const citationTotal = citationRows.reduce((s, r) => s + r.citationCount, 0)
  const ownedCount = citationRows.filter((r) => r.ownerType === 'brand-owned').reduce((s, r) => s + r.citationCount, 0)
  const top: CitationRow[] = sortedCitations.slice(0, 6).map((r) => ({
    domain: r.domain,
    owner: OWNER_TYPE_LABEL[r.ownerType] ?? r.ownerType,
    count: r.citationCount,
    isOwned: r.ownerType === 'brand-owned',
  }))
  for (const r of sortedCitations.filter((r) => r.ownerType === 'brand-owned' && !top.some((t) => t.domain === r.domain))) {
    top.push({ domain: r.domain, owner: OWNER_TYPE_LABEL[r.ownerType] ?? r.ownerType, count: r.citationCount, isOwned: true })
  }

  return {
    brandName: card.brandName,
    tenantId: card.tenantId,
    weekOf: card.weekOf,
    industry: card.industry,
    region: card.region,
    score: card.aeoScore.current,
    ciLow: card.aeoScore.ciLow,
    ciHigh: card.aeoScore.ciHigh,
    cohortPosition: positionOf(card.aeoScore.current, scores).position,
    cohortTotal: cohortCards.length,
    cohortTied: positionOf(card.aeoScore.current, scores).tied,
    conditions: measureConditionText(card),
    site,
    checks: trustChecks(card, history, members, cohort, general),
    cohort,
    general,
    mentionedQuestions: [...mentionedByText].map(([text, engines]) => ({ text, engines: [...engines] })),
    categories,
    citations: {
      total: citationTotal,
      owned: ownedCount,
      ownedRate: card.brandOwnedCitationRate,
      ownedRank: cohortCards.length > 1 ? ownedRates.filter((r) => r > card.brandOwnedCitationRate).length + 1 : null,
      top,
    },
    factuality: {
      score: card.factualityScore,
      contradicted: analyses.flatMap((a) =>
        a.factualityClaims
          .filter((c) => c.verdict === 'contradicted')
          .map((c) => ({
            question: bankById.get(a.questionId)?.text ?? a.questionId,
            engine: ENGINE_LABEL[a.engine] ?? a.engine,
            said: c.responseValue ?? c.claimText,
            registered: c.factGraphValue ?? '—',
          })),
      ),
    },
    recommendations: periodic.recommendations.map((r) => ({ title: r.title, priority: r.priority, basis: r.basis, evidence: r.evidence })),
  }
}

/** 측정 신뢰도 점검 — 순위·점수를 그대로 읽어도 되는지. */
function trustChecks(
  card: WeeklyScorecard,
  history: WeeklyScorecard[],
  members: WeeklyScorecard[],
  cohort: CohortRow[],
  general: ReviewReport['general'],
): TrustCheck[] {
  const checks: TrustCheck[] = []
  const others = cohort.filter((r) => !r.isSelf)

  // 1) 같은 시험지 — 일반 질문이 다르면 순위가 질문 차이를 잰다.
  if (others.length === 0) {
    checks.push({ id: 'cohort', label: '비교 대상', status: 'warn', detail: '이 주차에 함께 잰 코호트 브랜드가 없어 순위를 비교할 수 없습니다.' })
  } else {
    const differ = others.filter((r) => r.sameQuestions === false)
    const unknown = others.filter((r) => r.sameQuestions === null) // 이 브랜드 은행을 못 읽어도 여기로 온다.
    checks.push(
      differ.length > 0
        ? {
            id: 'questions',
            label: '같은 질문지',
            status: 'warn',
            detail: `${differ.map((r) => r.brandName).join(', ')}은(는) 일반 질문이 다릅니다 — 점수 차이가 가시성이 아니라 질문 차이일 수 있습니다.`,
          }
        : unknown.length > 0
          ? {
              id: 'questions',
              label: '같은 질문지',
              status: 'warn',
              detail: `${unknown.map((r) => r.brandName).join(', ')}의 질문 은행을 읽지 못해 같은 질문을 받았는지 확인하지 못했습니다.`,
            }
          : {
              id: 'questions',
              label: '같은 질문지',
              status: 'ok',
              detail: `코호트 ${cohort.length}곳이 같은 일반 질문 ${general.questions}개를 받았습니다.`,
            },
    )
  }

  // 2) 같은 측정 조건 — 수집 엔진·모델·판정 모델.
  const all = [card, ...members]
  const diffs: string[] = []
  if (new Set(all.map(engineSet)).size > 1) diffs.push('수집 엔진')
  if (new Set(all.map((c) => JSON.stringify(c.modelsUsed ?? {}))).size > 1) diffs.push('엔진 모델')
  if (new Set(all.map((c) => c.judgeModel ?? '')).size > 1) diffs.push('판정 모델')
  // 반복 횟수는 기록이 있는 카드끼리만 비교한다(기록 이전 카드는 모른다 — 다르다고 하지 않는다).
  if (new Set(all.filter((c) => c.repeatsPerQuestion).map((c) => c.repeatsPerQuestion)).size > 1) diffs.push('질문당 반복 횟수')
  if (others.length > 0) {
    checks.push(
      diffs.length > 0
        ? { id: 'conditions', label: '같은 측정 조건', status: 'warn', detail: `코호트 안에서 다른 조건이 있습니다(${diffs.join(' · ')}) — 같은 조건의 비교가 아닙니다.` }
        : {
            id: 'conditions',
            label: '같은 측정 조건',
            status: 'ok',
            detail: `코호트 모두 ${engineText(card)}로 쟀고 판정 모델${card.repeatsPerQuestion ? `·반복 횟수(질문당 ${card.repeatsPerQuestion}회)` : ''}도 같습니다.`,
          },
    )
  }

  // 3) 측정 횟수 — 한 번 잰 결과는 같은 설정에서도 몇 %p씩 흔들린다.
  //    은행 버전과 주차를 적는다. "한 번뿐"만 쓰면 "1차 시험 결과"로 읽혔다 — 같은 주 재측정은 그 주를
  //    덮어써서 세지 않으므로, 세는 단위가 주차라는 것도 보이게 한다.
  const sameConditionWeeks = history
    .filter((h) => h.questionBankVersion === card.questionBankVersion && engineSet(h) === engineSet(card))
    .map((h) => h.weekOf)
    .sort()
  const bank = card.questionBankVersion ? `질문 은행 ${card.questionBankVersion}` : '같은 질문 은행'
  checks.push(
    sameConditionWeeks.length >= 2
      ? {
          id: 'runs',
          label: '측정 횟수',
          status: 'ok',
          detail: `${bank}·같은 엔진으로 잰 주차가 ${sameConditionWeeks.length}개입니다(${weekLabel(sameConditionWeeks[0]!)}–${weekLabel(sameConditionWeeks.at(-1)!)}). 같은 방향인지 추이로 확인합니다.`,
        }
      : {
          id: 'runs',
          label: '측정 횟수',
          status: 'warn',
          detail: `${bank}·같은 엔진으로 잰 주차가 아직 1개입니다(${weekLabel(card.weekOf)}). 고객용 결론은 다음 주차 측정에서도 같은 방향일 때 씁니다.`,
        },
  )

  // 4) 되물은 응답 — 많으면 질문에 지역·조건이 모자라 브랜드가 불릴 자리가 없다.
  if (general.responses > 0) {
    const rate = general.clarifying / general.responses
    checks.push(
      rate >= CLARIFYING_WARN
        ? {
            id: 'clarifying',
            label: '되물은 응답',
            status: 'warn',
            detail: `일반 질문 응답 ${general.responses}건 중 ${general.clarifying}건(${pct(rate)})이 답 대신 조건을 되물었습니다 — 질문에 지역·조건이 모자랄 수 있습니다.`,
          }
        : { id: 'clarifying', label: '되물은 응답', status: 'ok', detail: `일반 질문 응답 ${general.responses}건 중 되물은 응답 ${general.clarifying}건(${pct(rate)}).` },
    )
  }

  // 5) 사실성 「틀림」 — 판정 오류일 수 있어 결론으로 쓰기 전에 사람이 원문을 본다.
  checks.push(
    card.hallucinationFlags.length > 0
      ? {
          id: 'facts',
          label: '사실성 판정',
          status: 'review',
          detail: `「틀림」 판정 ${card.hallucinationFlags.length}건 — AI가 실제로 틀렸을 수도, 다른 브랜드에 대한 답을 이 브랜드 사실과 대조한 판정 오류일 수도 있습니다. 원문을 확인한 뒤 씁니다.`,
        }
      : card.factualityScore === null
        ? { id: 'facts', label: '사실성 판정', status: 'ok', detail: '팩트 그래프가 없어 사실성을 재지 않았습니다(점수 미포함).' }
        : { id: 'facts', label: '사실성 판정', status: 'ok', detail: `「틀림」 판정 없음 · 사실성 ${pct(card.factualityScore)}.` },
  )
  return checks
}

/* ───────────────────────── HTML 문서 ───────────────────────── */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CHECK_LABEL: Record<CheckStatus, string> = { ok: '확인', warn: '주의', review: '사람 확인' }
const PRIORITY_TEXT: Record<Priority, string> = { high: '높음', medium: '중간', low: '낮음' }

/** 개선제안 하나 — 근거와 이번 주 데이터로 본 실행 항목(밀린 질문·출처·감점)을 함께 적는다. */
function recommendationHtml(x: ReviewReport['recommendations'][number]): string {
  const blocks = (x.evidence?.blocks ?? [])
    .map(
      (b) =>
        `<p class="note"><b>${esc(b.heading)}</b></p><ul class="qs">${b.items
          .map((it) => `<li>${esc(it.text)}${it.detail ? `<span class="e">${esc(it.detail)}</span>` : ''}</li>`)
          .join('')}</ul>${b.more ? `<p class="note">외 ${b.more}개</p>` : ''}`,
    )
    .join('')
  const estimate = x.evidence?.estimate ? `<p class="note">${esc(x.evidence.estimate)}</p>` : ''
  return `<li><b>${esc(x.title)}</b> <span class="dim">우선순위 ${PRIORITY_TEXT[x.priority]}</span><p>${esc(x.basis)}</p>${blocks}${estimate}</li>`
}

/** 공유용 단일 HTML 문서. 스타일을 안에 담아 파일 하나로 열린다(라이트·다크 모두). */
export function reviewReportHtml(r: ReviewReport): string {
  const week = weekLabel(r.weekOf)
  const warns = r.checks.filter((c) => c.status !== 'ok')
  const rank = `${r.cohortTied ? '공동 ' : ''}${r.cohortPosition}위`
  const lede = [
    `${week} Brand AEO Score <strong>${r.score}점</strong>(95% 신뢰구간 ${r.ciLow}–${r.ciHigh}, 코호트 ${r.cohortTotal}곳 중 ${rank})`,
    r.site ? `, Site AEO Score <strong>${r.site.score}점</strong>이다.` : '이다. Site AEO 진단 기록은 없다.',
    ` 브랜드 이름 없는 일반 질문 응답 ${r.general.responses}건 중 <strong>${r.general.mentioned}건</strong>에서 불렸다.`,
    warns.length > 0
      ? ` 아래 측정 신뢰도 점검에서 <strong>${warns.length}건</strong>이 걸렸다 — 점수·순위를 그대로 읽기 전에 먼저 본다.`
      : ' 측정 신뢰도 점검은 모두 통과했다.',
  ].join('')

  const checkRows = r.checks
    .map(
      (c) =>
        `<li class="chk ${c.status}"><span class="chip ${c.status}">${CHECK_LABEL[c.status]}</span><b>${esc(c.label)}</b><p>${esc(c.detail)}</p></li>`,
    )
    .join('')

  const cohortRows = r.cohort
    .map(
      (c) =>
        `<tr${c.isSelf ? ' class="hi"' : ''}><td class="lead">${c.isSelf ? `<strong>${esc(c.brandName)}</strong>` : esc(c.brandName)}</td>` +
        `<td class="n">${c.tied ? '공동 ' : ''}${c.position}</td><td class="n">${c.score}</td><td class="n">${pct(c.mentionRate)}</td>` +
        `<td class="n">${pct(c.ownedRate)}</td><td class="n">${c.sameQuestions === null ? '<span class="dim">확인 불가</span>' : c.sameQuestions ? '같음' : '<strong>다름</strong>'}</td></tr>`,
    )
    .join('')

  const mentioned =
    r.mentionedQuestions.length > 0
      ? `<ul class="qs">${r.mentionedQuestions.map((q) => `<li>${esc(q.text)}<span class="e">${esc(q.engines.join(' · '))}</span></li>`).join('')}</ul>`
      : '<p class="note">이번 주 일반 질문에서는 한 번도 불리지 않았다.</p>'

  const categoryRows = [
    ...r.categories.map((c) => `<tr><td class="lead">${esc(c.label)}</td><td class="n">${c.mentioned}/${c.total}</td></tr>`),
    `<tr class="hi"><td class="lead"><strong>일반 (브랜드 이름 없음)</strong></td><td class="n"><strong>${r.general.mentioned}/${r.general.responses}</strong></td></tr>`,
  ].join('')

  const citationRows = r.citations.top
    .map(
      (c) =>
        `<tr${c.isOwned ? ' class="hi"' : ''}><td class="lead"><code>${esc(c.domain)}</code>${c.isOwned ? ' <span class="dim">(자사)</span>' : ''}</td><td class="n">${c.count}</td><td class="lead dim">${esc(c.owner)}</td></tr>`,
    )
    .join('')

  const siteSection = r.site
    ? `<section><p class="eyebrow">Site AEO</p><h2>홈페이지 ${r.site.score}점</h2><div class="scroller"><table>
<caption>Site AEO Score — <code>${esc(r.site.url)}</code> (${esc(weekLabel(r.site.weekOf))} 진단)</caption>
<thead><tr><th class="lead">진단 영역</th><th>점수</th></tr></thead><tbody>
<tr class="hi"><td class="lead">총점</td><td class="n">${r.site.score} / 100</td></tr>
${r.site.categories.map((c) => `<tr><td class="lead">${esc(c.name)}</td><td class="n">${c.score === null ? '<span class="dim">확인 불가</span>' : `${c.score} / ${c.maxScore}`}</td></tr>`).join('')}
</tbody></table></div></section>`
    : ''

  const recs =
    r.recommendations.length > 0
      ? `<ol class="todo">${r.recommendations.map(recommendationHtml).join('')}</ol>`
      : '<p class="note">주의·미흡 지표가 없어 별도 개선제안이 없다.</p>'

  const factNote =
    r.factuality.contradicted.length > 0
      ? `<p class="note">사실성 「틀림」 판정 — 원문을 확인하기 전에는 결론으로 쓰지 않는다.</p><ul class="qs">${r.factuality.contradicted
          .map(
            (c) =>
              `<li>${esc(c.question)}<span class="e">${esc(c.engine)}</span><span>AI: “${esc(c.said)}” · 등록: “${esc(c.registered)}”</span></li>`,
          )
          .join('')}</ul>`
      : ''

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.brandName)} ${esc(r.weekOf.slice(-3))} 검토</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--plane:#f3f5f4;--surface:#ffffff;--sunk:#f7f9f8;--ink:#111c18;--ink-2:#4a5752;--muted:#5b6862;--rule:#dce3e0;--rule-2:#c4cdc9;--warn:#a15c07;--good:#0b6b5d;--review:#b93815;
--sans:"IBM Plex Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--plane:#0d1311;--surface:#141c19;--sunk:#1a2420;--ink:#e8efec;--ink-2:#a9b7b1;--muted:#93a19b;--rule:#26332e;--rule-2:#3a4a44;--warn:#f0b45a;--good:#4cc7b0;--review:#f2895f}}
body{margin:0;background:var(--plane);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.72}
.wrap{max-width:800px;margin:0 auto;padding:40px 20px 72px}
h1,h2{margin:0;font-weight:600;line-height:1.32;text-wrap:balance}h1{font-size:1.7rem}h2{font-size:1.15rem}p{margin:0}
code,.n{font-family:var(--mono);font-variant-numeric:tabular-nums}code{font-size:.87em;background:var(--sunk);padding:.1em .38em;border-radius:3px}
.eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
.lede{color:var(--ink-2)}.note{font-size:.83rem;color:var(--muted)}.dim{color:var(--muted)}
header{display:flex;flex-direction:column;gap:14px}
.meta{display:flex;flex-wrap:wrap;gap:0 22px;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:12px 0;margin:4px 0 0}
.meta div{display:flex;gap:7px;align-items:baseline}.meta dt{font-size:.78rem;color:var(--muted)}.meta dd{margin:0;font-family:var(--mono);font-size:.82rem}
section{display:flex;flex-direction:column;gap:14px;margin-top:44px}
.scroller{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.875rem}
caption{text-align:left;color:var(--muted);font-size:.8rem;padding-bottom:8px}
th,td{padding:9px 10px;border-bottom:1px solid var(--rule);text-align:right;white-space:nowrap}
th{font-weight:500;font-size:.76rem;color:var(--muted);border-bottom-color:var(--rule-2)}td.lead,th.lead{text-align:left}
tbody tr.hi td{background:var(--sunk)}tbody tr:last-child td{border-bottom:none}
ul.checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.chk{background:var(--surface);border:1px solid var(--rule);border-left:3px solid var(--rule-2);border-radius:5px;padding:10px 14px;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:baseline}
.chk.warn{border-left-color:var(--warn)}.chk.review{border-left-color:var(--review)}.chk.ok{border-left-color:var(--good)}
.chk p{grid-column:2;font-size:.88rem;color:var(--ink-2)}
.chip{font-family:var(--mono);font-size:.66rem;padding:2px 7px;border-radius:3px;border:1px solid currentColor}
.chip.ok{color:var(--good)}.chip.warn{color:var(--warn)}.chip.review{color:var(--review)}
ul.qs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:5px;overflow:hidden}
ul.qs li{background:var(--surface);padding:9px 12px;font-size:.86rem;color:var(--ink-2);display:grid;grid-template-columns:1fr auto;gap:12px}
ul.qs .e{font-family:var(--mono);font-size:.72rem;color:var(--muted);white-space:nowrap}
ol.todo{margin:0;padding-left:1.3em;display:flex;flex-direction:column;gap:12px}ol.todo p{font-size:.88rem;color:var(--ink-2);margin-top:2px}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--rule);font-size:.8rem;color:var(--muted)}
@media (max-width:560px){ul.qs li{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
<p class="eyebrow">검토 리포트 · ${esc(r.industry)} ${esc(r.region)} · Brand AEO + Site AEO · ${esc(r.weekOf)}</p>
<h1>${esc(r.brandName)} ${esc(week)} 검토</h1>
<p class="lede">${lede}</p>
<dl class="meta">
<div><dt>브랜드</dt><dd>${esc(r.brandName)} (${esc(r.tenantId)})</dd></div>
<div><dt>코호트</dt><dd>${esc(r.industry)} · ${esc(r.region)} · ${r.cohortTotal}곳</dd></div>
<div><dt>수집 엔진</dt><dd>${esc(r.conditions.collect)}</dd></div>
<div><dt>판단 엔진</dt><dd>${esc(r.conditions.judge)}</dd></div>
<div><dt>반복</dt><dd>${esc(r.conditions.repeats)}</dd></div>
<div><dt>일반 질문</dt><dd>${r.general.questions}개 · 응답 ${r.general.responses}</dd></div>
</dl>
</header>

<section><p class="eyebrow">먼저 확인</p><h2>측정 신뢰도 점검</h2><ul class="checks">${checkRows}</ul></section>

<section><p class="eyebrow">코호트</p><h2>같은 주 코호트 비교</h2><div class="scroller"><table>
<caption>${esc(week)} Brand AEO Score · 일반 질문 언급률 · 자사 인용률 · 이 브랜드와 같은 일반 질문을 받았는지</caption>
<thead><tr><th class="lead">브랜드</th><th>순위</th><th>점수</th><th>일반 질문 언급률</th><th>자사 인용</th><th>질문지</th></tr></thead>
<tbody>${cohortRows}</tbody></table></div>
<p class="note">점수는 언급률·자사 인용·추천 순위로 낸다. SoM·사실성은 점수에 들어가지 않는다.</p></section>

<section><p class="eyebrow">Brand AEO ①</p><h2>브랜드 이름 없이 물었을 때 불린 질문</h2>${mentioned}
<p class="note">일반 질문 ${r.general.questions}개 × 엔진 응답 ${r.general.responses}건 중 ${r.general.mentioned}건 언급 · 되물은 응답 ${r.general.clarifying}건.</p></section>

<section><p class="eyebrow">Brand AEO ②</p><h2>질문 유형별 언급</h2><div class="scroller"><table>
<caption>응답 수 기준</caption><thead><tr><th class="lead">질문 유형</th><th>언급</th></tr></thead><tbody>${categoryRows}</tbody></table></div>${factNote}</section>

<section><p class="eyebrow">Brand AEO ③</p><h2>AI가 근거로 쓴 출처</h2><div class="scroller"><table>
<caption>응답의 인용 ${r.citations.total}건 — 상위 출처</caption><thead><tr><th class="lead">출처</th><th>인용</th><th class="lead">성격</th></tr></thead><tbody>${citationRows}</tbody></table></div>
<p class="note">자사 인용 ${r.citations.owned}건 · 자사 인용률 ${pct(r.citations.ownedRate)}${r.citations.ownedRank ? ` (코호트 ${r.cohortTotal}곳 중 ${r.citations.ownedRank}번째)` : ''}.</p></section>

${siteSection}

<section><p class="eyebrow">다음</p><h2>개선제안</h2>${recs}</section>

<footer>앱이 저장한 ${esc(r.weekOf)} 측정(스코어카드·질문별 판정·질문 은행·인용 분석)과 같은 주 코호트 카드에서 코드로 만든 문서다. 수치를 다시 계산하거나 새로 만들지 않았다. Site AEO는 ${r.site ? `${esc(weekLabel(r.site.weekOf))} 진단 기록` : '기록이 없다'}.</footer>
</div>
</body>
</html>
`
}
