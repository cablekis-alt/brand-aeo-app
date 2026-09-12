import type { FactGraphNode, PromptMessage } from './types';

/**
 * 콘텐츠 브리프 — 실행 항목 하나를 "무엇을 써야 하나"로 바꾼다. **본문은 쓰지 않는다.**
 *
 * 왜 브리프에서 멈추나. AI가 쓴 글을 제3자 사이트에 올리는 것은 경쟁 서비스(Frostai)가 하는
 * 일이고, 우리는 그걸 문제로 봤다 — 오탈자·근거 없는 수치·상투적 문장이 브랜드 이름으로 나가고,
 * 답변 엔진들은 그런 콘텐츠의 신뢰를 낮추는 방향으로 움직이고 있다. 브리프는 사람이 쓰는 글의
 * 뼈대다: 무엇에 답하고, 어떤 사실만 쓰고, 어떤 구조가 인용되기 쉬운가.
 *
 * 사실은 팩트 그래프에서만 가져온다. 거기 없는 가격·수치·인증은 만들어내지 않고 "확인 필요"로
 * 남긴다 — 사실성 판정(B5-D)이 나중에 그 문장을 '모순'으로 잡는 일을 처음부터 막는다.
 */
export interface ContentBrief {
  /** 제목 후보 — 질문 그대로의 어투를 살린 것 2~3개 */
  titles: string[];
  /** 누가 읽나(구매 여정 단계 포함) */
  audience: string;
  /** 이 글이 답해야 할 질문 — 카드에 붙은 질문을 그대로 쓰고, 빠진 하위 질문만 보탠다 */
  questionsToAnswer: string[];
  /** 팩트 그래프에서 가져온, 반드시 들어가야 할 사실 */
  mustIncludeFacts: string[];
  /** 팩트 그래프에 없어 쓰면 안 되거나 확인이 필요한 것 */
  doNotClaim: string[];
  /** 인용되기 쉬운 구조 — H2 단위. 각 절이 어느 질문에 답하는지 */
  structure: { heading: string; answers: string; format: 'paragraph' | 'faq' | 'table' | 'list' }[];
  /** 그대로 옮겨도 되는 인용용 문장 3~5개 — 사실 기반, 과장 없이 */
  citableSentences: string[];
  /** 채널 메모(등재형): 그 플랫폼에서 지켜야 할 것 */
  channelNotes: string[];
}

export interface ContentBriefRequest {
  brandName: string;
  industry: string;
  region: string;
  competitorNames: string[];
  factGraph: FactGraphNode[];
  action: {
    kind: 'listing' | 'content';
    title: string;
    targetDomain?: string;
    questionTexts: string[];
    evidence: string;
  };
}

export function buildContentBriefPrompt(req: ContentBriefRequest): PromptMessage {
  const facts = req.factGraph.length
    ? req.factGraph.map((f) => `- [${f.type}] ${f.claim}: ${f.value}`).join('\n')
    : '- (등록된 사실 없음)';
  const system = `당신은 AEO(답변엔진 최적화) 콘텐츠 기획자입니다. **글을 쓰지 않습니다.** 사람이 쓸 글의 브리프만 만듭니다.

절대 규칙:
1. 사실(가격·수치·주소·인증·연혁·의사 수 등)은 아래 "팩트 그래프"에 있는 것만 mustIncludeFacts에 넣는다.
   거기 없는 사실은 만들어내지 말고 doNotClaim에 "확인 필요: …" 형태로 적는다.
2. "최고·유일·1위·완벽" 같은 과장 표현은 어디에도 쓰지 않는다. 인용용 문장은 검증 가능한 사실만 담는다.
3. questionsToAnswer는 제공된 질문을 **그대로** 먼저 넣고, 그 질문에 답하려면 꼭 필요한 하위 질문만 보탠다.
4. 구조는 답변 엔진이 추출하기 쉬운 형태를 우선한다 — 질문형 H2, 첫 문장에 직접 답, FAQ, 비교표.
5. 출력은 아래 JSON 하나만. 설명·마크다운·코드블록 금지.

JSON 스키마:
{
  "titles": string[],
  "audience": string,
  "questionsToAnswer": string[],
  "mustIncludeFacts": string[],
  "doNotClaim": string[],
  "structure": [{ "heading": string, "answers": string, "format": "paragraph" | "faq" | "table" | "list" }],
  "citableSentences": string[],
  "channelNotes": string[]
}
titles는 2~3개, citableSentences는 3~5개(각 60자 이내), channelNotes는 콘텐츠형이면 빈 배열이어도 된다.`;
  const kindLine =
    req.action.kind === 'listing'
      ? `종류: 외부 채널 등재·기고 — 대상 채널 ${req.action.targetDomain ?? '(미정)'}. 그 채널에서 지켜야 할 것(광고성 금지·문서 규칙·형식)을 channelNotes에 적는다.`
      : '종류: 자사 사이트 콘텐츠 — 우리 도메인에 올릴 페이지의 브리프.';
  const user = `브랜드: ${req.brandName} (${req.industry} · ${req.region})
경쟁사: ${req.competitorNames.join(', ') || '(없음)'}
${kindLine}
실행 항목: ${req.action.title}
왜 이 항목이 나왔나: ${req.action.evidence}

이 글이 답해야 할 질문(AI가 이 출처를 꺼낸 질문 / 우리가 밀린 질문):
${req.action.questionTexts.map((q) => `- ${q}`).join('\n') || '- (질문 없음 — 채널 특성만으로 기획)'}

팩트 그래프(이 사실만 쓸 수 있다):
${facts}`;
  return { system, user };
}
