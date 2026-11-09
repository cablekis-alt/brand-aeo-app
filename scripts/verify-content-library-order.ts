/**
 * 콘텐츠 보관함의 글 순서(src/lib/contentLibraryOrder.ts)를 확인한다 — 작성자 배정이 있는 브랜드는 작성자별로 묶고(배정표 순서), 배정 밖
 * 글은 마지막에 최근 순, 배정이 없거나 읽지 못하면 지금처럼 한 목록(최근 순). 서버 · 화면 · AI는 부르지 않는다. 브랜드 · 질문 · 작성자는
 * 모두 가짜다.
 *
 * 왜: 배정 글 80편이 한 목록에 최근 고친 순으로 섞여 있어 누구 글인지 · 몇 편이 남았는지 보기 어려웠다. 어느 글이 누구 몫인지는 콘텐츠
 * 생성(src/pages/GapActions.tsx writerArticleOf)과 같은 규칙이어야 한다 — 글 id가 배정에 있어도 그 추가 글을 배정 판이 아닌 판으로
 * 만들었으면 다른 질문이라 배정 밖 글이다. 추가 글 정의가 없는 배정 글 id(질문 은행 화면에서 만든 글)는 그 작성자 칸에 「판 미확인」으로
 * 둔다(사용자 결정, 2026-11-09 — 발행 현황 · 콘텐츠 생성 작성자 줄 · 작성자 묶음과 같이 그 작성자 글로 본다). 추가 글 목록이나 배정을
 * 읽지 못하면 짐작하지 않고 지금 순서로 모든 글을 보인다.
 *
 *   npx tsx scripts/verify-content-library-order.ts
 */
import {
  assignedArticle,
  assignedTopicSnapshot,
  BANK_UNKNOWN_NOTE,
  libraryCount,
  libraryLayout,
  libraryPickOptions,
  libraryRecordTopic,
  livePostsOf,
  LIBRARY_FALLBACK_NOTE,
  orphansShown,
  OUTSIDE_PICK,
  recentFirst,
  recordBlockedReason,
  sectionDetail,
  sectionTitle,
  shownSections,
  validLibraryPick,
  type LibraryLayout,
  type LibrarySection,
} from '../src/lib/contentLibraryOrder';
import { topicArticleId } from '../src/lib/extraArticles';
import { WRITER_PLAN_FORMAT, type PlanWriter, type WriterPlan, type WriterPlanArticle } from '../src/lib/probePlan';
import { buildTenantStatus, type LedgerPostLike } from '../src/lib/publishStatus';
import type { QuestionBank, QuestionSpec } from '../src/lib/types';

const checks: [string, boolean, string | undefined][] = [];
/** detail은 실패했을 때만 찍는다. */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── 가짜 브랜드 「가상펜션」(질문지 v9) · 작성자 3명 ─────────────────────────
const W1: PlanWriter = { key: 'w1', name: '가상 작성자 하나' };
const W2: PlanWriter = { key: 'w2', name: '가상 작성자 둘' };
const W3: PlanWriter = { key: 'w3', name: '가상 작성자 셋' };

const art = (ids: string[], name: string, writer: PlanWriter): WriterPlanArticle => ({
  id: topicArticleId(ids),
  name,
  angle: `${name}의 각도`,
  writer,
  blog: '',
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => `가상 질문 ${id}`),
});
// 배정표 순서 — w1 셋, w2 둘, w3 둘(w3는 아직 한 편도 만들지 않았다).
const A1 = art(['q-001', 'q-002'], '가상 글 일', W1);
const A2 = art(['q-003', 'q-004'], '가상 글 이', W1);
const A3 = art(['q-005', 'q-006'], '가상 글 삼', W1);
const B1 = art(['q-001', 'q-003'], '가상 글 사', W2);
const B2 = art(['q-002', 'q-005'], '가상 글 오', W2);
const C1 = art(['q-004', 'q-006'], '가상 글 육', W3);
const C2 = art(['q-001', 'q-006'], '가상 글 칠', W3);

const plan: WriterPlan = {
  format: WRITER_PLAN_FORMAT,
  tenantId: 'demo-library',
  bankVersion: 'v9',
  activeUntil: '2027-03-31',
  source: { writers: 'docs/writers.json', seed: 1 },
  articles: [A1, A2, A3, B1, B2, C1, C2],
};

interface Draft {
  actionId: string;
  generatedAt: string;
  editedAt?: string;
}
const draft = (actionId: string, generatedAt: string, editedAt?: string): Draft => ({ actionId, generatedAt, ...(editedAt ? { editedAt } : {}) });

// 만든 순서는 배정표와 다르다 — 최근 순이면 A3 · B1 · A1 …로 섞인다.
const dA1 = draft(A1.id, '2026-11-03T01:00:00.000Z', '2026-11-08T09:00:00.000Z');
const dA2 = draft(A2.id, '2026-11-03T03:00:00.000Z');
const dA3 = draft(A3.id, '2026-11-04T00:00:00.000Z', '2026-11-09T00:00:00.000Z');
const dB1 = draft(B1.id, '2026-11-05T00:00:00.000Z');
const dB2 = draft(B2.id, '2026-11-02T00:00:00.000Z');
// 배정 밖 — 본 글, 배정에 없는 질문 글, 배정 글 id지만 다른 판(v8)으로 만든 추가 글. 배정 글 id지만 추가 글 정의가 없는 글(질문 은행
// 화면)은 그 작성자(w3) 칸에 「판 미확인」으로 둔다.
const dMain = draft('content:category-agnostic', '2026-10-20T00:00:00.000Z', '2026-11-06T00:00:00.000Z');
const dTopic = draft('topic:q-007+q-008', '2026-10-25T00:00:00.000Z');
const dOldBank = draft(C1.id, '2026-10-28T00:00:00.000Z');
const dNoDef = draft(C2.id, '2026-11-07T00:00:00.000Z');

const drafts: Draft[] = [dMain, dB2, dA3, dTopic, dA1, dOldBank, dB1, dNoDef, dA2];

const def = (id: string, bankVersion: string) => ({ id, bankVersion });
const extras = [
  def(A1.id, 'v9'),
  def(A2.id, 'v9'),
  def(A3.id, 'v9'),
  def(B1.id, 'v9'),
  def(B2.id, 'v9'),
  def(C1.id, 'v8'),
  def('topic:q-007+q-008', 'v9'),
];

const ids = (list: readonly Draft[]) => list.map((d) => d.actionId);
const grouped = (layout: LibraryLayout<Draft>) => (layout.grouped ? layout : null);

// ── 최근 순(지금 순서) ──────────────────────────────────────────────────────
{
  const recent = recentFirst(drafts);
  ok(
    '최근 순 — 고친 시각이 있으면 그 시각, 없으면 만든 시각으로 늦은 순',
    same(ids(recent), [A3.id, A1.id, C2.id, 'content:category-agnostic', B1.id, A2.id, B2.id, C1.id, 'topic:q-007+q-008']),
    ids(recent).join('\n'),
  );
  ok('최근 순 — 받은 배열을 바꾸지 않는다', drafts[0] === dMain && drafts.length === 9);
}

// ── 작성자별로 묶기 ─────────────────────────────────────────────────────────
// 원장 줄 — 주소 키 · 올린 날 · 기록 시각 · 뺀 까닭 · 그 글을 쓴 질문지 판(topic: 글만). 주소는 모두 가짜(example.test).
let seq = 0;
const post = (
  articleId: string,
  o: { key: string; on?: string | null; at?: string; removedAt?: string; reason?: 'mistake' | 'taken-down'; version?: string | null },
): LedgerPostLike => ({
  id: `p-${++seq}`,
  url: `https://blog.example.test/${o.key}`,
  key: `blog.example.test/${o.key}`,
  publishedOn: o.on === undefined ? '2026-11-06' : o.on,
  recordedAt: o.at ?? '2026-11-06T01:00:00.000Z',
  articleId,
  ...(o.removedAt ? { removedAt: o.removedAt, removedReason: o.reason ?? 'taken-down' } : {}),
  ...(o.version !== undefined ? { topic: { bankVersion: o.version } } : {}),
});
const posts = [
  post(A2.id, { key: 'a2', version: 'v9' }),
  post(A2.id, { key: 'a2-wrong', removedAt: '2026-11-08T00:00:00.000Z', reason: 'mistake', version: 'v9' }),
  post(A3.id, { key: 'a3', removedAt: '2026-11-08T00:00:00.000Z', version: 'v9' }),
  post(B1.id, { key: 'b1', version: 'v9' }),
  post('content:category-agnostic', { key: 'main' }),
];
const live = livePostsOf(plan, posts);
const layout = libraryLayout({ drafts, plan, planUnreadable: false, extras, posts });
const g = grouped(layout);
{
  ok('묶기 — 배정과 추가 글 목록을 읽었으면 묶는다', g !== null);
  ok('묶기 — 작성자 순서(w1 → w2 → w3), 배정 밖 글은 마지막', same(g?.sections.map((s) => s.pick), ['w1', 'w2', 'w3', OUTSIDE_PICK]));
  ok('묶기 — 작성자 칸 안은 배정표 순서(최근 순이 아님)', same(ids(g?.sections[0].drafts ?? []), [A1.id, A2.id, A3.id]) && same(ids(g?.sections[1].drafts ?? []), [B1.id, B2.id]));
  // 사용자 결정(2026-11-09)으로 바뀐 기대 — 예전에는 정의 없는 글(C2)도 이 칸에 있었다. 이제는 w3 칸의 「판 미확인」 글이다.
  ok(
    '묶기 — 배정 밖 글은 최근 순(본 글 · 배정에 없는 질문 · 다른 판 — 정의 없는 배정 글은 없음)',
    same(ids(g?.sections[3].drafts ?? []), ['content:category-agnostic', C1.id, 'topic:q-007+q-008']),
    ids(g?.sections[3].drafts ?? []).join('\n'),
  );
  ok('묶기 — 배정 밖 칸은 작성자가 없다', g?.sections[3].writer === null);
  ok('묶기 — 모든 글이 한 번씩(숨기는 글 없음)', g !== null && g.total === drafts.length && g.sections.reduce((n, s) => n + s.drafts.length, 0) === drafts.length);
  const all = new Set(g?.sections.flatMap((s) => ids(s.drafts)));
  ok('묶기 — 같은 글이 두 칸에 나오지 않는다', all.size === drafts.length);
}

// ── 판이 다른 추가 글 · 정의 없는 글 ─────────────────────────────────────────
{
  const w3 = g?.sections.find((s) => s.pick === 'w3');
  ok('판 — 배정 글 id라도 다른 판(v8)으로 만든 글은 배정 밖', !ids(w3?.drafts ?? []).includes(C1.id) && ids(g?.sections[3].drafts ?? []).includes(C1.id));
  // 사용자 결정(2026-11-09, 「작성자 칸에 두기」)으로 바뀐 기대 — 예전 기대는 「추가 글 정의가 없는 배정 글 id도 배정 밖(판을 모른다)」였다.
  ok(
    '판 미확인 — 추가 글 정의가 없는 배정 글 id(질문 은행 글)는 그 작성자(w3) 칸에, 배정 밖 칸에는 없다',
    same(ids(w3?.drafts ?? []), [C2.id]) && !ids(g?.sections[3].drafts ?? []).includes(C2.id),
    JSON.stringify({ w3: ids(w3?.drafts ?? []), outside: ids(g?.sections[3].drafts ?? []) }),
  );
  ok(
    '판 미확인 — 그 글만 「판 미확인」으로 표시(배정 판으로 만든 글 · 배정 밖 칸은 표시 없음)',
    same(g?.sections.map((s) => s.bankUnknown), [[], [], [C2.id], []]),
    JSON.stringify(g?.sections.map((s) => s.bankUnknown)),
  );
  ok('판 — 같은 판으로 다시 만들면 작성자 칸으로(정의 없는 글과 함께 배정표 순서)', (() => {
    const fixed = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras: [...extras.filter((e) => e.id !== C1.id), def(C1.id, 'v9')], posts }));
    const s = fixed?.sections.find((x) => x.pick === 'w3');
    return same(ids(s?.drafts ?? []), [C1.id, C2.id]) && same(s?.bankUnknown, [C2.id]) && s?.unmade === 0;
  })());
  // 칸 안은 배정표 순서 그대로 — 판 미확인 글을 칸 끝으로 밀지 않는다(w1의 가운데 글 A2의 정의가 없을 때).
  const midUnknown = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras: extras.filter((e) => e.id !== A2.id), posts }));
  ok(
    '판 미확인 — 칸 안은 배정표 순서(A1 · A2 · A3) · A2만 표시',
    same(ids(midUnknown?.sections[0].drafts ?? []), [A1.id, A2.id, A3.id]) && same(midUnknown?.sections[0].bankUnknown, [A2.id]) && midUnknown?.sections[0].unmade === 0,
    JSON.stringify(midUnknown?.sections[0] && { drafts: ids(midUnknown.sections[0].drafts), bankUnknown: midUnknown.sections[0].bankUnknown }),
  );
  ok('판 미확인 — 표시 문구는 질문 은행 글 · 판을 모른다는 뜻을 밝힌다', BANK_UNKNOWN_NOTE.includes('질문 은행') && BANK_UNKNOWN_NOTE.includes('판'), BANK_UNKNOWN_NOTE);
  // 배정 — 정의가 배정 판이면 판을 안다, 정의가 없으면 판 미확인, 다른 판이면 배정 아님. 배정에 없는 글 · 배정 없음도 아님.
  const defs = new Map(extras.map((e) => [e.id, e]));
  const a1 = assignedArticle(plan, defs, A1.id);
  const c2 = assignedArticle(plan, defs, C2.id);
  ok(
    '배정 — 배정 판 정의: 그 배정 글(판 앎) · 정의 없음: 그 배정 글(판 미확인) · 다른 판 · 배정에 없는 글 · 배정 없음: null',
    a1?.article?.id === A1.id &&
      a1.article.writer.key === 'w1' &&
      a1.bankUnknown === false &&
      c2?.article?.id === C2.id &&
      c2.article.writer.key === 'w3' &&
      c2.bankUnknown === true &&
      assignedArticle(plan, defs, C1.id) === null &&
      assignedArticle(plan, defs, 'topic:q-007+q-008') === null &&
      assignedArticle(plan, defs, 'content:category-agnostic') === null &&
      assignedArticle(null, defs, A1.id) === null,
    JSON.stringify({ a1, c2 }),
  );
  // 「목록에서 빼기」 한 추가 글도 정의는 남는다 — 콘텐츠 생성도 뺀 글까지 정의로 본다.
  const removedDef = grouped(
    libraryLayout({ drafts, plan, planUnreadable: false, extras: extras.map((e) => (e.id === A2.id ? { ...e, removedAt: '2026-11-08T00:00:00.000Z' } : e)), posts }),
  );
  ok('판 — 목록에서 뺀 추가 글도 그 작성자 칸에 남는다', ids(removedDef?.sections[0].drafts ?? []).includes(A2.id));
}

// ── 작성자 칸의 수 ──────────────────────────────────────────────────────────
{
  const [s1, s2, s3, out] = g?.sections ?? [];
  ok('수 — w1: 3편 · 올림 1(내린 글만 있는 글은 세지 않음) · 아직 안 만든 글 없음', s1?.drafts.length === 3 && s1.posted === 1 && s1.unmade === 0);
  ok('수 — w2: 2편 · 올림 1', s2?.drafts.length === 2 && s2.posted === 1 && s2.unmade === 0);
  // 사용자 결정(2026-11-09)으로 바뀐 기대 — 예전 기대는 「w3: 0편 · 아직 안 만든 글 2편」 · 「배정 밖: 4편」이었다. 정의 없는 C2가 w3 칸으로
  // 옮겨 와 만든 글로 세고, 다른 판(v8)으로 만든 C1만 아직 안 만든 글이다.
  ok(
    '수 — w3: 1편(판 미확인 글) · 아직 안 만든 글 1편(판 미확인 글은 세지 않음 — 다른 판으로 만든 C1만)',
    s3?.drafts.length === 1 && s3.posted === 0 && s3.unmade === 1,
    JSON.stringify(s3 && { drafts: s3.drafts.length, posted: s3.posted, unmade: s3.unmade }),
  );
  const noC2 = grouped(libraryLayout({ drafts: drafts.filter((d) => d !== dNoDef), plan, planUnreadable: false, extras, posts }));
  const empty3 = noC2?.sections.find((s) => s.pick === 'w3');
  ok('수 — 글이 없는 작성자도 칸이 있다(0편 · 아직 안 만든 글 2편)', empty3?.drafts.length === 0 && empty3.posted === 0 && empty3.unmade === 2 && same(empty3.bankUnknown, []));
  ok('수 — 배정 밖: 3편 · 올림 1 · 아직 안 만든 글은 세지 않음', out?.drafts.length === 3 && out.posted === 1 && out.unmade === 0, JSON.stringify(out && { drafts: out.drafts.length, posted: out.posted }));
  ok('수 — 내린 기록 · 잘못 적은 주소만 있는 글은 올린 글이 아니다', live !== null && !live.any.has(A3.id) && live.any.has(A2.id) && live.planned.has(A2.id) && !live.planned.has(A3.id));
  ok('수 — 원장을 못 읽으면(null) 올린 글 수도 null', livePostsOf(plan, null) === null);
  ok('수 — 판을 모르는 기록이 없으면 올렸는지 미확인 0', s1?.unsure === 0 && s2?.unsure === 0 && out?.unsure === 0);

  ok('머리 — 작성자 칸 이름은 「w1 · 이름」', sectionTitle(s1) === 'w1 · 가상 작성자 하나');
  ok('머리 — 배정 밖 칸 이름', sectionTitle(out) === '배정 밖 글');
  ok('머리 — 편수 · 올림', sectionDetail(s1) === '3편 · 올림 1', sectionDetail(s1));
  ok('머리 — 아직 안 만든 글이 있으면 덧붙인다(판 미확인 글은 만든 글)', sectionDetail(s3) === '1편 · 올림 0 · 아직 안 만든 글 1편', sectionDetail(s3));
  ok('머리 — 글이 없는 작성자', empty3 !== undefined && sectionDetail(empty3) === '0편 · 올림 0 · 아직 안 만든 글 2편', empty3 && sectionDetail(empty3));
  const noLedger = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras, posts: null }));
  ok('머리 — 원장을 못 읽으면 올림을 말하지 않는다(0으로 채우지 않음)', noLedger?.sections[0].posted === null && sectionDetail(noLedger.sections[0]) === '3편', noLedger ? sectionDetail(noLedger.sections[0]) : '');
  // 아직 안 만든 글 — 배정 글 가운데 그 작성자 칸에 들어간 초안이 없는 글. 다른 판으로 만든 글은 그 작성자 몫을 채우지 않는다.
  const someMissing = grouped(libraryLayout({ drafts: drafts.filter((d) => d.actionId !== A2.id), plan, planUnreadable: false, extras, posts }));
  ok('머리 — w1 한 편을 아직 안 만들었으면 「아직 안 만든 글 1편」', sectionDetail(someMissing!.sections[0]) === '2편 · 올림 0 · 아직 안 만든 글 1편', sectionDetail(someMissing!.sections[0]));
}

// ── 올림 — 발행 현황(buildTenantStatus 작성자 진행)과 같은 규칙 ─────────────────
{
  const sectionsWith = (extra: LedgerPostLike[], base: LedgerPostLike[] = posts) =>
    grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras, posts: [...base, ...extra] }))?.sections ?? [];
  const w1Of = (list: LibrarySection<Draft>[]) => list.find((s) => s.pick === 'w1');

  // 판을 모르는 기록(질문 은행이 초안보다 나중이라 판 null로 남은 기록) — 올림이 아니라 「올렸는지 미확인」.
  const unknown = w1Of(sectionsWith([post(A1.id, { key: 'a1', version: null })]));
  ok('판 — 판을 모르는 기록은 올림에 넣지 않고 「올렸는지 미확인」', unknown?.posted === 1 && unknown.unsure === 1, JSON.stringify(unknown && { posted: unknown.posted, unsure: unknown.unsure }));
  ok('판 — 칸 머리에 「올렸는지 미확인 n」', unknown !== undefined && sectionDetail(unknown) === '3편 · 올림 1 · 올렸는지 미확인 1', unknown && sectionDetail(unknown));
  // 다른 판으로 적은 기록 — 발행 현황은 그 줄을 배정 없음으로 본다.
  const other = w1Of(sectionsWith([post(A1.id, { key: 'a1', version: 'v8' })]));
  ok('판 — 다른 판(v8)으로 적은 기록은 올림도 미확인도 아니다', other?.posted === 1 && other.unsure === 0, JSON.stringify(other && { posted: other.posted, unsure: other.unsure }));
  // 판이 맞는 기록이 하나라도 있으면 올림 — 판을 모르는 기록이 함께 있어도 미확인으로 두 번 세지 않는다.
  const both = w1Of(sectionsWith([post(A1.id, { key: 'a1', version: null }), post(A1.id, { key: 'a1-tistory', version: 'v9' })]));
  ok('판 — 판이 맞는 기록이 있으면 올림(미확인으로 세지 않음)', both?.posted === 2 && both.unsure === 0, JSON.stringify(both && { posted: both.posted, unsure: both.unsure }));
  // 기록에 질문 스냅샷이 없는 topic: 기록(옛 기록) — 판을 모른다.
  const noTopic = w1Of(sectionsWith([post(A1.id, { key: 'a1' })]));
  ok('판 — 질문 스냅샷이 없는 기록도 판을 모른다(미확인)', noTopic?.posted === 1 && noTopic.unsure === 1);

  // 같은 주소 · 같은 올린 날의 두 줄(자사 줄 · 블로그 채널 줄) 가운데 한 줄만 「글을 내렸어요」 — 그 편은 내린 것이다.
  const own = post(A1.id, { key: 'a1-pair', version: 'v9', at: '2026-11-06T01:00:00.000Z' });
  const chan = post(A1.id, { key: 'a1-pair', version: 'v9', at: '2026-11-06T01:05:00.000Z', removedAt: '2026-11-08T00:00:00.000Z' });
  const pairDown = w1Of(sectionsWith([own, chan]));
  ok('내림 — 같은 주소 · 같은 날 두 줄 중 한 줄만 내려도 그 편은 올림이 아니다', pairDown?.posted === 1, JSON.stringify(pairDown?.posted));
  // 내린 뒤 같은 주소를 다시 적으면(내린 시각보다 나중 기록) 다시 올린 것이다.
  const again = post(A1.id, { key: 'a1-pair', version: 'v9', at: '2026-11-09T00:00:00.000Z' });
  ok('내림 — 내린 뒤 같은 주소를 다시 적으면 올림', w1Of(sectionsWith([own, chan, again]))?.posted === 2);
  // 날짜 없는 옛 줄 — 같은 주소에 날짜 있는 줄이 있으면 뺀다(내린 날짜 있는 줄만 남는다).
  const legacy = post(A1.id, { key: 'a1-legacy', on: null, version: 'v9', at: '2026-10-01T00:00:00.000Z' });
  const datedDown = post(A1.id, { key: 'a1-legacy', version: 'v9', removedAt: '2026-11-08T00:00:00.000Z' });
  ok('내림 — 날짜 있는 줄을 내렸으면 같은 주소의 날짜 없는 옛 줄은 올림이 아니다', w1Of(sectionsWith([legacy, datedDown]))?.posted === 1);

  // 배정 밖 칸은 판과 상관없이 글 id로 센다 — 다른 판(v8)으로 만든 C1의 v8 기록도 올림.
  const outside = sectionsWith([post(C1.id, { key: 'c1', version: 'v8' })]).find((s) => s.pick === OUTSIDE_PICK);
  ok('배정 밖 — 판과 상관없이 살아 있는 기록이 있으면 올림', outside?.posted === 2 && outside.unsure === 0, JSON.stringify(outside && { posted: outside.posted, unsure: outside.unsure }));
  ok('배정 밖 — 같은 주소 · 같은 날 한 줄만 내려도 올림이 아니다', sectionsWith([
    post('content:category-agnostic', { key: 'main', at: '2026-11-06T02:00:00.000Z', removedAt: '2026-11-08T00:00:00.000Z' }),
  ]).find((s) => s.pick === OUTSIDE_PICK)?.posted === 0);

  // 판 미확인 글(C2 — 정의 없음)의 올림도 작성자 칸의 규칙(livePostsOf) — 칸이 판을 몰라도 기록의 판으로 센다.
  const w3Of = (list: LibrarySection<Draft>[]) => list.find((s) => s.pick === 'w3');
  const c2Planned = w3Of(sectionsWith([post(C2.id, { key: 'c2', version: 'v9' })]));
  ok('판 미확인 글 — 배정 판(v9)으로 적은 기록이면 올림', c2Planned?.posted === 1 && c2Planned.unsure === 0, JSON.stringify(c2Planned && { posted: c2Planned.posted, unsure: c2Planned.unsure }));
  const c2Unknown = w3Of(sectionsWith([post(C2.id, { key: 'c2', version: null })]));
  ok('판 미확인 글 — 판 없는 기록(질문 은행 「올렸어요」)이면 「올렸는지 미확인」', c2Unknown?.posted === 0 && c2Unknown.unsure === 1, JSON.stringify(c2Unknown && { posted: c2Unknown.posted, unsure: c2Unknown.unsure }));
  const c2Other = w3Of(sectionsWith([post(C2.id, { key: 'c2', version: 'v8' })]));
  ok('판 미확인 글 — 다른 판(v8)으로 적은 기록은 올림도 미확인도 아니다', c2Other?.posted === 0 && c2Other.unsure === 0, JSON.stringify(c2Other && { posted: c2Other.posted, unsure: c2Other.unsure }));
  ok('판 미확인 글 — 배정 밖 칸의 올림에는 들어가지 않는다', sectionsWith([post(C2.id, { key: 'c2', version: 'v9' })]).find((s) => s.pick === OUTSIDE_PICK)?.posted === 1);

  // 발행 현황과 같은 수 — 작성자 글의 초안이 모두 그 칸에 있을 때(w1 · w2) 칸의 올림 · 미확인이 발행 현황 작성자 진행과 같다. w3는 다른 판
  // 글(C1)의 기록이 없을 때 — 판 미확인 글(C2)의 판 없는 기록이 두 화면 모두 「올렸는지 미확인」 1이다.
  const mixed = [
    ...posts,
    post(A1.id, { key: 'a1', version: null }),
    own,
    chan,
    post(B2.id, { key: 'b2', version: 'v8' }),
    post(C2.id, { key: 'c2', version: null }),
  ];
  const lib = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras, posts: mixed }))?.sections ?? [];
  const status = buildTenantStatus({ tenantId: plan.tenantId, brand: '가상펜션', ownedDomains: [], posts: mixed, plan, planUnreadable: false, checks: {} }).writers;
  for (const key of ['w1', 'w2', 'w3']) {
    const s = lib.find((x) => x.pick === key);
    const w = status.find((x) => x.key === key);
    ok(`발행 현황과 같은 수 — ${key} 올림 · 미확인`, s !== undefined && w !== undefined && s.posted === w.posted && s.unsure === w.unsure, JSON.stringify({ lib: s && [s.posted, s.unsure], status: w && [w.posted, w.unsure] }));
  }
}

// ── 보관함 「올렸어요」의 질문 스냅샷 — 콘텐츠 생성과 같은 판 ──────────────────
{
  const spec = (questionId: string, text: string): QuestionSpec => ({
    questionId,
    text,
    category: 'category-agnostic',
    industry: '숙박',
    region: '가상시',
    containsBrandName: false,
    version: 'v10',
  });
  // 질문지가 v10으로 올라간 뒤 — 은행이 초안보다 나중에 만들어졌다.
  const newerBank: QuestionBank = { version: 'v10', generatedAt: '2026-11-10T00:00:00.000Z', questions: [spec('q-001', '바뀐 가상 질문 1'), spec('q-002', '바뀐 가상 질문 2')] };
  const fullDefs = [{ id: A1.id, bankVersion: 'v9', questionIds: A1.questionIds, questionTexts: A1.questionTexts }];
  const snap = libraryRecordTopic(A1.id, fullDefs, newerBank, dA1.generatedAt, plan);
  ok(
    '기록 — 추가 글 정의가 있으면 그 정의의 판 · 문장(지금 은행이 아님)',
    same(snap, { bankVersion: 'v9', questionIds: A1.questionIds, questionTexts: A1.questionTexts }),
    JSON.stringify(snap),
  );
  const recorded = post(A1.id, { key: 'a1', version: snap?.bankVersion ?? null });
  const after = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras, posts: [...posts, recorded] }))?.sections[0];
  const st = buildTenantStatus({ tenantId: plan.tenantId, brand: '가상펜션', ownedDomains: [], posts: [...posts, recorded], plan, planUnreadable: false, checks: {} }).writers[0];
  ok('기록 — 그렇게 적은 기록은 질문지가 바뀐 뒤에도 보관함 · 발행 현황 모두 올림', after?.posted === 2 && after.unsure === 0 && st?.posted === 2 && st.unsure === 0);
  // 검토 반영(2026-11-09)으로 바뀐 기대 — 예전 기대 「정의가 없으면 질문 은행으로」는 판 미확인 배정 글(C2)로 보았다. 이제 배정에 없는 글만
  // 질문 은행으로 보고(아래), 판 미확인 배정 글은 작성자 기록(주소 한꺼번에 등록 · CLI)과 같은 배정 파일의 판으로 적는다.
  const qBank = (version: string, generatedAt: string): QuestionBank => ({
    version,
    generatedAt,
    questions: ['q-001', 'q-002', 'q-006', 'q-007', 'q-008'].map((id) => spec(id, `${version} 가상 질문 ${id}`)),
  });
  ok(
    '기록 — 배정에 없는 글은 정의가 없으면 지금처럼 질문 은행으로(은행이 초안보다 나중이면 판 없음)',
    libraryRecordTopic('topic:q-007+q-008', fullDefs, qBank('v10', '2026-11-10T00:00:00.000Z'), dTopic.generatedAt, plan)?.bankVersion === null,
  );
  ok(
    '기록 — 배정에 없는 글은 정의가 없고 은행이 초안보다 앞서면 그 은행의 판',
    libraryRecordTopic('topic:q-007+q-008', fullDefs, qBank('v9', '2026-10-01T00:00:00.000Z'), dTopic.generatedAt, plan)?.bankVersion === 'v9',
  );
  const olderBank: QuestionBank = { ...newerBank, version: 'v9', generatedAt: '2026-10-01T00:00:00.000Z' };
  ok(
    '기록 — 배정이 없는 브랜드는 정의가 없고 은행이 초안보다 앞서면 그 은행의 판 · 문장',
    same(libraryRecordTopic(A1.id, [], olderBank, dA1.generatedAt, null), { bankVersion: 'v9', questionIds: ['q-001', 'q-002'], questionTexts: ['바뀐 가상 질문 1', '바뀐 가상 질문 2'] }),
  );
  ok('기록 — 추가 글 목록을 못 읽었으면(null) 질문 은행으로', libraryRecordTopic(A1.id, null, newerBank, dA1.generatedAt, plan)?.bankVersion === null);
  ok('기록 — topic: 글이 아니면 스냅샷 없음', libraryRecordTopic('content:category-agnostic', fullDefs, olderBank, dMain.generatedAt, plan) === undefined);
  // 다른 판(v8)으로 만든 배정 글 id(C1 — 배정 밖 칸)는 지금처럼 그 정의의 판 · 문장이다(배정 파일의 판으로 바꾸지 않는다).
  const c1Def = { id: C1.id, bankVersion: 'v8', questionIds: C1.questionIds, questionTexts: ['v8 가상 질문 하나', 'v8 가상 질문 둘'] };
  ok(
    '기록 — 다른 판으로 만든 배정 글 id는 지금처럼 그 정의의 판 · 문장(배정 파일의 판이 아님)',
    same(libraryRecordTopic(C1.id, [...fullDefs, c1Def], qBank('v9', '2026-10-01T00:00:00.000Z'), dOldBank.generatedAt, plan), {
      bankVersion: 'v8',
      questionIds: C1.questionIds,
      questionTexts: c1Def.questionTexts,
    }),
  );

  // 판 미확인 배정 글(C2 — 정의 없음)의 「올렸어요」 — 작성자 칸에 둔 글이므로 주소 한꺼번에 등록 · CLI(src/lib/postRegistration.ts
  // writerRecordInput)와 같은 배정 파일의 판 · 문장을 싣는다. 질문 은행이 초안보다 나중(판 없음)이든, 초안보다 앞선 다른 판(v10)이든 같다.
  const planSnap = { bankVersion: 'v9', questionIds: C2.questionIds, questionTexts: C2.questionTexts };
  const unknownSnaps = [qBank('v10', '2026-11-10T00:00:00.000Z'), qBank('v9', '2026-10-01T00:00:00.000Z'), qBank('v10', '2026-10-01T00:00:00.000Z'), null].map((b) =>
    libraryRecordTopic(C2.id, fullDefs, b, dNoDef.generatedAt, plan),
  );
  ok('기록 — 판 미확인 배정 글은 배정 파일의 판 · 문장(작성자 기록과 같다 — 질문 은행과 상관없이)', unknownSnaps.every((s) => same(s, planSnap)), JSON.stringify(unknownSnaps));
  ok(
    '기록 — 초안이 없는 기록(주소만 남은 기록 — 작성자 칸에 없는 글)은 지금처럼 판 없음',
    libraryRecordTopic(C2.id, fullDefs, qBank('v9', '2026-10-01T00:00:00.000Z'), undefined, plan)?.bankVersion === null,
  );
  ok('기록 — 배정이 없거나 못 읽었으면(null) 배정 글 id라도 질문 은행으로(작성자 칸이 없다)', libraryRecordTopic(C2.id, fullDefs, qBank('v9', '2026-10-01T00:00:00.000Z'), dNoDef.generatedAt, null)?.bankVersion === 'v9');
  const c2Recorded = post(C2.id, { key: 'c2', version: unknownSnaps[0]?.bankVersion ?? null });
  const w3After = grouped(libraryLayout({ drafts, plan, planUnreadable: false, extras, posts: [...posts, c2Recorded] }))?.sections.find((s) => s.pick === 'w3');
  const w3Status = buildTenantStatus({ tenantId: plan.tenantId, brand: '가상펜션', ownedDomains: [], posts: [...posts, c2Recorded], plan, planUnreadable: false, checks: {} }).writers.find(
    (w) => w.key === 'w3',
  );
  ok(
    '기록 — 그렇게 적은 판 미확인 글 기록은 보관함 w3 칸 · 발행 현황 모두 올림 1(미확인 아님 — 앱 등록 · CLI로 적은 것과 같은 셈)',
    w3After?.posted === 1 && w3After.unsure === 0 && w3Status?.posted === 1 && w3Status.unsure === 0,
    JSON.stringify({ lib: w3After && [w3After.posted, w3After.unsure], status: w3Status && [w3Status.posted, w3Status.unsure] }),
  );

  // 질문 은행 「올렸어요」(src/pages/QuestionBank.tsx)도 배정 글에는 같은 스냅샷(assignedTopicSnapshot) — 배정 글이 아니면(배정에 없음 · 다른
  // 판으로 만든 글 · 배정이나 추가 글 목록이 없음) null이라 화면은 지금처럼 질문 은행 판을 싣는다.
  const withC1 = [...fullDefs, c1Def];
  ok(
    '질문 은행 기록 — 판 미확인 배정 글은 보관함 「올렸어요」와 같은 배정 파일의 판 · 문장',
    same(assignedTopicSnapshot(plan, withC1, C2.id), planSnap) && same(assignedTopicSnapshot(plan, withC1, C2.id), libraryRecordTopic(C2.id, withC1, qBank('v10', '2026-10-01T00:00:00.000Z'), dNoDef.generatedAt, plan)),
    JSON.stringify(assignedTopicSnapshot(plan, withC1, C2.id)),
  );
  ok(
    '질문 은행 기록 — 배정 판으로 만든 배정 글은 그 정의의 판 · 문장',
    same(assignedTopicSnapshot(plan, withC1, A1.id), { bankVersion: 'v9', questionIds: A1.questionIds, questionTexts: A1.questionTexts }),
  );
  ok(
    '질문 은행 기록 — 다른 판으로 만든 글 · 배정에 없는 글 · 배정이나 추가 글 목록이 없으면 null(지금처럼 질문 은행 판)',
    assignedTopicSnapshot(plan, withC1, C1.id) === null &&
      assignedTopicSnapshot(plan, withC1, 'topic:q-007+q-008') === null &&
      assignedTopicSnapshot(null, withC1, C2.id) === null &&
      assignedTopicSnapshot(plan, null, C2.id) === null,
  );
}

// ── 「올렸어요」(보관함 · 질문 은행)를 적지 않는 때 — 배정 글인지 · 어느 판인지 가를 수 없으면(주소 한꺼번에 등록과 같다) ──────
{
  const defs = [{ id: A1.id, bankVersion: 'v9' }];
  const planMsg = recordBlockedReason(A1.id, null, true, null);
  ok(
    '적지 않음 — 배정 파일을 읽지 못했으면 질문 글(topic:)은 모두(배정 글인지 모른다 — 지금은 질문 은행 판으로 적었다)',
    planMsg?.includes('probe-plan.json') === true && recordBlockedReason('topic:q-007+q-008', null, true, defs) === planMsg,
    String(planMsg),
  );
  const extrasMsg = recordBlockedReason(A1.id, plan, false, null);
  ok(
    '적지 않음 — 배정 글 id인데 추가 글 목록을 읽지 못했으면(null) 그 글(정상 정의 · 판 미확인 모두 — 지금은 보관함이 질문 은행 판으로 적었다)',
    extrasMsg?.includes('추가 글 목록') === true && recordBlockedReason(C2.id, plan, false, null) === extrasMsg,
    String(extrasMsg),
  );
  ok('적음 — 배정에 없는 글은 추가 글 목록을 못 읽어도 지금처럼', recordBlockedReason('topic:q-007+q-008', plan, false, null) === null);
  ok('적음 — 배정과 추가 글 목록을 읽었으면(판 미확인 글 포함)', recordBlockedReason(A1.id, plan, false, defs) === null && recordBlockedReason(C2.id, plan, false, defs) === null);
  ok(
    '적음 — 배정 파일이 없는 브랜드 · topic: 글이 아니면',
    recordBlockedReason(C2.id, null, false, null) === null && recordBlockedReason('content:category-agnostic', null, true, null) === null,
  );
}

// ── 배정 밖 글이 없으면 그 칸도 없다 ─────────────────────────────────────────
{
  const onlyPlan = grouped(libraryLayout({ drafts: [dA1, dB1], plan, planUnreadable: false, extras, posts }));
  ok('배정 밖 — 글이 없으면 칸을 만들지 않는다', same(onlyPlan?.sections.map((s) => s.pick), ['w1', 'w2', 'w3']));
  ok('배정 밖 — 그때 고르기에도 없다', !libraryPickOptions(onlyPlan!).some((o) => o.value === OUTSIDE_PICK));
}

// ── 운영 기간이 지난 배정도 묶는다(발행 현황의 작성자 칸과 같다) ───────────────
{
  const expired = grouped(libraryLayout({ drafts, plan: { ...plan, activeUntil: '2026-01-31' }, planUnreadable: false, extras, posts }));
  ok('기간 — 마지막 날이 지난 배정도 같은 칸으로 묶는다', same(expired?.sections.map((s) => s.pick), ['w1', 'w2', 'w3', OUTSIDE_PICK]));
}

// ── 짐작하지 않기 — 한 목록(지금 순서)으로 ────────────────────────────────────
{
  const noPlan = libraryLayout({ drafts, plan: null, planUnreadable: false, extras, posts });
  ok('배정 없음 — 묶지 않고 지금처럼 최근 순 · 안내 없음', !noPlan.grouped && same(ids(noPlan.drafts), ids(recentFirst(drafts))) && noPlan.fallback === null);
  ok('배정 없음 — 추가 글 목록을 못 읽어도 안내 없음(지금과 같다)', (() => {
    const l = libraryLayout({ drafts, plan: null, planUnreadable: false, extras: null, posts: null });
    return !l.grouped && l.fallback === null;
  })());
  const noExtras = libraryLayout({ drafts, plan, planUnreadable: false, extras: null, posts });
  ok('추가 글 목록을 못 읽음 — 묶지 않고 모든 글을 최근 순', !noExtras.grouped && same(ids(noExtras.drafts), ids(recentFirst(drafts))));
  ok('추가 글 목록을 못 읽음 — 이유를 밝힌다', !noExtras.grouped && noExtras.fallback === 'extras-unreadable' && LIBRARY_FALLBACK_NOTE['extras-unreadable'].includes('최근 순'));
  const badPlan = libraryLayout({ drafts, plan: null, planUnreadable: true, extras, posts });
  ok('배정을 못 읽음 — 묶지 않고 모든 글을 최근 순 · 이유', !badPlan.grouped && badPlan.drafts.length === drafts.length && badPlan.fallback === 'plan-unreadable');
  ok('못 읽음 — 고르기는 「전체」 하나', libraryPickOptions(noExtras).length === 1 && libraryPickOptions(noExtras)[0].value === '');
}

// ── 작성자 고르기 ────────────────────────────────────────────────────────────
{
  const opts = libraryPickOptions(layout);
  ok(
    '고르기 — 전체 · 작성자(배정표 순서) · 배정 밖 글',
    same(opts, [
      { value: '', label: '전체' },
      { value: 'w1', label: 'w1 · 가상 작성자 하나' },
      { value: 'w2', label: 'w2 · 가상 작성자 둘' },
      { value: 'w3', label: 'w3 · 가상 작성자 셋' },
      { value: OUTSIDE_PICK, label: '배정 밖 글' },
    ]),
    JSON.stringify(opts),
  );
  ok('고르기 — 배정 밖 값은 작성자 키가 될 수 없는 글자', !/^[A-Za-z0-9_-]+$/.test(OUTSIDE_PICK));
  ok('고르기 — 있는 작성자는 그대로', validLibraryPick(layout, 'w2') === 'w2' && validLibraryPick(layout, OUTSIDE_PICK) === OUTSIDE_PICK);
  ok('고르기 — 다시 읽은 뒤 없는 작성자면 전체로', validLibraryPick(layout, 'w9') === '');
  const onlyPlan = libraryLayout({ drafts: [dA1], plan, planUnreadable: false, extras, posts });
  ok('고르기 — 배정 밖 글이 없어졌으면 전체로', validLibraryPick(onlyPlan, OUTSIDE_PICK) === '');
  ok('고르기 — 묶지 않은 화면(배정 없음 · 못 읽음)이면 전체로', validLibraryPick(libraryLayout({ drafts, plan: null, planUnreadable: false, extras, posts }), 'w1') === '');
  ok('고르기 — w3를 고르면 그 칸의 판 미확인 글이 보인다', validLibraryPick(layout, 'w3') === 'w3' && shownSections(layout, 'w3').length === 1 && same(ids(shownSections(layout, 'w3')[0].drafts), [C2.id]));
  ok('고르기 — 배정 밖 글만 고르면 판 미확인 글은 없다', !shownSections(layout, OUTSIDE_PICK).some((s) => ids(s.drafts).includes(C2.id)));
  const noC2 = libraryLayout({ drafts: drafts.filter((d) => d !== dNoDef), plan, planUnreadable: false, extras, posts });
  ok('고르기 — 글이 없는 작성자도 고를 수 있다', validLibraryPick(noC2, 'w3') === 'w3' && shownSections(noC2, 'w3').length === 1 && shownSections(noC2, 'w3')[0].drafts.length === 0);

  ok('보이는 칸 — 전체면 모든 칸', same(shownSections(layout, '').map((s) => s.pick), ['w1', 'w2', 'w3', OUTSIDE_PICK]));
  ok('보이는 칸 — 작성자를 고르면 그 칸만', same(shownSections(layout, 'w2').map((s) => s.pick), ['w2']));
  ok('보이는 칸 — 배정 밖 글만', same(shownSections(layout, OUTSIDE_PICK).map((s) => s.pick), [OUTSIDE_PICK]));
  ok('보이는 칸 — 없는 값이면 전체', shownSections(layout, 'w9').length === 4);
  ok('보이는 칸 — 묶지 않은 화면은 칸이 없다', shownSections(libraryLayout({ drafts, plan: null, planUnreadable: false, extras, posts }), '').length === 0);

  ok('주소만 남은 기록 — 전체에서만', orphansShown(layout, '') && !orphansShown(layout, 'w1') && !orphansShown(layout, OUTSIDE_PICK));
  ok('주소만 남은 기록 — 없는 값으로 남은 고르기는 전체로 보고 보인다', orphansShown(layout, 'w9'));
  ok('주소만 남은 기록 — 배정 없는 브랜드는 늘 보인다(지금과 같다)', orphansShown(libraryLayout({ drafts, plan: null, planUnreadable: false, extras, posts }), 'w1'));
}

// ── 「글 N편」 안내 ──────────────────────────────────────────────────────────
{
  ok('글 수 — 전체면 모든 글', same(libraryCount(layout, ''), { scope: null, shown: 9, total: 9 }));
  ok('글 수 — 작성자를 고르면 그 작성자 글과 전체', same(libraryCount(layout, 'w1'), { scope: 'w1', shown: 3, total: 9 }));
  ok('글 수 — 배정 밖 글(판 미확인 글은 빠짐)', same(libraryCount(layout, OUTSIDE_PICK), { scope: '배정 밖', shown: 3, total: 9 }), JSON.stringify(libraryCount(layout, OUTSIDE_PICK)));
  ok('글 수 — w3를 고르면 판 미확인 글까지', same(libraryCount(layout, 'w3'), { scope: 'w3', shown: 1, total: 9 }), JSON.stringify(libraryCount(layout, 'w3')));
  ok('글 수 — 없는 값이면 전체', same(libraryCount(layout, 'w9'), { scope: null, shown: 9, total: 9 }));
  ok('글 수 — 배정 없음이면 지금처럼 모든 글', same(libraryCount(libraryLayout({ drafts, plan: null, planUnreadable: false, extras, posts }), ''), { scope: null, shown: 9, total: 9 }));
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
