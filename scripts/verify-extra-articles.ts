/**
 * 추가 글(본 글에서 질문 몇 개를 떼어 따로 쓰는 글)의 순수 로직을 확인한다(src/lib/extraArticles.ts). 파일 · 서버 · AI는 부르지 않는다.
 * 저장소 쓰기는 scripts/verify-extra-articles-store.ts가 본다.
 *
 * 왜: 추가 글의 id(topic:…)에 초안 · 브리프 · 올린 기록이 모두 붙는다. id 정렬이 질문 은행 화면과 다르면 같은 질문 묶음이 두 글로
 * 갈라지고, 원장 검사(checkTopic)가 스냅샷을 거절한다. 질문 id의 뜻은 은행 판마다 바뀌므로 판이 다른 주에 id로 찾으면 엉뚱한 질문을
 * 겨냥한다 — 문장이 정확히 같은 질문만 다시 찾고, 없으면 확인 불가로 남아야 한다.
 *
 * 주간 계산(src/lib/gapActions.ts computeGapActions의 opts): 정의가 없으면 결과가 예전과 한 글자도 다르지 않아야 정기진단 보고서와
 * 기존 검사가 그대로 돈다. 추가 글이 맡은 질문은 본 글에서 빠지되, 본 글이 비게 되면 빼지 않는다 — 본 글이 사라지면 그 글의 채널
 * 줄과 올린 기록이 갈 곳을 잃는다.
 *
 *   npx tsx scripts/verify-extra-articles.ts
 */
import { analyzeCitationSources } from '../server/citationSources';
import type { QuestionRepeatAnalysis } from '../server/types';
import type { ActionStateMap, PublishedPost } from '../src/lib/api';
import { computeGapActions, isOpenAction } from '../src/lib/gapActions';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import {
  aliveExtraArticles,
  checkExtraArticlePatch,
  checkNewExtraArticle,
  extraTopicSnapshot,
  isExtraArticleId,
  normalizeExtraArticles,
  questionTextKey,
  resolveExtraArticle,
  topicArticleId,
  type ExtraArticle,
} from '../src/lib/extraArticles';

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const NOW = '2026-10-30T09:00:00.000Z';
const def = (ids: string[], texts: string[], extra: Partial<ExtraArticle> = {}): ExtraArticle => ({
  id: `topic:${ids.join('+')}`,
  name: '가상 주제',
  bankVersion: 'v6',
  questionIds: ids,
  questionTexts: texts,
  createdAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  ...extra,
});

// ── (a) 순수 로직 — id · 정규화 · 다시 찾기 · 스냅샷 ─────────────────────────────────────────────
{
  // id — 질문 은행 화면(QuestionBank.tsx actionFromQuestions)과 같은 기본 정렬
  ok('id는 정렬한 질문 id를 +로 잇는다', topicArticleId(['c1-012', 'c1-011']) === 'topic:c1-011+c1-012');
  ok('정렬은 코드 단위(숫자 크기가 아님)', topicArticleId(['c1-100', 'c1-20']) === 'topic:c1-100+c1-20');
  const pickedOrder = ['c1-014', 'c1-013'];
  ok('id를 지어도 넘긴 배열은 그대로', topicArticleId(pickedOrder) === 'topic:c1-013+c1-014' && pickedOrder.join() === 'c1-014,c1-013');
  ok('topic: 글만 추가 글 id', isExtraArticleId('topic:c1-007') && !isExtraArticleId('content:category-agnostic') && !isExtraArticleId('listing:tistory.com'));
  ok('문장 비교는 공백만 정리', questionTextKey('  가상\n질문   하나 ') === '가상 질문 하나' && questionTextKey('가상 질문 하나?') !== '가상 질문 하나');

  // 정규화 — 모양이 틀린 줄 · id와 질문이 어긋난 줄 · 같은 id 두 번째 줄은 뺀다
  const good = def(['c1-011', 'c1-012'], ['가상 질문 열하나', '가상 질문 열둘'], { angle: '주말 기준', createdWeek: '2026-W44' });
  const normalized = normalizeExtraArticles({
    version: 1,
    articles: [
      good,
      { ...good, name: '가상 중복' },
      def(['c1-012', 'c1-011'], ['가상 질문 열둘', '가상 질문 열하나']),
      { ...def(['c1-007'], ['가상 질문 일곱']), id: 'topic:c1-008' },
      def(['c1-009'], []),
      def(['c1-010'], ['가상 질문 열'], { bankVersion: '' }),
      def(['c1-015'], ['가상 질문 열다섯'], { createdAt: '어제' }),
      def(['c1-016'], ['가상 질문 열여섯'], { removedAt: '2026-10-30T08:00:00.000Z' }),
      null,
      '문자열',
    ],
  });
  ok('정규화는 맞는 줄만 남긴다(정렬 안 된 id · 어긋난 id · 빈 문장 · 판 없음 · 날짜 아님 제외)', normalized.map((a) => a.id).join() === 'topic:c1-011+c1-012,topic:c1-016');
  ok('같은 id는 첫 줄', normalized[0].name === '가상 주제' && normalized[0].angle === '주말 기준' && normalized[0].createdWeek === '2026-W44');
  ok('뺀 표시는 남긴다', normalized[1].removedAt === '2026-10-30T08:00:00.000Z');
  ok('배열도 받는다', normalizeExtraArticles([good]).length === 1);
  ok('모양이 아니면 빈 목록', normalizeExtraArticles(null).length === 0 && normalizeExtraArticles({ articles: 'x' }).length === 0);
  ok('살아 있는 글만', aliveExtraArticles(normalized).map((a) => a.id).join() === 'topic:c1-011+c1-012');

  // 다시 찾기 — 판이 같으면 id, 다르면 문장이 정확히 같은 것, 없으면 확인 불가
  const bankV6 = [
    { questionId: 'c1-011', text: '가상 질문 열하나' },
    { questionId: 'c1-012', text: '가상 질문 열둘' },
  ];
  const same = resolveExtraArticle(good, 'v6', bankV6);
  ok('같은 판은 id로 찾는다', same.how === 'same-bank' && same.currentIds.join() === 'c1-011,c1-012' && same.missingTexts.length === 0);
  const sameMissing = resolveExtraArticle(good, 'v6', [bankV6[0]]);
  ok('같은 판인데 은행에 없는 id는 문장으로 확인 불가에 남긴다', sameMissing.how === 'same-bank' && sameMissing.currentIds.join() === 'c1-011' && sameMissing.missingTexts.join() === '가상 질문 열둘');
  // v7에서 id가 다시 쓰였다 — c1-011은 이제 다른 질문이고, 열둘은 c1-030으로 옮겨 갔다(공백만 다름).
  const bankV7 = [
    { questionId: 'c1-011', text: '가상 전혀 다른 질문' },
    { questionId: 'c1-030', text: ' 가상  질문 열둘' },
  ];
  const byText = resolveExtraArticle(good, 'v7', bankV7);
  ok('다른 판은 id가 같아도 쓰지 않고 문장으로 찾는다', byText.how === 'by-text' && byText.currentIds.join() === 'c1-030');
  ok('다른 판에서 못 찾은 질문은 확인 불가(고정 문장)', byText.missingTexts.join() === '가상 질문 열하나');
  const changed = resolveExtraArticle(good, 'v7', [{ questionId: 'c1-030', text: '가상 질문 열둘?' }]);
  ok('문장이 조금만 달라도 못 찾는다 → 전부 확인 불가', changed.how === 'unresolved' && changed.currentIds.length === 0 && changed.missingTexts.length === 2);
  const unknown = resolveExtraArticle(good, null, bankV6);
  ok('이번 주 판을 모르면 확인 불가', unknown.how === 'unresolved' && unknown.currentIds.length === 0 && unknown.missingTexts.join() === good.questionTexts.join());
  ok('판을 몰라도(undefined) 확인 불가', resolveExtraArticle(good, undefined, bankV6).how === 'unresolved');

  // 스냅샷 — 원장 검사(checkTopic)의 규칙: id = topic: + ids 그대로 이음, 문장 수 = 질문 수, 판 있음
  const snap = extraTopicSnapshot(good);
  ok('스냅샷은 만들 때의 판 · id · 문장', snap.bankVersion === 'v6' && snap.questionIds.join() === 'c1-011,c1-012' && snap.questionTexts.join() === good.questionTexts.join());
  ok('스냅샷 id를 이으면 글 id', `topic:${snap.questionIds.join('+')}` === good.id && snap.questionTexts.length === snap.questionIds.length);
  snap.questionIds.push('c1-999');
  ok('스냅샷은 사본(정의를 바꾸지 않는다)', good.questionIds.length === 2);

  // 새 글 검사 — 짝 정렬 · 겹침 · 되살리기(저장소 검사와 같은 함수를 순수하게)
  const created = checkNewExtraArticle(
    { id: 'topic:c1-013+c1-014', name: '가상 주차', bankVersion: ' v6 ', questionIds: ['c1-014', 'c1-013'], questionTexts: ['가상 질문 열넷', '가상 질문 열셋'] },
    [good],
    NOW,
  );
  ok('질문 · 문장을 짝지어 정렬한다', created.ok && created.article.questionIds.join() === 'c1-013,c1-014' && created.article.questionTexts.join() === '가상 질문 열셋,가상 질문 열넷');
  ok('판은 공백을 뗀다 · 만든 시각 = 고친 시각', created.ok && created.article.bankVersion === 'v6' && created.article.createdAt === NOW && created.article.updatedAt === NOW);
  ok('목록 끝에 붙인다', created.ok && created.articles.map((a) => a.id).join() === `${good.id},topic:c1-013+c1-014`);
  ok('질문 id에 +가 있으면 400', (() => {
    const r = checkNewExtraArticle({ id: 'topic:a+b', name: '가상', bankVersion: 'v6', questionIds: ['a+b'], questionTexts: ['가상 질문'] }, [], NOW);
    return !r.ok && r.status === 400;
  })());
  const removedGood = { ...good, removedAt: '2026-10-29T10:00:00.000Z' };
  const revive = checkNewExtraArticle(
    { id: good.id, name: '가상 다시', bankVersion: 'v7', questionIds: good.questionIds, questionTexts: ['가상 새 문장 하나', '가상 새 문장 둘'] },
    [removedGood],
    NOW,
  );
  ok('뺀 같은 id는 되살린다(만든 시각 유지, 판 · 문장은 새 값)', revive.ok && revive.revived && !revive.article.removedAt && revive.article.createdAt === good.createdAt && revive.article.bankVersion === 'v7' && revive.articles.length === 1);
  const patched = checkExtraArticlePatch({ id: good.id, removed: true }, [good], NOW);
  ok('빼기는 removedAt만 남긴다', patched.ok && patched.article.removedAt === NOW && patched.article.name === good.name && !patched.revived);
  const noop = checkExtraArticlePatch({ id: good.id, removed: true }, [removedGood], NOW);
  ok('이미 뺀 글을 다시 빼도 처음 뺀 시각을 둔다', noop.ok && noop.article.removedAt === removedGood.removedAt);
}

// ── (b) 주간 계산 — computeGapActions opts ───────────────────────────────────────────────────────
{
  const MAIN = 'content:category-agnostic';
  const question = (questionId: string, category: string, containsBrandName: boolean) =>
    ({ questionId, text: `${questionId} 질문`, category, containsBrandName }) as QuestionSpec;
  // v6 은행 — a1~a5 카테고리 무관(이름 없음), c1 비교(이름 있음)
  const questions = [
    question('a1', 'category-agnostic', false),
    question('a2', 'category-agnostic', false),
    question('a3', 'category-agnostic', false),
    question('a4', 'category-agnostic', false),
    question('a5', 'category-agnostic', false),
    question('c1', 'comparison', true),
  ];
  const cite = (raw: string) => ({ raw, domain: null, ownerType: 'third-party-authority' as const, supportsBrandMention: false });
  const analysis = (questionId: string, callIndex: number, mentioned: boolean, urls: string[], competitor = 0) =>
    ({
      questionId,
      engine: 'gemini',
      callIndex,
      mentioned,
      mentionSentences: mentioned ? [{ text: '가상브랜드', sentiment: 'neutral' }] : [],
      competitorMentions: competitor > 0 ? [{ name: '가상경쟁사', mentionCount: competitor }] : [],
      shareOfMention: 0,
      citations: urls.map(cite),
      topRecommendation: null,
      brandRank: null,
      factualityClaims: [],
      factualitySupported: 0,
      factualityContradicted: 0,
      brandOwnedCitation: false,
      clarifying: false,
    }) as unknown as QuestionRepeatAnalysis;
  // a1 · a2 · a5 패(언급 0) · a3 패(언급률 0.5, 경쟁사가 더 많음) · a4 승 · c1 비교 패
  const week = [
    analysis('a1', 0, false, ['https://blog.naver.com/fake/1']),
    analysis('a1', 1, false, []),
    analysis('a2', 0, false, ['https://fake.tistory.com/1']),
    analysis('a2', 1, false, []),
    analysis('a3', 0, true, ['https://blog.naver.com/fake/3'], 3),
    analysis('a3', 1, false, [], 2),
    analysis('a4', 0, true, ['https://fake.tistory.com/4']),
    analysis('a4', 1, true, []),
    analysis('a5', 0, false, ['https://fake.tistory.com/5']),
    analysis('a5', 1, false, []),
    analysis('c1', 0, false, ['https://namu.wiki/w/가상']),
    analysis('c1', 1, false, []),
  ];
  const citations = analyzeCitationSources(week);
  type Opts = Parameters<typeof computeGapActions>[6];
  const plan = (opts?: Opts, states: ActionStateMap = {}, posts: PublishedPost[] = [], qs = questions) =>
    opts === undefined
      ? computeGapActions(week as unknown as ClientAnalysis[], qs, citations, states, posts, '2026-W44')
      : computeGapActions(week as unknown as ClientAnalysis[], qs, citations, states, posts, '2026-W44', opts);
  const find = (p: ReturnType<typeof plan>, id: string) => p.actions.find((a) => a.id === id);
  const sorted = (ids: string[] | undefined) => [...(ids ?? [])].sort().join();
  const withExtras = (defs: ExtraArticle[], bankVersion: string | null = 'v6') => plan({ extraArticles: defs, bankVersion });

  const e1 = def(['a3', 'a4'], ['a3 질문', 'a4 질문'], { name: '가상 코스 비교', angle: '주말 하루 기준' });
  const e2 = def(['a5'], ['a5 질문'], { name: '가상 지도 앱' });

  // 1) 정의가 없으면 결과가 예전과 같다
  const base = plan();
  const baseJson = JSON.stringify(base);
  ok('opts 없음 = 빈 opts(JSON 동일)', JSON.stringify(plan({})) === baseJson);
  ok('opts 없음 = 정의 빈 목록(JSON 동일)', JSON.stringify(withExtras([])) === baseJson);
  ok('opts 없음 = 판을 모르는 빈 정의(JSON 동일)', JSON.stringify(withExtras([], null)) === baseJson);
  ok('opts 없음 = 뺀 글만 있음(JSON 동일)', JSON.stringify(withExtras([{ ...e1, removedAt: NOW }, { ...e2, removedAt: NOW }])) === baseJson);
  ok('기준 — 본 글은 카테고리 무관 패 4개(a1 · a2 · a3 · a5)', sorted(find(base, MAIN)?.questionIds) === 'a1,a2,a3,a5' && find(base, MAIN)?.reach === 4);

  // 2) 추가 글이 맡은 질문은 본 글에서 빠진다 — id · 제목 · 배지는 그대로
  const two = withExtras([e1, e2]);
  const main = find(two, MAIN);
  ok('본 글에서 추가 글 질문이 빠진다(a3 · a5)', sorted(main?.questionIds) === 'a1,a2' && main?.reach === 2);
  ok('본 글의 질문 문장도 같이 빠진다', main?.questionTexts.join() === 'a1 질문,a2 질문');
  ok('본 글의 id · 제목 · 배지는 그대로', main?.id === MAIN && main.title === find(base, MAIN)?.title && main.badge === find(base, MAIN)?.badge);
  ok('본 글 근거 문장은 남은 질문 수로', /질문 2개에서 밀리고/.test(main?.evidence ?? ''));
  ok('등재형 항목은 그대로(JSON 동일)', JSON.stringify(two.actions.filter((a) => a.kind === 'listing')) === JSON.stringify(base.actions.filter((a) => a.kind === 'listing')));
  ok('otherLost는 그대로', JSON.stringify(two.otherLost) === JSON.stringify(base.otherLost));
  ok('할 일 수 = 기준 + 추가 글 2편', two.openCount === base.openCount + 2);

  // 3) 추가 글 항목의 모양
  const x1 = find(two, e1.id);
  ok('추가 글 항목 — id는 정의 id, 콘텐츠형, 배지 「추가 글」', x1?.kind === 'content' && x1.badge === '추가 글' && x1.title === '가상 코스 비교 콘텐츠 보강');
  ok('추가 글 항목 — 질문은 언급률 낮은 순, 이긴 질문도 남긴다(a3 0.5 → a4 1.0)', x1?.questionIds.join() === 'a3,a4');
  ok('추가 글 항목 — 질문 문장은 만들 때 고정한 것', x1?.questionTexts.join() === e1.questionTexts.join() && x1.questionTexts !== e1.questionTexts);
  ok('추가 글 항목 — reach는 이번 주 진 질문 수(a3)', x1?.reach === 1 && !x1.satisfied && x1.status === 'todo');
  ok('추가 글 항목 — extra(이름 · 각도 · 같은 판 · 빠진 질문 없음)', x1?.extra?.name === e1.name && x1.extra.angle === e1.angle && x1.extra.how === 'same-bank' && x1.extra.missingTexts.length === 0);
  ok('추가 글 항목 — 원장 스냅샷은 만들 때의 판 · id · 문장', JSON.stringify(x1?.extra?.topic) === JSON.stringify(extraTopicSnapshot(e1)));
  ok('추가 글 항목 — 근거 문장', x1?.evidence === '고른 질문 2개 중 1개에서 밀리고 있습니다.');
  ok('추가 글 항목 — 각도가 없으면 extra.angle 없음', find(two, e2.id)?.extra !== undefined && !('angle' in (find(two, e2.id)?.extra ?? {})));
  ok('추가 글 항목 — 언급 0건 질문을 밝힌다', find(two, e2.id)?.evidence === '고른 질문 1개 중 1개에서 밀리고, 그중 1개는 언급이 아예 0건입니다.');
  ok('본 글에는 extra가 없다', main !== undefined && !('extra' in main));

  // 4) 안전장치 — 본 글이 비게 되면 하나도 빼지 않는다
  const all = def(['a1', 'a2', 'a3', 'a5'], ['a1 질문', 'a2 질문', 'a3 질문', 'a5 질문'], { name: '가상 전부' });
  const greedy = withExtras([all]);
  ok('본 글의 질문을 모두 가져가면 본 글은 그대로', JSON.stringify(find(greedy, MAIN)) === JSON.stringify(find(base, MAIN)));
  ok('그래도 추가 글 항목은 만든다', find(greedy, all.id)?.reach === 4);

  // 5) 이번 주 모두 이기는 추가 글 — reach 0이어도 목록에 남고 할 일로 센다(사람이 뺄 때까지)
  const winner = def(['a4'], ['a4 질문'], { name: '가상 이긴 글' });
  const won = find(withExtras([winner]), winner.id);
  ok('reach 0 추가 글도 남는다', won?.reach === 0 && won.questionIds.join() === 'a4' && isOpenAction(won));
  ok('reach 0 근거 문장', won?.evidence === '고른 질문 1개 가운데 이번 주 밀린 질문이 없습니다.');
  ok('이긴 질문만 가져가면 본 글은 그대로', JSON.stringify(find(withExtras([winner]), MAIN)) === JSON.stringify(find(base, MAIN)));

  // 6) 뺀 글 — 항목이 없고 질문이 본 글로 돌아온다
  const back = withExtras([{ ...e2, removedAt: NOW }, e1]);
  ok('뺀 글은 항목이 없다', !find(back, e2.id) && find(back, e1.id) !== undefined);
  ok('뺀 글의 질문은 본 글로 돌아온다', sorted(find(back, MAIN)?.questionIds) === 'a1,a2,a5');

  // 7) 판이 다른 주 — 문장이 정확히 같은 질문만 다시 찾는다
  const fromV5 = def(['c1-099'], ['a5 질문'], { name: '가상 옛 판', bankVersion: 'v5' });
  const v5Plan = withExtras([fromV5]);
  const moved = find(v5Plan, fromV5.id);
  ok('다른 판 — 문장으로 찾는다(c1-099 → a5)', moved?.extra?.how === 'by-text' && moved.questionIds.join() === 'a5' && moved.reach === 1);
  ok('다른 판 — 찾은 질문은 본 글에서 빠진다', sorted(find(v5Plan, MAIN)?.questionIds) === 'a1,a2,a3');
  ok('다른 판 — 근거가 판 바뀜을 밝힌다', /v5 → v6/.test(moved?.evidence ?? ''));
  ok('다른 판 — 스냅샷은 만들 때의 판(v5) 그대로', moved?.extra?.topic.bankVersion === 'v5' && moved.extra.topic.questionIds.join() === 'c1-099');
  const lostV5 = def(['c1-098'], ['가상 사라진 질문'], { name: '가상 못 찾음', bankVersion: 'v5' });
  const lostPlan = withExtras([lostV5]);
  const unresolved = find(lostPlan, lostV5.id);
  ok('못 찾은 질문 — 확인 불가(질문 없음 · reach 0 · 빠진 문장)', unresolved?.extra?.how === 'unresolved' && unresolved.questionIds.length === 0 && unresolved.reach === 0 && unresolved.extra.missingTexts.join() === '가상 사라진 질문');
  ok('못 찾은 질문 — 근거가 확인 불가를 밝힌다', /확인 불가/.test(unresolved?.evidence ?? '') && !/밀리/.test(unresolved?.evidence ?? ''));
  ok('못 찾은 질문 — 본 글은 그대로', JSON.stringify(find(lostPlan, MAIN)) === JSON.stringify(find(base, MAIN)));
  ok('못 찾은 질문 — 고정 문장으로 브리프를 만든다', unresolved?.questionTexts.join() === '가상 사라진 질문');

  // 8) 이번 주 판을 모르면(예시 은행 · 판 없음) 확인 불가 — 본 글에서 빼지 않는다
  const unknownPlan = withExtras([e1, e2], null);
  ok('판 모름 — 추가 글은 확인 불가', [e1.id, e2.id].every((id) => find(unknownPlan, id)?.extra?.how === 'unresolved' && find(unknownPlan, id)?.reach === 0));
  ok('판 모름 — 근거가 판을 모른다고 밝힌다', /판을 몰라/.test(find(unknownPlan, e1.id)?.evidence ?? ''));
  ok('판 모름 — 본 글은 그대로', JSON.stringify(find(unknownPlan, MAIN)) === JSON.stringify(find(base, MAIN)));

  // 9) 은행을 읽지 못한 주(content:) — 추가 글을 만들지 않는다
  const noBankBase = plan(undefined, {}, [], []);
  const noBank = plan({ extraArticles: [e1, e2], bankVersion: 'v6' }, {}, [], []);
  ok('은행 없음 — 추가 글 없이 예전과 같다(JSON 동일)', JSON.stringify(noBank) === JSON.stringify(noBankBase) && noBank.actions.every((a) => !a.extra));

  // 10) 집행 상태 · 올린 기록은 같은 병합으로 붙는다
  const states: ActionStateMap = { [e2.id]: { status: 'done', updatedAt: NOW, markedWeek: '2026-W44' } };
  const ownPost: PublishedPost = {
    id: 'p-own', url: 'https://fake-brand.example/extra', key: 'fake-brand.example/extra', publishedOn: '2026-10-20', publishedOnSource: 'user',
    recordedAt: '2026-10-20T00:00:00Z', articleId: e2.id, targetActionId: e2.id, via: 'own', topic: extraTopicSnapshot(e2),
  };
  const merged = find(plan({ extraArticles: [e1, e2], bankVersion: 'v6' }, states, [ownPost]), e2.id);
  ok('추가 글 — 자사 기록이 붙는다', merged?.publishedUrls.join() === ownPost.url && merged.publishedHits?.length === 1);
  ok('추가 글 — 집행 상태가 붙는다', merged?.status === 'done' && merged.markedWeek === '2026-W44');
  const skipped = find(plan({ extraArticles: [e2], bankVersion: 'v6' }, { [e2.id]: { status: 'skip', updatedAt: NOW } }), e2.id);
  ok('추가 글 — 콘텐츠형이라 보류는 읽지 않는다(본 글과 같은 규칙)', skipped?.status === 'todo');
  ok('추가 글 기록은 본 글에 붙지 않는다', (find(plan({ extraArticles: [e1, e2], bankVersion: 'v6' }, states, [ownPost]), MAIN)?.publishedUrls.length ?? -1) === 0);
}

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
