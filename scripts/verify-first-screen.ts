/**
 * 개요(첫 화면) 숫자 — 변화 알림 · 점수 구성 · 사실성 경고 · 원문 마크다운 정리를 확인한다.
 *
 * 왜(2026-10-26 상용화 UI 3차 1-B, U8 · U20 · U23):
 *   - 앱을 열면 처음 보는 알림 「코호트 순위 상승 3위 → 1위」가 바로 아래 「공동 2 / 7」과 어긋났다(이번 주 처음 잰 브랜드가 빠지고,
 *     동점에 「공동」이 없었다).
 *   - 12점 중 10점이 순위 응답 2건에서 나왔는데 화면마다 비중을 달리 적어(25% · 8%) 다시 계산할 수 없었다.
 *   - 사실성 경고가 「openai / v5-006 #1」 같은 내부 기록 줄이었고, 진단 · EEAT 인용문에 「**」 · 「###」이 그대로 보였다.
 * 값은 실측을 흉내 낸 가짜다.
 *
 *   npx tsx scripts/verify-first-screen.ts
 */
import { computeAeoScore } from '../server/scoring'
import { computeAlerts, contradictedLine, factFlagSummary } from '../src/lib/alerts'
import { highlightAnswer, tidyMarkdown, tidySegments } from '../src/lib/answerHighlight'
import { aeoScoreOf, scoreBreakdown, weightTagText } from '../src/lib/b9-report'
import type { WeeklyScorecard } from '../src/prompts/b8-report'

const checks: [string, boolean][] = []
const ok = (label: string, cond: boolean) => checks.push([label, cond])

const base = {
  tenantId: 'me',
  brandName: '가상 스테이',
  enginesUsed: ['gemini', 'openai', 'perplexity'],
  judgeEngine: 'claude',
  modelsUsed: { gemini: 'g', openai: 'o', perplexity: 'p' },
  judgeModel: 'c',
  questionBankVersion: 'v5',
  repeatsPerQuestion: 1,
  hallucinationFlags: [],
  factualityScore: null,
  shareOfMention: null,
}
const card = (weekOf: string, score: number, extra: Record<string, unknown> = {}) =>
  ({
    ...base,
    weekOf,
    aeoScore: { current: score, ma4: score, previousWeek: score, ciLow: Math.max(0, score - 3), ciHigh: score + 3 },
    mentionRate: 0.026,
    brandOwnedCitationRate: 0.023,
    avgRecommendationRank: null,
    rankedResponses: 0,
    cohortRank: { position: 1, totalTenants: 1 },
    ...extra,
  }) as unknown as WeeklyScorecard

// 1) 점수 구성 — 순위 응답 2건이면 순위 몫이 25% × 2/6로 줄고, 나머지가 그만큼 커진다
const w43 = card('2026-W43', 12, { avgRecommendationRank: 1, rankedResponses: 2 })
const parts = new Map(scoreBreakdown(w43).map((p) => [p.key, p]))
const rank = parts.get('avgRecommendationRank')!
ok('점수 구성: 순위 이번 주 비중 10%(25% × 2/6를 재정규화)', Math.round(rank.weight * 100) === 10)
ok('점수 구성: 12점 중 약 10점이 순위에서', Math.round(rank.points ?? 0) === 10)
ok('점수 구성: 비중 합 100%', Math.abs([...parts.values()].reduce((s, p) => s + p.weight, 0) - 1) < 1e-9)
ok('점수 구성: 보탠 점수 합 = 점수', Math.round([...parts.values()].reduce((s, p) => s + (p.points ?? 0), 0)) === 12)
ok('가중치 꼬리표: 「가중치 25% → 이번 주 10%」', weightTagText(rank) === '가중치 25% → 이번 주 10%')
ok('가중치 꼬리표(짧게): 「25% → 10%」', weightTagText(rank, { short: true }) === '25% → 10%')
const noRank = new Map(scoreBreakdown(card('2026-W43', 3)).map((p) => [p.key, p]))
ok('순위가 없으면 「점수 제외」 · 보탠 점수 없음', weightTagText(noRank.get('avgRecommendationRank')!) === '점수 제외' && noRank.get('avgRecommendationRank')!.points === null)
ok('순위 응답 6건 이상이면 기본 가중치 그대로', weightTagText(scoreBreakdown(card('2026-W43', 30, { avgRecommendationRank: 2, rankedResponses: 6 })).find((p) => p.key === 'mentionRate')!) === '가중치 42%')

// 2) 순위 알림 — 동점은 「공동」, 이번 주 처음 잰 곳은 빠졌다고 밝히고, 우리보다 높으면 좋은 소식으로 내세우지 않는다(실측 W43 모양)
const prevMembers = [
  { tenantId: 'me', aeoScore: 1 },
  { tenantId: 'golmok', aeoScore: 9 },
  { tenantId: 'chowon', aeoScore: 3 },
  { tenantId: 'ok', aeoScore: 0 },
  { tenantId: 'seon', aeoScore: 0 },
]
const curMembers = [
  { tenantId: 'me', aeoScore: 12 },
  { tenantId: 'golmok', aeoScore: 12 },
  { tenantId: 'chowon', aeoScore: 10 },
  { tenantId: 'ok', aeoScore: 7 },
  { tenantId: 'seon', aeoScore: 1 },
  { tenantId: 'yeomi', aeoScore: 24 },
  { tenantId: 'haeoreum', aeoScore: 6 },
]
const w42 = card('2026-W42', 1, { cohortRank: { position: 3, totalTenants: 5, members: prevMembers } })
const w43r = card('2026-W43', 12, { avgRecommendationRank: 1, rankedResponses: 2, cohortRank: { position: 2, totalTenants: 7, tiedCount: 2, members: curMembers } })
const names: Record<string, string> = { yeomi: '여미랑' }
const alerts = computeAlerts([w42, w43r], { nameOf: (id) => names[id] })
const rankAlert = alerts.find((a) => a.title.includes('순위'))
ok('순위 알림: 기준(두 주 모두 잰 5곳)을 제목에', rankAlert?.title === '두 주 모두 잰 5곳 사이 순위 상승 3위 → 공동 1위')
ok('순위 알림: 이번 주 비교 그룹 전체 순위를 함께', rankAlert?.detail.includes('이번 주 비교 그룹 전체로는 공동 2 / 7입니다.') === true)
// 「처음 잰」이라고 단정하지 않는다 — 앞서 쟀다가 직전 주에 빠졌을 수 있다(1-B 검토)
ok('순위 알림: 직전 측정에 없던 곳(우리보다 높음)은 빠졌다고 이름과 함께', rankAlert?.detail.includes('직전 측정에 없던 여미랑(24점)은 이 비교에서 빠졌습니다.') === true)
ok('순위 알림: 그때는 「개선」이 아니라 「안내」', rankAlert?.level === 'info')
const noName = computeAlerts([w42, w43r]).find((a) => a.title.includes('순위'))
ok('순위 알림: 이름을 모르면 곳 수로', noName?.detail.includes('직전 측정에 없던 1곳은 이 비교에서 빠졌습니다.') === true)
ok('알림: 「코호트」 대신 「비교 그룹」', alerts.every((a) => !`${a.title} ${a.detail}`.includes('코호트')))

// 3) 큰 증감은 어디서 왔는지 — 순위 응답 2건이 만든 +11
const scoreAlert = alerts.find((a) => a.title.startsWith('Brand AEO Score'))
ok('점수 알림: 증감의 대부분이 추천 순위(순위 응답 2건)에서', scoreAlert?.detail.endsWith('이번 증감의 대부분은 추천 순위(순위 응답 2건)에서 나왔습니다.') === true)

// 4) 언급 점유율 — 점유율은 등록 경쟁사 목록으로 세어 비교 그룹 구성원과 상관이 없다. 「이 브랜드만 측정」으로 구성원이 줄어도
//    진짜 급락은 그대로 알린다(1-B 검토: 구성원 변화로 거르던 규칙이 실제 하락을 가렸다 — 뺐다).
const somAlerts = computeAlerts([
  card('2026-W42', 5, { shareOfMention: 0.45, cohortRank: { position: 1, totalTenants: 5, members: prevMembers } }),
  card('2026-W43', 5, { shareOfMention: 0.15, cohortRank: { position: 1, totalTenants: 1, members: [{ tenantId: 'me', aeoScore: 5 }] } }),
])
ok('점유율: 구성원이 바뀌어도 급락은 「주의」로 알린다', somAlerts.some((a) => a.title === '언급 점유율 급락' && a.level === 'warn'))

// 5) 사실성 — 내부 기록 줄 대신 무엇이 어긋났는지, 「판정 검토 전」, 보고서로 잇기
const flags = ['openai / v5-006 #1: 사실성 불일치 1건', 'gemini / v5-006 #1: 사실성 불일치 1건', 'gemini / v5-010 #1: 사실성 불일치 1건']
const factCard = card('2026-W43', 12, { hallucinationFlags: flags })
const claims = [{ question: '커플 여행 갈 때 스테이와 선연 중에 어디를 더 추천해?', engine: 'Gemini', said: '도보 3분', registered: '13m' }]
const withClaims = computeAlerts([factCard], { contradicted: claims })[0]!
ok('사실성 알림: 「주의」 · 응답 수 · 판정 검토 전', withClaims.level === 'warn' && withClaims.title === '사실 확인 필요 — AI 응답 3건 (판정 검토 전)')
ok('사실성 알림: 질문 · 엔진 · AI 값 ↔ 등록 값', withClaims.detail.startsWith('Gemini · 커플 여행 갈 때 스테이와 선연 중에 어디를 더 추…') && withClaims.detail.includes('AI “도보 3분” ↔ 등록 “13m”'))
// 제목은 응답 수, 목록은 주장 단위 — 「외 N건」이 응답 수로 읽히지 않게 「주장」이라고 밝힌다(1-B 검토)
const twoClaims = computeAlerts([factCard], { contradicted: [...claims, { question: '주소', engine: 'ChatGPT', said: '가상로 9', registered: '가상로 1' }] })[0]!
ok('사실성 알림: 나머지는 「외 주장 N건」', twoClaims.detail.endsWith(' 외 주장 1건'))
ok('사실성 알림: 보고서로 잇는다', withClaims.link?.to === '/report')
const noClaims = computeAlerts([factCard])[0]!
ok('사실성 알림: 주장 기록이 없으면 엔진별 응답 수만', noClaims.detail === 'ChatGPT 1건 · Gemini 2건의 응답이 등록된 브랜드 정보와 다릅니다.')
ok('사실성: 내부 값(엔진 id · 질문 id · 회차)을 쓰지 않는다', !/openai|v5-0|#\d/.test(`${withClaims.title} ${withClaims.detail} ${noClaims.detail}`))
ok('엔진별 요약: 모양이 다른 줄은 「기타」', factFlagSummary(['이상한 줄']) === '기타 1건')
ok('주장 한 줄: 짧은 질문은 그대로', contradictedLine({ question: '주소 알려줘', engine: 'ChatGPT', said: '가상로 9', registered: '가상로 1' }) === 'ChatGPT · 주소 알려줘 — AI “가상로 9” ↔ 등록 “가상로 1”')

// 6) 증감 출처 — 항목마다 「직전 측정에 이번 주 그 값만 넣었을 때」로 본다. 순위가 빠져 비중이 재정규화된 증감을 언급률로
//    짚지 않는다(1-B 검토: 언급률 70% · 자사 인용 30% 그대로, 순위 6.4위 · 6건 → 없음이면 39 → 52인데 「언급률에서」라고 했다)
const realScore = (mentionRate: number, owned: number, rank: number | null, responses: number) =>
  computeAeoScore({ mentionRate, brandOwnedCitationRate: owned, avgRecommendationRank: rank, rankWeight: rank === null ? 0 : Math.min(1, responses / 6), mentionSentiment: 1 })
const renormPrev = card('2026-W42', realScore(0.7, 0.3, 6.4, 6), { mentionRate: 0.7, brandOwnedCitationRate: 0.3, avgRecommendationRank: 6.4, rankedResponses: 6 })
const renormCur = card('2026-W43', realScore(0.7, 0.3, null, 0), { mentionRate: 0.7, brandOwnedCitationRate: 0.3, avgRecommendationRank: null, rankedResponses: 0 })
const renorm = computeAlerts([renormPrev, renormCur]).find((a) => a.title.startsWith('Brand AEO Score'))
ok('증감 출처: 순위가 빠져 오른 점수는 「추천 순위가 점수에서 빠진 데서」', renorm?.detail.endsWith('이번 증감의 대부분은 추천 순위가 점수에서 빠진 데서 나왔습니다(순위가 매겨진 응답 없음).') === true)
const mentionPrev = card('2026-W42', realScore(0.2, 0.1, 2, 6), { mentionRate: 0.2, brandOwnedCitationRate: 0.1, avgRecommendationRank: 2, rankedResponses: 6 })
const mentionCur = card('2026-W43', realScore(0.5, 0.1, 2, 6), { mentionRate: 0.5, brandOwnedCitationRate: 0.1, avgRecommendationRank: 2, rankedResponses: 6 })
const mentionUp = computeAlerts([mentionPrev, mentionCur]).find((a) => a.title.startsWith('Brand AEO Score'))
ok('증감 출처: 언급률만 오르면 「언급률에서」', mentionUp?.detail.endsWith('이번 증감의 대부분은 언급률에서 나왔습니다.') === true)
// 화면의 점수 식이 서버 식(server/scoring.ts)과 같은 값을 낸다 — 증감 출처 · 점수 구성이 이 식에 기댄다
const grid: [number, number, number | null, number, number][] = []
for (const m of [0, 0.03, 0.4, 1]) for (const o of [0, 0.02, 0.3]) for (const r of [null, 1, 3.5, 6.4]) for (const n of [0, 1, 2, 6]) for (const s of [0.2, 0.7, 1]) grid.push([m, o, r, n, s])
ok(
  '점수 식: 화면 aeoScoreOf = 서버 computeAeoScore(격자 576가지)',
  grid.every(([m, o, r, n, s]) =>
    aeoScoreOf({ mentionRate: m, sentiment: s, brandOwnedCitationRate: o, avgRecommendationRank: r, rankedResponses: n }) ===
    computeAeoScore({ mentionRate: m, brandOwnedCitationRate: o, avgRecommendationRank: r, rankWeight: r === null ? 0 : Math.min(1, n / 6), mentionSentiment: s }),
  ),
)

// 7) 원문 마크다운 정리 — 글자는 남기고 기호만 걷는다
ok('마크다운: 굵게 · 제목', tidyMarkdown('### 군산 **스테이, 머뭄**은') === '군산 스테이, 머뭄은')
ok('마크다운: 표 줄은 칸을 「·」로, 구분 줄은 뺀다', tidyMarkdown('| 항목 | 스테이 |\n|---|---|\n| 객실 | **독채** |') === '항목 · 스테이\n객실 · 독채')
const segs = tidySegments([
  { text: '## 추천\n군산 **', kind: null },
  { text: '스테이, 머뭄', kind: 'mention' },
  { text: '**은 ### 좋아요', kind: null },
])
ok('하이라이트 조각: 칠한 글자는 그대로, 굵게 기호만 걷는다', segs.map((s) => s.text).join('|') === '추천\n군산 |스테이, 머뭄|은 ### 좋아요')
ok('하이라이트 조각: 줄 가운데의 「###」은 제목 기호로 보지 않는다', segs[2]!.text.includes('###'))
// 표 한 칸 값만 칠해도 칸 이름과 붙지 않는다(1-B 검토: 「위치역에서 도보 3분」)
const table = '| 항목 | 내용 |\n|---|---|\n| 위치 | 역에서 도보 3분 |\n| 가격 | 15만 원 |'
const tableSegs = tidySegments(highlightAnswer(table, [{ text: '역에서 도보 3분', kind: 'wrong' }]).segments)
ok('표 칸 하이라이트: 「위치 · 역에서 도보 3분」', tableSegs.map((x) => x.text).join('') === tidyMarkdown(table) && tidyMarkdown(table).includes('위치 · 역에서 도보 3분'))
ok('표 칸 하이라이트: 칠한 글자는 그대로', tableSegs.some((x) => x.kind === 'wrong' && x.text === '역에서 도보 3분'))

let failed = 0
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`)
  if (!pass) failed += 1
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`)
  process.exit(1)
}
console.log(`\n모두 통과 (${checks.length}건)`)
