import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { Engine, QuestionCategory, QuestionSpec } from '../src/prompts/types.js';
import demoScorecards from '../src/data/demo-scorecards.json' with { type: 'json' };
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

// category-agnostic 비중 8/12 = 67% — b1-question-bank의 60% 하한을 넘긴다.
const QUESTIONS: DemoQuestion[] = [
  { questionId: 'q-air-purifier-pick', text: '공기청정기 어떤 걸 사는 게 좋아?', topic: '공기청정기', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-washer-2026', text: '2026년 기준으로 살 만한 세탁기를 추천해줘.', topic: '세탁기', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-quiet-aircon', text: '소음이 적은 에어컨은 어떤 제품이 있어?', topic: '에어컨', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-fridge-single', text: '1인 가구가 쓰기 좋은 냉장고를 알려줘.', topic: '냉장고', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-energy-efficient', text: '에너지 효율이 좋은 가전 브랜드는 어디야?', topic: '고효율 가전', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-robot-vacuum', text: '로봇청소기를 고를 때 어떤 브랜드를 봐야 해?', topic: '로봇청소기', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-dryer-review', text: '건조기는 어떤 제품이 평이 좋아?', topic: '건조기', category: 'category-agnostic', containsBrandName: false, ranked: false, factual: false },
  { questionId: 'q-service-access', text: 'AS 센터 접근성이 좋은 가전 브랜드를 알려줘.', topic: 'AS 네트워크', category: 'category-agnostic', containsBrandName: false, ranked: true, factual: false },
  { questionId: 'q-brand-reputation', text: '예시브랜드 평판은 어때?', topic: '브랜드 평판', category: 'brand-direct', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-price-flagship', text: '예시브랜드 플래그십 모델 가격이 얼마야?', topic: '플래그십 가격', category: 'price-spec', containsBrandName: true, ranked: false, factual: true },
  { questionId: 'q-vs-competitor-a', text: '예시브랜드랑 경쟁브랜드A 중에 뭐가 더 나아?', topic: '경쟁 비교', category: 'comparison', containsBrandName: true, ranked: true, factual: true },
  { questionId: 'q-seoul-store', text: '서울에서 가전을 사기 좋은 곳을 추천해줘.', topic: '오프라인 구매처', category: 'local-regional', containsBrandName: false, ranked: true, factual: false },
];

const AUTHORITY_DOMAINS = ['danawa.com', 'enuri.com', 'consumer.go.kr'];
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

export function demoQuestionBank(tenant: DemoTenant, weekOf: string): QuestionBank {
  return {
    version: tenant.questionBankVersion,
    generatedAt: `${isoDateOfWeek(weekOf)}T03:00:00.000Z`,
    questions: QUESTIONS.map<QuestionSpec>((question) => ({
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

function buildSlots(engines: Engine[]): Slot[] {
  const slots: Slot[] = [];
  for (const question of QUESTIONS) {
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
    return { sentence: `${topic} 쪽에서는 ${brandName}이(가) 가격 대비 성능이 아쉽다는 의견도 있습니다.`, sentiment: 'negative' };
  }
  if (variant % 2 === 0) {
    return { sentence: `${topic}을(를) 찾는다면 ${brandName}도 후보에 함께 올려볼 만합니다.`, sentiment: 'neutral' };
  }
  return { sentence: `${brandName}의 ${topic}은(는) 소음과 전력 효율의 균형이 좋다는 평가가 많습니다.`, sentiment: 'positive' };
}

function competitorSentence(name: string, topic: string): MentionSentence {
  return { sentence: `${topic} 카테고리에서는 ${name}도 자주 함께 언급됩니다.`, sentiment: 'neutral' };
}

/**
 * 스코어카드가 확정한 주간 지표에 맞춰 반복 호출 단위 판정 레코드를 만든다.
 * 저장된 실측이 없는 배포 환경에서만 사용한다.
 */
export function demoQuestionAnalyses(tenant: DemoTenant, weekOf: string): QuestionRepeatAnalysis[] {
  const card = scorecardFor(tenant.tenantId, weekOf);
  if (!card) return [];

  const slots = buildSlots(tenant.engines);
  const competitorNames = tenant.competitors.map((competitor) => competitor.name);

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
  const targetWhenMentioned = mentionedRatio > 0 ? Math.min(1, card.shareOfMention / mentionedRatio) : 0;
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
          raw: `https://${brandDomain}/support/${slot.question.questionId}`,
          domain: brandDomain,
          ownerType: 'brand-owned',
          supportsBrandMention: isMentioned,
        });
      } else if (citationSeen % 5 === 1 && competitorNames.length > 0) {
        const rival = tenant.competitors[citationSeen % tenant.competitors.length];
        const rivalDomain = rival?.domains[0] ?? 'competitor.com';
        citations.push({
          raw: `https://${rivalDomain}/product`,
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

    // 사실성 주장.
    const factualityClaims: FactClaimDetail[] = [];
    if (slot.question.factual) {
      const contradicted = evenCount(factualSeen, factualSlots, contradictedTarget);
      factualSeen += 1;
      factualityClaims.push(
        contradicted
          ? {
              claimText: '플래그십 모델 출고가',
              claimType: 'price',
              verdict: 'contradicted',
              responseValue: '1,190,000원',
              factGraphValue: '1,290,000원',
            }
          : {
              claimText: '플래그십 모델 출고가',
              claimType: 'price',
              verdict: 'supported',
              responseValue: '1,290,000원',
              factGraphValue: '1,290,000원',
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
