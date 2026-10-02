import { buildClaimCheckPrompt, type ClaimCheckItem, type ClaimCheckVerdict } from '../src/prompts/b5g-claim-check.js';
import type { FactGraphNode } from '../src/prompts/types.js';
import type { EngineClient } from './engines/types.js';
import { containsValue, type GuardMode } from './factGuard.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 격상 가드 — 숫자 없는 격상(대표 원장 → 설립자, 원장단 → 의료진 전체)을 판정 모델로 잡는다.
 *
 * 사실 가드(factGuard)가 숫자를 대조한 **뒤에** 돈다. 사실 값이 들어간 문장만 골라 한 번에 보내므로
 * 원고 하나에 판정 호출이 한 번 는다. 판정이 실패하면 원고를 막지 않고, 검사하지 못했다는 사실을
 * 기록에 남긴다 — 조용히 넘어가면 "검사를 통과했다"로 읽힌다.
 */
export interface OverclaimResult {
  /** 격상으로 판정된 문장(원문 그대로). */
  overclaimed: Set<string>;
  /** 걸린 이유와 검사하지 못한 사정. 호출부가 guardNotes·editWarnings에 붙인다. */
  notes: string[];
}

/** 한 번에 보내는 문장 수 상한 — 초안 하나는 보통 10~20문장이다. 넘으면 앞쪽만 보고 밝힌다. */
const MAX_SENTENCES = 40;

export async function findOverclaims(
  sentences: string[],
  facts: FactGraphNode[],
  judge: EngineClient,
  mode: GuardMode,
): Promise<OverclaimResult> {
  const overclaimed = new Set<string>();
  const notes: string[] = [];

  const items: ClaimCheckItem[] = [];
  for (const sentence of new Set(sentences)) {
    // 사실 가드와 같은 대조 규칙(대소문자 무시) — 다르면 "since 2005" 문장이 격상 검사를 건너뛴다.
    const hits = facts.filter((f) => f.value && containsValue(sentence, f.value));
    if (hits.length) items.push({ id: items.length + 1, sentence, facts: hits.map((f) => `${f.claim}: ${f.value}`) });
  }
  if (items.length === 0) return { overclaimed, notes };
  const batch = items.slice(0, MAX_SENTENCES);
  if (items.length > batch.length) {
    notes.push(`사실이 들어간 문장이 ${items.length}개라 앞 ${batch.length}개만 격상 검사를 했습니다.`);
  }

  let verdicts: ClaimCheckVerdict[] | null;
  try {
    const result = await judge.call(buildClaimCheckPrompt(batch));
    verdicts = parseJsonLoose<ClaimCheckVerdict[]>(result.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[claimGuard] 격상 검사 실패: ${message}`);
    notes.push(`격상 검사를 하지 못했습니다(${message}) — 사실이 들어간 문장을 사람이 한 번 더 확인하세요.`);
    return { overclaimed, notes };
  }
  if (!Array.isArray(verdicts)) {
    notes.push('격상 검사 응답을 해석하지 못했습니다 — 사실이 들어간 문장을 사람이 한 번 더 확인하세요.');
    return { overclaimed, notes };
  }

  for (const v of verdicts) {
    if (v?.verdict !== 'overclaim') continue;
    const item = batch.find((it) => it.id === v.id);
    if (!item) continue;
    overclaimed.add(item.sentence);
    const reason = (v.reason ?? '').trim() || '등록된 사실보다 크게 말합니다.';
    notes.push(
      mode === 'drop'
        ? `"${item.sentence}" — ${reason} 그래서 뺐습니다(격상 방지).`
        : `"${item.sentence}" — ${reason} 등록된 사실(${item.facts.join(' / ')})과 맞는지 확인하세요.`,
    );
  }
  return { overclaimed, notes };
}
