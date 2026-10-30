import type { FactGraphNode, PromptMessage, QuestionLanguage } from './types';

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
  /** 팩트 그래프에 없어 이 글에 쓰기 전에 확인이 필요한 **사실**. 문체 규칙은 여기 오지 않는다 */
  doNotClaim: string[];
  /** 인용되기 쉬운 구조 — H2 단위. 각 절이 어느 질문에 답하는지 */
  structure: { heading: string; answers: string; format: 'paragraph' | 'faq' | 'table' | 'list' }[];
  /** 그대로 옮겨도 되는 인용용 문장 3~5개 — 사실 기반, 과장 없이 */
  citableSentences: string[];
  /** 채널 메모(등재형): 그 플랫폼에서 지켜야 할 것 */
  channelNotes: string[];
  /**
   * 서버 검증이 걸러낸 것에 대한 설명(있을 때만). 판정이 사실을 요약·격상하면("의료진 30명" →
   * "전문의 30명") 그 문장을 버리고 여기 이유를 적는다 — 조용히 지우면 사용자가 "문장이 왜 3개뿐이지"
   * 하고 판정을 의심하게 된다.
   */
  guardNotes?: string[];
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
    /** 다룰 각도(추가 글만) — 주제 이름과 사람이 적은 각도. 없으면 프롬프트가 예전과 한 글자도 다르지 않다. */
    angle?: string;
    /**
     * 이미 쓴 본 글(추가 글만) — 본 글 초안의 제목과 소제목. 추가 글이 본 글과 같은 절을 되풀이하지 않게 한다.
     * 본 글은 다시 만들지 않으므로(src/lib/extraArticles.ts) 겹침은 추가 글 쪽에서 피한다.
     */
    avoid?: BriefAvoid;
  };
  /** 원고 언어. 없으면 한국어. 영어 테넌트(해외 환자 관점)는 'en'. */
  language?: QuestionLanguage;
}

export interface BriefAvoid {
  title: string;
  headings: string[];
}

/** 각도 · 피할 글의 길이 상한. 넘는 값은 자른다 — 프롬프트가 본 글 원고만큼 길어지지 않게. */
export const BRIEF_FOCUS_LIMITS = {
  angle: 200,
  /** 피할 소제목 수. */
  headings: 20,
  /** 제목 · 소제목 한 줄. */
  heading: 80,
} as const;

const clipText = (v: string, max: number): string => v.trim().slice(0, max).trim();

/**
 * 요청 본문의 angle · avoid를 고른다(서버 POST /api/content-brief와 화면이 같은 규칙을 쓴다). 모양이 틀리면 버린다 — 브리프는 둘
 * 없이도 만들 수 있으니 400으로 막지 않는다. 비면 키를 아예 두지 않아 프롬프트가 예전과 같다.
 */
export function briefFocusOf(angle: unknown, avoid: unknown): { angle?: string; avoid?: BriefAvoid } {
  const out: { angle?: string; avoid?: BriefAvoid } = {};
  if (typeof angle === 'string') {
    const a = clipText(angle, BRIEF_FOCUS_LIMITS.angle);
    if (a) out.angle = a;
  }
  if (avoid && typeof avoid === 'object' && !Array.isArray(avoid)) {
    const r = avoid as Record<string, unknown>;
    if ((r.title === undefined || typeof r.title === 'string') && Array.isArray(r.headings)) {
      const title = typeof r.title === 'string' ? clipText(r.title, BRIEF_FOCUS_LIMITS.heading) : '';
      const headings = r.headings
        .filter((h): h is string => typeof h === 'string')
        .map((h) => clipText(h, BRIEF_FOCUS_LIMITS.heading))
        .filter(Boolean)
        .slice(0, BRIEF_FOCUS_LIMITS.headings);
      if (title || headings.length) out.avoid = { title, headings };
    }
  }
  return out;
}

/**
 * 영어 원고 규칙 — 원고에 들어가는 칸만 영어로 쓰고, 운영자가 읽는 메모는 한국어로 둔다.
 * 원고를 다듬고 사실을 확인하는 사람은 한국 직원이라, 메모까지 영어면 확인이 늦어진다.
 */
const ENGLISH_BRIEF_RULE = `
6. **이 글은 해외 환자에게 보이는 영어 원고다.** titles·questionsToAnswer·structure의 heading·citableSentences는
   자연스러운 영어로 쓴다. audience·doNotClaim·channelNotes·structure의 answers는 운영자가 읽는 메모라 한국어로 쓴다.
   citableSentences는 각 25단어 이내로 쓴다. 사실 값은 팩트 그래프에 적힌 글자 그대로 옮긴다(번역하지 않는다).`;

export function buildContentBriefPrompt(req: ContentBriefRequest): PromptMessage {
  const facts = req.factGraph.length
    ? req.factGraph.map((f) => `- [${f.type}] ${f.claim}: ${f.value}`).join('\n')
    : '- (등록된 사실 없음)';
  const system = `당신은 AEO(답변엔진 최적화) 콘텐츠 기획자입니다. **글을 쓰지 않습니다.** 사람이 쓸 글의 브리프만 만듭니다.

절대 규칙:
1. 사실(가격·수치·주소·인증·연혁·의사 수 등)은 아래 "팩트 그래프"에 있는 것만 mustIncludeFacts에 넣는다.
   거기 없는데 이 글에 필요한 사실은 만들어내지 말고 doNotClaim에 "확인 필요: <무엇>" 형태로 적는다.
   doNotClaim에는 그런 **사실 항목만** 넣는다. 작성 규칙·문체 지침·일반 조언은 넣지 않는다.
1-1. 사실은 **요약하거나 바꿔 쓰지 않는다.** mustIncludeFacts 원소는 팩트 그래프의 "<주장>: <값>"을 글자
   그대로 옮긴다. 인용용 문장에 사실을 담을 때도 값 문자열을 그대로 포함시킨다. 특히 명사를 격상하지
   마라 — "의료진 30명"을 "전문의 30명"으로, "약 20만원"을 "20만원"으로 바꾸는 것은 새 사실을 만드는 것이다.
2. "최고·유일·1위·완벽" 같은 과장 표현은 어디에도 쓰지 않는다. 인용용 문장은 검증 가능한 사실만 담는다.
   이 문체 규칙 자체를 출력에 적지 마라 — doNotClaim은 **사실 항목**만 담는 자리다.
3. questionsToAnswer는 제공된 질문을 **그대로** 먼저 넣고, 그 질문에 답하려면 꼭 필요한 하위 질문만 보탠다.
4. 구조는 답변 엔진이 추출하기 쉬운 형태를 우선한다 — 질문형 H2, 첫 문장에 직접 답, FAQ, 비교표.
4-1. **질문에 브랜드명이 없으면, 브랜드는 글 뒤쪽에 "실제 사례"로 한 절만 둔다.**
   앞 절들은 브랜드 없이도 읽히는 안내여야 한다 — 고르는 기준, 확인할 항목, 비교표.
   그다음 절에서 "이 기준을 실제로 적용해 보면"이라며 우리 브랜드를 예로 든다.
     맞음  ① 군산 펜션, 왜 위치부터 봐야 하나  ② 위치 체크리스트(표)
           ③ 편의시설 확인 항목  ④ 실제 사례로 적용 — <브랜드>  ⑤ FAQ
     틀림  ① <브랜드> 소개  ② <브랜드> 시설  ③ <브랜드> 이용 안내
   이유: 사람이 "군산 펜션 추천해줘"라고 물을 때 답변 엔진이 인용하는 것은 브랜드 소개글이
   아니라 **고르는 법을 알려 주는 글**이다. 브랜드만 늘어놓은 글은 광고로 취급돼 인용되지 않는다.
   사실은 그 사례 절에 모아 넣으면 된다 — 인용될 때 브랜드와 함께 딸려 간다.
4-2. 반대로 **질문에 브랜드명이 있으면 첫 절에서 바로 답한다.** "스테이,머뭄 체크인 몇 시야?"에
   일반론부터 꺼내는 것은 나쁜 글이다. 이때는 4-1을 적용하지 않는다.
4-3. **브랜드가 확인해 줄 수 없는 바깥 수치가 있어야 쓸 수 있는 절은 만들지 않는다** — 시장 통계 · 업계 평균 가격 ·
   공공기관이나 지자체가 정하는 기준 · 다른 업체의 수치. 그런 주제는 "고르는 기준" · "확인할 항목"처럼 독자가 직접
   확인하는 방법으로 바꾼다. doNotClaim에도 그런 바깥 수치는 넣지 않는다 — 브랜드에 물어 채울 수 없는 자리가 된다.
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
titles는 2~3개, citableSentences는 3~5개(각 60자 이내), channelNotes는 콘텐츠형이면 빈 배열이어도 된다.${req.language === 'en' ? ENGLISH_BRIEF_RULE : ''}`;
  const kindLine =
    req.action.kind === 'listing'
      ? `종류: 외부 채널 등재·기고 — 대상 채널 ${req.action.targetDomain ?? '(미정)'}. 그 채널에서 지켜야 할 것(광고성 금지·문서 규칙·형식)을 channelNotes에 적는다.`
      : '종류: 자사 사이트 콘텐츠 — 우리 도메인에 올릴 페이지의 브리프.';
  // 각도 · 피할 글은 추가 글에만 온다. 없으면 두 자리가 빈 문자열이라 프롬프트가 예전과 한 글자도 다르지 않다
  // (scripts/verify-extra-articles.ts가 기준 문자열로 확인한다).
  const angle = req.action.angle?.trim() ?? '';
  const angleLine = angle ? `\n다룰 각도: ${angle} — 제목 후보와 구조를 이 각도에 맞춘다.` : '';
  const avoidTitle = req.action.avoid?.title.trim() ?? '';
  const avoidHeadings = (req.action.avoid?.headings ?? []).map((h) => h.trim()).filter(Boolean);
  const avoidBlock =
    avoidTitle || avoidHeadings.length
      ? `\n\n이미 쓴 본 글(겹치지 않게): ${avoidTitle ? `「${avoidTitle}」` : '(제목 없음)'}
${avoidHeadings.length ? '아래 소제목과 같은 절을 만들지 말고' : '본 글과 같은 절을 만들지 말고'}, 이 글의 질문을 더 깊게 다룬다.${avoidHeadings.map((h) => `\n- ${h}`).join('')}`
      : '';
  const user = `브랜드: ${req.brandName} (${req.industry} · ${req.region})
경쟁사: ${req.competitorNames.join(', ') || '(없음)'}
${kindLine}
실행 항목: ${req.action.title}
왜 이 항목이 나왔나: ${req.action.evidence}${angleLine}

이 글이 답해야 할 질문(AI가 이 출처를 꺼낸 질문 / 우리가 밀린 질문):
${req.action.questionTexts.map((q) => `- ${q}`).join('\n') || '- (질문 없음 — 채널 특성만으로 기획)'}${avoidBlock}

팩트 그래프(이 사실만 쓸 수 있다):
${facts}`;
  return { system, user };
}
