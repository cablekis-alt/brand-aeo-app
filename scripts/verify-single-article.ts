/**
 * 콘텐츠 생성의 글이 **한 편**인지 확인한다(src/lib/gapActions.ts contentActions · isIdleAction, src/lib/publishPlan.ts). AI는 부르지 않는다.
 *
 * 왜: 예전에는 밀린 질문의 카테고리마다 글을 한 편씩 쓰고, 어느 글과도 겹치지 않는 채널은 채널용 글을 따로 쓰게 했다. 실측(W43,
 * 브랜드 36곳)으로 보면 카테고리 무관 글이 질문의 85~95%와 채널 줄 대부분을 맡고, 나머지 글은 질문 1~3개짜리였다. 「덮는 글 없는
 * 채널」 68줄은 모두 덮는 밀린 질문이 0개였다. 언급률 · 추천 순위는 카테고리 무관 질문으로만 재므로 글을 그 한 편으로 줄였다.
 * 아래 규칙이 깨지면 ① 글 확인에 글이 다시 여러 편 뜨거나, 올린 기록이 다른 글로 갈라진다.
 *
 *   npx tsx scripts/verify-single-article.ts
 */
import { analyzeCitationSources } from '../server/citationSources';
import type { QuestionRepeatAnalysis } from '../server/types';
import type { ActionStateMap } from '../src/lib/api';
import { computeGapActions, isIdleAction, isOpenAction } from '../src/lib/gapActions';
import { buildPublishPlan } from '../src/lib/publishPlan';
import { buildRecommendationEvidence } from '../src/lib/recommendationEvidence';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import type { WeeklyScorecard } from '../src/prompts/b8-report';

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const question = (questionId: string, category: string, containsBrandName: boolean) =>
  ({ questionId, text: `${questionId} 질문`, category, containsBrandName }) as QuestionSpec;
// a1 · a2 카테고리 무관(이름 없음) · c1 비교(이름 있음) · r1 후기(이름 있음) · p1 가격(옛 은행처럼 이름 없음)
const questions = [
  question('a1', 'category-agnostic', false),
  question('a2', 'category-agnostic', false),
  question('c1', 'comparison', true),
  question('r1', 'troubleshooting-review', true),
  question('p1', 'price-spec', false),
];

const cite = (raw: string) => ({ raw, domain: null, ownerType: 'third-party-authority' as const, supportsBrandMention: false });
// mentioned=false면 그 질문은 「패」(언급 0), true면 「승」(경쟁사 언급 없음).
const analysis = (questionId: string, mentioned: boolean, urls: string[]) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex: 0,
    mentioned,
    mentionSentences: mentioned ? [{ text: '가상브랜드', sentiment: 'neutral' }] : [],
    competitorMentions: [],
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

// 네이버 블로그 · 티스토리는 카테고리 무관 패가 인용 → 글에 붙는다. namu.wiki는 비교 패(이름 있음)만, clien.net은 이긴 후기 질문만,
// tripadvisor는 가격 패(이름 없지만 카테고리 무관 아님)만 인용 → 덮는 밀린 질문이 없다.
const week = [
  analysis('a1', false, ['https://blog.naver.com/x/1', 'https://y.tistory.com/1']),
  analysis('a2', false, ['https://blog.naver.com/x/2']),
  analysis('c1', false, ['https://namu.wiki/w/가상']),
  analysis('r1', true, ['https://clien.net/service/board/1']),
  analysis('p1', false, ['https://www.tripadvisor.co.kr/Attraction_Review-1']),
];
const citations = analyzeCitationSources(week);
const plan = (states: ActionStateMap = {}, qs = questions, list = week) =>
  computeGapActions(list as unknown as ClientAnalysis[], qs, analyzeCitationSources(list), states);
const find = (p: ReturnType<typeof plan>, id: string) => p.actions.find((a) => a.id === id);
const publishOf = (p: ReturnType<typeof plan>) => {
  const open = p.actions.filter(isOpenAction);
  return buildPublishPlan(
    open.filter((a) => a.kind === 'content'),
    open.filter((a) => a.kind === 'listing'),
    null,
  );
};

// 1) 글은 한 편 — 카테고리 무관 패만, id는 예전 그대로(올린 기록 · 다듬은 글 · 초안이 이 키에 붙어 있다)
const base = plan();
const content = base.actions.filter((a) => a.kind === 'content');
ok('콘텐츠 항목은 한 개', content.length === 1);
ok('id는 content:category-agnostic 그대로', content[0]?.id === 'content:category-agnostic');
ok('글의 질문은 카테고리 무관 패만(a1 · a2)', JSON.stringify([...(content[0]?.questionIds ?? [])].sort()) === JSON.stringify(['a1', 'a2']));
ok(
  '글에 넣지 않은 패는 otherLost로 — 유형 이름과 이름 유무를 함께',
  base.otherLost.length === 2 &&
    base.otherLost.some((q) => q.questionId === 'c1' && q.categoryLabel === '비교' && q.containsBrandName === true) &&
    base.otherLost.some((q) => q.questionId === 'p1' && q.categoryLabel === '가격·사양' && q.containsBrandName === false),
);
ok('이긴 질문은 otherLost에 없다', !base.otherLost.some((q) => q.questionId === 'r1'));

// 2) 덮는 밀린 질문이 없는 채널은 목록에서 뺀다
for (const id of ['listing:namu.wiki', 'listing:clien.net', 'listing:tripadvisor.co.kr']) {
  const a = find(base, id);
  ok(`${id} — reach 0 · 목록에서 뺌(idle) · 할 일 수에서 빠짐`, a !== undefined && a.reach === 0 && isIdleAction(a) && !isOpenAction(a));
}
const naver = find(base, 'listing:platform:blog.naver.com');
ok('네이버 블로그 — 카테고리 무관 패 2개를 덮는다', naver?.reach === 2 && isOpenAction(naver) && !isIdleAction(naver));
// 고객 보고서에도 실리는 문장이라 「카테고리 무관」 대신 같은 질문을 부르는 고객용 말 「이름 없이 물은 질문」(상용화 UI 3차 결정 D7 — 뜻은 그대로)
ok('근거 문장이 카테고리 무관 질문의 패라고 밝힌다', /그중 2개는 이름 없이 물은 질문에서 우리가 밀린 질문입니다/.test(naver?.evidence ?? ''));
ok('openCount = 글 1 + 채널 2', base.openCount === 3);

// 3) 올리기 목록 — 글 한 편, 따로 쓸 글 없음, 진행 분모는 글의 질문 수
const pub = publishOf(base);
ok('글은 한 편', pub.articles.length === 1 && pub.articles[0]?.action.id === 'content:category-agnostic');
ok('따로 쓸 글(orphan) 줄 없음', pub.rows.every((r) => r.kind !== 'orphan'));
ok('채널 줄은 모두 그 글에 붙는다', pub.rows.filter((r) => r.kind === 'channel').every((r) => r.article.action.id === 'content:category-agnostic'));
ok('진행 분모 = 글의 질문 수', pub.totalQuestions === 2);

// 4) 예전 화면에서 남긴 글의 「보류」는 읽지 않는다 — 보류하면 채널이 모두 따로 쓸 글로 쪼개진다
const skipped = plan({ 'content:category-agnostic': { status: 'skip', updatedAt: '2026-10-20T00:00:00Z', markedWeek: '2026-W43' } });
const skippedArticle = find(skipped, 'content:category-agnostic');
ok('글의 보류는 「안 함」으로 읽는다', skippedArticle?.status === 'todo' && isOpenAction(skippedArticle));
ok('보류가 남아 있어도 따로 쓸 글 줄 없음', publishOf(skipped).rows.every((r) => r.kind !== 'orphan'));
const channelSkip = plan({ 'listing:platform:blog.naver.com': { status: 'skip', updatedAt: '2026-10-20T00:00:00Z' } });
ok('채널의 보류는 그대로', find(channelSkip, 'listing:platform:blog.naver.com')?.status === 'skip' && channelSkip.skippedCount === 1);

// 5) 손댄 곳은 덮는 질문이 없어도 빼지 않는다
const touched = plan({
  'listing:namu.wiki': { status: 'done', updatedAt: '2026-10-20T00:00:00Z', markedWeek: '2026-W43' },
  'listing:clien.net': { status: 'doing', updatedAt: '2026-10-20T00:00:00Z', markedWeek: '2026-W43' },
});
const wikiDone = find(touched, 'listing:namu.wiki')!;
ok('집행함 · 진행 중인 곳은 idle이 아니다', !isIdleAction(wikiDone) && !isIdleAction(find(touched, 'listing:clien.net')!));
const touchedPub = publishOf(touched);
const wikiRow = touchedPub.rows.find((r) => r.target.id === 'listing:namu.wiki');
ok(
  '이미 올린 곳은 그 글의 채널 줄로 남는다(따로 쓸 글로 쪼개지지 않음)',
  wikiRow?.kind === 'channel' && wikiRow.article.action.id === 'content:category-agnostic' && wikiRow.questionIds.length === 0 && wikiRow.done,
);
ok('진행 중(올린 기록 없음)인 곳은 예전처럼 따로 쓸 글', touchedPub.rows.find((r) => r.target.id === 'listing:clien.net')?.kind === 'orphan');

// 6) 은행을 읽지 못하면 유형을 몰라 밀린 패 전부를 한 편으로(예전과 같은 모양)
const noBank = plan({}, []);
const noBankContent = noBank.actions.filter((a) => a.kind === 'content');
ok('은행 없음 — 콘텐츠 항목 한 개(content:)', noBankContent.length === 1 && noBankContent[0]?.id === 'content:');
ok('은행 없음 — 밀린 패 전부(a1 · a2 · c1 · p1)', noBankContent[0]?.questionIds.length === 4);
ok('은행 없음 — otherLost 비어 있음', noBank.otherLost.length === 0);
ok('은행 없음 — 비교 패를 인용한 namu.wiki도 덮는 질문이 있다', find(noBank, 'listing:namu.wiki')?.reach === 1 && !isIdleAction(find(noBank, 'listing:namu.wiki')!));
ok('은행 없음 — 근거 문장에 「카테고리 무관」을 붙이지 않는다', !/카테고리 무관/.test(find(noBank, 'listing:platform:blog.naver.com')?.evidence ?? ''));

// 7) 카테고리 무관 패가 없는 주 — 글 0편, 채널은 모두 빠지고, 다른 유형의 패는 그대로 밝힌다
const allWin = week.map((a) => (a.questionId === 'a1' || a.questionId === 'a2' ? { ...a, mentioned: true, mentionSentences: [{ text: '가상브랜드', sentiment: 'neutral' }] } : a)) as QuestionRepeatAnalysis[];
const noArticle = plan({}, questions, allWin);
ok('카테고리 무관 패 0 — 콘텐츠 항목 없음', noArticle.actions.every((a) => a.kind !== 'content'));
ok('카테고리 무관 패 0 — 남은 할 일 0', noArticle.openCount === 0);
ok('카테고리 무관 패 0 — 다른 유형의 패는 otherLost에 남는다', noArticle.otherLost.length === 2);
// 이미 올린 곳(비교 패만 인용한 namu.wiki · 아무 패도 인용하지 않은 네이버 블로그)은 글이 없어도 주소 줄로 남는다 — 따로 쓸 글로 쪼개지 않는다.
const noArticleDone = plan(
  {
    'listing:namu.wiki': { status: 'done', updatedAt: '2026-10-20T00:00:00Z', markedWeek: '2026-W43' },
    'listing:platform:blog.naver.com': { status: 'done', updatedAt: '2026-10-20T00:00:00Z', markedWeek: '2026-W43' },
  },
  questions,
  allWin,
);
const noArticlePub = publishOf(noArticleDone);
ok('글 없는 주 · 올린 곳 — 글 0편(① 글 확인 · 한꺼번에 만들기 없음)', noArticlePub.articles.length === 0);
ok(
  '글 없는 주 · 올린 곳 — 잠기지 않은 「올림」 줄(주소를 다룰 수 있다)',
  noArticlePub.rows.length === 2 && noArticlePub.rows.every((r) => r.kind === 'channel' && r.done && !r.locked && !r.needsAdapt),
);

// 8) 정기진단 보고서도 목록에서 뺀 곳을 권하지 않는다
const repCard = { weekOf: '2026-W43', brandName: '가상브랜드', mentionRate: 0, aeoScore: { current: 5, ciLow: 0, ciHigh: 10 }, avgRecommendationRank: null, rankedResponses: 0, brandOwnedCitationRate: 0 } as unknown as WeeklyScorecard;
const blocks = buildRecommendationEvidence({ card: repCard, analyses: week as unknown as ClientAnalysis[], questions, citations, site: null }).citation?.blocks ?? [];
const recommendedTitles = blocks.filter((b) => b.heading.startsWith('AI가 인용했지만')).flatMap((b) => b.items.map((i) => i.text));
ok('보고서는 덮는 질문이 있는 채널만 권한다', recommendedTitles.some((t) => t.startsWith('네이버 블로그')));
ok('보고서는 목록에서 뺀 곳을 권하지 않는다', !recommendedTitles.some((t) => /namu\.wiki|clien\.net|tripadvisor/.test(t)));

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
console.log(`\n${checks.length - failed}/${checks.length} 통과`);
if (failed > 0) process.exit(1);
