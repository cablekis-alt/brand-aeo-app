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
 * 올리기 목록(src/lib/publishPlan.ts buildPublishPlan): 채널 항목 하나에 본 글과 추가 글의 기록이 함께 모인다. 줄마다 그 글의 기록으로
 * 「올림」을 보지 않으면 추가 글을 티스토리에 올린 순간 본 글의 티스토리 줄도 「올림」이 된다. 플랫폼이 아닌 채널은 한 줄 · 본 글 먼저 —
 * 이미 올린 위키나 여행 사이트 줄이 추가 글로 넘어가면 「본문 다시 복사」가 엉뚱한 글을 복사한다.
 *
 * 브리프 프롬프트(src/prompts/b9b-content-brief.ts): 추가 글만 다룰 각도와 이미 쓴 본 글의 제목 · 소제목을 보낸다. 둘이 없는 요청(본 글 ·
 * 등재형 · 질문 은행 글)의 프롬프트는 넣기 전과 한 글자도 다르지 않아야 한다 — 그 브리프들의 결과가 조용히 바뀌지 않게.
 *
 *   npx tsx scripts/verify-extra-articles.ts
 */
import { createHash } from 'node:crypto';
import { analyzeCitationSources } from '../server/citationSources';
import type { QuestionRepeatAnalysis } from '../server/types';
import { BRIEF_FOCUS_LIMITS, briefFocusOf, buildContentBriefPrompt, type ContentBriefRequest } from '../src/prompts/b9b-content-brief';
import type { ActionStateMap, PublishedPost, StoredDraft } from '../src/lib/api';
import { briefInputOf, effectiveDraft } from '../src/lib/draftGaps';
import { draftTitle } from '../src/lib/markdownFile';
import { computeGapActions, extraStandingOf, isOpenAction, type GapAction, type PublishedHit } from '../src/lib/gapActions';
import { buildPublishPlan, recordInputOf, type PublishRow } from '../src/lib/publishPlan';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import {
  aliveExtraArticles,
  checkExtraArticlePatch,
  checkNewExtraArticle,
  EXTRA_LIMITS,
  extraBriefAngle,
  extraTopicSnapshot,
  isExtraArticleId,
  NAME_AND_ANGLE_LIMIT,
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

  // 이름 + 각도 — 브리프는 「이름 — 각도」 한 줄을 BRIEF_FOCUS_LIMITS.angle에서 자른다. 하나씩은 상한 안이어도 합쳐 넘으면 저장하지 않는다.
  ok('이름 + 각도 상한 = 브리프 각도 상한 - 「 — 」', NAME_AND_ANGLE_LIMIT === BRIEF_FOCUS_LIMITS.angle - 3 && NAME_AND_ANGLE_LIMIT < EXTRA_LIMITS.name + EXTRA_LIMITS.angle);
  ok('브리프 각도 줄 — 「이름 — 각도」, 각도가 비면 이름만', extraBriefAngle('조용한 방', '  방음 ') === '조용한 방 — 방음' && extraBriefAngle('조용한 방', '  ') === '조용한 방' && extraBriefAngle('조용한 방', undefined) === '조용한 방');
  const newWith = (name: string, angle: string) =>
    checkNewExtraArticle({ id: 'topic:c1-013+c1-014', name, angle, bankVersion: 'v6', questionIds: ['c1-013', 'c1-014'], questionTexts: ['가상 질문 열셋', '가상 질문 열넷'] }, [good], NOW);
  const over = newWith('이'.repeat(40), '각'.repeat(190));
  ok('새 글 — 이름 40 + 각도 190(하나씩은 상한 안)은 합쳐 넘어 400', !over.ok && over.status === 400 && over.error.includes(`${NAME_AND_ANGLE_LIMIT}자까지`) && over.error.includes('지금 230자'));
  const atLimit = newWith('이'.repeat(40), '각'.repeat(NAME_AND_ANGLE_LIMIT - 40));
  ok('새 글 — 합쳐 상한과 같으면 저장', atLimit.ok && atLimit.article.angle?.length === NAME_AND_ANGLE_LIMIT - 40);
  ok('새 글 — 각도 하나만 200자를 넘으면 예전 문구', (() => {
    const r = newWith('가상', '각'.repeat(201));
    return !r.ok && r.status === 400 && r.error.startsWith('다룰 각도는 200자까지');
  })());
  const longAngled = def(['c1-021'], ['가상 질문 스물하나'], { name: '이'.repeat(20), angle: '각'.repeat(NAME_AND_ANGLE_LIMIT - 20) });
  const renameOver = checkExtraArticlePatch({ id: longAngled.id, name: '이'.repeat(21) }, [longAngled], NOW);
  ok('고치기 — 이름만 바꿔도 있던 각도와 합쳐 넘으면 400', !renameOver.ok && renameOver.status === 400 && renameOver.error.includes(`${NAME_AND_ANGLE_LIMIT}자까지`));
  const angleOver = checkExtraArticlePatch({ id: longAngled.id, angle: '각'.repeat(NAME_AND_ANGLE_LIMIT - 19) }, [longAngled], NOW);
  ok('고치기 — 각도만 바꿔도 있던 이름과 합쳐 넘으면 400', !angleOver.ok && angleOver.status === 400);
  const renameShort = checkExtraArticlePatch({ id: longAngled.id, name: '이'.repeat(19), angle: '각'.repeat(NAME_AND_ANGLE_LIMIT - 19) }, [longAngled], NOW);
  ok('고치기 — 합쳐 상한 안이면 저장', renameShort.ok && renameShort.article.name.length === 19 && renameShort.article.angle?.length === NAME_AND_ANGLE_LIMIT - 19);
  ok('고치기 — 빼기만 할 때는 이름 · 각도를 다시 재지 않는다', checkExtraArticlePatch({ id: longAngled.id, removed: true }, [{ ...longAngled, name: '이'.repeat(60) }], NOW).ok);
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

  // 11) 이번 주 형편(extraStandingOf) — reach는 진 질문만 센다. reach 0만으로 「모두 이김」이라 하면 무승부 · 되물음 · 응답 없는 질문까지
  // 이김이 되고, 결과가 없는 글은 「0개」가 아니라 확인 불가다.
  ok('형편 — 진 질문이 있으면 losing', extraStandingOf(x1!) === 'losing' && x1?.extra?.won === 1 && x1.extra.noAnswer === 0 && x1.extra.missingWhy === undefined);
  ok('형편 — 고른 질문을 모두 이기면 all-win', extraStandingOf(won!) === 'all-win' && won?.extra?.won === 1);
  ok('형편 — 못 찾은 질문뿐이면 unknown(0개가 아님)', extraStandingOf(unresolved!) === 'unknown');
  ok('형편 — 판을 모르면 unknown', [e1.id, e2.id].every((id) => extraStandingOf(find(unknownPlan, id)!) === 'unknown'));
  ok('형편 — 본 글은 null', extraStandingOf(find(base, MAIN)!) === null);
  // 못 찾은 까닭 — 판 모름 · 판 바뀜 · 같은 판인데 은행에 없음. 화면 요약이 근거 문장과 같은 까닭을 댄다.
  ok('까닭 — 판을 모르면 bank-unknown', find(unknownPlan, e1.id)?.extra?.missingWhy === 'bank-unknown');
  ok('까닭 — 판이 바뀌어 하나도 못 찾으면 bank-changed · 근거가 판 바뀜을 밝힌다', unresolved?.extra?.missingWhy === 'bank-changed' && /판이 바뀌었습니다\(v5 → v6\)/.test(unresolved.evidence));
  const partV6 = def(['a4', 'zz-1'], ['a4 질문', '가상 없는 질문'], { name: '가상 반만 찾음' });
  const part = find(withExtras([partV6]), partV6.id);
  ok('까닭 — 같은 판인데 은행에 없는 질문은 not-in-bank', part?.extra?.missingWhy === 'not-in-bank' && part.extra.how === 'same-bank' && !/판이 바뀌/.test(part.evidence));
  ok('형편 — 찾은 질문을 모두 이겨도 못 찾은 질문이 있으면 no-loss(「모두 이김」 아님)', extraStandingOf(part!) === 'no-loss');

  // 무승부(a6: 셋 중 하나만 언급, 더 많이 말한 경쟁사 없음) · 되물음(a7) · 응답 없음(a8: 은행에는 있고 분석 줄이 없다)
  const evenWeek = [
    ...week,
    analysis('a6', 0, true, []),
    analysis('a6', 1, false, []),
    analysis('a6', 2, false, []),
    { ...analysis('a7', 0, false, []), clarifying: true },
    { ...analysis('a7', 1, false, []), clarifying: true },
  ];
  const evenQuestions = [...questions, question('a6', 'category-agnostic', false), question('a7', 'category-agnostic', false), question('a8', 'category-agnostic', false)];
  const evenPlan = (defs: ExtraArticle[]) =>
    computeGapActions(evenWeek as unknown as ClientAnalysis[], evenQuestions, analyzeCitationSources(evenWeek), {}, [], '2026-W44', { extraArticles: defs, bankVersion: 'v6' });
  const withEven = def(['a4', 'a6'], ['a4 질문', 'a6 질문'], { name: '가상 무승부' });
  const evenX = find(evenPlan([withEven]), withEven.id);
  ok('무승부 — reach 0이어도 all-win이 아니다(no-loss)', evenX?.reach === 0 && evenX.extra?.won === 1 && extraStandingOf(evenX) === 'no-loss');
  ok('무승부 — 근거 문장은 예전처럼 「밀린 질문이 없습니다」', evenX?.evidence === '고른 질문 2개 가운데 이번 주 밀린 질문이 없습니다.');
  const asked = def(['a7'], ['a7 질문'], { name: '가상 되물음' });
  const askedX = find(evenPlan([asked]), asked.id);
  ok('되물음 — no-loss(이김 아님)', askedX?.reach === 0 && askedX.extra?.won === 0 && askedX.extra.noAnswer === 0 && extraStandingOf(askedX) === 'no-loss');
  const halfNoRow = def(['a4', 'a8'], ['a4 질문', 'a8 질문'], { name: '가상 응답 반' });
  const halfX = find(evenPlan([halfNoRow]), halfNoRow.id);
  ok('응답 없음 — 찾은 질문으로 남고 noAnswer로 센다 · no-loss', halfX?.questionIds.join() === 'a4,a8' && halfX.extra?.noAnswer === 1 && halfX.extra.won === 1 && extraStandingOf(halfX) === 'no-loss');
  ok(
    '응답 없음 — 근거가 응답 있는 질문만 「밀린 질문 없음」으로 말하고 나머지는 확인 불가',
    halfX?.evidence === '응답이 있는 질문 1개 가운데 이번 주 밀린 질문이 없습니다. 고른 질문 중 1개는 이번 주 응답이 없어 확인 불가입니다.',
  );
  const onlyNoRow = def(['a8'], ['a8 질문'], { name: '가상 응답 없음' });
  const onlyX = find(evenPlan([onlyNoRow]), onlyNoRow.id);
  ok('응답 없음뿐 — unknown · 근거가 「밀린 질문 없음」이라 하지 않는다', extraStandingOf(onlyX!) === 'unknown' && onlyX?.extra?.how === 'same-bank' && !/밀린/.test(onlyX.evidence) && /확인 불가/.test(onlyX.evidence));
}

// ── (c) 올리기 목록 — buildPublishPlan · recordInputOf ───────────────────────────────────────────
{
  const MAIN = 'content:category-agnostic';
  const post = (url: string, articleId: string, targetActionId: string, via: PublishedPost['via']): PublishedPost => ({
    id: `p-${url}`, url, key: url.replace(/^https?:\/\//, ''), publishedOn: '2026-10-20', publishedOnSource: 'user',
    recordedAt: '2026-10-20T00:00:00Z', articleId, targetActionId, via,
  });
  const hit = (p: PublishedPost): PublishedHit => ({ post: p, timing: 'after', tally: null, variantCited: 0 });
  const action = (id: string, kind: GapAction['kind'], questionIds: string[], extra: Partial<GapAction> = {}): GapAction => ({
    id, kind, title: id, badge: kind === 'content' ? '콘텐츠' : '블로그 플랫폼', evidence: '', questionIds, questionTexts: questionIds,
    reach: questionIds.length, satisfied: false, status: 'todo', publishedUrls: [], citedPublishedUrls: [], doneSignal: '', ...extra,
  });
  // 채널 항목 — 올린 기록은 계산(computeGapActions)처럼 대상 항목 하나에 글 구분 없이 모인다.
  const channel = (id: string, questionIds: string[], posts: PublishedPost[], extra: Partial<GapAction> = {}): GapAction =>
    action(id, 'listing', questionIds, {
      targetDomain: id.replace(/^listing:(platform:)?/, ''),
      publishedUrls: posts.map((p) => p.url),
      ...(posts.length ? { publishedHits: posts.map(hit) } : {}),
      ...extra,
    });
  const extraAction = (d: ExtraArticle, questionIds: string[], posts: PublishedPost[] = []): GapAction =>
    action(d.id, 'content', questionIds, {
      badge: '추가 글',
      publishedUrls: posts.map((p) => p.url),
      ...(posts.length ? { publishedHits: posts.map(hit) } : {}),
      extra: { name: d.name, how: 'same-bank', missingTexts: [], won: 0, noAnswer: 0, topic: extraTopicSnapshot(d) },
    });

  const x1Def = def(['q7', 'q8'], ['q7 질문', 'q8 질문'], { name: '가상 코스' });
  const x2Def = def(['q9'], ['q9 질문'], { name: '가상 지도' });
  // 목록에서 뺀 추가 글 — 항목은 없지만 티스토리에 올린 기록은 원장에 남는다.
  const goneId = 'topic:q10';

  const main = action(MAIN, 'content', ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  const x1Own = post('https://fake-brand.example/x1', x1Def.id, x1Def.id, 'own');
  const x1 = extraAction(x1Def, ['q7', 'q8'], [x1Own]);
  const x2 = extraAction(x2Def, ['q9']);

  // 티스토리 — 글 ①(x1)과 치운 글만 올렸다. 본 글은 아직(집행 상태 todo).
  const x1Tistory = post('https://fake-a.tistory.com/1', x1Def.id, 'listing:platform:tistory.com', 'channel');
  const goneTistory = post('https://fake-a.tistory.com/9', goneId, 'listing:platform:tistory.com', 'channel');
  const tistory = channel('listing:platform:tistory.com', ['q1', 'q7'], [x1Tistory, goneTistory], { citedPublishedUrls: [x1Tistory.url] });
  // 네이버 블로그 — 본 글만 올렸다(「올렸어요」가 집행함으로 바꿨다). 글 ①과도 겹친다.
  const mainNaver = post('https://blog.naver.com/fake/1', MAIN, 'listing:platform:blog.naver.com', 'channel');
  const naver = channel('listing:platform:blog.naver.com', ['q2', 'q7'], [mainNaver], { status: 'done', citedPublishedUrls: [mainNaver.url] });
  // 브런치 — 글 ②하고만 겹치고 아무도 올리지 않았다 → 추가 글 줄만, 따로 쓸 글 없음.
  const brunch = channel('listing:platform:brunch.co.kr', ['q9'], []);
  // 벨로그 — 본 글하고만 겹치고 아무도 올리지 않았다 → 본 글 줄만.
  const velog = channel('listing:platform:velog.io', ['q3'], []);
  // 단일 채널(플랫폼 아님)
  const wiki = channel('listing:namu.wiki', ['q3', 'q9'], [], { badge: '위키' }); // 본 글과도 글 ②와도 겹침 → 본 글
  const trip = channel('listing:trip.com', ['q9'], [], { badge: '후기·예약 플랫폼' }); // 글 ②하고만 겹침 → 글 ②(한 줄)
  const legacyYeogi = post('https://www.yeogi.com/fake/1', 'listing:yeogi.com', 'listing:yeogi.com', 'channel');
  const yeogi = channel('listing:yeogi.com', ['q9'], [legacyYeogi], { badge: '후기·예약 플랫폼', status: 'done' }); // 본 글(옛 기록)로 올림 · 글 ②와만 겹침
  const x2Triple = post('https://triple.guide/fake/1', x2Def.id, 'listing:triple.guide', 'channel');
  const triple = channel('listing:triple.guide', ['q4', 'q9'], [x2Triple], { badge: '후기·예약 플랫폼' }); // 글 ②로만 올림 · 본 글과도 겹침
  const cafe = channel('listing:cafe.daum.net', ['q11'], [], { badge: '커뮤니티' }); // 어느 글과도 안 겹침 → 따로 쓸 글

  // 추가 글이 본 글보다 앞에 온다 — 항목은 순위 · 밀린 질문 수 순이다.
  const listing = [tistory, naver, brunch, velog, wiki, trip, yeogi, triple, cafe];
  const pub = buildPublishPlan([x1, main, x2], listing, null);
  const rowsOf = (channelId: string) => pub.rows.filter((r) => r.target.id === channelId);
  const rowOf = (articleId: string, channelId: string) => pub.rows.find((r) => r.article.action.id === articleId && r.target.id === channelId);

  ok('목록 — row.key가 겹치지 않는다', new Set(pub.rows.map((r) => r.key)).size === pub.rows.length);
  const channelIds = new Set(pub.rows.filter((r) => r.kind === 'channel').map((r) => r.target.id));
  ok('목록 — channel 줄이 있는 채널마다 앵커 하나', [...channelIds].every((id) => rowsOf(id).filter((r) => r.anchor).length === 1));
  ok('목록 — own · orphan 줄은 앵커가 아니다', pub.rows.filter((r) => r.kind !== 'channel').every((r) => !r.anchor));
  ok('목록 — 플랫폼의 앵커는 본 글 줄', rowsOf(tistory.id).find((r) => r.anchor)?.article.action.id === MAIN && rowsOf(naver.id).find((r) => r.anchor)?.article.action.id === MAIN);
  ok('목록 — 추가 글 플랫폼 줄 key는 글|채널, 본 글 줄은 채널 id 그대로', rowOf(x1Def.id, tistory.id)?.key === `${x1Def.id}|${tistory.id}` && rowOf(MAIN, tistory.id)?.key === tistory.id);
  ok('목록 — 글은 추가 글이 앞이어도 셋 그대로', pub.articles.map((a) => a.action.id).join() === [x1.id, MAIN, x2.id, cafe.id].join());

  // 줄별 「올림」 — 추가 글 티스토리 기록이 본 글 줄을 「올림」으로 만들지 않는다(반대도)
  const mainTistory = rowOf(MAIN, tistory.id);
  const x1TistoryRow = rowOf(x1Def.id, tistory.id);
  ok('티스토리 — 글 ① 줄은 「올림」, 그 기록 · 인용만', x1TistoryRow?.done === true && x1TistoryRow.publishedUrls.join() === x1Tistory.url && x1TistoryRow.citedUrls.join() === x1Tistory.url && x1TistoryRow.hits.length === 1);
  ok('티스토리 — 본 글 줄은 「올림」이 아니다(글 ① 기록이 섞이지 않음)', mainTistory?.done === false && mainTistory.citedUrls.length === 0);
  ok('티스토리 — 치운 추가 글의 기록도 본 글 줄에 섞이지 않는다', mainTistory?.hits.length === 0 && mainTistory.publishedUrls.length === 0);
  ok('티스토리 — 치운 추가 글의 줄은 없다', !pub.rows.some((r) => r.article.action.id === goneId || r.key.startsWith(`${goneId}|`)));
  ok('네이버 — 본 글 줄은 「올림」(기록 · 집행함)', rowOf(MAIN, naver.id)?.done === true && rowOf(MAIN, naver.id)?.publishedUrls.join() === mainNaver.url);
  ok('네이버 — 글 ① 줄은 「올림」이 아니다(채널 집행함을 읽지 않음)', rowOf(x1Def.id, naver.id)?.done === false && rowOf(x1Def.id, naver.id)?.hits.length === 0);
  ok('자사 — 글 ①은 자기 기록으로 「올림」, 본 글은 아님', pub.rows.find((r) => r.key === `own:${x1.id}`)?.done === true && pub.rows.find((r) => r.key === `own:${MAIN}`)?.done === false);

  // 추가 글이 받는 플랫폼 줄 — 겹치는 곳 · 브랜드가 이미 올린 곳 · 그 글로 올린 곳
  ok('플랫폼 — 글 ②는 겹치지 않아도 이미 올린 티스토리 · 네이버 줄을 받는다(질문 0개)', rowOf(x2Def.id, tistory.id)?.questionIds.length === 0 && rowOf(x2Def.id, naver.id) !== undefined);
  ok('플랫폼 — 글 ①은 겹치는 티스토리 줄(q7)', rowOf(x1Def.id, tistory.id)?.questionIds.join() === 'q7');
  ok('플랫폼 — 아무도 안 올린 곳은 겹치는 글만(브런치: 글 ②만, 따로 쓸 글 없음)', rowsOf(brunch.id).map((r) => r.article.action.id).join() === x2.id && rowsOf(brunch.id).every((r) => r.kind === 'channel'));
  ok('플랫폼 — 본 글하고만 겹치고 안 올린 곳(벨로그)은 본 글 줄만', rowsOf(velog.id).map((r) => r.article.action.id).join() === MAIN);
  ok('플랫폼 — 추가 글 채널 줄은 다듬기 필요', rowOf(x2Def.id, brunch.id)?.needsAdapt === true);

  // 단일 채널 — 한 줄, 본 글 먼저, orphan으로 쪼개지지 않음
  ok('단일 — 본 글과 겹치면 본 글(한 줄)', rowsOf(wiki.id).length === 1 && rowOf(MAIN, wiki.id)?.questionIds.join() === 'q3');
  ok('단일 — 추가 글하고만 겹치면 그 추가 글(한 줄 · 채널 id key · orphan 아님)', rowsOf(trip.id).length === 1 && rowsOf(trip.id)[0]?.article.action.id === x2.id && rowsOf(trip.id)[0]?.kind === 'channel' && rowsOf(trip.id)[0]?.key === trip.id);
  ok('단일 — 본 글로 이미 올린 곳은 추가 글과만 겹쳐도 본 글에 남는다', rowsOf(yeogi.id).length === 1 && rowsOf(yeogi.id)[0]?.article.action.id === MAIN && rowsOf(yeogi.id)[0]?.done === true);
  ok('단일 — 추가 글로만 올린 곳은 본 글과 겹쳐도 그 추가 글에 남는다', rowsOf(triple.id).length === 1 && rowsOf(triple.id)[0]?.article.action.id === x2.id && rowsOf(triple.id)[0]?.done === true);
  ok('단일 — 어느 글과도 안 겹치면 따로 쓸 글(orphan)', rowsOf(cafe.id).length === 1 && rowsOf(cafe.id)[0]?.kind === 'orphan');
  ok('단일 — orphan은 그 하나뿐', pub.rows.filter((r) => r.kind === 'orphan').length === 1);
  ok('진행 수 — 올린 줄 수(글 ① 자사 · 글 ① 티스토리 · 본 글 네이버 · 여기어때 · 트리플)', pub.done === 5);

  // recordInputOf — 추가 글 채널 줄은 집행 상태를 바꾸지 않고 질문 스냅샷을 싣는다
  const rec = (r: PublishRow | undefined) => (r ? recordInputOf(r) : null);
  const snapX1 = JSON.stringify(extraTopicSnapshot(x1Def));
  const recX1Tistory = rec(x1TistoryRow);
  ok('기록 — 추가 글 채널 줄: markDone false · 스냅샷 · 채널 대상', recX1Tistory?.markDone === false && JSON.stringify(recX1Tistory.topic) === snapX1 && recX1Tistory.targetActionId === tistory.id && recX1Tistory.articleId === x1.id && recX1Tistory.via === 'channel');
  ok('기록 — 추가 글 스냅샷 id를 이으면 글 id(원장 검사 통과)', recX1Tistory !== null && `topic:${recX1Tistory.topic?.questionIds.join('+')}` === x1.id);
  const recX1Own = rec(pub.rows.find((r) => r.key === `own:${x1.id}`));
  ok('기록 — 추가 글 자사 줄: markDone true · 스냅샷', recX1Own?.markDone === true && JSON.stringify(recX1Own.topic) === snapX1 && recX1Own.via === 'own' && recX1Own.targetActionId === x1.id);
  const recTrip = rec(rowsOf(trip.id)[0]);
  ok('기록 — 추가 글이 맡은 단일 채널 줄: markDone true(줄이 하나라 집행 상태도 그 줄 것) · 스냅샷', recTrip?.markDone === true && JSON.stringify(recTrip.topic) === JSON.stringify(extraTopicSnapshot(x2Def)) && recTrip.articleId === x2.id && recTrip.targetActionId === trip.id);
  ok('기록 — 추가 글이 맡은 브런치(플랫폼) 줄은 markDone false', rec(rowOf(x2Def.id, brunch.id))?.markDone === false);
  const recMain = rec(mainTistory);
  ok('기록 — 본 글 채널 줄: markDone true · 스냅샷 없음', recMain?.markDone === true && !('topic' in recMain) && recMain.articleId === MAIN && recMain.via === 'channel');
  const recCafe = rec(rowsOf(cafe.id)[0]);
  ok('기록 — 따로 쓸 글: 채널 항목이 글 · markDone true', recCafe?.via === 'orphan' && recCafe.articleId === cafe.id && recCafe.markDone && !('topic' in recCafe));

  // 본 글이 없는 주 — 이미 올린 곳은 주소 줄(옛 규칙)로 남고, 추가 글은 자기 줄을 받는다. 본 글 대신 추가 글에 붙지 않는다.
  const yeogiQ7 = { ...yeogi, questionIds: ['q7'], questionTexts: ['q7'] }; // 글 ①과 겹치는 이미 올린 곳
  const noMain = buildPublishPlan([x1], [naver, yeogiQ7], null);
  const naverRows = noMain.rows.filter((r) => r.target.id === naver.id);
  ok('본 글 없음 — 네이버는 주소 줄(앵커 · 올림) + 글 ① 줄', naverRows.length === 2 && naverRows[0]?.article.action.id === naver.id && naverRows[0].anchor && naverRows[0].done && naverRows[1]?.key === `${x1.id}|${naver.id}` && !naverRows[1].done);
  const yeogiRows = noMain.rows.filter((r) => r.target.id === yeogi.id);
  ok('본 글 없음 — 이미 올린 단일 채널은 추가 글로 가지 않고 주소 줄', yeogiRows.length === 1 && yeogiRows[0]?.article.action.id === yeogi.id && yeogiRows[0].done && !yeogiRows[0].needsAdapt);
  ok('본 글 없음 — 따로 쓸 글 없음', noMain.rows.every((r) => r.kind !== 'orphan'));

  // 줄이 보이는 기록의 규칙(keepsArticle) — 화면의 「뺀 주소」 목록도 이 규칙으로 고른다. 주소 줄은 목록에서 뺀 추가 글의 기록도 받으므로,
  // 「topic:이 아닌 기록」으로 고르면 거기서 뺀 주소가 어느 목록에도 남지 않아 되살릴 수 없다.
  const goneNaver = post('https://blog.naver.com/fake/9', goneId, naver.id, 'channel');
  const naverWithGone = channel(naver.id, ['q2', 'q7'], [mainNaver, goneNaver], { status: 'done' });
  const goneRows = buildPublishPlan([x1], [naverWithGone], null).rows;
  const naverAddress = goneRows.find((r) => r.key === naver.id);
  ok('규칙 — 주소 줄은 뺀 추가 글의 기록을 보이고 같은 규칙으로 고른다', naverAddress?.hits.some((h) => h.post.articleId === goneId) === true && naverAddress.keepsArticle(goneId) && naverAddress.keepsArticle(naver.id) && !naverAddress.keepsArticle(x1.id));
  ok('규칙 — 뺀 추가 글의 주소는 줄 하나에만 걸린다(되살릴 곳이 하나)', goneRows.filter((r) => r.target.id === naver.id && r.keepsArticle(goneId)).length === 1);
  ok('규칙 — 추가 글 줄은 그 글의 기록만', rowOf(x1Def.id, tistory.id)?.keepsArticle(x1Def.id) === true && !rowOf(x1Def.id, tistory.id)?.keepsArticle(goneId) && !rowOf(x1Def.id, tistory.id)?.keepsArticle(MAIN));
  ok('규칙 — 본 글이 있는 주의 본 글 줄은 topic:이 아닌 기록만', mainTistory?.keepsArticle(MAIN) === true && !mainTistory.keepsArticle(goneId) && !mainTistory.keepsArticle(x1Def.id));
  ok('규칙 — 모든 줄의 hits가 그 줄의 규칙을 따른다', [...pub.rows, ...noMain.rows, ...goneRows].every((r) => r.hits.every((h) => r.keepsArticle(h.post.articleId))));

  // 추가 글로 올린 단일 채널 — 「올렸어요」(markDone true)가 집행함으로 바꾼다. 집행함이어도 그 추가 글 줄에 남아 올린 주소를 보이고,
  // 그 글을 목록에서 빼도 이미 등록한 곳이 「올리기」로 돌아가지 않는다(같은 업체 중복 등록 방지).
  const x2Trip = post('https://www.trip.com/fake/1', x2Def.id, trip.id, 'channel');
  const tripPosted = channel(trip.id, ['q9'], [x2Trip], { badge: '후기·예약 플랫폼', status: 'done' });
  const tripRows = (p: ReturnType<typeof buildPublishPlan>) => p.rows.filter((r) => r.target.id === trip.id);
  const postedTrip = tripRows(buildPublishPlan([main, x2], [tripPosted], null));
  ok('단일 — 추가 글로 올려 집행함이어도 그 추가 글 줄(올림 · 올린 주소)', postedTrip.length === 1 && postedTrip[0]?.article.action.id === x2.id && postedTrip[0].done && postedTrip[0].publishedUrls.join() === x2Trip.url && postedTrip[0].hits.length === 1);
  const tripTodo = { ...tripPosted, status: 'todo' as const };
  const todoTrip = tripRows(buildPublishPlan([main, x2], [tripTodo], null));
  ok('단일 — 같은 곳이 집행 상태 todo여도 같은 줄(집행함은 줄 배정을 바꾸지 않음)', todoTrip.length === 1 && todoTrip[0]?.article.action.id === x2.id && todoTrip[0].done);
  const mainWithQ9 = action(MAIN, 'content', [...main.questionIds, 'q9']);
  const backTrip = tripRows(buildPublishPlan([mainWithQ9], [tripPosted], null));
  ok('단일 — 그 추가 글을 빼서 질문이 본 글로 돌아와도 「올림」(본 글 줄 · 한 줄)', backTrip.length === 1 && backTrip[0]?.article.action.id === MAIN && backTrip[0].kind === 'channel' && backTrip[0].done);
  const apartPlan = buildPublishPlan([main], [tripPosted], null);
  const apartTrip = tripRows(apartPlan);
  ok('단일 — 빼고 나서 본 글과도 안 겹치면 이미 올린 곳이라 본 글 줄 · 「올림」(따로 쓸 글 없음)', apartTrip.length === 1 && apartTrip[0]?.article.action.id === MAIN && apartTrip[0].questionIds.length === 0 && apartTrip[0].done && apartPlan.rows.every((r) => r.kind !== 'orphan'));

  // 추가 글만 올린 플랫폼 — 본 글과 겹치지 않으면 본 글 줄을 붙이지 않는다. 아무도 쓰지 않은 줄이 할 일 · 진행 분모에 더해지고 채널 앵커를
  // 가져가면 안 된다. 본 글이 올렸거나(기록 · 집행함) 겹칠 때만 본 글 줄이다.
  const x2Tistory = post('https://fake-b.tistory.com/2', x2Def.id, tistory.id, 'channel');
  const tistoryX2 = channel(tistory.id, ['q9'], [x2Tistory]);
  const extraOnly = buildPublishPlan([main, x2], [tistoryX2], null);
  const extraOnlyRows = extraOnly.rows.filter((r) => r.target.id === tistory.id);
  ok('플랫폼 — 추가 글만 올린 곳은 그 글 줄 하나(본 글 줄 없음 · 앵커 · 올림)', extraOnlyRows.length === 1 && extraOnlyRows[0]?.key === `${x2.id}|${tistory.id}` && extraOnlyRows[0].anchor && extraOnlyRows[0].done);
  ok('플랫폼 — 추가 글만 올려도 진행 분모가 늘지 않는다(자사 2 + 글 ② 티스토리)', extraOnly.rows.length === 3 && extraOnly.done === 1);
  const tistoryX2Marked = channel(tistory.id, ['q9'], [x2Tistory], { status: 'done' });
  ok('플랫폼 — 본 글 집행함(옛 기록)이면 겹치지 않아도 본 글 줄이 앵커', buildPublishPlan([main, x2], [tistoryX2Marked], null).rows.find((r) => r.target.id === tistory.id && r.anchor)?.article.action.id === MAIN);

  // 추가 글이 없으면 줄의 기록은 항목 값 그대로(화면이 row.target.* 대신 row.*를 써도 같다)
  const plain = buildPublishPlan([main], [naver, yeogi], null);
  ok('추가 글 없음 — 줄 기록 = 항목 기록', plain.rows.every((r) => r.publishedUrls === r.target.publishedUrls && r.citedUrls === r.target.citedPublishedUrls && r.hits.length === (r.target.publishedHits?.length ?? 0)));
}

// ── (d) 브리프 프롬프트 — 각도 · 피할 글(b9b-content-brief) ─────────────────────────────────────────
{
  // 기준 — 각도 · 피할 글을 넣기 전의 buildContentBriefPrompt가 아래 두 요청에 낸 문자열. user는 글자 그대로, system은 길어서 sha256.
  // 프롬프트를 일부러 고칠 때만 기준을 다시 뜬다 — 각도 · 피할 글이 없는 요청(본 글 · 등재형 · 질문 은행 글)의 브리프가 바뀐다는 뜻이다.
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const briefBase: ContentBriefRequest = {
    brandName: '가상 여관',
    industry: '숙박',
    region: '가상시',
    competitorNames: ['가상 민박', '가상 호텔'],
    factGraph: [
      { id: 'f1', type: 'price', claim: '1박 요금', value: '약 8만원', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'f2', type: 'location', claim: '위치', value: '가상역 도보 5분', updatedAt: '2026-10-01T00:00:00.000Z' },
    ],
    action: { kind: 'content', title: '가상 주제 콘텐츠 보강', questionTexts: ['가상시 숙소 추천해줘', '가상시 조용한 숙소는?'], evidence: '밀린 질문 2개' },
  };
  const briefListing: ContentBriefRequest = {
    ...briefBase,
    competitorNames: [],
    factGraph: [],
    action: { kind: 'listing', title: '가상 위키 등재', targetDomain: 'wiki.example', questionTexts: [], evidence: '' },
    language: 'en',
  };
  const BASE_USER =
    '브랜드: 가상 여관 (숙박 · 가상시)\n경쟁사: 가상 민박, 가상 호텔\n종류: 자사 사이트 콘텐츠 — 우리 도메인에 올릴 페이지의 브리프.\n실행 항목: 가상 주제 콘텐츠 보강\n왜 이 항목이 나왔나: 밀린 질문 2개\n\n이 글이 답해야 할 질문(AI가 이 출처를 꺼낸 질문 / 우리가 밀린 질문):\n- 가상시 숙소 추천해줘\n- 가상시 조용한 숙소는?\n\n팩트 그래프(이 사실만 쓸 수 있다):\n- [price] 1박 요금: 약 8만원\n- [location] 위치: 가상역 도보 5분';
  const BASE_SYSTEM_SHA = '4a73467f54b6590ab58f581a74a4e19e9e36319a9d3f6229fad6c1dc0463f63c';
  const LISTING_USER =
    '브랜드: 가상 여관 (숙박 · 가상시)\n경쟁사: (없음)\n종류: 외부 채널 등재·기고 — 대상 채널 wiki.example. 그 채널에서 지켜야 할 것(광고성 금지·문서 규칙·형식)을 channelNotes에 적는다.\n실행 항목: 가상 위키 등재\n왜 이 항목이 나왔나: \n\n이 글이 답해야 할 질문(AI가 이 출처를 꺼낸 질문 / 우리가 밀린 질문):\n- (질문 없음 — 채널 특성만으로 기획)\n\n팩트 그래프(이 사실만 쓸 수 있다):\n- (등록된 사실 없음)';
  const LISTING_SYSTEM_SHA = '5cfd1b42f736b9e54dddeb19d30f05ae3b375f35e48071a035be2e0d286690ba';

  const basePrompt = buildContentBriefPrompt(briefBase);
  const listingPrompt = buildContentBriefPrompt(briefListing);
  ok('브리프 — 각도 · 피할 글 없음: 콘텐츠형 user가 기준과 같다', basePrompt.user === BASE_USER);
  ok('브리프 — 각도 · 피할 글 없음: 콘텐츠형 system이 기준과 같다', sha(basePrompt.system) === BASE_SYSTEM_SHA);
  ok('브리프 — 각도 · 피할 글 없음: 등재형(영어) user가 기준과 같다', listingPrompt.user === LISTING_USER);
  ok('브리프 — 각도 · 피할 글 없음: 등재형(영어) system이 기준과 같다', sha(listingPrompt.system) === LISTING_SYSTEM_SHA);
  // 서버는 본문의 angle · avoid를 briefFocusOf로 펼친다 — 보내지 않은 요청(본 글 · 등재형)은 키가 생기지 않아 기준과 같다.
  const serverAbsent = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, ...briefFocusOf(undefined, undefined) } });
  ok('브리프 — 서버 경로(보내지 않음)도 기준과 같다', serverAbsent.user === BASE_USER && sha(serverAbsent.system) === BASE_SYSTEM_SHA);
  const blank = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, angle: '   ', avoid: { title: ' ', headings: ['', '  '] } } });
  ok('브리프 — 빈 각도 · 빈 피할 글은 없는 것과 같다', blank.user === BASE_USER && blank.system === basePrompt.system);

  const withFocus = buildContentBriefPrompt({
    ...briefBase,
    action: { ...briefBase.action, angle: '가상 주제 — 조용한 방 고르는 법', avoid: { title: '가상시 숙소 고르는 법', headings: ['위치부터 보기', '편의시설 확인'] } },
  });
  const angleLine = '\n다룰 각도: 가상 주제 — 조용한 방 고르는 법 — 제목 후보와 구조를 이 각도에 맞춘다.';
  const avoidBlock =
    '\n\n이미 쓴 본 글(겹치지 않게): 「가상시 숙소 고르는 법」\n아래 소제목과 같은 절을 만들지 말고, 이 글의 질문을 더 깊게 다룬다.\n- 위치부터 보기\n- 편의시설 확인';
  ok('브리프 — 각도 · 피할 글 있음: system은 그대로', withFocus.system === basePrompt.system);
  ok('브리프 — 「다룰 각도」 줄은 「왜 이 항목이 나왔나」 바로 다음', withFocus.user.includes(`왜 이 항목이 나왔나: 밀린 질문 2개${angleLine}\n\n이 글이 답해야 할 질문`));
  ok('브리프 — 「이미 쓴 본 글(겹치지 않게)」 블록은 질문 다음 · 팩트 그래프 앞', withFocus.user.includes(`- 가상시 조용한 숙소는?${avoidBlock}\n\n팩트 그래프(이 사실만 쓸 수 있다):`));
  ok('브리프 — 두 자리를 빼면 기준과 같다(다른 글자는 바뀌지 않음)', withFocus.user.replace(angleLine, '').replace(avoidBlock, '') === BASE_USER);
  const angleOnly = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, angle: '조용한 방' } });
  ok('브리프 — 각도만: 피할 글 블록 없음', angleOnly.user.includes('다룰 각도: 조용한 방') && !angleOnly.user.includes('이미 쓴 본 글'));
  const headingsOnly = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, avoid: { title: '', headings: ['위치부터 보기'] } } });
  ok('브리프 — 소제목만: 제목 없음으로 표시 · 각도 줄 없음', headingsOnly.user.includes('이미 쓴 본 글(겹치지 않게): (제목 없음)\n아래 소제목과 같은 절을') && !headingsOnly.user.includes('다룰 각도'));
  const titleOnly = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, avoid: { title: '가상시 숙소 고르는 법', headings: [] } } });
  ok('브리프 — 제목만: 소제목 목록 없이 본 글과 겹치지 않게', titleOnly.user.includes('「가상시 숙소 고르는 법」\n본 글과 같은 절을 만들지 말고, 이 글의 질문을 더 깊게 다룬다.\n\n팩트 그래프'));

  // 상한 · 모양 — 서버(POST /api/content-brief)와 화면이 같은 briefFocusOf를 쓴다
  const L = BRIEF_FOCUS_LIMITS;
  ok('상한 — 각도 200 · 소제목 20개 · 한 줄 80', L.angle === 200 && L.headings === 20 && L.heading === 80);
  ok('모양 — 아무것도 없으면 키도 없음', JSON.stringify(briefFocusOf(undefined, undefined)) === '{}');
  ok('모양 — 문자열이 아닌 각도는 버림', JSON.stringify(briefFocusOf(42, null)) === '{}' && JSON.stringify(briefFocusOf(['a'], 'x')) === '{}');
  ok('모양 — 각도는 앞뒤 공백을 다듬음', briefFocusOf('  조용한 방  ', undefined).angle === '조용한 방');
  const longAngle = briefFocusOf('가'.repeat(250), undefined).angle ?? '';
  ok('모양 — 긴 각도는 200자로 자름', longAngle.length === 200);
  ok('모양 — 피할 글이 객체가 아니거나 소제목이 배열이 아니면 버림', [briefFocusOf(undefined, 'x'), briefFocusOf(undefined, ['a']), briefFocusOf(undefined, { title: 'T', headings: 'a' }), briefFocusOf(undefined, { title: 7, headings: ['a'] })].every((r) => !('avoid' in r)));
  const clipped = briefFocusOf(undefined, { title: '제'.repeat(100), headings: [...Array.from({ length: 25 }, (_, i) => `소제목 ${i + 1}`), 7, null] }).avoid;
  ok('모양 — 소제목은 20개까지 · 제목은 80자로 자름', clipped?.headings.length === 20 && clipped.headings[19] === '소제목 20' && clipped.title.length === 80);
  const mixed = briefFocusOf(undefined, { headings: ['  위치  ', 3, '', 'ㄱ'.repeat(90)] }).avoid;
  ok('모양 — 제목 없어도 됨 · 문자열 아닌 · 빈 소제목은 빼고 한 줄은 80자', mixed?.title === '' && mixed.headings.length === 2 && mixed.headings[0] === '위치' && mixed.headings[1]?.length === 80);
  ok('모양 — 제목 · 소제목이 모두 비면 피할 글 없음', !('avoid' in briefFocusOf(undefined, { title: '  ', headings: [' '] })));

  // briefInputOf — 브리프를 만드는 세 길(글 설계 · 초안 카드 · 한 번에 만들기)이 함께 쓴다
  const mainDraft: StoredDraft = {
    actionId: 'content:category-agnostic',
    generatedAt: NOW,
    draft: {
      title: '가상시 숙소 고르는 법',
      lead: '가상 문단',
      sections: [
        { heading: '위치부터 보기', answers: 'q1', blocks: [{ kind: 'text', body: '가상 본문' }] },
        { heading: '편의시설 확인', answers: 'q2', blocks: [{ kind: 'gap', need: '주차 대수 — 팩트 그래프에 없음' }] },
      ],
      gapCount: 1,
      usedFacts: [],
    },
  };
  const plainAction = {
    id: 'content:category-agnostic',
    kind: 'content' as const,
    title: '카테고리 무관 질문 콘텐츠 보강',
    targetDomain: undefined,
    questionTexts: ['가상시 숙소 추천해줘'],
    evidence: '밀린 질문 1개',
  };
  const oldInput = { actionId: plainAction.id, kind: plainAction.kind, title: plainAction.title, targetDomain: undefined, questionTexts: plainAction.questionTexts, evidence: plainAction.evidence };
  ok('요청 — 본 글 · 등재형은 예전 요청 그대로(본 글 초안이 있어도)', JSON.stringify(briefInputOf(plainAction, mainDraft)) === JSON.stringify(oldInput) && JSON.stringify(briefInputOf(plainAction, undefined)) === JSON.stringify(oldInput));
  const snap = extraTopicSnapshot(def(['c1-011', 'c1-012'], ['가상시 조용한 숙소는?', '가상시 방음 좋은 숙소']));
  const extraAction = {
    ...plainAction,
    id: 'topic:c1-011+c1-012',
    title: '조용한 방 콘텐츠 보강',
    extra: { name: '조용한 방', angle: '  방음 · 층 고르는 법 ', how: 'same-bank' as const, missingTexts: [], won: 0, noAnswer: 0, topic: snap },
  };
  const withMain = briefInputOf(extraAction, mainDraft);
  ok('요청 — 추가 글: 각도는 「이름 — 각도」', withMain.angle === '조용한 방 — 방음 · 층 고르는 법');
  ok('요청 — 추가 글: 피할 글은 본 글 초안의 제목 · 소제목', JSON.stringify(withMain.avoid) === JSON.stringify({ title: '가상시 숙소 고르는 법', headings: ['위치부터 보기', '편의시설 확인'] }));
  const articleMain: StoredDraft = { ...mainDraft, draft: { ...mainDraft.draft, format: 'article', title: '가상시 숙소 고를 때 볼 {N}가지' } };
  const articleAvoid = briefInputOf(extraAction, articleMain).avoid;
  ok('요청 — 추가 글: 블로그 글 형식 본 글의 제목은 화면 제목({N}을 채운 것)', articleAvoid?.title === draftTitle(effectiveDraft(articleMain)) && !articleAvoid.title.includes('{N}'));
  ok('요청 — 추가 글: 나머지 칸은 그 항목 그대로', withMain.actionId === extraAction.id && withMain.title === extraAction.title && withMain.questionTexts === extraAction.questionTexts);
  const noAngle = briefInputOf({ ...extraAction, extra: { ...extraAction.extra, angle: undefined } }, undefined);
  ok('요청 — 각도가 없으면 이름만 · 본 글 초안이 없으면 피할 글 없음', noAngle.angle === '조용한 방' && !('avoid' in noAngle));
  const longName = briefInputOf({ ...extraAction, extra: { ...extraAction.extra, name: '이'.repeat(60), angle: '각'.repeat(200) } }, undefined);
  ok('요청 — 이름 + 각도가 길면 200자로 자름(서버도 같은 상한)', longName.angle?.length === 200 && longName.angle.startsWith('이'.repeat(60)));
  // 저장 검사를 거친 가장 긴 이름 + 각도는 화면 → 서버 → 프롬프트 어디서도 잘리지 않는다(각도 끝 글자까지 「다룰 각도」 줄에 들어감).
  const stored = checkNewExtraArticle(
    { id: 'topic:c1-031', name: '조'.repeat(EXTRA_LIMITS.name), angle: `${'각'.repeat(NAME_AND_ANGLE_LIMIT - EXTRA_LIMITS.name - 1)}끝`, bankVersion: 'v6', questionIds: ['c1-031'], questionTexts: ['가상 질문 서른하나'] },
    [],
    NOW,
  );
  const storedInput = stored.ok ? briefInputOf({ ...extraAction, extra: { ...extraAction.extra, name: stored.article.name, angle: stored.article.angle } }, undefined) : undefined;
  const storedPrompt = storedInput ? buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, ...briefFocusOf(storedInput.angle, storedInput.avoid) } }) : undefined;
  ok(
    '요청 — 저장한 가장 긴 이름 + 각도는 잘리지 않고 각도 끝까지 프롬프트에 들어감',
    stored.ok && storedInput?.angle === extraBriefAngle(stored.article.name, stored.article.angle) && storedInput.angle.length === BRIEF_FOCUS_LIMITS.angle &&
      Boolean(storedPrompt?.user.includes(`다룰 각도: ${storedInput.angle} — 제목 후보와`)) && Boolean(storedInput.angle.endsWith('각끝')),
  );
  const sent = buildContentBriefPrompt({ ...briefBase, action: { ...briefBase.action, ...briefFocusOf(withMain.angle, withMain.avoid) } });
  ok('요청 → 서버 → 프롬프트: 각도 줄과 본 글 소제목이 들어감', sent.user.includes('다룰 각도: 조용한 방 — 방음 · 층 고르는 법') && sent.user.includes('「가상시 숙소 고르는 법」') && sent.user.includes('\n- 편의시설 확인'));
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
