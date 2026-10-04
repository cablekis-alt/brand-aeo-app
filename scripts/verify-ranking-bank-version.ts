/**
 * 경쟁 순위의 언급 점유(SoM)가 **그 주에 쓴 질문지**로 이름 없는 질문을 골라내는지 확인한다.
 *
 * 2026-10-04: SK하이닉스 경쟁 순위 화면이 「질문 은행을 읽지 못해 전체 응답으로 집계」로 나왔다. W37은
 * 질문지 v3로 쟀는데 화면은 지금 설정(v4)을 읽었고, 두 질문지의 질문 id가 하나도 겹치지 않아 이름 없는
 * 질문을 하나도 못 골랐다 — 그래서 이름 넣은 질문까지 세어 자사 점유가 부풀었다(51.3% → 53.1%).
 * 아래는 같은 상황을 가짜 데이터로 만든다: 측정은 v-old, 설정은 v-new.
 *
 *   npx tsx scripts/verify-ranking-bank-version.ts
 */
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import { getRankingView } from '../server/queries';
import type { QuestionBank } from '../server/store';
import type { QuestionRepeatAnalysis } from '../server/types';

const WEEK = '2026-W37';
const BRAND = '테스트브랜드';

const bank = (version: string, prefix: string) =>
  ({
    version,
    questions: [
      { questionId: `${prefix}-1`, category: 'category-agnostic', text: '이름 없는 질문' },
      { questionId: `${prefix}-2`, category: 'brand-direct', text: `${BRAND}는 어떤가요?` },
    ],
  }) as unknown as QuestionBank;
const banks: Record<string, QuestionBank> = { 'v-old': bank('v-old', 'old'), 'v-new': bank('v-new', 'new') };

const analysis = (questionId: string, own: number, competitor: number) =>
  ({
    questionId,
    engine: 'gemini',
    mentioned: own > 0,
    clarifying: false,
    mentionSentences: Array.from({ length: own }, () => '언급 문장'),
    competitorMentions: competitor > 0 ? [{ name: '경쟁사A', mentionCount: competitor }] : [],
    topRecommendation: null,
  }) as unknown as QuestionRepeatAnalysis;
// 이름 없는 질문: 자사 1 · 경쟁사 1 → SoM 50%. 이름 넣은 질문까지 세면 자사 4 · 경쟁사 1 → 80%.
const analyses = [analysis('old-1', 1, 1), analysis('old-2', 3, 0)];

const card = {
  tenantId: 'test-brand',
  brandName: BRAND,
  weekOf: WEEK,
  industry: '테스트업종',
  region: '테스트지역',
  questionBankVersion: 'v-old',
  aeoScore: { current: 10 },
  mentionRate: 0.5,
  brandOwnedCitationRate: 0,
  avgRecommendationRank: null,
  rankedResponses: 0,
  shareOfMention: 0.5,
} as unknown as WeeklyScorecard;

const store = {
  getQuestionAnalyses: async () => analyses,
  getCohortScorecards: async (_industry: string, _region: string, weekOf: string) => (weekOf === WEEK ? [card] : []),
  getQuestionBank: async (_tenantId: string, version: string) => banks[version] ?? null,
};

const view = await getRankingView(
  store,
  { tenantId: 'test-brand', brandName: BRAND, industry: '테스트업종', region: '테스트지역', questionBankVersion: 'v-new' },
  WEEK,
);

const own = view.competitorShareOfMention.find((e) => e.name === BRAND)?.share ?? null;
const checks: [string, boolean, string][] = [
  ['모집단이 이름 없는 질문', view.mentionScope === 'category-agnostic', view.mentionScope],
  ['자사 SoM 50%', own === 0.5, own === null ? '없음' : `${(own * 100).toFixed(1)}%`],
  [
    '이름 넣은/없는 질문 나눔이 됨',
    view.promptedSplit?.named.answered === 1 && view.promptedSplit.unnamed.answered === 1,
    JSON.stringify(view.promptedSplit),
  ],
];
let failed = 0;
for (const [label, ok, actual] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label} — 실제: ${actual}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n모두 통과');
