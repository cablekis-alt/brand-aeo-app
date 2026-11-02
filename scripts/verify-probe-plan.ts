/**
 * 작성자 배정(src/lib/probePlan.ts, probe-plan/2)을 앱이 쓰는 순수 로직을 확인한다 — 잠금(topicGuard) · 운영 기간 · 추가 글 상한과 질문
 * 겹침 규칙 · 카드 머리 글자 · 「글 더 만들기」 화면. 서버 · AI는 부르지 않는다. 브랜드 · 질문 · 작성자는 모두 가짜다. 배정 파일을 만드는
 * 쪽(scripts/writer-plan.ts)과 파일 읽기 거절 갈래는 scripts/verify-writer-plan.ts가, 서버 저장소 · 라우트 검사는
 * scripts/verify-extra-articles-store.ts가 본다.
 *
 * 왜: 잠금 하나로 서버(추가 글 만들기 · 되살리기, 브리프 · 초안)와 화면이 함께 닫는다 — 갈래 하나가 틀리면 막아야 할 글이 열리거나, 배정
 * 파일이 없는 브랜드의 글까지 막힌다. 배정 파일이 없으면(plan null) 모든 함수가 「허용 · 상한 10편 · 겹침 409」여야 지금과 같다. 배정 글은
 * 화면이 정의(이름 · 각도 · 질문 · 문장)를 그대로 「글 더 만들기」로 보내므로 추가 글 검사(checkNewExtraArticle)를 그대로 통과해야 하고,
 * 한 질문을 여러 글이 맡는 배정이라 운영 기간에는 겹침을 받아야 한다.
 *
 * 화면은 jsdom으로 두 가지만 본다: 일괄 실행 잠금 · 브리프 · 초안이 브랜드를 넘지 않는지(src/lib/bulkRun.ts), 「글 더 만들기」에 배정이
 * 늦게 와도 그 전에 고른 체크의 경고가 남지 않고 배정 글의 각도까지 보내는지 · 작성자 거르기가 배정표 글을 줄이는지 · 한 질문을 여러
 * 배정 글이 맡으면 「맡음」에 그 글을 모두 다는지. 콘텐츠 생성 화면의 자리 · 문구는 화면이 쓰는 순수 함수로 본다(src/lib/gapActions.ts) —
 * 작성자를 골라 본 글 카드가 걸러져도 「글 더 만들기」가 남는지, 운영 기간의 실증 칸이 처치 · 대조를 말하지 않는지.
 *
 *   npx tsx scripts/verify-probe-plan.ts
 */
import { JSDOM } from 'jsdom';
import * as React from 'react';
import ExtraArticleForm from '../src/components/ExtraArticleForm';
import type { NewExtraArticleInput } from '../src/lib/api';
import { bulkRunsAfter, passForTenant, type BulkRuns } from '../src/lib/bulkRun';
import { checkNewExtraArticle, checkExtraArticlePatch, DEFAULT_EXTRA_RULES, EXTRA_LIMITS, extraBriefAngle, topicArticleId, type ExtraArticle } from '../src/lib/extraArticles';
import { extraFormSlot, probeSectionHint, probeTakenNote, type GapAction } from '../src/lib/gapActions';
import {
  allowedTopicIds,
  extraArticleCap,
  isActive,
  parseWriterPlan,
  planWriters,
  PROBE_NAME_BANNED,
  topicGuard,
  writerArticle,
  writerChip,
  writerExtraRules,
  WRITER_PLAN_FORMAT,
  type WriterPlan,
} from '../src/lib/probePlan';
import type { WinLossRow } from '../src/lib/questionWinLoss';

const checks: [string, boolean, string | undefined][] = [];
/** detail은 실패했을 때만 찍는다. */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);

// ── 가짜 브랜드 「가상펜션」(질문지 v9) · 작성자 2명 × 2편 ─────────────────────
const TEXT: Record<string, string> = {
  'c1-001': '가상시 원도심 걸어 다니기 좋은 숙소 어디야?',
  'c1-002': '가상시 기차역에서 가까운 조용한 숙소 추천해줘',
  'c1-003': '가상시 숙소 주차 편한 곳 후기 어디서 봐?',
  'c1-004': '가상시 독채 숙소 특징이 어때?',
  'c1-005': '가상시 바다 전망 숙소 추천해줘',
};
const WRITER_A = { key: 'w1', name: '가상 작성자 하나' };
const WRITER_B = { key: 'w2', name: '가상 작성자 둘' };
const art = (ids: string[], name: string, angle: string, writer: { key: string; name: string }, blog: string) => ({
  id: topicArticleId(ids),
  name,
  angle,
  writer,
  blog,
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => TEXT[id]),
});
// 한 질문을 여러 글이 맡는다(c1-001 · c1-002) — 같은 질문 조합은 없고, 한 작성자가 같은 질문을 두 번 맡지 않는다.
const A1 = art(['c1-001', 'c1-002'], '원도심 걸어서 다니는 숙소', '부모님과 천천히 걷는 하루', WRITER_A, 'https://a.example.com');
const A2 = art(['c1-003', 'c1-004'], '주차 편한 독채 숙소', '차로 오는 가족 여행', WRITER_A, 'https://a.example.com');
const B1 = art(['c1-003', 'c1-002'], '역 가까운 주차 편한 숙소', '혼자 기차로 떠나는 주말', WRITER_B, '');
const B2 = art(['c1-001', 'c1-004'], '원도심 독채 숙소 고르기', '혼자 쉬다 오는 조용한 방', WRITER_B, '');

/** 매번 새 객체. */
function rawPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      format: WRITER_PLAN_FORMAT,
      tenantId: 'demo-writer',
      bankVersion: 'v9',
      activeUntil: '2027-03-31',
      source: { writers: 'docs/writers.json', seed: 20261102 },
      articles: [A1, A2, B1, B2],
      ...over,
    }),
  ) as Record<string, unknown>;
}

const parsed = parseWriterPlan(rawPlan());
const plan = parsed.plan as WriterPlan;
const ids = plan?.articles.map((a) => a.id) ?? [];

// ── 읽기 ────────────────────────────────────────────────────────────────────
{
  ok('읽기 — 가짜 배정 파일은 통과', Boolean(parsed.plan) && parsed.error === undefined, parsed.error);
  ok('읽기 — 글 4편 · 서로 다른 글 id · 질문이 겹치는 글이 있음', ids.length === 4 && new Set(ids).size === 4 && plan.articles.filter((a) => a.questionIds.includes('c1-001')).length >= 2);
  ok('읽기 — 작성자 2명(처음 나온 순서) · 블로그', JSON.stringify(planWriters(plan)) === JSON.stringify([{ ...WRITER_A, blog: 'https://a.example.com' }, { ...WRITER_B, blog: '' }]));
  // 실증 때의 배정 파일(probe-plan/1)은 더 읽지 않는다 — 서버는 깨진 배정으로 보고 'topic:' 글 만들기를 막는다(fail closed).
  const old = parseWriterPlan({ format: 'probe-plan/1', tenantId: 'demo-writer', bankVersion: 'v9', activeUntil: '2026-12-28', rounds: [], questions: {} });
  ok('읽기 — 실증 형식(probe-plan/1)은 거절', old.plan === undefined && Boolean(old.error?.includes('probe-plan/2')));
}

// ── 배정 글은 추가 글 검사를 각도까지 그대로 통과 ───────────────────────────
{
  for (const a of plan.articles) {
    const res = checkNewExtraArticle({ id: a.id, name: a.name, angle: a.angle, bankVersion: plan.bankVersion, questionIds: a.questionIds, questionTexts: a.questionTexts }, [], '2026-11-03T00:00:00.000Z');
    ok(`배정 글 ${a.name} — 그대로 보내면 추가 글 검사 통과 · 같은 id · 이름 · 각도`, res.ok && res.article.id === a.id && res.article.name === a.name && res.article.angle === a.angle);
    ok(`배정 글 ${a.name} — 브리프 각도(이름 — 각도)에 실험 용어 없음`, PROBE_NAME_BANNED.every((w) => !extraBriefAngle(a.name, a.angle).includes(w)));
  }
}

// ── 운영 기간 · 허용 글 ─────────────────────────────────────────────────────
{
  ok('기간 — 마지막 날(03-31)까지 켜짐', isActive(plan, '2026-11-03') && isActive(plan, '2027-03-31'));
  ok('기간 — 다음 날(04-01)부터 꺼짐', !isActive(plan, '2027-04-01'));
  ok('기간 — plan 없으면 꺼짐', !isActive(null, '2026-11-03'));
  ok('허용 글 — 배정 글 4편', JSON.stringify(allowedTopicIds(plan)) === JSON.stringify(ids));
  ok('허용 글 — plan 없으면 null(제한 없음)', allowedTopicIds(null) === null);
}

// ── topicGuard 갈래마다 ─────────────────────────────────────────────────────
{
  const TODAY = '2026-11-10';
  const OUTSIDE = 'topic:c1-005';
  ok('지킴 — plan 없음: 배정 밖 글도 허용(지금과 같다)', topicGuard(null, false, 'v9', OUTSIDE, TODAY) === null && topicGuard(null, false, null, OUTSIDE, TODAY) === null);
  const corrupt = topicGuard(null, true, 'v9', ids[0], TODAY);
  ok('지킴 — 배정 파일이 깨짐: 배정 글도 거절(fail closed)', Boolean(corrupt?.includes('깨져')));
  ok('지킴 — 깨졌어도 기간 뒤 · 다른 판이어도 거절', topicGuard(null, true, 'v8', OUTSIDE, '2027-05-01') !== null);
  ok('지킴 — 깨졌어도 본 글 · 등재형(topic:이 아님)은 규칙 밖', topicGuard(null, true, 'v9', 'content:category-agnostic', TODAY) === null && topicGuard(null, true, 'v9', 'listing:naver-place', TODAY) === null);
  ok('지킴 — 기간 뒤(04-01): 배정 밖 · 다른 판도 허용', topicGuard(plan, false, 'v9', OUTSIDE, '2027-04-01') === null && topicGuard(plan, false, 'v8', OUTSIDE, '2027-04-01') === null);
  ok('지킴 — 마지막 날(03-31)은 아직 거절', topicGuard(plan, false, 'v9', OUTSIDE, '2027-03-31') !== null);
  ok('지킴 — topic:이 아닌 글은 기간 중에도 허용', topicGuard(plan, false, 'v9', 'content:category-agnostic', TODAY) === null && topicGuard(plan, false, 'v8', 'content:category-agnostic', TODAY) === null);
  const otherBank = topicGuard(plan, false, 'v8', ids[0], TODAY);
  ok('지킴 — 판이 다르면 배정 글도 거절하고 두 판을 알림', Boolean(otherBank?.includes('v8') && otherBank.includes('v9')));
  ok('지킴 — 판을 모르는 주(null · 빈 글자 · undefined)도 거절', topicGuard(plan, false, null, ids[0], TODAY) !== null && topicGuard(plan, false, '', ids[0], TODAY) !== null && topicGuard(plan, false, undefined, ids[0], TODAY) !== null);
  ok('지킴 — 배정 글 4편은 허용', ids.every((id) => topicGuard(plan, false, 'v9', id, TODAY) === null));
  const notAllowed = topicGuard(plan, false, 'v9', OUTSIDE, TODAY);
  ok('지킴 — 배정 밖 질문 글은 거절 · 기간 안내', Boolean(notAllowed?.includes('배정표 글만') && notAllowed.includes('2027-03-31')));
  ok('지킴 — 배정 글의 일부만 고른 글도 거절', topicGuard(plan, false, 'v9', 'topic:c1-001', TODAY) !== null);
  ok('지킴 — 배정 글 둘을 합친 글도 거절', topicGuard(plan, false, 'v9', topicArticleId([...A1.questionIds, ...A2.questionIds]), TODAY) !== null);
  ok('지킴 — 거절 문구에 실험 말(실증 · 차수)이 없음', [notAllowed, otherBank, corrupt].every((m) => !m?.includes('실증') && !m?.includes('차수')));
}

// ── 추가 글 상한 · 질문 겹침 규칙(extraArticleCap · writerExtraRules) ─────────
{
  const TODAY = '2026-11-10';
  ok('상한 — plan 없으면 10편(지금과 같다)', extraArticleCap(null, TODAY) === EXTRA_LIMITS.articles && EXTRA_LIMITS.articles === 10);
  ok('상한 — 배정 글이 10편보다 적으면 10편', extraArticleCap(plan, TODAY) === 10);
  const many = { ...plan, articles: Array.from({ length: 80 }, (_, i) => ({ ...plan.articles[0], id: `topic:x-${String(i).padStart(3, '0')}` })) } as WriterPlan;
  ok('상한 — 배정 글 80편이면 80편', extraArticleCap(many, TODAY) === 80);
  ok('상한 — 기간이 지나면 10편', extraArticleCap(many, '2027-04-01') === 10);
  ok('규칙 — plan 없음 · 깨짐 · 기간 뒤에는 undefined(기본 규칙)', writerExtraRules(null, false, TODAY) === undefined && writerExtraRules(null, true, TODAY) === undefined && writerExtraRules(many, true, TODAY) === undefined && writerExtraRules(many, false, '2027-04-01') === undefined);
  ok('규칙 — 운영 기간이면 상한 = 배정 글 수 · 겹침 허용', JSON.stringify(writerExtraRules(many, false, TODAY)) === JSON.stringify({ cap: 80, sharedQuestions: true }));
  ok('규칙 — 기본 규칙은 10편 · 겹침 409', DEFAULT_EXTRA_RULES.cap === 10 && !DEFAULT_EXTRA_RULES.sharedQuestions);

  // checkNewExtraArticle · checkExtraArticlePatch에 규칙을 넘기면 — 기본(rules 없음)은 지금과 같다.
  const NOW = '2026-11-10T00:00:00.000Z';
  const inputOf = (a: (typeof plan.articles)[number]) => ({ id: a.id, name: a.name, angle: a.angle, bankVersion: 'v9', questionIds: a.questionIds, questionTexts: a.questionTexts });
  const first = checkNewExtraArticle(inputOf(plan.articles[0]), [], NOW);
  const all: ExtraArticle[] = first.ok ? first.articles : [];
  const shared = plan.articles.find((a) => a.id !== plan.articles[0].id && a.questionIds.some((q) => plan.articles[0].questionIds.includes(q)))!;
  const plain = checkNewExtraArticle(inputOf(shared), all, NOW);
  ok('겹침 — 기본 규칙이면 같은 질문을 맡은 글은 409(지금과 같다)', !plain.ok && plain.status === 409 && plain.error.includes('맡고 있어요'));
  const relaxed = checkNewExtraArticle(inputOf(shared), all, NOW, { cap: 80, sharedQuestions: true });
  ok('겹침 — 운영 규칙이면 같은 질문을 맡은 글도 만든다', relaxed.ok && relaxed.articles.length === 2);
  const tenAlive: ExtraArticle[] = Array.from({ length: 10 }, (_, i) => ({ id: `topic:k-${i}`, name: `가상 ${i}`, bankVersion: 'v9', questionIds: [`k-${i}`], questionTexts: [`가상 상한 ${i}`], createdAt: NOW, updatedAt: NOW }));
  const capped = checkNewExtraArticle(inputOf(plan.articles[0]), tenAlive, NOW);
  ok('상한 — 기본 규칙이면 살아 있는 10편에서 409 · 「10편까지」', !capped.ok && capped.status === 409 && capped.error.includes('10편까지'));
  ok('상한 — 운영 규칙(80)이면 11번째도 만든다', checkNewExtraArticle(inputOf(plan.articles[0]), tenAlive, NOW, { cap: 80, sharedQuestions: true }).ok);
  const elevenAlive = [...tenAlive, { ...tenAlive[0], id: 'topic:k-10', questionIds: ['k-10'], questionTexts: ['가상 상한 10'] }];
  const cap11 = checkNewExtraArticle(inputOf(plan.articles[0]), elevenAlive, NOW, { cap: 11, sharedQuestions: true });
  ok('상한 — 운영 규칙의 상한에 닿으면 409 · 그 편수를 알림', !cap11.ok && cap11.status === 409 && cap11.error.includes('11편까지'));
  const removedOne = [...tenAlive.slice(1), { ...tenAlive[0], removedAt: NOW }];
  const withRemoved = [...removedOne, { ...tenAlive[0], id: 'topic:k-10', questionIds: ['k-10'], questionTexts: ['가상 상한 10'] }];
  ok('되살리기 — 기본 규칙이면 살아 있는 10편에서 409', (() => {
    const r = checkExtraArticlePatch({ id: 'topic:k-0', removed: false }, withRemoved, NOW);
    return !r.ok && r.status === 409;
  })());
  ok('되살리기 — 운영 규칙이면 11번째로 되살린다', (() => {
    const r = checkExtraArticlePatch({ id: 'topic:k-0', removed: false }, withRemoved, NOW, { cap: 80, sharedQuestions: true });
    return r.ok && r.revived;
  })());
}

// ── 카드 머리 · 배정 글 ─────────────────────────────────────────────────────
{
  ok('카드 머리 — 블로그가 있으면 「이름 · 블로그」', writerChip(plan, A1.id) === `${WRITER_A.name} · https://a.example.com`);
  ok('카드 머리 — 블로그를 모르면 이름만', writerChip(plan, B2.id) === WRITER_B.name);
  ok('카드 머리 — 배정 밖 글 · 본 글 · plan 없음은 없음', writerChip(plan, 'topic:c1-005') === null && writerChip(plan, 'content:category-agnostic') === null && writerChip(null, A1.id) === null);
  const got = writerArticle(plan, A2.id);
  ok('배정 글 — 이름 · 각도 · 작성자 · 질문 · 문장', got?.name === A2.name && got.angle === A2.angle && got.writer.key === 'w1' && got.questionIds.join() === A2.questionIds.join() && got.questionTexts.join() === A2.questionTexts.join());
  got?.questionIds.push('c1-999');
  if (got) got.writer.name = '바뀐 이름';
  ok('배정 글 — 돌려준 값을 고쳐도 plan은 그대로', plan.articles[1].questionIds.length === 2 && plan.articles[1].writer.name === WRITER_A.name);
  ok('배정 글 — 배정 밖 · plan 없음은 null', writerArticle(plan, 'topic:c1-005') === null && writerArticle(null, A1.id) === null);
}

// ── 화면 — 일괄 실행은 브랜드마다(src/lib/bulkRun.ts) ───────────────────────
// 콘텐츠 생성 화면은 브랜드를 바꿔도 그대로다. 앞 브랜드에서 누른 작성자 실행(몇 분)이 지금 브랜드를 잠그거나, 그 실행의 브리프 · 초안이
// 지금 브랜드 목록에 섞이면 안 된다.
{
  let runs: BulkRuns = {};
  runs = bulkRunsAfter(runs, 'demo-a', 'writer', true);
  ok('일괄 실행 — 시작한 브랜드만 돌고 있음(바꾼 브랜드는 잠기지 않음)', runs['demo-a'] === 'writer' && runs['demo-b'] === undefined, JSON.stringify(runs));
  runs = bulkRunsAfter(runs, 'demo-b', 'all', true);
  runs = bulkRunsAfter(runs, 'demo-a', 'writer', false);
  ok('일괄 실행 — 앞 브랜드 실행이 끝나도 지금 브랜드의 실행은 그대로', runs['demo-b'] === 'all' && !('demo-a' in runs), JSON.stringify(runs));
  runs = bulkRunsAfter(runs, 'demo-b', 'all', false);
  ok('일괄 실행 — 모두 끝나면 빈 표', Object.keys(runs).length === 0, JSON.stringify(runs));
  const idle: BulkRuns = {};
  ok('일괄 실행 — 돌지 않는 브랜드를 끝내도 같은 표', bulkRunsAfter(idle, 'demo-a', 'all', false) === idle);

  // 화면과 같이 — 실행은 누른 때의 브랜드를 쥐고, 넘길 때 지금 화면의 브랜드와 견준다.
  let current = 'demo-a';
  const got: string[] = [];
  const started = current;
  const onBrief = (s: string) => passForTenant(current, started, s, (v) => got.push(v));
  onBrief('a-1');
  current = 'demo-b';
  onBrief('a-2');
  current = 'demo-a';
  onBrief('a-3');
  ok('브리프 · 초안 — 브랜드를 바꾼 동안 앞 브랜드 실행이 넘긴 것은 버리고, 돌아오면 다시 받음', got.join() === 'a-1,a-3', got.join());
}

// ── 화면 — 「글 더 만들기」 ─────────────────────────────────────────────────
{
  // 화면 파일은 jsx 자동 변환을 전제로 하는데 tsx는 고전 변환으로 읽는다 — React를 전역에 둔다(verify-execution-marks.ts와 같다).
  // react-dom/client는 읽을 때 DOM이 있는지 보므로 jsdom 전역을 먼저 둔다.
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import('react-dom/client');
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const mainAction = { id: 'demo-main', kind: 'content', title: '본 글', questionIds: ['c1-001', 'c1-002'], questionTexts: [TEXT['c1-001'], TEXT['c1-002']] } as unknown as GapAction;
  const probeRows = [{ questionId: 'v9-p001', text: '가상시 벚꽃 철에 묵기 좋은 숙소 추천해줘', verdict: 'loss' }] as unknown as WinLossRow[];
  const sent: Omit<NewExtraArticleInput, 'bankVersion' | 'createdWeek'>[] = [];
  const made = { id: A2.id, title: `${A2.name} 콘텐츠 보강`, questionIds: A2.questionIds, questionTexts: A2.questionTexts, extra: { name: A2.name } } as unknown as GapAction;
  const render = (probePlan: WriterPlan | null, writerKey: string | null = null, bankVersion = 'v9', extraActions = probePlan ? [made] : []) =>
    React.act(async () => {
      root.render(
        React.createElement(ExtraArticleForm, {
          main: mainAction,
          probes: probeRows,
          extraActions,
          bankVersion,
          corrupt: false,
          loadError: null,
          onCreate: async (input) => {
            sent.push(input);
            return null;
          },
          probePlan,
          writerKey,
        }),
      );
    });
  const warnings = () => [...host.querySelectorAll('.hint.warn')].map((e) => e.textContent ?? '').join(' | ');
  const LEAVES_NONE = '본 글에 질문을 하나 이상 남겨 두세요';
  const MIXED = '실증과 일반 질문을 섞으면';
  const radios = () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const button = () => host.querySelector<HTMLButtonElement>('.brief-bar button.primary')!;

  await render(null);
  const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  for (const box of boxes) await React.act(async () => box.click());
  // 대조 — 배정이 없으면 고른 체크가 경고를 낸다(검사가 헛돌지 않게). 배정이 없으면 지금 화면 그대로다.
  ok('글 더 만들기 대조 — 배정 없이 본 글 질문 전부 + 실증을 고르면 두 경고 · 라디오 없음', boxes.length === 3 && warnings().includes(LEAVES_NONE) && warnings().includes(MIXED) && radios().length === 0, `${boxes.length} ${warnings()}`);

  await render(plan);
  ok(
    '글 더 만들기 — 배정이 늦게 와 「배정표 글」로 바뀌면 체크 · 경고가 사라지고 배정표 글만 고름(만든 글은 막힘)',
    host.querySelectorAll('input[type="checkbox"]').length === 0 &&
      radios().length === 4 &&
      radios().filter((r) => r.disabled).length === 1 &&
      !warnings().includes(LEAVES_NONE) &&
      !warnings().includes(MIXED) &&
      button().textContent === '배정표 글 만들기',
    `${warnings()} / ${button().textContent}`,
  );
  ok('글 더 만들기 — 배정표 글 줄에 작성자 이름 · 각도', host.textContent?.includes(WRITER_B.name) === true && host.textContent.includes(B2.angle));
  const pick = radios().find((r) => !r.disabled && r.closest('li')?.textContent?.includes(B2.name));
  if (pick) await React.act(async () => pick.click());
  await React.act(async () => button().click());
  const last = sent.at(-1);
  ok('글 더 만들기 — 고른 배정 글의 이름 · 각도 · 질문 · 문장을 그대로 보냄', last?.name === B2.name && last.angle === B2.angle && last.questionIds.join() === B2.questionIds.join() && last.questionTexts.join() === B2.questionTexts.join(), JSON.stringify(last));

  await render(plan, 'w2');
  ok('글 더 만들기 — 작성자를 고르면 그 작성자의 배정표 글만', radios().length === 2 && host.textContent?.includes(A1.name) === false, `${radios().length}`);
  await render(plan, null, 'v8');
  ok('글 더 만들기 — 판이 다르면 서버와 같은 말로 막음', warnings().includes('v8') && warnings().includes('v9') && button().disabled);

  // 운영 기간에는 배정 글 여러 편이 한 질문을 맡는다 — 「맡음」에 맡은 글을 모두 달고, 본 글에서 빠진 같은 질문은 한 줄로 둔다.
  const madeOf = (a: typeof A1) =>
    ({ id: a.id, title: `${a.name} 콘텐츠 보강`, questionIds: a.questionIds, questionTexts: a.questionTexts, extra: { name: a.name } }) as unknown as GapAction;
  await render(plan, null, 'v9', [madeOf(A1), madeOf(A2), madeOf(B2)]);
  const mainRows = [...host.querySelectorAll('ul[aria-label="본 글의 이번 주 질문"] > li')].map((li) => li.textContent ?? '');
  const rowsOf = (id: string) => mainRows.filter((t) => t.startsWith(TEXT[id]));
  ok(
    '맡음 — 한 질문을 여러 글이 맡으면 모두(c1-001 = 하나 · 둘)',
    rowsOf('c1-001').length === 1 && rowsOf('c1-001')[0].includes(`「${A1.name}」 · 「${B2.name}」 글이 맡음`),
    mainRows.join(' | '),
  );
  ok('맡음 — 한 편만 맡으면 그 글 하나(지금과 같음)', rowsOf('c1-002').length === 1 && rowsOf('c1-002')[0].endsWith(` · 「${A1.name}」 글이 맡음`), mainRows.join(' | '));
  ok(
    '맡음 — 본 글에서 빠진 같은 질문은 한 줄에 맡은 글 모두(c1-004)',
    rowsOf('c1-004').length === 1 && rowsOf('c1-004')[0].includes(`「${A2.name}」 · 「${B2.name}」 글이 맡음`),
    mainRows.join(' | '),
  );
  await React.act(async () => root.unmount());
}

// ── 화면 — 콘텐츠 생성의 「글 더 만들기」 자리 · 실증 칸 문구(src/lib/gapActions.ts) ──────────────
{
  ok('자리 — 본 글 카드가 보이면 그 아래', extraFormSlot({ hasMain: true, mainShown: true, probes: 1 }) === 'under-main');
  ok('자리 — 작성자를 골라 본 글 카드가 걸러져도 글 카드 뒤에 남음', extraFormSlot({ hasMain: true, mainShown: false, probes: 0 }) === 'after-cards');
  ok('자리 — 본 글이 없는 주는 고를 실증이 있을 때만 실증 칸', extraFormSlot({ hasMain: false, mainShown: false, probes: 2 }) === 'probes' && extraFormSlot({ hasMain: false, mainShown: false, probes: 0 }) === null);

  // 배정이 없으면 지금 문구 그대로 — 처치 · 대조를 말한다.
  ok('실증 칸 — 배정 없음: 맡은 글 있으면 처치 · 없으면 대조(지금과 같음)', probeTakenNote(['가상 글'], false) === ' · 「가상 글」 글이 맡음(처치)' && probeTakenNote([], false) === ' · 맡은 글 없음(대조)');
  ok(
    '실증 칸 — 배정 없음: 안내 문구 그대로',
    probeSectionHint(null) ===
      '우리 글이 AI 답에 인용되는지 실험하려고 덧붙인 질문입니다. 언급률 · 추천 순위 · 비교 그룹에 들지 않고 본 글에도 넣지 않습니다. 「글 더 만들기」에서 골라 추가 글이 맡으면 처치, 맡은 글이 없으면 대조입니다. 효과는 두 번 이상의 측정에서 같은 방향일 때만 읽으세요.',
  );
  // 운영 기간 — 질문을 골라 만들 수 없으니 처치 · 대조 · 「골라」를 말하지 않는다.
  const opsHint = probeSectionHint(plan.activeUntil);
  ok(
    '실증 칸 — 운영 기간: 처치 · 대조 없이 맡은 글만(여러 편이면 모두)',
    probeTakenNote(['가상 글', '가상 둘'], true) === ' · 「가상 글」 · 「가상 둘」 글이 맡음' && probeTakenNote([], true) === '',
  );
  ok(
    '실증 칸 — 운영 기간: 안내가 배정표 글만 만든다고 말하고 처치 · 대조 · 「골라」 없음',
    opsHint.includes(`~${plan.activeUntil}`) && opsHint.includes('배정표 글만') && !/처치|대조|에서 골라/.test(opsHint),
    opsHint,
  );
}

let failed = 0;
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass && detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`);
  if (!pass) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
