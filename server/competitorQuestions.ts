import type { CompetitorContext, QuestionSpec } from '../src/prompts/types.js';

/**
 * 브랜드 전용 질문 가운데 경쟁사를 짚은 질문을 찾는다(경쟁사 편집 서랍의 「v5-004 / 비교 질문 없음」).
 *
 * 질문에는 경쟁사를 가리키는 필드가 없다 — 질문지 생성 프롬프트가 본문에 이름을 넣을 뿐이다
 * (cohortQuestionBank.ts). 그래서 본문에서 이름·별칭을 찾는다.
 * - 띄어쓰기는 무시한다: '스테이옥도'와 '스테이 옥도'는 같은 곳이다.
 * - 고객 자신의 이름을 먼저 지운다: 경쟁사 이름이 고객 이름 안에 들어 있으면(예: '스테이') 모든 질문이 걸린다.
 * - 긴 이름부터 찾고 찾은 자리는 지운다: '초원'과 '초원고택'이 둘 다 경쟁사면 '초원고택' 질문은 '초원고택'에만 잇는다.
 * - 코호트 공통 질문(cohortShared)은 보지 않는다 — 특정 브랜드를 짚지 않고, 고쳐 쓸 대상도 아니다.
 */
export interface LinkedQuestion {
  questionId: string;
  text: string;
  category: QuestionSpec['category'];
  /** 이 질문이 짚은 경쟁사(competitors 배열의 위치). */
  competitorIndexes: number[];
}

export interface CompetitorQuestionLinks {
  /** competitors와 같은 순서 — 그 경쟁사를 짚은 질문 id. */
  byCompetitor: string[][];
  questions: LinkedQuestion[];
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export function linkCompetitorQuestions(
  questions: QuestionSpec[],
  competitors: CompetitorContext[],
  brandNames: string[],
): CompetitorQuestionLinks {
  const needles: { index: number; term: string }[] = [];
  competitors.forEach((competitor, index) => {
    const terms = new Set([competitor.name, ...(competitor.aliases ?? [])].map(squash).filter(Boolean));
    for (const term of terms) needles.push({ index, term });
  });
  needles.sort((a, b) => b.term.length - a.term.length);
  const own = [...new Set(brandNames.map(squash).filter(Boolean))].sort((a, b) => b.length - a.length);

  const byCompetitor: string[][] = competitors.map(() => []);
  const linked: LinkedQuestion[] = [];
  for (const q of questions) {
    if (q.cohortShared) continue;
    // 찾은 자리는 한 글자짜리 빈칸으로 바꾼다 — 지운 자리를 건너 앞뒤 글자가 붙어 새 이름이 생기지 않게.
    let hay = squash(q.text);
    for (const name of own) hay = hay.split(name).join('\u0000');
    const hits = new Set<number>();
    for (const { index, term } of needles) {
      if (!hay.includes(term)) continue;
      hits.add(index);
      hay = hay.split(term).join('\u0000');
    }
    if (hits.size === 0) continue;
    const competitorIndexes = [...hits].sort((a, b) => a - b);
    for (const i of competitorIndexes) byCompetitor[i].push(q.questionId);
    linked.push({ questionId: q.questionId, text: q.text, category: q.category, competitorIndexes });
  }
  return { byCompetitor, questions: linked };
}
