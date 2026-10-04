import type { FactGraphNode, PromptMessage, QuestionLanguage } from './types';

/**
 * B9d 채널 다듬기 — 완성된 글(발행본)을 올릴 채널의 문체·형식으로 고쳐 쓴다.
 *
 * 콘텐츠 생성에서 글 한 편은 자사 사이트와 외부 채널 여러 곳(블로그·위키·커뮤니티 등)에 올라간다. 같은
 * 원고를 그대로 붙이면 위키에서는 홍보 문구로 지워지고, 커뮤니티에서는 광고로 읽힌다. 그래서 **내용은
 * 그대로 두고 형식만** 바꾼다 — 새 사실을 더하지 않는다. 결과는 초안과 같은 사실 대조를 다시 거친다
 * (server/channelAdapt.ts).
 *
 * 하지 않는 것: 고객 후기·체험담처럼 쓰기(가짜 후기), 원문에 없는 인용문·수치·순위 만들기.
 */

export type ChannelStyle = 'blog' | 'wiki' | 'community' | 'listing' | 'press' | 'social';

/** 실행 항목 배지(lib/gapActions LISTING_PLAY)에서 문체를 정한다. 모르는 배지는 블로그 문체로 둔다. */
export function channelStyleOf(badge: string): ChannelStyle {
  if (badge.includes('위키')) return 'wiki';
  if (badge.includes('커뮤니티')) return 'community';
  if (badge.includes('후기') || badge.includes('예약')) return 'listing';
  if (badge.includes('언론')) return 'press';
  if (badge.includes('소셜')) return 'social';
  return 'blog';
}

/** 화면에 적는 문체 설명. */
export const STYLE_LABEL: Record<ChannelStyle, string> = {
  blog: '블로그 문체 · 소제목 유지 · 짧은 문단',
  wiki: '중립 서술 · 홍보 문구 없음',
  community: '정보 공유 글 · 300~500자',
  listing: '등록 정보 · 소개와 항목',
  press: '보도자료 형식',
  social: '짧은 게시글 · 해시태그 3개 이하',
};

const STYLE_RULE: Record<ChannelStyle, string> = {
  blog: `블로그 글로 고친다. 소제목(##)은 원문 구조를 따르되 읽기 쉬운 말로 바꿔도 된다. 문단은 2~3문장으로 짧게,
"~해요/~입니다" 중 하나로 통일한다. 길이는 원문과 비슷하거나 조금 짧게. 맺음말 한 문단을 둔다.`,
  wiki: `위키 문서에 넣을 문단으로 고친다. 3인칭 중립 서술("~이다" 체), 홍보·권유·감탄 표현은 모두 뺀다
("추천", "최고", "믿을 수 있는", "방문해 보세요" 등). 소제목(##)은 주제별로 2~4개. 각 사실 뒤에 출처를 지어 붙이지 않는다.`,
  community: `커뮤니티(카페·게시판)에 올릴 정보 공유 글로 고친다. 300~500자. 질문 하나에 답하는 형태로, 핵심만 목록(-)으로
정리해도 된다. 고객 후기·체험담처럼 쓰지 않는다("제가 받아 봤는데" 금지) — 업체가 쓴 정보 글임을 감추지 않는다.`,
  listing: `후기·예약 플랫폼에 등록할 업체 정보로 고친다. 형식: 첫 줄에 한 문장 소개, 이어서 "## 소개"(2~3문장),
"## 진료·서비스"(목록), "## 이용 안내"(원문에 있는 위치·연락·운영 정보만, 없으면 이 절을 뺀다).`,
  press: `보도자료 형식으로 고친다. 제목, 첫 문단에 핵심(누가·무엇을), 이어서 본문 2~3문단. 인용문("~라고 말했다")을
만들지 않는다 — 원문에 없는 말을 누군가의 말로 지어내는 것이 된다.`,
  social: `소셜 게시글로 고친다. 3~5문장, 첫 문장에 핵심. 해시태그는 3개 이하로 끝에 둔다. 이모지는 쓰지 않는다.`,
};

export interface ChannelAdaptRequest {
  brandName: string;
  channelDomain: string;
  style: ChannelStyle;
  /** 발행본 마크다운(빈칸 표시·내부 메모를 뺀 것). 이것만이 내용의 근거다. */
  sourceMarkdown: string;
  factGraph: FactGraphNode[];
  language?: QuestionLanguage;
}

export interface ChannelAdaptOutput {
  title: string;
  /** 마크다운 본문(## 소제목·문단·목록). 제목(#)은 넣지 않는다. */
  body: string;
}

export function buildChannelAdaptPrompt(req: ChannelAdaptRequest): PromptMessage {
  const facts = req.factGraph.length
    ? req.factGraph.map((f) => `- ${f.claim}: ${f.value}`).join('\n')
    : '- (등록된 사실 없음)';
  const language = req.language === 'en' ? '영어로 쓴다(원문이 영어다).' : '원문과 같은 한국어로 쓴다.';

  const system = `당신은 ${req.brandName}의 콘텐츠 편집자입니다. 이미 완성된 원문을 받아 올릴 채널에 맞게 **형식과 문체만** 고칩니다.

절대 규칙:
1. 내용은 원문에 있는 것만 쓴다. 원문에 없는 사실·숫자·가격·기간·인원·순위·효과를 더하지 않는다.
2. 숫자와 고유명사는 원문 글자 그대로 옮긴다. 단위를 바꾸거나 반올림하지 않는다.
3. 원문보다 크게 말하지 않는다("가장", "최초", "유일", "100%" 같은 말을 새로 붙이지 않는다).
4. 고객 후기·체험담·가짜 인용문을 만들지 않는다.
5. 줄일 때는 빼는 것만 한다. 빼서 뜻이 바뀌면 그 문장은 통째로 뺀다.
6. ${language}

채널 형식:
${STYLE_RULE[req.style]}

출력은 JSON 하나만: {"title": string, "body": string}
body는 마크다운이며 제목(# )은 넣지 않는다. 소제목은 ##, 목록은 - 로 쓴다.`;

  const user = `올릴 채널: ${req.channelDomain}

원문:
${req.sourceMarkdown}

참고 — 브랜드 사실(이 범위를 넘는 사실은 원문에 있어도 더 늘리지 않는다):
${facts}`;

  return { system, user };
}

/**
 * 원문 지문 — 다듬은 글이 지금 원문에서 나온 것인지 가린다(원문을 고치거나 빈칸을 더 채우면 바뀐다).
 * 암호용이 아니라 변경 감지용이라 짧은 해시면 된다.
 */
export function sourceKeyOf(markdown: string): string {
  let h = 5381;
  for (let i = 0; i < markdown.length; i += 1) h = ((h << 5) + h + markdown.charCodeAt(i)) >>> 0;
  return `${markdown.length.toString(36)}-${h.toString(36)}`;
}
