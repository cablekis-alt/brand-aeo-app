/**
 * 추가 글(본 글에서 질문 몇 개를 떼어 따로 쓰는 글)의 순수 로직을 확인한다(src/lib/extraArticles.ts). 파일 · 서버 · AI는 부르지 않는다.
 * 저장소 쓰기는 scripts/verify-extra-articles-store.ts가 본다.
 *
 * 왜: 추가 글의 id(topic:…)에 초안 · 브리프 · 올린 기록이 모두 붙는다. id 정렬이 질문 은행 화면과 다르면 같은 질문 묶음이 두 글로
 * 갈라지고, 원장 검사(checkTopic)가 스냅샷을 거절한다. 질문 id의 뜻은 은행 판마다 바뀌므로 판이 다른 주에 id로 찾으면 엉뚱한 질문을
 * 겨냥한다 — 문장이 정확히 같은 질문만 다시 찾고, 없으면 확인 불가로 남아야 한다.
 *
 *   npx tsx scripts/verify-extra-articles.ts
 */
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
