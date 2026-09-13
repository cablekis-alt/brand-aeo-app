import type { ContentBrief } from './b9b-content-brief';
import type { FactGraphNode, PromptMessage } from './types';

/**
 * 콘텐츠 초안 — 브리프에서 **한 걸음만** 더 간다.
 *
 * ── 왜 본문을 통째로 쓰지 않나 ────────────────────────────────────────────
 * 경쟁 서비스(Frostai)는 주제를 넣으면 4,477자짜리 완성본을 뽑아 준다. 그 샘플 본문에는
 * "러너 2명 중 1명이 20만원대를 꼽는다" 같은 문장이 출처 없이 들어 있었다. 이런 통계는
 * 글을 그럴듯하게 만들지만 확인할 수 없고, 사실성 판정(B5-D)이 나중에 '모순'으로 잡는다.
 * 빈칸을 그럴듯한 수치로 메우는 순간 우리가 가진 유일한 차별점이 사라진다.
 *
 * ── 그래서 이렇게 쓴다 ────────────────────────────────────────────────
 * 팩트 그래프로 **쓸 수 있는 문단만** 채운다. 사실이 있어야 쓸 수 있는 자리인데 그 사실이
 * 없으면, 문장을 지어내지 않고 그 자리를 gap으로 비워 둔다 — "여기에 무엇이 필요한가"를
 * 적어서. 사람이 그 값을 채우면 글이 완성되고, 채울 수 없으면 그 문단은 없는 게 맞다.
 *
 * 결과물은 '발행 직전 원고'가 아니라 '사람이 30분 안에 마무리할 수 있는 원고'다.
 */

/** 문단 하나 — 쓴 것이거나, 못 써서 비운 것이거나. 둘 중 하나다. */
export interface DraftBlock {
  /** 'text'면 body가 본문, 'gap'이면 need가 "무엇이 필요한가". */
  kind: 'text' | 'gap';
  body?: string;
  /** gap일 때: 이 자리를 채우려면 어떤 사실이 필요한가. 팩트 그래프에 추가할 항목이 된다. */
  need?: string;
}

export interface DraftSection {
  heading: string;
  /** 이 절이 답하는 질문 — 브리프 structure의 answers를 잇는다. */
  answers: string;
  blocks: DraftBlock[];
}

export interface ContentDraft {
  title: string;
  /** 글 첫머리 2~3문장. 질문에 바로 답한다(답변 엔진이 첫 문장을 잘 뽑아 간다). */
  lead: string;
  sections: DraftSection[];
  /** 사실이 없어 비운 자리 수 — 화면이 "이만큼 채우면 완성"으로 쓴다. */
  gapCount: number;
  /** 이 초안이 쓴 사실들(정본). 사람이 원고를 검수할 때 대조표가 된다. */
  usedFacts: string[];
  /** 가드가 걸러낸 것과 이유. 조용히 지우지 않는다. */
  guardNotes?: string[];
}

export interface ContentDraftRequest {
  brandName: string;
  industry: string;
  region: string;
  factGraph: FactGraphNode[];
  questionTexts: string[];
  brief: ContentBrief;
  /** 등재형이면 그 채널 — 채널 규칙을 문체에 반영한다. */
  targetDomain?: string;
}

export function buildContentDraftPrompt(req: ContentDraftRequest): PromptMessage {
  const facts = req.factGraph.length
    ? req.factGraph.map((f) => `- [${f.type}] ${f.claim}: ${f.value}`).join('\n')
    : '- (등록된 사실 없음)';
  const b = req.brief;

  const system = `당신은 ${req.industry} 분야의 콘텐츠 작성자입니다. 브리프를 받아 **초안**을 씁니다.

이 초안의 목적은 발행이 아니라 **사람이 이어받아 30분 안에 마무리할 원고**를 만드는 것입니다.
그래서 "못 쓰는 자리를 비워 두는 것"이 이 작업의 핵심입니다.

절대 규칙:
1. 사실(가격·수치·기간·인증·주소·인원 등)은 아래 팩트 그래프에 있는 것만 쓴다.
   값은 **글자 그대로** 옮긴다. 요약·반올림·명사 격상 금지 —
   "30명의 의료진"을 "전문의 30명"으로, "약 20만원"을 "20만원"으로 바꾸면 새 사실을 만드는 것이다.
2. 사실이 있어야 쓸 수 있는 문단인데 그 사실이 팩트 그래프에 없으면, **문장을 지어내지 말고**
   그 자리를 {"kind":"gap","need":"..."}로 둔다. need에는 무엇이 필요한지 구체적으로 적는다.
   예: {"kind":"gap","need":"쌍꺼풀 재수술 평균 비용 범위 — 팩트 그래프에 가격 항목 없음"}
   업계 평균·일반적으로 알려진 수치·추정치를 대신 쓰는 것도 지어내는 것이다.
3. 숫자가 들어간 문장은 그 숫자가 팩트 그래프의 값에서 온 것이어야 한다. 다만 질문 문장에
   이미 나온 숫자(예: "50인 규모")는 그대로 인용해도 된다.
4. "최고·유일·1위·완벽·업계 최저" 같은 과장 표현을 쓰지 않는다.
5. 각 절은 **첫 문장에서 질문에 바로 답한다.** 배경 설명으로 시작하지 않는다 —
   답변 엔진은 첫 문장을 인용해 간다.
6. 브리프의 구조(heading)를 그대로 따른다. 절을 늘리거나 순서를 바꾸지 않는다.
7. 출력은 아래 JSON 하나만. 설명·마크다운·코드블록 금지.

JSON 스키마:
{
  "title": string,
  "lead": string,
  "sections": [
    { "heading": string, "answers": string,
      "blocks": [ {"kind":"text","body":string} | {"kind":"gap","need":string} ] }
  ]
}
lead는 2~3문장. 각 절의 blocks는 1~4개. 사실이 없어 쓸 게 없는 절은 blocks가 gap 하나여도 된다.`;

  const channelLine = req.targetDomain
    ? `게재 채널: ${req.targetDomain} — 광고성 문구를 피하고 그 채널의 독자에게 맞는 어투로 씁니다.\n`
    : '게재 위치: 자사 사이트\n';

  const user = `브랜드: ${req.brandName} (${req.industry} · ${req.region})
${channelLine}제목(브리프 후보 중 하나를 골라 다듬어 쓴다): ${b.titles.join(' / ') || '(없음)'}
읽는 사람: ${b.audience || '(미정)'}

이 글이 답해야 할 질문:
${b.questionsToAnswer.map((q) => `- ${q}`).join('\n') || '- (없음)'}

브리프가 정한 구조(이 순서·이 제목 그대로):
${b.structure.map((s, i) => `${i + 1}. [${s.format}] ${s.heading} — ${s.answers}`).join('\n') || '(없음)'}

반드시 담아야 할 사실(값을 글자 그대로):
${b.mustIncludeFacts.map((f) => `- ${f}`).join('\n') || '- (없음)'}

쓰기 전에 확인이 필요해 **아직 쓸 수 없는 것**(이 자리는 gap으로 둔다):
${b.doNotClaim.map((f) => `- ${f}`).join('\n') || '- (없음)'}

팩트 그래프(이 사실만 쓸 수 있다):
${facts}`;

  return { system, user };
}
