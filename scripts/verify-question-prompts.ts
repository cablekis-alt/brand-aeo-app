/**
 * 시장 범위(지역형 · 전국형 · B2B형)별 질문지 프롬프트에 지시가 맞게 들어가는지 확인한다. AI는 부르지 않는다.
 *
 * 왜: 시장 범위가 생기기 전에는 모든 브랜드를 「지역 소비자」로 보고 질문을 만들었다. B2B 납품사(셋톱박스)가
 * 「수도권 원룸 OTT 셋톱박스 추천」 같은 소비자 질문을 받아 코호트 5곳이 모두 언급률 0%였다(2026-W40).
 * 지역형은 시장 범위 이전과 같은 프롬프트여야 한다 — 이미 만든 코호트 질문지와 성격이 갈리면 안 된다.
 *
 *   npx tsx scripts/verify-question-prompts.ts
 */
import { buildBrandQuestionBankPrompt, buildCohortQuestionBankPrompt } from '../src/prompts/b1-question-bank';
import type { MarketScope } from '../src/prompts/types';

const BUYER = '통신사 IPTV 셋톱박스 구매 · 조달 담당자';

function prompts(marketScope: MarketScope | undefined, industry: string, region: string, buyer?: string) {
  const cohort = buildCohortQuestionBankPrompt({
    industry,
    region,
    excludedNames: [],
    count: 22,
    learnMin: 7,
    version: 'c1',
    marketScope,
    buyer,
  });
  const brand = buildBrandQuestionBankPrompt({
    industry,
    region,
    brandName: '테스트브랜드',
    competitorNames: ['경쟁사A'],
    count: 14,
    version: 'v1',
    marketScope,
    buyer,
  });
  return { cohort: `${cohort.system}\n${cohort.user}`, brand: `${brand.system}\n${brand.user}` };
}

const checks: [string, boolean][] = [];
const has = (label: string, text: string, needle: string) => checks.push([`${label}: 「${needle}」 있음`, text.includes(needle)]);
const lacks = (label: string, text: string, needle: string) => checks.push([`${label}: 「${needle}」 없음`, !text.includes(needle)]);

// 지역형(값 없음 = 지역형) — 시장 범위 이전 문구 그대로
for (const scope of [undefined, 'local'] as const) {
  const name = `지역형(${scope ?? '값 없음'})`;
  const p = prompts(scope, '정형외과', '서울 성동구');
  has(`${name} 공통`, p.cohort, '목표는 실제 소비자가 ChatGPT/Perplexity');
  has(`${name} 공통`, p.cohort, '이 업종의 소비자가 흔히 묻는 주제를 고르게 다룬다.');
  has(`${name} 공통`, p.cohort, '"서울 성동구 정형외과 추천해줘"처럼');
  lacks(`${name} 공통`, p.cohort, '시장 범위:');
  has(`${name} 브랜드`, p.brand, 'local-regional(지역 특화)로 고르게 분배한다.');
  lacks(`${name} 브랜드`, p.brand, '시장 범위:');
}

// 전국형
{
  const p = prompts('national', '메모리 반도체', '국내');
  has('전국형 공통', p.cohort, '목표는 전국의 소비자 · 제품 구매자가');
  has('전국형 공통', p.cohort, '특정 시 · 구 같은 지역을 질문에 넣지 마라');
  has('전국형 공통', p.cohort, '"메모리 반도체 브랜드 추천해줘"처럼');
  lacks('전국형 공통', p.cohort, '"국내 메모리 반도체 추천해줘"');
  has('전국형 공통', p.cohort, '시장 범위: 전국형');
  has('전국형 브랜드', p.brand, 'local-regional(지역 특화)은 만들지 않는다 — 전국 시장이다.');
}

// B2B형
{
  const p = prompts('b2b', '셋톱박스 제조', '국내', BUYER);
  has('B2B형 공통', p.cohort, `목표는 ${BUYER}가`);
  has('B2B형 공통', p.cohort, '일반 소비자의 구매 질문');
  lacks('B2B형 공통', p.cohort, '목표는 실제 소비자가');
  lacks('B2B형 공통', p.cohort, '이 업종의 소비자가 흔히 묻는 주제');
  has('B2B형 공통', p.cohort, '"셋톱박스 제조 공급사 · 제조사 추천해줘"처럼');
  has('B2B형 공통', p.cohort, `질문하는 사람: ${BUYER}`);
  has('B2B형 브랜드', p.brand, 'local-regional(지역 특화)은 만들지 않는다 — 이 시장은 지역이 아니라 고객사로 나뉜다.');
  has('B2B형 브랜드', p.brand, '납품 실적 · 레퍼런스');
}

// B2B형인데 구매자를 비워 두면 업종으로 만든 기본 구매자
{
  const p = prompts('b2b', '셋톱박스 제조', '국내');
  has('B2B형(구매자 없음) 공통', p.cohort, '목표는 셋톱박스 제조 공급사를 찾는 기업 고객의 구매 · 조달 담당자가');
}

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
