import type { FactGraphNode } from '../src/prompts/types.js';

/**
 * 사실 가드 — 판정이 사실을 요약·격상·창작하는 것을 코드로 막는다.
 *
 * 프롬프트가 금지하지만 어길 때가 있다(실측: "30명의 의료진이 직접 집도"를 "전문의 30명"으로
 * 옮겼다 — 의료진과 전문의는 다른 주장이다). 브리프에서 쓰던 규칙을 여기로 꺼낸 이유는
 * **초안도 같은 규칙을 써야 하기 때문**이다. 두 벌로 두면 한쪽만 고쳐져, 브리프는 막고 초안은
 * 통과시키는 상태가 된다. 그러면 둘 다 못 믿게 된다.
 *
 * 걸러낸 것은 notes에 이유와 함께 쌓는다 — 조용히 지우지 않는다. 사용자가 "문장이 왜 3개뿐이지"
 * 하고 판정 자체를 의심하게 만들지 않기 위해서다.
 */
export interface FactGuard {
  /** 판정이 쓴 사실 문장을 팩트 그래프의 "<주장>: <값>" 정본으로 바꾼다. 짝이 없으면 버린다. */
  canonicalFacts: (arr: string[]) => string[];
  /** 숫자를 담은 문장이 그 숫자의 출처 값을 그대로 담고 있는지. 아니면 false(= 버린다). */
  guardSentence: (sentence: string) => boolean;
  /** 걸러낸 이유들. 호출부가 결과에 붙여 화면에 드러낸다. */
  notes: string[];
}

/**
 * 문자열에 든 숫자를 **토큰으로** 뽑는다.
 *
 * 부분 문자열로 비교하면 안 된다. 실측(가드 단위 시험): 질문에 "50인 규모"가 있으면
 * 지어낸 문장 "누적 수술 5만 건"의 5가 "50" 안에 들어 있다는 이유로 통과했다.
 * 숫자는 토큰 단위로 같아야 같은 숫자다.
 */
function numberTokens(s: string): Set<string> {
  return new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);
}

export function createFactGuard(facts: FactGraphNode[], questionTexts: string[]): FactGuard {
  const notes: string[] = [];
  const questionNums = numberTokens(questionTexts.join('\n'));
  const factNums = facts.map((f) => ({ fact: f, nums: numberTokens(f.value) }));

  const canonicalFacts = (arr: string[]): string[] => {
    const out: string[] = [];
    for (const item of arr) {
      // 값 원문 포함 → 그 사실. 아니면 주장 이름 포함 → 그 사실. 둘 다 아니면 새로 만든 사실.
      const hit = facts.find((f) => item.includes(f.value)) ?? facts.find((f) => f.claim && item.includes(f.claim));
      if (!hit) {
        notes.push(`"${item}"은(는) 팩트 그래프에 없는 사실이라 넣지 않았습니다.`);
        continue;
      }
      const line = `${hit.claim}: ${hit.value}`;
      if (!out.includes(line)) out.push(line);
    }
    return out;
  };

  const guardSentence = (sentence: string): boolean => {
    for (const n of numberTokens(sentence)) {
      const fromFact = factNums.find((f) => f.nums.has(n))?.fact;
      if (fromFact) {
        if (!sentence.includes(fromFact.value)) {
          notes.push(
            `"${sentence}" — 사실 "${fromFact.claim}: ${fromFact.value}"의 값을 그대로 담지 않아 뺐습니다(요약·격상 방지).`,
          );
          return false;
        }
        continue;
      }
      if (questionNums.has(n)) continue;
      notes.push(`"${sentence}" — 숫자 ${n}의 출처가 팩트 그래프에 없어 뺐습니다.`);
      return false;
    }
    return true;
  };

  return { canonicalFacts, guardSentence, notes };
}
