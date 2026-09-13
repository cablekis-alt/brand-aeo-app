import { buildFactExtractPrompt, FACT_TYPES_FOR_EXTRACT } from '../src/prompts/b5e-fact-extract.js';
import type { FactGraphNode } from '../src/prompts/types.js';
import { collectPage } from './aeo/collectPage.js';
import type { EngineClient } from './engines/types.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 브랜드 페이지에서 팩트 그래프 후보를 뽑는다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * 팩트 그래프는 사람이 손으로 채우게 설계했고, 그래서 아무도 채우지 않았다. 111개 브랜드 중
 * 사실이 2건 이상인 곳이 하나뿐이다. 사실이 없으면 초안은 빈칸투성이가 되고, 그러면 초안을
 * 안 쓰게 된다.
 *
 * 경쟁 서비스(Frostai)는 브랜드 페이지를 읽어 본문에 그대로 쓴다. 스테이,머뭄 사례에서
 * 체크인 15시·추가 요금 2만원·직화 금지 같은 **운영 규정**을 정확히 가져왔다. 그건 마케팅
 * 문구가 아니라 가게가 공개한 계약 조건이라 신뢰할 만하다.
 *
 * ── 우리가 다르게 하는 것 ──────────────────────────────────────────────────
 * 뽑되 **바로 쓰지 않는다.** 후보로 올리고 사람이 승인해야 팩트 그래프에 들어간다. 그리고
 * 값은 페이지에 **글자 그대로** 있어야 한다 — 판정이 "약 20만원"을 "20만원"으로 다듬거나
 * "30여 명"을 "30명"으로 줄이면 그 자리에서 버린다. 요약·반올림은 새 사실을 만드는 것이고,
 * 그건 우리가 브리프·초안에서 이미 막고 있는 일이다.
 */
export interface FactCandidate {
  type: FactGraphNode['type'];
  claim: string;
  value: string;
  sourceUrl: string;
}

export interface FactExtractResult {
  candidates: FactCandidate[];
  sourceUrl: string;
  /** 페이지에 글자 그대로 없어서 버린 것과 이유. 조용히 지우지 않는다. */
  dropped: string[];
}

/** HTML에서 사람이 읽는 텍스트만 남긴다. 판정에 태그를 넣으면 토큰만 먹고 정확도는 안 오른다. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 값이 페이지에 그대로 있는지. 공백만 무시한다 — 숫자·단위·어미는 그대로여야 한다. */
function appearsVerbatim(value: string, pageText: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '');
  return squash(pageText).includes(squash(value));
}

/** 값의 길이 상한. 이보다 긴 것은 사실이 아니라 설명이다. */
const MAX_VALUE_LENGTH = 40;

/**
 * 값이 문장인지 — 사실이 아니라 설명을 가져온 것이다.
 *
 * 실측으로 걸린 것: 금연 규정의 값이 "건물과 객실 안은 절대 금연입니다."로 들어왔다.
 * 페이지에 글자 그대로 있으니 verbatim 가드는 통과하지만, 값은 브리프의 인용용 문장에
 * **그대로 박히는 자리**라 문장이 들어가면 "…는 건물과 객실 안은 절대 금연입니다입니다"가
 * 된다. 그 자리에 맞는 것은 "절대 금연" 같은 구(句)다.
 *
 * 종결어미와 마침표로 잡는다. "주차 가능"·"반려동물 동반 불가"·"숙박요금의 100%"처럼
 * 어미가 없는 구는 그대로 통과한다.
 */
function looksLikeSentence(value: string): boolean {
  if (value.length > MAX_VALUE_LENGTH) return true;
  if (/[.!?。][\s"'”’)\]]*$/.test(value)) return true; // 마침표로 끝남
  // 한국어 종결어미 — 문장 끝이든 중간이든(여러 문장을 이어 붙인 경우) 설명이다.
  return /(니다|세요|어요|아요|여요|해요|에요|예요|시오|십시오)/.test(value);
}

export async function extractFactCandidates(
  url: string,
  brandName: string,
  industry: string,
  judge: EngineClient,
  existing: FactGraphNode[] = [],
): Promise<FactExtractResult> {
  const page = await collectPage(url);
  if (page.fetchError) throw new Error(`페이지를 읽지 못했습니다: ${page.fetchError}`);
  const text = htmlToText(page.html);
  if (text.length < 200) {
    throw new Error(
      '페이지 본문이 거의 비어 있습니다. 자바스크립트로 그리는 페이지면 정적 HTML에 본문이 나오도록 해야 합니다.',
    );
  }
  const sourceUrl = page.finalUrl || url;

  const result = await judge.call(buildFactExtractPrompt(brandName, industry, text.slice(0, 12_000)));
  const parsed = parseJsonLoose<Array<Record<string, unknown>>>(result.text) ?? [];

  const dropped: string[] = [];
  const candidates: FactCandidate[] = [];
  const seen = new Set(existing.map((f) => `${f.claim}|${f.value}`));

  for (const row of parsed) {
    const claim = String(row?.claim ?? '').trim();
    const value = String(row?.value ?? '').trim();
    const type = FACT_TYPES_FOR_EXTRACT.includes(row?.type as never)
      ? (row.type as FactGraphNode['type'])
      : 'other';
    if (!claim || !value) continue;
    if (seen.has(`${claim}|${value}`)) continue;
    // 이것이 이 기능의 전부다. 페이지에 없는 값은 판정이 지어냈거나 다듬은 것이다.
    if (!appearsVerbatim(value, text)) {
      dropped.push(`"${claim}: ${value}" — 페이지에 이 값이 그대로 없어 뺐습니다(요약·격상 방지).`);
      continue;
    }
    // 값은 브리프 문장에 그대로 박히는 자리다. 문장이 들어가면 초안이 겹말이 된다.
    if (looksLikeSentence(value)) {
      dropped.push(`"${claim}: ${value}" — 문장이라 뺐습니다. 값은 "절대 금연"처럼 짧은 구여야 합니다.`);
      continue;
    }
    candidates.push({ type, claim, value, sourceUrl });
    if (candidates.length >= 20) break;
  }
  return { candidates, sourceUrl, ...(dropped.length ? { dropped } : { dropped: [] }) };
}
