import type { EeatAnalysis } from '../prompts/b6-eeat'
import type { WeeklyScorecard } from '../prompts/b8-report'
import { formatPct, formatRank } from './format'

// B9 — 주간 스코어카드를 결정적 규칙으로 진단하고 개선제안을 도출한다.
// 점수·수치는 이미 확정된 입력이며, 여기서는 "해석"과 "실행안"만 규칙 기반으로 붙인다(새 수치 생성 금지).

export type MetricStatus = 'good' | 'ok' | 'warn' | 'bad' | 'unknown'
export type Priority = 'high' | 'medium' | 'low'

export const STATUS_LABEL: Record<MetricStatus, string> = {
  good: '양호',
  ok: '보통',
  warn: '주의',
  bad: '미흡',
  unknown: '확인 불가',
}
export const PRIORITY_LABEL: Record<Priority, string> = { high: '높음', medium: '중간', low: '낮음' }

export interface MetricDiagnosis {
  key: string
  label: string
  weight: number
  valueText: string
  status: MetricStatus
  note: string
  delta?: { text: string; tone: 'up' | 'down' | 'flat' }
}

export interface Recommendation {
  id: string
  title: string
  priority: Priority
  basis: string
  actions: string[]
  expected: string
  links: { label: string; to: string }[]
}

export interface PeriodicReport {
  verdict: { tone: MetricStatus; label: string; summary: string }
  metrics: MetricDiagnosis[]
  strengths: MetricDiagnosis[]
  risks: string[]
  recommendations: Recommendation[]
  variabilityNote: string | null
}

// 지표별 가중치(AEO Score 계산과 동일). 개선제안 우선순위 산정에 재사용.
const WEIGHT = {
  mentionRate: 0.35,
  shareOfMention: 0.25,
  avgRecommendationRank: 0.15,
  factualityScore: 0.15,
  brandOwnedCitationRate: 0.1,
}

const SEVERITY: Record<MetricStatus, number> = { bad: 1, warn: 0.6, unknown: 0.5, ok: 0.25, good: 0 }

function rateStatus(v: number, good: number, ok: number, warn: number): MetricStatus {
  if (v >= good) return 'good'
  if (v >= ok) return 'ok'
  if (v >= warn) return 'warn'
  return 'bad'
}

function pctDelta(
  cur: number | null,
  prev: number | null | undefined,
  lowerIsBetter = false,
): MetricDiagnosis['delta'] {
  if (cur === null || prev === null || prev === undefined) return undefined
  const d = Math.round((cur - prev) * 1000) / 10 // 퍼센트포인트, 소수1
  if (d === 0) return { text: '보합', tone: 'flat' }
  const improved = lowerIsBetter ? d < 0 : d > 0
  return { text: `${d > 0 ? '+' : ''}${d}%p`, tone: improved ? 'up' : 'down' }
}

function rankDelta(cur: number | null, prev: number | null | undefined): MetricDiagnosis['delta'] {
  if (cur === null || prev === null || prev === undefined) return undefined
  const d = Math.round((cur - prev) * 10) / 10
  if (d === 0) return { text: '보합', tone: 'flat' }
  // 순위는 낮을수록 좋다 → 감소가 개선
  return { text: `${d > 0 ? '+' : ''}${d}`, tone: d < 0 ? 'up' : 'down' }
}

function diagnoseMetrics(card: WeeklyScorecard, prev?: WeeklyScorecard, eeat?: EeatAnalysis): MetricDiagnosis[] {
  const out: MetricDiagnosis[] = []

  // 1) 카테고리 무관 언급률
  {
    const s = rateStatus(card.mentionRate, 0.5, 0.35, 0.2)
    out.push({
      key: 'mentionRate',
      label: '카테고리 무관 언급률',
      weight: WEIGHT.mentionRate,
      valueText: formatPct(card.mentionRate),
      status: s,
      note:
        s === 'good'
          ? '브랜드명을 넣지 않은 자연어 질문에서도 잘 노출됩니다.'
          : '브랜드명을 넣지 않은 질문에서 답변에 등장하는 비율이 낮습니다.',
      delta: pctDelta(card.mentionRate, prev?.mentionRate),
    })
  }

  // 2) Share of Mention
  {
    const v = card.shareOfMention
    const s: MetricStatus = v === null ? 'unknown' : rateStatus(v, 0.4, 0.28, 0.15)
    out.push({
      key: 'shareOfMention',
      label: 'Share of Mention',
      weight: WEIGHT.shareOfMention,
      valueText: formatPct(v),
      status: s,
      note:
        v === null
          ? '경쟁사가 설정되지 않아 점유율을 측정할 수 없습니다.'
          : s === 'good'
            ? '경쟁 브랜드 대비 언급 점유가 높습니다.'
            : '경쟁사가 함께 언급되는 질문에서 점유가 낮습니다.',
      delta: pctDelta(v, prev?.shareOfMention),
    })
  }

  // 3) 평균 추천 순위 (낮을수록 좋음)
  {
    const v = card.avgRecommendationRank
    let s: MetricStatus = 'unknown'
    if (v !== null) s = v <= 2 ? 'good' : v <= 3 ? 'ok' : v <= 4 ? 'warn' : 'bad'
    out.push({
      key: 'avgRecommendationRank',
      label: '평균 추천 순위',
      weight: WEIGHT.avgRecommendationRank,
      valueText: formatRank(v),
      status: s,
      note:
        v === null
          ? '추천·나열형 문맥이 부족해 순위를 판정할 수 없습니다.'
          : s === 'good'
            ? 'AI가 추천을 나열할 때 상위에 배치됩니다.'
            : 'AI가 여러 브랜드를 추천할 때 상대적으로 하위에 놓입니다.',
      delta: rankDelta(v, prev?.avgRecommendationRank),
    })
  }

  // 4) 사실성
  {
    let s = rateStatus(card.factualityScore, 0.9, 0.8, 0.6)
    if (card.hallucinationFlags.length > 0 && (s === 'good' || s === 'ok')) s = 'warn'
    out.push({
      key: 'factualityScore',
      label: '사실성',
      weight: WEIGHT.factualityScore,
      valueText: formatPct(card.factualityScore),
      status: s,
      note:
        card.hallucinationFlags.length > 0
          ? `Fact Graph와 모순되는 주장이 ${card.hallucinationFlags.length}건 관측됐습니다.`
          : s === 'good'
            ? '답변이 사실 정보와 대체로 일치합니다.'
            : '답변에 사실과 어긋나는 서술이 포함될 여지가 있습니다.',
      delta: pctDelta(card.factualityScore, prev?.factualityScore),
    })
  }

  // 5) 브랜드 소유 출처 인용률
  {
    const s = rateStatus(card.brandOwnedCitationRate, 0.3, 0.15, 0.05)
    out.push({
      key: 'brandOwnedCitationRate',
      label: '브랜드 소유 출처 인용',
      weight: WEIGHT.brandOwnedCitationRate,
      valueText: formatPct(card.brandOwnedCitationRate),
      status: s,
      note:
        s === 'good'
          ? 'AI 답변의 인용이 자사 도메인으로 잘 연결됩니다.'
          : 'AI가 근거로 삼는 출처가 자사 콘텐츠로 거의 연결되지 않습니다.',
      delta: pctDelta(card.brandOwnedCitationRate, prev?.brandOwnedCitationRate),
    })
  }

  // 6) EEAT (보조 지표, 있을 때만)
  if (eeat && eeat.totalCallCount > 0) {
    const s = rateStatus(eeat.overall, 0.6, 0.45, 0.3)
    out.push({
      key: 'eeat',
      label: 'EEAT 종합',
      weight: 0, // 점수 가중치엔 없으나 진단 참고
      valueText: formatPct(eeat.overall),
      status: s,
      note:
        s === 'good'
          ? '경험·전문성·권위·신뢰 신호가 고르게 나타납니다.'
          : 'AI 답변에서 전문성·권위·신뢰 신호가 약하게 나타납니다.',
    })
  }

  return out
}

const REC_LINKS = {
  questions: { label: 'S-04 질문 프롬프트 빌더', to: '/questions' },
  diagnosis: { label: 'S-02 브랜드 종합 진단', to: '/diagnosis' },
  site: { label: 'S-03 사이트 종합 진단', to: '/site-diagnosis' },
  citations: { label: 'S-05 URL 상세 분석', to: '/citations' },
  sources: { label: 'S-10 AI 인용출처 분석', to: '/citation-sources' },
  ranking: { label: 'S-07 랭킹 분석', to: '/ranking' },
  eeat: { label: 'S-09 EEAT 분석', to: '/eeat' },
  onboarding: { label: 'S-08 브랜드 추가', to: '/brand-onboarding' },
}

function priorityOf(weight: number, status: MetricStatus): Priority {
  const impact = (weight || 0.1) * SEVERITY[status]
  if (impact >= 0.2) return 'high'
  if (impact >= 0.1) return 'medium'
  return 'low'
}

// 지표 상태 → 개선제안. warn/bad/unknown 인 지표에만 생성한다.
function buildRecommendations(metrics: MetricDiagnosis[], card: WeeklyScorecard): Recommendation[] {
  const by = Object.fromEntries(metrics.map((m) => [m.key, m])) as Record<string, MetricDiagnosis>
  const recs: Recommendation[] = []
  const weak = (k: string) => by[k] && (by[k].status === 'warn' || by[k].status === 'bad' || by[k].status === 'unknown')

  if (weak('mentionRate')) {
    const m = by.mentionRate
    recs.push({
      id: 'mention',
      title: '카테고리 무관 노출 확대',
      priority: priorityOf(m.weight, m.status),
      basis: `현재 언급률 ${m.valueText} — 브랜드명 없는 질문에서의 노출이 부족합니다.`,
      actions: [
        '업종·지역·니즈(증상/상황) 기반의 공개 가이드·FAQ 콘텐츠를 확충해 자연어 질문의 답이 되도록 합니다.',
        '"○○ 지역 추천", "○○ 잘하는 곳" 류의 제3자 비교·추천 글에 포함되도록 노출을 늘립니다.',
        '핵심 페이지에 구조화 데이터(JSON-LD)와 명확한 제목·요약을 넣어 AI가 인용하기 쉽게 만듭니다.',
      ],
      expected: '가중치 35%로 점수 기여가 가장 큰 지표 — 개선 시 AEO Score 상승 폭이 큽니다.',
      links: [REC_LINKS.questions, REC_LINKS.sources],
    })
  }

  if (weak('shareOfMention')) {
    const m = by.shareOfMention
    const isUnknown = m.status === 'unknown'
    recs.push({
      id: 'som',
      title: isUnknown ? '경쟁사 설정으로 점유율 측정 시작' : '경쟁 대비 언급 점유 강화',
      priority: priorityOf(m.weight, m.status),
      basis: isUnknown
        ? '경쟁사가 설정되지 않아 Share of Mention을 측정하지 못하고 있습니다(점수에서 제외·재정규화).'
        : `현재 SoM ${m.valueText} — 경쟁사가 함께 언급되는 질문에서 밀리고 있습니다.`,
      actions: isUnknown
        ? ['S-08에서 주요 경쟁사를 등록하면 다음 측정부터 점유율이 산출됩니다.']
        : [
            '경쟁사와 함께 거론되는 질문에서 차별화 포인트(시술/후기/가격 투명성 등)를 공개 콘텐츠로 명확히 합니다.',
            '후기·평점 플랫폼과 지역 커뮤니티에서의 노출·언급을 늘려 비교 문맥에서 우위를 확보합니다.',
          ],
      expected: isUnknown ? '점유율 지표가 활성화되어 진단 정확도가 올라갑니다.' : '가중치 25% 지표 — 비교형 질문에서의 우위가 점수에 직접 반영됩니다.',
      links: isUnknown ? [REC_LINKS.onboarding] : [REC_LINKS.diagnosis, REC_LINKS.ranking],
    })
  }

  if (weak('avgRecommendationRank')) {
    const m = by.avgRecommendationRank
    recs.push({
      id: 'rank',
      title: '추천 순위 끌어올리기',
      priority: priorityOf(m.weight, m.status),
      basis:
        m.status === 'unknown'
          ? '추천·나열형 문맥이 적어 순위가 판정되지 않습니다.'
          : `현재 평균 추천 순위 ${m.valueText} — AI 추천 나열에서 하위에 배치됩니다.`,
      actions: [
        '권위 있는 제3자 추천·수상·"1위/베스트" 신호를 확보해 AI가 상위로 인식하도록 합니다.',
        '리뷰 수·평점·최신 후기를 늘려 추천 근거를 강화합니다.',
      ],
      expected: '가중치 15% 지표 — 추천형 질문 비중이 큰 업종에서 특히 효과적입니다.',
      links: [REC_LINKS.ranking],
    })
  }

  if (weak('factualityScore')) {
    const m = by.factualityScore
    recs.push({
      id: 'fact',
      title: '사실 오류 정정 및 공식 정보 정비',
      priority: Math.max(0, card.hallucinationFlags.length) > 0 ? 'high' : priorityOf(m.weight, m.status),
      basis:
        card.hallucinationFlags.length > 0
          ? `AI가 사실과 어긋난 주장을 ${card.hallucinationFlags.length}건 생성: ${card.hallucinationFlags.slice(0, 3).join(' / ')}`
          : `사실성 ${m.valueText} — 답변에 부정확한 서술이 섞일 여지가 있습니다.`,
      actions: [
        '주소·진료(취급) 항목·가격·자격/이력 등 핵심 사실을 공식 페이지에 최신 상태로 명확히 게시합니다.',
        '오정보의 근거가 된 외부 출처(오래된 소개글 등)를 찾아 정정·갱신을 요청합니다.',
        '구조화 데이터로 핵심 사실을 기계가 읽기 쉽게 제공해 혼동을 줄입니다.',
      ],
      expected: '사실성 오류는 신뢰 훼손 위험이 커 우선 처리 대상입니다.',
      links: [REC_LINKS.diagnosis, REC_LINKS.site],
    })
  }

  if (weak('brandOwnedCitationRate')) {
    const m = by.brandOwnedCitationRate
    recs.push({
      id: 'citation',
      title: '자사 출처 인용 가능성 개선',
      priority: priorityOf(m.weight, m.status),
      basis: `자사 출처 인용률 ${m.valueText} — AI가 근거로 자사 콘텐츠를 거의 참조하지 않습니다.`,
      actions: [
        '자바스크립트 없이도 읽히는 정적 콘텐츠를 확보합니다(비-JS 크롤러 패리티 — S-03 참고).',
        '인용하기 좋은 "팩트/요약" 페이지를 만들고 llms.txt·구조화 데이터로 접근성을 높입니다.',
        'AI가 실제로 인용 중인 제3자 출처를 파악해 그 출처에 자사 정보가 반영되도록 합니다.',
      ],
      expected: '가중치 10% 지표지만, 인용 연결은 신뢰·전환에 직접 기여합니다.',
      links: [REC_LINKS.site, REC_LINKS.citations, REC_LINKS.sources],
    })
  }

  if (weak('eeat')) {
    const m = by.eeat
    recs.push({
      id: 'eeat',
      title: 'EEAT 신호 보강',
      priority: 'low',
      basis: `EEAT 종합 ${m.valueText} — 전문성·권위·신뢰 신호가 약하게 나타납니다.`,
      actions: [
        '전문가(원장/자격)·실제 경험(후기)·권위 있는 제3자 언급을 공개 콘텐츠에 드러냅니다.',
      ],
      expected: '답변의 어조·추천 맥락을 우호적으로 만들어 다른 지표를 함께 끌어올립니다.',
      links: [REC_LINKS.eeat],
    })
  }

  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 }
  return recs.sort((a, b) => order[a.priority] - order[b.priority])
}

export function buildPeriodicReport(
  history: WeeklyScorecard[],
  weekOf: string,
  eeat?: EeatAnalysis,
): PeriodicReport | null {
  const idx = history.findIndex((h) => h.weekOf === weekOf)
  const card = idx >= 0 ? history[idx] : history.at(-1)
  if (!card) return null
  const prev = idx > 0 ? history[idx - 1] : undefined

  const metrics = diagnoseMetrics(card, prev, eeat)
  const strengths = metrics.filter((m) => m.status === 'good')
  const recommendations = buildRecommendations(metrics, card)

  // 종합 판정
  const badCount = metrics.filter((m) => m.status === 'bad').length
  const warnCount = metrics.filter((m) => m.status === 'warn').length
  const trend = card.aeoScore.current - card.aeoScore.previousWeek
  const trendText = trend > 0 ? `전주 대비 +${trend}` : trend < 0 ? `전주 대비 ${trend}` : '전주와 보합'
  let tone: MetricStatus
  let label: string
  if (card.aeoScore.current >= 60 && badCount === 0) {
    tone = 'good'
    label = '전반적으로 양호'
  } else if (card.aeoScore.current >= 40 && badCount <= 1) {
    tone = 'warn'
    label = '부분 개선 필요'
  } else {
    tone = 'bad'
    label = '개선 필요'
  }
  const summary = `AEO Score ${card.aeoScore.current}점(4주 이동평균 ${card.aeoScore.ma4}, ${trendText}). 미흡 ${badCount}개·주의 ${warnCount}개 지표가 있으며, 아래 ${recommendations.length}개 개선제안을 우선순위대로 제시합니다.`

  const ciWidth = card.aeoScore.ciHigh - card.aeoScore.ciLow
  const variabilityNote =
    ciWidth > 25
      ? `95% 신뢰구간이 ${card.aeoScore.ciLow}–${card.aeoScore.ciHigh}로 넓습니다(변동성 큼). 이번 주 단일 변동은 과잉 해석하지 말고 4주 이동평균(${card.aeoScore.ma4}) 추세로 판단하세요.`
      : null

  return {
    verdict: { tone, label, summary },
    metrics,
    strengths,
    risks: card.hallucinationFlags,
    recommendations,
    variabilityNote,
  }
}
