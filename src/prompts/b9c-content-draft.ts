import type { ContentBrief } from './b9b-content-brief';
import type { FactGraphNode, PromptMessage, QuestionLanguage } from './types';

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

/**
 * 블로그 글 형식(format 'article')에서 text 문단의 구실. 내보낼 때 모양이 갈린다(src/lib/markdownFile.ts) —
 * key는 굵게, quote는 인용, 나머지는 보통 문단.
 */
export type DraftRole = 'key' | 'action' | 'why' | 'quote' | 'limit';
export const DRAFT_ROLES: readonly DraftRole[] = ['key', 'action', 'why', 'quote', 'limit'];

/** 문단 하나 — 쓴 것이거나, 못 써서 비운 것이거나. 둘 중 하나다. */
export interface DraftBlock {
  /** 'text'면 body가 본문, 'gap'이면 need가 "무엇이 필요한가". */
  kind: 'text' | 'gap';
  body?: string;
  /** gap일 때: 이 자리를 채우려면 어떤 사실이 필요한가. 팩트 그래프에 추가할 항목이 된다. */
  need?: string;
  /** 블로그 글 형식의 text 문단 구실. 옛 초안 · 옛 형식에는 없다. */
  role?: DraftRole;
}

/** 사진 자리 — 글은 사진을 만들지 않는다. 무엇을 찍어 넣을지(alt)와 그 아래 한 줄(caption)만 제안한다. */
export interface DraftImage {
  alt: string;
  caption?: string;
}

export interface DraftSection {
  heading: string;
  /** 이 절이 답하는 질문 — 브리프 structure의 answers를 잇는다. */
  answers: string;
  blocks: DraftBlock[];
  /** 블로그 글 형식에서 사진이 글을 돕는 절에만. */
  image?: DraftImage;
}

/** 초안 형식 — 없으면 옛 형식(짧은 문단 원고). 'article'은 블로그 긴 글(절 번호 · 핵심 문장 · 사진 자리). */
export type DraftFormat = 'article';

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
  /** 이 초안의 형식. 없으면 옛 형식 — 옛 초안의 내보내기는 한 글자도 바뀌지 않는다. */
  format?: DraftFormat;
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
  /** 원고 언어. 없으면 한국어. 영어 테넌트(해외 환자 관점)는 'en'. */
  language?: QuestionLanguage;
  /** 'article'이면 블로그 긴 글 형식. 영어 원고에는 쓰지 않는다(articleFormatOf). */
  format?: DraftFormat;
}

/** 이 요청이 블로그 글 형식인지 — 영어 원고는 옛 형식 그대로 둔다(규칙 8이 둘이 되지 않게). */
export function articleFormatOf(req: Pick<ContentDraftRequest, 'format' | 'language'>): DraftFormat | undefined {
  return req.format === 'article' && req.language !== 'en' ? 'article' : undefined;
}

/**
 * 영어 원고 규칙 — title·lead·본문은 영어, gap의 need는 운영자 메모라 한국어.
 * 사실 값은 번역하지 않는다: 사실 가드가 값 문자열을 그대로 찾기 때문에, 번역한 값은 "요약·격상"으로
 * 걸려 문장이 빠진다. 영어 원고에는 영어 값으로 된 팩트 그래프(영문 사이트에서 추출)가 필요하다.
 */
const ENGLISH_DRAFT_RULE = `
8. **이 초안은 해외 환자에게 보이는 영어 원고다.** title·lead·각 절의 heading과 text 본문은 자연스러운 영어로 쓴다.
   gap의 need는 운영자가 읽는 메모라 한국어로 쓴다. 1-1의 "우리말로 풀어 쓴다"는 "자연스러운 영어로 풀어 쓴다"로 읽는다.
   사실 값은 팩트 그래프에 적힌 글자 그대로 옮긴다 — 번역하거나 단위를 바꾸지 않는다(값이 한국어면 그 문단은 gap으로 둔다).`;

/**
 * 블로그 글 형식 규칙 — 참고한 글(에이전시 블로그)의 뼈대: 첫머리에서 답하고, 절마다 질문 → 핵심 한 문장 →
 * 할 일 · 이유 · 그대로 쓸 말 · 한계, 사진 자리. 실측 답변 · 공식 링크 · 상담 안내 · 태그는 **코드가 붙인다**
 * (src/lib/publishArticle.ts) — 글쓰기 엔진이 지어내면 확인할 수 없어서 금지한다.
 */
const ARTICLE_DRAFT_RULE = `
8. **이 초안은 블로그 긴 글이다.** 읽는 사람이 이 글만 보고 바로 움직일 수 있게 쓴다.
   lead와 모든 text 본문을 합쳐 2,500~3,500자. 사실이 모자라면 짧아도 된다 — 길이를 채우려고 사실을 지어내지 않는다.
   - heading은 규칙 6대로 뜻과 순서를 지키되, 독자가 실제로 묻는 **질문 꼴**로 다듬는다. 앞에 번호를 붙이지 않는다(코드가 붙인다).
   - text 블록마다 role을 붙인다.
       key    그 절의 질문에 대한 답 한 문장. 절의 첫 블록이다(규칙 5). 굵게 나간다.
       action 독자가 할 일 — 무엇을 어떤 순서로 확인하거나 준비하는지.
       why    그 일이 왜 중요한지.
       quote  독자가 그대로 옮겨 쓸 말 1~2문장(문의 · 예약 · 상담 때 물어볼 말 등). 인용으로 나간다.
       limit  한계 · 주의 — 이 방법으로 안 되는 것, 미리 알아 둘 조건.
     key는 절마다 하나. action · why · quote · limit는 쓸 말이 있을 때만 하나씩 — 억지로 채우지 않는다.
   - 사진이 글을 돕는 절(최대 3개)에만 "image"를 붙인다: alt는 사진에 담길 장면, caption은 사진 아래 한 줄.
     사진은 사람이 직접 찍거나 고른다 — 브랜드에 실제로 있는 장소 · 물건 · 화면만 제안하고, 수상 · 인증 장면처럼
     확인하지 않은 것은 제안하지 않는다. caption에 사실이 들어가면 규칙 1~3을 따른다.
   - 쓰지 않는 것: 팩트 그래프에 없는 통계 · 건수 · 비율, 주소(URL), "AI에게 물어보면 ~라고 답한다" 같은 AI 답변
     묘사(실제로 잰 답변은 코드가 따로 붙인다), 문의 · 상담 · 예약 유도 문구(브랜드 안내 문구를 코드가 글 끝에 붙인다),
     마크다운 기호(**, #, >, 목록 기호).
   - 제목에 절 수를 넣고 싶으면 숫자 대신 {N}이라고 쓴다(예: "… 고를 때 확인할 {N}가지"). 코드가 실제로 실린 절 수로 바꾼다.
   - 브리프 구조의 [table] · [list] 절도 표 · 목록 없이 문장으로 쓴다. 항목이 여럿이면 action 블록을 여러 개로 나눈다.
   - 문장 하나가 빠져도 나머지가 읽히게 쓴다(사실 확인에 걸린 문장은 코드가 뺀다). 앞 문장을 가리키는 말(그다음 · 그곳 ·
     그래서 · 이때 등)로 문장을 시작하지 말고, 순서가 있으면 한 문장 안에 담는다(예: "먼저 가장 오래 머물 곳을 고른 뒤
     그곳과 가까운 숙소를 찾으세요"). 일정 · 기간은 숫자로 쓰지 않아도 되면 쓰지 않는다.
   - 빈칸(gap)에는 "scope"를 붙인다. brand = 브랜드가 확인해 줄 수 있는 자기 정보(가격 · 시설 · 운영 · 인력 · 정책, 그리고
     인증 · 등록 · 등급 · 허가 · 보험처럼 기관이 정해 주지만 그 브랜드의 상태인 것),
     external = 브랜드 밖의 정보(시장 통계 · 업계 평균 · 공공기관이나 지자체가 정하는 정보 · 다른 업체 정보).
     external이 필요한 자리는 빈칸으로 두기보다 독자가 직접 확인할 곳과 방법(action)으로 바꿔 쓴다. 그래도 남으면 scope를
     external로 둔다 — 그런 빈칸은 브랜드가 채울 수 없어 코드가 본문에서 뺀다. 애매하면 brand로 둔다.`;

const DRAFT_SCHEMA = `JSON 스키마:
{
  "title": string,
  "lead": string,
  "sections": [
    { "heading": string, "answers": string,
      "blocks": [ {"kind":"text","body":string} | {"kind":"gap","need":string} ] }
  ]
}
lead는 2~3문장. 각 절의 blocks는 1~4개. 사실이 없어 쓸 게 없는 절은 blocks가 gap 하나여도 된다.`;

const ARTICLE_SCHEMA = `JSON 스키마:
{
  "title": string,
  "lead": string,
  "sections": [
    { "heading": string, "answers": string,
      "blocks": [ {"kind":"text","role":"key"|"action"|"why"|"quote"|"limit","body":string} | {"kind":"gap","need":string,"scope":"brand"|"external"} ],
      "image": {"alt": string, "caption": string} }
  ]
}
image는 붙일 절에만 쓴다(없으면 키를 빼라). lead는 2~3문장 — 글 전체의 질문에 바로 답한다.
각 절의 blocks는 2~6개. 사실이 없어 쓸 게 없는 절은 blocks가 gap 하나여도 된다.`;

export function buildContentDraftPrompt(req: ContentDraftRequest): PromptMessage {
  const article = articleFormatOf(req) === 'article';
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
1-1. 다만 팩트 그래프의 **항목 이름(":" 왼쪽)을 문장에 그대로 붙여 넣지 마라.** 그대로 옮기는 것은
   **값(":" 오른쪽)**뿐이다. 항목 이름이 뜻하는 바는 자연스러운 우리말로 풀어 쓴다.
     팩트: "마취과 전담 원장 수: 3명"
     틀림: "마취과 전담 원장 수: 3명이 상주하며"   ← 항목 이름이 문장에 박혔다
     맞음: "마취과를 전담하는 원장 3명이 상주하며"  ← 값 "3명"은 그대로, 나머지는 우리말
     팩트: "대표원장 경력: 23년 07개월"
     틀림: "대표원장: 강문석(대표원장 경력: 23년 07개월)"
     맞음: "대표원장 강문석은 23년 07개월의 경력을 갖고 있습니다"
1-2. **값이 이미 주어를 품고 있으면 항목 이름은 아예 쓰지 마라.** 항목 이름과 값에 같은 말이
   들어 있으면 "A는 A다" 꼴의 겹말이 된다. 이때는 값만으로 문장이 선다.
     팩트: "자쿠지 또는 스파 구비 여부: 자쿠지 없음"
     틀림: "자쿠지 또는 스파 구비 여부는 자쿠지 없음으로 확인됩니다"  ← 겹말
     맞음: "자쿠지는 없습니다"
     팩트: "반려동물 동반 여부: 반려동물 동반 불가"
     틀림: "반려동물 동반 여부는 반려동물 동반 불가이며"             ← 겹말
     맞음: "반려동물은 동반하실 수 없으며"
     팩트: "월명동 중심부와의 정확한 도보 소요 시간: 도보 8분"
     틀림: "월명동 중심부와의 정확한 도보 소요 시간은 도보 8분으로"   ← 항목 이름이 박혔다
     맞음: "월명동 중심부까지는 도보 8분입니다"
   항목 이름은 그 값이 무엇인지 당신이 알아보라고 붙여 둔 꼬리표다. 독자에게 보일 말이 아니다.
1-3. **브리프의 structure 순서를 그대로 따른다.** 브랜드가 뒤쪽 절에 놓여 있으면 앞 절을
   브랜드 이야기로 채우지 마라 — 앞 절은 브랜드 없이 읽히는 안내다. 브랜드명을 앞 절에 넣고
   싶어지면, 그 자리에 들어갈 말은 "어떤 숙소를 고를 때 무엇을 봐야 하는가"이지 우리 이름이 아니다.

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
7. 출력은 아래 JSON 하나만. 설명·마크다운·코드블록 금지.${article ? ARTICLE_DRAFT_RULE : ''}

${article ? ARTICLE_SCHEMA : DRAFT_SCHEMA}${req.language === 'en' ? ENGLISH_DRAFT_RULE : ''}`;

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

쓰기 전에 확인이 필요해 **아직 쓸 수 없는 것**(이 자리는 gap으로 둔다 — 단, 아래 팩트 그래프에 그 값이
이제 있으면 gap으로 두지 말고 그 값을 글자 그대로 써서 문장으로 채운다. 브리프를 만든 뒤 사람이 확인해 넣은 사실이다):
${b.doNotClaim.map((f) => `- ${f}`).join('\n') || '- (없음)'}

팩트 그래프(이 사실만 쓸 수 있다):
${facts}`;

  return { system, user };
}
