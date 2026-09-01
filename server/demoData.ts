import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { Engine, FactGraphNode, QuestionCategory, QuestionSpec } from '../src/prompts/types.js';
import demoScorecards from '../src/data/demo-scorecards.json' with { type: 'json' };
import liveQuestionBank from '../src/data/live-question-bank.json' with { type: 'json' };
import liveQuestionAnalyses from '../src/data/live-question-analyses.json' with { type: 'json' };
import liveStayQuestionBank from '../src/data/live-stay-question-bank.json' with { type: 'json' };
import liveStayQuestionAnalyses from '../src/data/live-stay-question-analyses.json' with { type: 'json' };
import type { QuestionBank } from './store.js';
import type {
  CitationDetail,
  CompetitorMentionDetail,
  FactClaimDetail,
  MentionSentence,
  QuestionRepeatAnalysis,
} from './types.js';

/**
 * 배포 환경(서버리스)에는 파이프라인이 쓴 data/ 디렉터리가 없다. 화면을 빈 상태로 두지 않으려고
 * 스코어카드가 확정한 주간 지표에서 역으로 판정 레코드를 만들어 낸다. 난수를 쓰지 않고 인덱스
 * 기반으로 배분하므로 같은 주차는 항상 같은 결과가 나오고, 화면에서 다시 집계해도 스코어카드와
 * 어긋나지 않는다.
 */

export interface DemoTenant {
  tenantId: string;
  brandName: string;
  industry: string;
  region: string;
  engines: Engine[];
  ownedDomains: string[];
  competitors: { name: string; domains: string[] }[];
  questionBankVersion: string;
  factGraph: FactGraphNode[];
}

interface DemoQuestion {
  questionId: string;
  text: string;
  topic: string;
  category: QuestionCategory;
  containsBrandName: boolean;
  /** B5-C 추천 순위 판정이 성립하는 질문인지. */
  ranked: boolean;
  /** B5-D Fact Graph 대조가 가능한 사실 주장을 유도하는 질문인지. */
  factual: boolean;
}

// 업종별 데모 질문 세트. questionId·category·ranked·factual·containsBrandName는 위치별로 동일하게 두고
// text·topic만 바꾼다 — 그래야 스코어카드 역산 로직(demoQuestionAnalyses)이 업종과 무관하게 같은 구조로 재현된다.
// category-agnostic 비중 8/12 = 67% — b1-question-bank의 60% 하한을 넘긴다.
const CLINIC_QUESTIONS: DemoQuestion[] = [
  { questionId: 'q-air-purifier-pick', text: '강남에서 코성형 잘하는 곳 어디야?', topic: '코성형', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-washer-2026', text: '눈성형 병원 추천해줘.', topic: '눈성형', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-quiet-aircon', text: '강남 가슴성형은 어느 병원이 나아?', topic: '가슴성형', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-fridge-single', text: '리프팅 잘하는 성형외과를 알려줘.', topic: '리프팅', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-energy-efficient', text: '자연스러운 얼굴 성형을 찾는다면 어디를 봐야 해?', topic: '얼굴 성형', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-robot-vacuum', text: '강남 성형외과를 고를 때 뭘 봐야 해?', topic: '병원 선택 기준', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-dryer-review', text: '쌍꺼풀 재수술 후기가 좋은 곳은 어디야?', topic: '재수술', category: 'category-agnostic', containsBrandName: false, ranked: false, factual: false },
  { questionId: 'q-service-access', text: '안전 시스템이 잘 된 성형외과는 어디야?', topic: '안전 시스템', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-brand-reputation', text: '예시브랜드 평판은 어때?', topic: '브랜드 평판', category: 'brand-direct', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-price-flagship', text: '예시브랜드는 어디에 있어?', topic: '병원 위치', category: 'price-spec', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-vs-competitor-a', text: '예시브랜드랑 경쟁브랜드A 중에 어디가 나아?', topic: '경쟁 비교', category: 'comparison', containsBrandName: true, ranked: true, factual: true },
  { questionId: 'q-seoul-store', text: '신논현역 근처 성형외과를 추천해줘.', topic: '신논현 성형외과', category: 'local-regional', containsBrandName: false, ranked: true, factual: false },
];

const STAY_QUESTIONS: DemoQuestion[] = [
  { questionId: 'q-air-purifier-pick', text: '군산에서 하룻밤 묵기 좋은 스테이 추천해줘.', topic: '숙소 추천', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-washer-2026', text: '군산 감성 숙소 어디가 좋아?', topic: '감성 숙소', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-quiet-aircon', text: '군산 여행 갈 때 묵을 독채 스테이 있어?', topic: '독채 스테이', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-fridge-single', text: '군산 바다 근처 숙소 추천해줘.', topic: '바다 근처 숙소', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-energy-efficient', text: '조용하게 쉬기 좋은 군산 스테이를 찾는다면?', topic: '휴식 스테이', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-robot-vacuum', text: '군산 숙소 고를 때 뭘 봐야 해?', topic: '숙소 선택 기준', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-dryer-review', text: '군산 게스트하우스 후기 좋은 곳은?', topic: '숙소 후기', category: 'category-agnostic', containsBrandName: false, ranked: false, factual: false },
  { questionId: 'q-service-access', text: '조식이 잘 나오는 군산 스테이 있어?', topic: '조식 제공', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-brand-reputation', text: '예시브랜드 후기는 어때?', topic: '브랜드 평판', category: 'brand-direct', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-price-flagship', text: '예시브랜드 체크인 시간은 언제야?', topic: '체크인 시간', category: 'price-spec', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-vs-competitor-a', text: '예시브랜드랑 경쟁브랜드A 중에 어디가 나아?', topic: '경쟁 비교', category: 'comparison', containsBrandName: true, ranked: true, factual: true },
  { questionId: 'q-seoul-store', text: '군산 근대역사거리 근처 숙소 추천해줘.', topic: '근대역사거리 인근', category: 'local-regional', containsBrandName: false, ranked: true, factual: false },
];

/** 업종에 맞는 데모 질문 세트를 고른다. 숙박·스테이 계열이면 STAY, 그 외에는 CLINIC. */
function questionsFor(tenant: Pick<DemoTenant, 'industry'>): DemoQuestion[] {
  return /숙박|스테이|호텔|펜션|게스트하우스|리조트/.test(tenant.industry) ? STAY_QUESTIONS : CLINIC_QUESTIONS;
}

const AUTHORITY_DOMAINS = ['hidoc.co.kr', 'namu.wiki', 'consumer.go.kr'];
const UGC_DOMAINS = ['blog.naver.com', 'cafe.naver.com', 'youtube.com'];

/** 순위 판정이 붙은 응답 중 자사가 1순위로 뽑히는 비율. */
const TOP_RANK_SHARE = 0.15;

/** total개 중 정확히 count개가 되도록 index번째 항목을 고르게 뽑는다. */
function evenCount(index: number, total: number, count: number): boolean {
  if (total <= 0 || count <= 0) return false;
  const ratio = count / total;
  return Math.floor((index + 1) * ratio) > Math.floor(index * ratio);
}

function scorecardFor(tenantId: string, weekOf: string): WeeklyScorecard | null {
  const all = demoScorecards as WeeklyScorecard[];
  return all.find((card) => card.tenantId === tenantId && card.weekOf === weekOf) ?? null;
}

export function demoScorecardHistory(tenantId: string): WeeklyScorecard[] {
  return (demoScorecards as WeeklyScorecard[])
    .filter((card) => card.tenantId === tenantId)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}

export function demoCohortScorecards(industry: string, region: string, weekOf: string): WeeklyScorecard[] {
  return (demoScorecards as WeeklyScorecard[]).filter(
    (card) => card.industry === industry && card.region === region && card.weekOf === weekOf,
  );
}

interface LiveAnalysesFile {
  tenantId: string;
  weekOf: string;
  analyses: QuestionRepeatAnalysis[];
}

/**
 * 실제 파이프라인을 돌려 얻은 산출물. 테넌트별로 등록하며, 등록된 테넌트는 합성 데모 대신
 * 이 실측 데이터를 그대로 내려준다 (파이프라인이 쓴 data/ 디렉터리가 없는 배포 환경용).
 */
const LIVE_BANKS: Record<string, QuestionBank> = {
  'example-brand': liveQuestionBank as QuestionBank,
  'stay-meomum': liveStayQuestionBank as QuestionBank,
};

const LIVE_ANALYSES: LiveAnalysesFile[] = [
  liveQuestionAnalyses as LiveAnalysesFile,
  liveStayQuestionAnalyses as LiveAnalysesFile,
];

export function demoQuestionBank(tenant: DemoTenant, weekOf: string): QuestionBank {
  const live = LIVE_BANKS[tenant.tenantId];
  if (live && live.version === tenant.questionBankVersion && Array.isArray(live.questions) && live.questions.length > 0) {
    return live;
  }
  return {
    version: tenant.questionBankVersion,
    generatedAt: `${isoDateOfWeek(weekOf)}T03:00:00.000Z`,
    questions: questionsFor(tenant).map<QuestionSpec>((question) => ({
      questionId: question.questionId,
      text: question.text.replace('예시브랜드', tenant.brandName).replace('경쟁브랜드A', tenant.competitors[0]?.name ?? '경쟁사'),
      category: question.category,
      industry: tenant.industry,
      region: tenant.region,
      containsBrandName: question.containsBrandName,
      version: tenant.questionBankVersion,
    })),
  };
}

/** ISO 주차 문자열("2026-W36")의 월요일 날짜. 질문 은행 생성 시각 표기에만 쓴다. */
function isoDateOfWeek(weekOf: string): string {
  const match = weekOf.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return '2026-01-01';
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

interface Slot {
  question: DemoQuestion;
  engine: Engine;
  callIndex: number;
}

function buildSlots(questions: DemoQuestion[], engines: Engine[]): Slot[] {
  const slots: Slot[] = [];
  for (const question of questions) {
    for (const engine of engines) {
      for (let callIndex = 1; callIndex <= 3; callIndex += 1) {
        slots.push({ question, engine, callIndex });
      }
    }
  }
  return slots;
}

function mentionSentence(brandName: string, topic: string, variant: number): MentionSentence {
  if (variant % 5 === 0) {
    return { sentence: `${topic}에서는 ${brandName}이(가) 대기·비용 부담이 크다는 의견도 있습니다.`, sentiment: 'negative' };
  }
  if (variant % 2 === 0) {
    return { sentence: `${topic}을(를) 찾는다면 ${brandName}도 후보로 함께 올려볼 만합니다.`, sentiment: 'neutral' };
  }
  return { sentence: `${brandName}의 ${topic}은(는) 후기와 응대가 좋다고 자주 언급됩니다.`, sentiment: 'positive' };
}

function competitorSentence(name: string, topic: string): MentionSentence {
  return { sentence: `${topic} 카테고리에서는 ${name}도 자주 함께 언급됩니다.`, sentiment: 'neutral' };
}

/** Fact Graph 대조에서 "불일치"로 표시할 잘못된 응답값. 실제 값은 노출하지 않고 유형별 안내만 준다. */
function wrongFactValue(fact: FactGraphNode): string {
  switch (fact.type) {
    case 'location':
      return '위치가 응답마다 다르게 안내됨';
    case 'price':
      return '실제와 다른 금액 안내';
    case 'date':
      return '실제와 다른 날짜 안내';
    default:
      return '확인되지 않은 값 안내';
  }
}

/**
 * 스코어카드가 확정한 주간 지표에 맞춰 반복 호출 단위 판정 레코드를 만든다.
 * 저장된 실측이 없는 배포 환경에서만 사용한다.
 */
export function demoQuestionAnalyses(tenant: DemoTenant, weekOf: string): QuestionRepeatAnalysis[] {
  const live = LIVE_ANALYSES.find(
    (file) => file.tenantId === tenant.tenantId && file.weekOf === weekOf && Array.isArray(file.analyses),
  );
  if (live && live.analyses.length > 0) {
    return live.analyses;
  }

  const card = scorecardFor(tenant.tenantId, weekOf);
  if (!card) return [];

  const slots = buildSlots(questionsFor(tenant), tenant.engines);
  const competitorNames = tenant.competitors.map((competitor) => competitor.name);
  const fact = tenant.factGraph[0];

  // 1) 언급 여부 — mentionRate는 category-agnostic 질문에 대한 비율이므로 그 부분집합에만 적용한다.
  //    브랜드명이 들어간 질문은 대부분 언급되므로 별도의 높은 비율을 쓴다.
  const agnosticTotal = slots.filter((slot) => slot.question.category === 'category-agnostic').length;
  const brandedTotal = slots.length - agnosticTotal;
  const agnosticMentions = Math.round(agnosticTotal * card.mentionRate);
  const brandedMentions = Math.round(brandedTotal * 0.95);

  const mentioned = new Array<boolean>(slots.length);
  let agnosticIndex = 0;
  let brandedIndex = 0;
  slots.forEach((slot, i) => {
    if (slot.question.category === 'category-agnostic') {
      mentioned[i] = evenCount(agnosticIndex, agnosticTotal, agnosticMentions);
      agnosticIndex += 1;
    } else {
      mentioned[i] = evenCount(brandedIndex, brandedTotal, brandedMentions);
      brandedIndex += 1;
    }
  });

  const mentionedCount = mentioned.filter(Boolean).length;

  // 2) Share of Mention — 스코어카드 값은 전체 레코드 평균이므로, 언급된 레코드의 평균이
  //    target / (언급 비율)이 되도록 경쟁사 언급 수를 인접한 두 단계로 섞는다.
  const mentionedRatio = mentionedCount / slots.length;
  // 합성 데이터 경로. 스코어카드 SoM이 null(경쟁사 없음)이면 경쟁사 언급도 0으로 둔다.
  const cardShareOfMention = card.shareOfMention ?? 0;
  const targetWhenMentioned = mentionedRatio > 0 ? Math.min(1, cardShareOfMention / mentionedRatio) : 0;
  const rivalFloor = Math.max(0, Math.floor(1 / Math.max(targetWhenMentioned, 1e-6)) - 1);
  const shareHigh = 1 / (1 + rivalFloor);
  const shareLow = 1 / (2 + rivalFloor);
  const highShareCount =
    shareHigh === shareLow
      ? mentionedCount
      : Math.round((mentionedCount * (targetWhenMentioned - shareLow)) / (shareHigh - shareLow));

  // 3) 인용 — 언급된 응답은 2건, 아닌 응답은 1건의 출처를 남긴다고 본다.
  const totalCitations = mentionedCount * 2 + (slots.length - mentionedCount);
  const brandOwnedTarget = Math.round(totalCitations * card.brandOwnedCitationRate);

  // 4) 사실성 — Fact Graph 대조가 가능한 질문에만 주장을 1건씩 붙인다.
  const factualSlots = slots.filter((slot) => slot.question.factual).length;
  const contradictedTarget = Math.round(factualSlots * (1 - card.factualityScore));

  // 5) 추천 순위 — 평균이 avgRecommendationRank가 되도록 1위 일부와 인접한 두 순위를 섞는다.
  //    1위를 따로 떼어두지 않으면 평균만 맞고 "추천 1순위 비율"이 항상 0이 된다.
  const rankedTotal = slots.filter((slot, i) => slot.question.ranked && mentioned[i]).length;
  const topRankCount = Math.round(rankedTotal * TOP_RANK_SHARE);
  const restTotal = rankedTotal - topRankCount;
  const targetRank = card.avgRecommendationRank ?? 3;
  const restMean = restTotal > 0 ? (targetRank * rankedTotal - topRankCount) / restTotal : 0;
  const rankBase = Math.max(1, Math.floor(restMean));
  const rankUpperCount = Math.round(restTotal * Math.max(0, Math.min(1, restMean - rankBase)));

  let mentionedSeen = 0;
  let citationSeen = 0;
  let factualSeen = 0;
  let rankedSeen = 0;
  let restRankSeen = 0;

  const brandDomain = tenant.ownedDomains[0] ?? 'example.com';

  return slots.map((slot, i) => {
    const isMentioned = mentioned[i];

    const mentionSentences: MentionSentence[] = isMentioned
      ? [mentionSentence(tenant.brandName, slot.question.topic, i)]
      : [];

    let rivalCount = 0;
    if (isMentioned) {
      rivalCount = evenCount(mentionedSeen, mentionedCount, highShareCount) ? rivalFloor : rivalFloor + 1;
      mentionedSeen += 1;
    }

    const competitorMentions: CompetitorMentionDetail[] = [];
    for (let r = 0; r < rivalCount; r += 1) {
      const name = competitorNames[(i + r) % Math.max(competitorNames.length, 1)];
      if (!name) break;
      competitorMentions.push({
        name,
        mentionCount: 1,
        sentences: [competitorSentence(name, slot.question.topic)],
      });
    }

    const brandMentionCount = mentionSentences.length;
    const rivalMentionCount = competitorMentions.reduce((sum, c) => sum + c.mentionCount, 0);
    const shareOfMention =
      brandMentionCount + rivalMentionCount > 0 ? brandMentionCount / (brandMentionCount + rivalMentionCount) : 0;

    // 인용: 브랜드 소유 비율을 전체 인용 인덱스 기준으로 고르게 배분한다.
    const citations: CitationDetail[] = [];
    const citationCount = isMentioned ? 2 : 1;
    for (let c = 0; c < citationCount; c += 1) {
      if (evenCount(citationSeen, totalCitations, brandOwnedTarget)) {
        citations.push({
          raw: `https://${brandDomain}/viewis/${slot.question.questionId}`,
          domain: brandDomain,
          ownerType: 'brand-owned',
          supportsBrandMention: isMentioned,
        });
      } else if (citationSeen % 5 === 1 && competitorNames.length > 0) {
        const rival = tenant.competitors[citationSeen % tenant.competitors.length];
        const rivalDomain = rival?.domains[0] ?? 'competitor.com';
        citations.push({
          raw: `https://${rivalDomain}/clinic`,
          domain: rivalDomain,
          ownerType: 'competitor-owned',
          supportsBrandMention: false,
        });
      } else if (citationSeen % 2 === 0) {
        const domain = AUTHORITY_DOMAINS[citationSeen % AUTHORITY_DOMAINS.length];
        citations.push({
          raw: `https://${domain}/review/${slot.question.questionId}`,
          domain,
          ownerType: 'third-party-authority',
          supportsBrandMention: isMentioned,
        });
      } else {
        const domain = UGC_DOMAINS[citationSeen % UGC_DOMAINS.length];
        citations.push({
          raw: `https://${domain}/post/${slot.question.questionId}`,
          domain,
          ownerType: 'third-party-ugc',
          supportsBrandMention: isMentioned,
        });
      }
      citationSeen += 1;
    }

    // 사실성 주장 — 테넌트의 Fact Graph 첫 항목을 기준값으로 삼는다.
    const factualityClaims: FactClaimDetail[] = [];
    if (slot.question.factual && fact) {
      const contradicted = evenCount(factualSeen, factualSlots, contradictedTarget);
      factualSeen += 1;
      factualityClaims.push(
        contradicted
          ? {
              claimText: fact.claim,
              claimType: fact.type,
              verdict: 'contradicted',
              responseValue: wrongFactValue(fact),
              factGraphValue: fact.value,
            }
          : {
              claimText: fact.claim,
              claimType: fact.type,
              verdict: 'supported',
              responseValue: fact.value,
              factGraphValue: fact.value,
            },
      );
    }

    // 추천 순위.
    let brandRank: number | null = null;
    let topRecommendation: string | null = null;
    if (slot.question.ranked && isMentioned) {
      if (evenCount(rankedSeen, rankedTotal, topRankCount)) {
        brandRank = 1;
      } else {
        brandRank = evenCount(restRankSeen, restTotal, rankUpperCount) ? rankBase + 1 : rankBase;
        restRankSeen += 1;
      }
      rankedSeen += 1;
      topRecommendation = brandRank === 1 ? tenant.brandName : (competitorNames[0] ?? tenant.brandName);
    }

    return {
      questionId: slot.question.questionId,
      engine: slot.engine,
      callIndex: slot.callIndex,
      mentioned: isMentioned,
      mentionSentences,
      competitorMentions,
      shareOfMention,
      citations,
      topRecommendation,
      brandRank,
      factualityClaims,
      factualitySupported: factualityClaims.filter((claim) => claim.verdict === 'supported').length,
      factualityContradicted: factualityClaims.filter((claim) => claim.verdict === 'contradicted').length,
      brandOwnedCitation: citations.some((citation) => citation.ownerType === 'brand-owned'),
    };
  });
}
