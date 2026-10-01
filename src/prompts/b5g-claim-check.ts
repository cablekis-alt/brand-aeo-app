import type { PromptMessage } from './types.js';

/**
 * 격상 검사 — 사실 값이 들어간 문장이 그 사실보다 **더 말하는지** 판정한다.
 *
 * 사실 가드(server/factGuard.ts)는 숫자만 대조한다. 숫자 없이 주체·범위·자격이 바뀌는 격상은
 * 거기서 걸리지 않는다(실측: 「대표 원장: Barn Jaesang, Oh Changhyun」을 "founded by …"로,
 * 「원장단 출신 대학」을 "the clinic's medical team graduated from …"으로 썼다). 사실 항목 이름은
 * 한국어이고 원고는 영어일 수 있어, 낱말 짝으로는 대조할 수 없다 — 뜻으로 판정하게 한다.
 */
export interface ClaimCheckItem {
  id: number;
  sentence: string;
  /** 문장에 값이 들어간 사실들("<항목 이름>: <값>"). */
  facts: string[];
}

export interface ClaimCheckVerdict {
  id: number;
  verdict: 'ok' | 'overclaim';
  /** overclaim일 때 무엇이 어떻게 커졌는지 — 한국어 한 문장. */
  reason?: string;
}

export function buildClaimCheckPrompt(items: ClaimCheckItem[]): PromptMessage {
  const system = `당신은 의료·서비스 콘텐츠의 사실 검수자입니다. 각 문장이 함께 주어진 **등록 사실이 말하는 것보다 더 말하는지**만 판정합니다.

overclaim(격상)으로 판정하는 경우:
1. 주체·역할이 바뀜 — 사실은 "대표 원장"인데 문장은 설립자·창업자(founder, founded by)라고 씀
2. 범위가 넓어짐 — 사실은 "원장단"(대표 원장들)인데 문장은 의료진 전체·모든 의사(medical team, all doctors)로 씀
3. 자격·등급이 올라감 — 사실은 "의료진 30명"인데 문장은 "전문의 30명"(30 board-certified surgeons)으로 씀
4. 사실에 없는 단정·최상급을 붙임 — only, first, best, largest, 유일, 최초, 최고, 모든, 항상
5. 값을 다른 의미로 씀 — 상담 시간을 수술 시간으로, 출신 대학을 소속 병원으로 쓰는 식
6. 여러 사실을 한 주체로 합침 — 문장에 사실이 둘 이상이면 **사실마다 주체를 따로 본다.** 「의료진 경력: over 20 years」와
   「원장단 출신 대학: …」을 "surgeons with over 20 years of experience from …"처럼 한 주체에 씌우면, 원장단의 출신 대학을
   의료진 전체로 넓힌 것이다

ok로 판정하는 경우:
- 값을 그대로 쓰고, 나머지는 문장을 잇는 말이나 사실을 바꾸지 않는 일반 안내뿐이다
- 항목 이름의 뜻을 같은 뜻으로 풀어 썼다(항목 이름은 한국어, 문장은 영어여도 뜻이 같으면 ok)
- 사실보다 좁게·약하게 말했다

판정 원칙:
- 문장에 함께 주어진 사실만 기준으로 본다. 당신이 아는 바깥 지식으로 맞고 틀림을 따지지 않는다.
- 애매하면 ok다. 위 다섯 경우에 분명히 해당할 때만 overclaim이다.
- reason은 overclaim일 때만, 무엇이 무엇으로 커졌는지 한국어 한 문장으로 쓴다.

출력은 JSON 배열만. 설명·마크다운·코드블록 금지.
[{ "id": number, "verdict": "ok" | "overclaim", "reason": string }]`;

  const user = items
    .map((it) => `[${it.id}] 문장: ${it.sentence}\n    사실: ${it.facts.join(' / ')}`)
    .join('\n');
  return { system, user };
}
