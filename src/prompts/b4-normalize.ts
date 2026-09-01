import type { PromptMessage } from './types';

/**
 * B4 — 응답 정규화.
 * 원칙: 가능한 부분(URL 정규식 추출, 마크다운 제거, 문장 분리)은 코드로 처리하고,
 * LLM은 "정형화된 메타데이터가 없는 출처 언급"만 보조적으로 추출한다.
 * 즉 이 프롬프트는 B4 전체가 아니라, 코드 기반 정규화 이후의 보조 단계다.
 */
export interface NormalizeAssistRequest {
  rawText: string;
  alreadyExtractedUrls: string[]; // 코드에서 정규식으로 뽑은 URL (중복 방지용으로 모델에 알려줌)
}

export function buildSourceMentionExtractionPrompt(req: NormalizeAssistRequest): PromptMessage {
  const system = `텍스트에서 "URL은 없지만 출처로 언급된 대상"만 찾아내는 추출기입니다.
예: "OO 공식 홈페이지", "네이버 블로그 후기에 따르면", "OO 뉴스 보도 기준" 처럼
URL 없이 매체/사이트/문서를 지칭하는 표현을 찾습니다.
이미 URL로 추출된 항목(아래 목록)과 중복되는 대상은 제외하세요.
정보를 지어내지 말고, 텍스트에 실제로 등장한 표현만 반환하세요.

출력 JSON 스키마 (배열):
{
  "mentionText": string,   // 원문 그대로의 출처 언급 표현
  "inferredSourceName": string  // 추정되는 매체/사이트명
}
설명 없이 JSON 배열만 반환하세요.`;

  const user = `이미 추출된 URL: ${req.alreadyExtractedUrls.join(', ') || '없음'}

본문:
"""
${req.rawText}
"""`;

  return { system, user };
}
