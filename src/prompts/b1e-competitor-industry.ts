import type { MarketScope, PromptMessage } from './types.js';

/**
 * B1e — 경쟁사가 고객과 같은 업종인지 묻는다(경쟁사 편집 5단계 「업종 다름」, 결정 7 · F5).
 *
 * 업종 이름을 맞대지 않는다 — 업종 문자열은 자유 글이라 표기가 흔들리고(관광안내 · 관광정보서비스, 숙박 · 펜션), 업종 묶음
 * (industryGroups)은 너무 굵어 펜션과 관광 정보 사이트를 같다고 본다. 대신 측정이 묻는 질문 그대로 「이 곳이 고객 업종 질문의
 * 답이 될 수 있는가」를 묻는다. 경쟁사를 고객 업종 질문으로 재기 때문에, 답이 될 수 없는 곳이면 점수가 낮게 나온다.
 *
 * 검색이 붙은 엔진(그라운딩)으로 부른다 — 작은 지역 업체는 이름만으로는 모른다. 모르면 unsure로 답하게 한다(화면은 칩을 달지 않는다).
 */
export interface CompetitorIndustryRequest {
  brandName: string;
  industry: string;
  /** 영어 질문 측정의 「(영어 질문)」 꼬리표는 여기서 뗀다. */
  region: string;
  marketScope?: MarketScope;
  buyer?: string;
  competitorName: string;
  aliases: string[];
  domain?: string;
}

const REGION_TAG = /\s*\(영어 질문\)\s*$/;

/** 고객이 받는 질문 — 시장 범위에 따라 다르다(b1-question-bank scopeGuide와 같은 뜻). */
function sampleQuestion(req: CompetitorIndustryRequest, region: string): string {
  if (req.marketScope === 'b2b') return `${req.industry} 공급사 · 제조사 추천해줘`;
  if (req.marketScope === 'national') return `${req.industry} 브랜드 추천해줘`;
  return `${region} ${req.industry} 추천해줘`;
}

export function buildCompetitorIndustryPrompt(req: CompetitorIndustryRequest): PromptMessage {
  const region = req.region.replace(REGION_TAG, '');
  const question = sampleQuestion(req, region);
  const system = `당신은 경쟁사 목록을 점검하는 시장 조사원입니다.
주어진 업체가 고객 브랜드와 같은 종류의 업체인지 판단합니다. 기준은 업종 이름이 같은가가 아니라, 그 업체가 고객이 받는 질문
「${question}」 같은 질문의 답(추천 대상)이 될 수 있는가입니다.

판단 예:
- 같음(same): 펜션 고객에게 한옥스테이 · 게스트하우스 · 풀빌라 · 독채 숙소처럼 같은 질문의 답이 되는 숙소. 이름에 업종이 없어도 실제로
  그 업종 영업을 하면 같다.
- 다름(different): 펜션 고객에게 관광 정보 사이트 · 지자체 관광 포털 · 예약 플랫폼 · 여행사 · 블로그 · 언론처럼 숙소 자체가 아닌 곳.
  성형외과 고객에게 성형 시술을 하지 않는 피부과처럼 질문의 답이 될 수 없는 곳.
- 모름(unsure): 검색해도 그 업체를 확인할 수 없거나, 같은 이름의 곳이 여럿이라 정할 수 없을 때. 짐작으로 정하지 마라.

응답은 JSON 객체 하나만: {"verdict": "same" | "different" | "unsure", "looksLike": "그 업체가 무엇으로 보이는지 짧은 한국어 명사구(20자 이내)", "reason": "한 문장 근거"}`;

  const aliases = req.aliases.filter((a) => a && a !== req.competitorName);
  const user = [
    `고객 브랜드: ${req.brandName} · 업종: ${req.industry} · 지역: ${region}`,
    ...(req.marketScope === 'b2b' && req.buyer ? [`고객이 파는 상대: ${req.buyer}`] : []),
    `점검할 업체: ${req.competitorName}${aliases.length ? ` (별칭: ${aliases.join(', ')})` : ''}`,
    ...(req.domain ? [`홈페이지: ${req.domain}`] : []),
  ].join('\n');
  return { system, user };
}
