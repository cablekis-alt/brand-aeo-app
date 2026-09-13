import { buildFactForGapsPrompt, type GapFactHit } from '../src/prompts/b5f-fact-for-gaps.js';
import { FACT_TYPES_FOR_EXTRACT } from '../src/prompts/b5e-fact-extract.js';
import type { FactGraphNode } from '../src/prompts/types.js';
import { collectPage } from './aeo/collectPage.js';
import type { EngineClient } from './engines/types.js';
import { appearsVerbatim, htmlToText, looksLikeSentence } from './factExtract.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 초안이 비워 둔 자리를 브랜드 페이지에서 메운다.
 *
 * ── 왜 ───────────────────────────────────────────────────────────────────
 * 빈칸을 "나가서 찾아오세요"로 두면 사람이 앱을 떠난다. 스테이,머뭄 초안의 빈칸 4개 중
 * 둘(숙박 요금·취사도구 품목)은 브랜드 페이지에 있을 법한 값이다. 매번 사람을 내보낼
 * 이유가 없다.
 *
 * ── 다만 지어내지는 않는다 ────────────────────────────────────────────────
 * 사실 추출(b5e)과 같은 가드 두 개를 그대로 쓴다 — 값이 페이지에 글자 그대로 있어야 하고,
 * 문장이 아니라 구여야 한다. 없으면 없다고 돌려준다. 빈칸은 정직함의 표시라, 여기서
 * 그럴듯하게 메우면 초안이 빈칸을 남긴 이유가 사라진다.
 */
export interface GapFillResult {
  found: GapFactHit[];
  /** 페이지에 없던 것 — 화면이 여기에 입력칸을 띄운다. */
  missing: string[];
  sourceUrl: string;
  /** 가드가 끊은 것과 이유. 조용히 지우지 않는다. */
  dropped: string[];
}

export async function findFactsForGaps(
  url: string,
  brandName: string,
  industry: string,
  needs: string[],
  judge: EngineClient,
  existing: FactGraphNode[] = [],
): Promise<GapFillResult> {
  const page = await collectPage(url);
  if (page.fetchError) throw new Error(`페이지를 읽지 못했습니다: ${page.fetchError}`);
  const text = htmlToText(page.html);
  if (text.length < 200) {
    throw new Error('페이지 본문이 거의 비어 있습니다. 사실이 적힌 다른 주소를 브랜드 페이지로 등록해 주세요.');
  }
  const sourceUrl = page.finalUrl || url;

  const result = await judge.call(buildFactForGapsPrompt(brandName, industry, needs, text.slice(0, 12_000)));
  const parsed = parseJsonLoose<Array<Record<string, unknown>>>(result.text) ?? [];

  const byNeed = new Map<string, Record<string, unknown>>();
  for (const row of parsed) {
    const need = String(row?.need ?? '').trim();
    if (need) byNeed.set(need, row);
  }

  const found: GapFactHit[] = [];
  const missing: string[] = [];
  const dropped: string[] = [];
  const seen = new Set(existing.map((f) => `${f.claim}|${f.value}`));

  for (const need of needs) {
    // 판정이 need를 그대로 되돌려 주지 않을 수 있으니 순서로도 찾아본다.
    const row = byNeed.get(need) ?? parsed[needs.indexOf(need)];
    const value = String(row?.value ?? '').trim();
    const claim = String(row?.claim ?? '').trim() || need;
    if (!row || row.found === false || !value || value === 'null') {
      missing.push(need);
      continue;
    }
    if (!appearsVerbatim(value, text)) {
      dropped.push(`"${need}" → "${value}" — 페이지에 이 값이 그대로 없어 뺐습니다.`);
      missing.push(need);
      continue;
    }
    if (looksLikeSentence(value)) {
      dropped.push(`"${need}" → "${value}" — 문장이라 뺐습니다. 값은 짧은 구여야 합니다.`);
      missing.push(need);
      continue;
    }
    if (seen.has(`${claim}|${value}`)) {
      missing.push(need);
      continue;
    }
    const type = FACT_TYPES_FOR_EXTRACT.includes(row.type as never)
      ? (row.type as FactGraphNode['type'])
      : 'other';
    found.push({ need, type, claim, value, sourceUrl });
  }
  return { found, missing, sourceUrl, dropped };
}
