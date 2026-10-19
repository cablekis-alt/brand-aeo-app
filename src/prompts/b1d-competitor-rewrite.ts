import { styleRule } from './b1-question-bank.js';
import type { CompetitorContext, PromptMessage, QuestionLanguage, QuestionSpec } from './types.js';

/**
 * B1d — 경쟁사를 바꾼 비교 질문 하나를 고쳐 쓴다(경쟁사 편집 4단계 「바뀐 경쟁사 질문만 고치기」).
 *
 * 질문지 전체를 새로 만들지 않는 이유: 나머지 문항이 그대로여야 지난 주와 같은 질문으로 잰 기록이 이어진다.
 * 그래서 이 질문도 경쟁사 이름만 바꾸고 의도 · 단계 · 문체 · 길이를 지키게 한다. 결과는 코드가 다시 검사한다
 * (server/questionHandoff.ts checkRewrite) — 판정 모델이 지시를 흘리는 일은 질문지 생성에서 이미 겪었다.
 *
 * 시스템 프롬프트에 다른 B1 프롬프트의 고유 문구를 쓰지 않는다 — 모의 판정(mockJudgeClient.ts)이 그 문구로
 * 프롬프트를 가려 질문지 생성 응답을 돌려준다.
 */
export interface CompetitorRewriteRequest {
  industry: string;
  /** 영어 질문 측정의 「(영어 질문)」 꼬리표는 여기서 뗀다. */
  region: string;
  brandName: string;
  brandAliases: string[];
  language?: QuestionLanguage;
  source: Pick<QuestionSpec, 'text' | 'topic' | 'category' | 'stage'>;
  /** 빼는 경쟁사 → 넣는 경쟁사. */
  swaps: { from: CompetitorContext; to: CompetitorContext }[];
  /** 그대로 두는 경쟁사(이 질문이 함께 짚은 곳). */
  keep: CompetitorContext[];
  /** 원래 주제에 빼는 경쟁사 이름이 들어 있어 주제도 새로 받는다. */
  topicNeedsRewrite: boolean;
  /** 직전 시도가 쓸 수 없던 이유(직전 안 포함). */
  retryNote?: string;
  /** 「다시 쓰기」 — 직전에 만든 문장과 다르게 쓴다. */
  avoidText?: string;
}

const REGION_TAG = /\s*\(영어 질문\)\s*$/;

function names(c: CompetitorContext): string {
  const aliases = (c.aliases ?? []).filter((a) => a && a !== c.name);
  return aliases.length ? `${c.name} (별칭: ${aliases.join(', ')})` : c.name;
}

export function buildCompetitorRewritePrompt(req: CompetitorRewriteRequest): PromptMessage {
  const system = `당신은 AI 검색 측정 질문지의 문장 편집자입니다.
고객 브랜드와 경쟁사를 함께 묻는 질문 하나를, 경쟁사만 바꿔 다시 씁니다. 질문지의 다른 질문은 그대로 두고 이 질문만
고치므로, 질문의 의도 · 구매 단계 · 묻는 관점 · 문체 · 길이를 원래 질문과 최대한 같게 지킵니다.

규칙:
1. 「빼는 경쟁사」의 이름은 문장에서 완전히 없앤다. 별칭 · 줄임말 · 이름 일부도 쓰지 마라.
2. 그 자리에 「넣는 경쟁사」 이름을 적힌 표기 그대로 넣는다.
3. 「그대로 두는 경쟁사」가 있으면 그 이름을 그대로 남긴다.
4. 원래 질문에 고객 브랜드 이름이 있으면 같은 표기로 남긴다.
5. 여기 적힌 곳 말고 다른 업체 · 브랜드 이름을 새로 넣지 마라.
6. 넣는 경쟁사에 대해 사실(위치 · 가격 · 시설 · 시술 등)을 지어내지 마라. 원래 질문이 빼는 경쟁사만의 특징을 짚었다면
   그 부분은 누구에게나 맞는 일반적인 표현으로 바꾼다.
7. 한 줄짜리 질문 하나만 쓴다. 번호 · 목록 기호 · 따옴표 · 설명을 붙이지 마라.
8. ${styleRule(req.language)}
${
  req.topicNeedsRewrite
    ? `9. 원래 주제(topic)에 빼는 경쟁사 이름이 들어 있다. 새 질문의 주제를 한국어 명사구(30자 이내)로 다시 붙인다.
   업체 이름을 넣지 말고 무엇을 비교 · 질문하는지로 이름 짓는다(예: "분위기 비교", "가족 숙소 비교").

응답은 JSON 객체 하나만: {"text": "고쳐 쓴 질문", "topic": "새 주제"}`
    : `
응답은 JSON 객체 하나만: {"text": "고쳐 쓴 질문"}`
}`;

  const aliasLine = req.brandAliases.filter((a) => a && a !== req.brandName);
  const lines = [
    `업종: ${req.industry} · 지역: ${req.region.replace(REGION_TAG, '')}`,
    `고객 브랜드: ${req.brandName}${aliasLine.length ? ` (별칭: ${aliasLine.join(', ')})` : ''}`,
    `원래 질문: ${req.source.text}`,
    ...(req.source.topic ? [`원래 주제: ${req.source.topic}`] : []),
    ...req.swaps.map((s) => `빼는 경쟁사: ${names(s.from)} → 넣는 경쟁사: ${s.to.name}`),
    ...(req.keep.length ? [`그대로 두는 경쟁사: ${req.keep.map((k) => k.name).join(', ')}`] : []),
    ...(req.retryNote ? ['', req.retryNote] : []),
    ...(req.avoidText ? ['', `직전에 만든 문장과 다른 표현으로 써라(같은 문장 금지): ${req.avoidText}`] : []),
  ];
  return { system, user: lines.join('\n') };
}
