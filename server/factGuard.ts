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

/**
 * 숫자와 바로 뒤 단위 한 글자(붙은 한글 · 영문 · %, 띄어 쓴 한글 하나)를 함께 뽑는다 — 「1박」과 「1인당」의 1은 다른 숫자다.
 * 숫자만 견주면 「1박 2일 일정이라면」의 1이 「인원 추가 요금: 1인당 20,000원」의 1과 같다고 보고 문장을 뺐다
 * (2026-10 스테이,머뭄 글 — 남은 「그다음 그곳과…」가 가리킬 곳을 잃었다). 띄어 쓴 영문은 단위로 보지 않는다(「Line 2 Yeoksam」).
 */
function numberUnitTokens(s: string): Array<{ num: string; unit: string }> {
  return [...s.matchAll(/(\d+(?:[.,]\d+)?)(?:([가-힣A-Za-z%])|\s([가-힣]))?/g)].map((m) => ({ num: m[1]!, unit: m[2] ?? m[3] ?? '' }));
}

/**
 * 단위 한 글자가 재는 것(차원). 「1박」(숙박)과 「1인당」(사람)처럼 **차원이 다를 때만** 다른 숫자로 본다. 같은 차원의 다른 표기
 * (「4인」 · 「4명」)는 같은 숫자다 — 다르게 보면 「기준 인원이 4인이라 추가 요금이 없습니다」가 「최대 인원: 4명」 대조를 비켜 간다
 * (2026-10-22 검토). 표에 없는 단위(분 · 단위 없음 등)는 모른다고 보고 풀어 주지 않는다(fail-closed).
 */
const UNIT_DIMENSION: Record<string, string> = {
  인: 'people', 명: 'people',
  박: 'nights',
  일: 'days',
  원: 'money',
  년: 'years', 해: 'years',
  층: 'floor',
  시: 'hour',
  개: 'count', 곳: 'count', 종: 'count',
  회: 'times', 번: 'times',
  월: 'month',
  '%': 'percent',
};

/**
 * 앞 문장에 기대는 첫머리 — 앞 문장이 빠지면 가리킬 곳을 잃는다.
 *   SEQUENCE  순서 잇기. 문단에 남은 앞 문장이 하나도 없을 때만 함께 뺀다(「먼저 …」가 남아 있으면 「다음으로 …」는 읽힌다).
 *   REFERENCE 지시 · 인과. 바로 앞 문장이 빠지면 함께 뺀다.
 */
const SEQUENCE_LEADS = ['그다음', '그 다음', '그런 다음', '이어서', '다음으로'];
const REFERENCE_LEADS = ['그곳', '그때', '이때', '그것', '그걸', '이 경우', '그 경우', '그래서', '그러면', '따라서', '그러므로'];
/** 첫머리가 같아도 앞 문장을 가리키지 않는 말(「그때그때 다릅니다」) — 접두 일치에서 먼저 뺀다. */
const NOT_LEADS = ['그때그때', '이때껏', '그것참'];

/**
 * 문단의 문장 가운데 passes를 통과한 것만 남기되, 빠진 문장에 기대던 문장도 함께 뺀다(이유는 notes에).
 * 사실 가드 · 격상 가드는 문장 하나씩 걸러 앞뒤 연결을 보지 않는다 — 「1박 2일 일정이라면 … 정하세요. 그다음 그곳과 가까운
 * 지역에서 …」에서 앞 문장만 빠져 「그다음 그곳…」이 혼자 남은 채 블로그에 올라갔다(2026-10-21). 초안 · 채널 다듬기가 함께 쓴다.
 */
export function keepSentences(all: string[], passes: (s: string) => boolean, notes: string[], mode: GuardMode = 'drop'): string[] {
  const kept: string[] = [];
  let prevDropped = false;
  for (const s of all) {
    let keep = passes(s);
    if (keep) {
      const head = s.trimStart();
      const orphan =
        !NOT_LEADS.some((w) => head.startsWith(w)) &&
        ((kept.length === 0 && prevDropped && SEQUENCE_LEADS.some((w) => head.startsWith(w))) ||
          (prevDropped && REFERENCE_LEADS.some((w) => head.startsWith(w))));
      if (orphan) {
        keep = false;
        notes.push(
          mode === 'drop'
            ? `"${s}" — 앞 문장이 빠져 가리킬 곳이 없어 함께 뺐습니다.`
            : `"${s}" — 앞 문장이 빠지면 가리킬 곳이 없습니다. 앞뒤가 이어지는지 확인하세요.`,
        );
      }
    }
    if (keep) kept.push(s);
    prevDropped = !keep;
  }
  return kept;
}

/**
 * 문장에 사실 값이 그대로 들어 있는지 — **대소문자는 가리지 않는다.**
 *
 * 사이트 원문 값은 제목 표기로 뽑힐 때가 많아(「Since 2005」), 문장 가운데 쓰면 소문자가 된다
 * ("… surgery since 2005."). 대소문자까지 같아야 같은 값으로 치면, 값을 그대로 옮긴 문장이
 * "값을 그대로 쓰셨는지 확인하세요"로 걸린다(실측: 뷰 영어 원고). 숫자·철자는 그대로 비교한다.
 */
export function containsValue(text: string, value: string): boolean {
  return text.toLowerCase().includes(value.toLowerCase());
}

/**
 * 걸린 문장을 어떻게 하는지 — 기록 문구가 실제 동작과 맞아야 한다.
 *   drop  생성 경로. 문장을 실제로 버린다.
 *   warn  편집 경로. 사람이 쓴 글은 버리지 않고 알리기만 한다.
 * 한 문구로 두면 편집 화면이 "뺐습니다"라고 거짓말을 한다(실측에서 그렇게 떴다).
 */
export type GuardMode = 'drop' | 'warn';

export function createFactGuard(
  facts: FactGraphNode[],
  questionTexts: string[],
  mode: GuardMode = 'drop',
): FactGuard {
  const notes: string[] = [];
  const questionNums = numberTokens(questionTexts.join('\n'));
  const questionUnits = new Set(numberUnitTokens(questionTexts.join('\n')).map((t) => `${t.num}${t.unit}`));
  const factNums = facts.map((f) => {
    const tokens = numberUnitTokens(f.value);
    // 숫자마다 그 사실에서 붙은 단위들(같은 숫자가 다른 단위로 두 번 나올 수 있다).
    const unitsOf = new Map<string, Set<string>>();
    for (const t of tokens) unitsOf.set(t.num, new Set([...(unitsOf.get(t.num) ?? []), t.unit]));
    return { fact: f, nums: numberTokens(f.value), units: new Set(tokens.map((t) => `${t.num}${t.unit}`)), unitsOf };
  });

  const canonicalFacts = (arr: string[]): string[] => {
    const out: string[] = [];
    for (const item of arr) {
      // 값 원문 포함 → 그 사실. 아니면 주장 이름 포함 → 그 사실. 둘 다 아니면 새로 만든 사실.
      const hit = facts.find((f) => containsValue(item, f.value)) ?? facts.find((f) => f.claim && item.includes(f.claim));
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
    // 문장에 값이 그대로 담긴 사실의 숫자는 출처가 있는 숫자다. 같은 숫자가 여러 사실에 들어 있으면
    // 그중 하나만 담겨도 된다 — 전에는 처음 찾은 사실만 봐서, "Line 2 … Yeoksam station exit no.6 …"의
    // 2를 전화번호(+82. 2. 522. 6636)의 2로 보고 문장을 버렸다.
    // 그 사실의 항목 이름에 든 숫자도 출처로 친다(「2호선 역삼역 오시는 길」의 2). 항목 이름은 값이
    // 무엇인지 알려 주는 꼬리표라, 영어 원고는 그 뜻을 풀어 쓰면서 숫자를 함께 옮긴다.
    const sourced = new Set<string>();
    for (const f of facts) {
      if (!f.value || !containsValue(sentence, f.value)) continue;
      for (const n of numberTokens(f.value)) sourced.add(n);
      for (const n of numberTokens(f.claim ?? '')) sourced.add(n);
    }
    for (const { num: n, unit } of numberUnitTokens(sentence)) {
      if (sourced.has(n)) continue;
      // 숫자 · 단위가 같은 사실이 먼저다. 그 숫자를 가진 사실들이 모두 다른 차원의 단위이고(「1박」 · 「1인당」) 질문에 같은 「숫자+단위」가
      // 있을 때만 받는다 — 질문에 나온 숫자는 인용해도 된다는 초안 규칙(b9c 규칙 3)과 맞춘다. 차원을 모르거나 같으면 그 사실의 값으로
      // 견준다(전과 같음).
      const sameUnit = factNums.find((f) => f.units.has(`${n}${unit}`))?.fact;
      const withNumber = factNums.filter((f) => f.nums.has(n));
      const dimension = UNIT_DIMENSION[unit];
      const otherDimension =
        dimension !== undefined &&
        withNumber.every((f) =>
          [...f.unitsOf.get(n)!].every((u) => UNIT_DIMENSION[u] !== undefined && UNIT_DIMENSION[u] !== dimension),
        );
      if (!sameUnit && withNumber.length && otherDimension && questionUnits.has(`${n}${unit}`)) continue;
      const fromFact = sameUnit ?? withNumber[0]?.fact;
      if (fromFact) {
        if (!containsValue(sentence, fromFact.value)) {
          notes.push(
            mode === 'drop'
              ? `"${sentence}" — 사실 "${fromFact.claim}: ${fromFact.value}"의 값을 그대로 담지 않아 뺐습니다(요약·격상 방지).`
              : `"${sentence}" — 등록된 사실은 "${fromFact.claim}: ${fromFact.value}"입니다. 값을 그대로 쓰셨는지 확인하세요.`,
          );
          return false;
        }
        continue;
      }
      if (questionNums.has(n)) continue;
      notes.push(
        mode === 'drop'
          ? `"${sentence}" — 숫자 ${n}의 출처가 팩트 그래프에 없어 뺐습니다.`
          : `"${sentence}" — 숫자 ${n}의 출처가 팩트 그래프에 없습니다. 확인하신 값이면 브랜드 사실에 넣어 두세요.`,
      );
      return false;
    }
    return true;
  };

  return { canonicalFacts, guardSentence, notes };
}
