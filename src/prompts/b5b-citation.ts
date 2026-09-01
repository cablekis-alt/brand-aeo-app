import type { BrandContext, PromptMessage } from './types';

export interface CitationCandidate {
  url?: string;
  mentionText?: string; // B4의 URL 없는 출처 언급
  inferredSourceName?: string;
}

/**
 * B5-B — 인용 URL 탐지 및 출처 소유권 분류.
 */
export function buildCitationClassificationPrompt(
  brand: BrandContext,
  responseText: string,
  candidates: CitationCandidate[],
): PromptMessage {
  const system = `당신은 텍스트 내 인용/출처를 브랜드 관점에서 분류하는 분석기입니다.

측정 대상 브랜드: ${brand.brandName}
대상 브랜드 소유 도메인: ${brand.ownedDomains.join(', ') || '없음'}
경쟁사 소유 도메인: ${brand.competitors.flatMap((c) => c.domains).join(', ') || '없음'}

주어진 인용 후보 목록 각각에 대해 다음을 판정하라:
1. ownerType 분류:
   - "brand-owned": 대상 브랜드 소유 도메인/공식 채널
   - "competitor-owned": 경쟁사 소유 도메인
   - "third-party-authority": 언론사, 위키, 공공기관 등 권위 있는 제3자
   - "third-party-ugc": 블로그, 커뮤니티, 리뷰 플랫폼 등 사용자 생성 콘텐츠
   - "unknown": 판단 불가
2. supportsBrandMention: 이 인용이 본문에서 대상 브랜드에 대한 언급/주장을 직접 뒷받침하는지 여부.
   (예: 경쟁사 기사인데 본문 다른 문단과 무관하면 false)
3. 원문에 등장하지 않은 인용을 지어내지 마라.

출력 JSON 스키마만 반환:
{
  "citations": [
    {
      "raw": string,
      "domain": string | null,
      "ownerType": "brand-owned" | "competitor-owned" | "third-party-authority" | "third-party-ugc" | "unknown",
      "supportsBrandMention": boolean
    }
  ]
}`;

  const candidateList = candidates
    .map((c) => `- ${c.url ?? c.mentionText ?? c.inferredSourceName ?? '(빈 항목)'}`)
    .join('\n');

  const user = `본문:
"""
${responseText}
"""

인용 후보 목록:
${candidateList || '없음'}`;

  return { system, user };
}
