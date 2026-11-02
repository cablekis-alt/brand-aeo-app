/**
 * 실증 배정(src/lib/probePlan.ts)의 순수 로직과 배정 파일을 만드는 운영 스크립트(scripts/write-probe-plan.ts)를 확인한다. 서버 · AI는
 * 부르지 않고, 파일은 임시 폴더의 가짜 브랜드에만 쓴다(스크립트는 하위 프로세스로 돌린다). 브랜드 · 질문은 모두 가짜다.
 *
 * 왜: 실증 기간에 배정표 밖의 글이 하나라도 생기면 그 질문은 대조로 쓸 수 없다(docs/proof/preregistration.md §9). 잠금은 이 검사 하나로
 * 서버(추가 글 만들기 · 되살리기, 브리프 · 초안)와 화면이 함께 닫는다 — 갈래 하나가 틀리면 막아야 할 글이 열리거나, 배정 파일이 없는
 * 브랜드의 글까지 막힌다. 배정 파일이 없으면(plan null) 모든 함수가 「역할 없음 · 허용」이어야 지금과 같다.
 *
 * 배정 글은 화면이 정의를 그대로 「글 더 만들기」로 보내므로 추가 글 검사(checkNewExtraArticle)를 그대로 통과해야 하고, 이름은 브리프
 * 각도로 글에 들어가므로 실험 용어가 없어야 한다.
 *
 *   npx tsx scripts/verify-probe-plan.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { articleIdOf } from './proof-read';
import {
  buildProbePlan,
  planBackupDirName,
  PROBE_ACTIVE_UNTIL,
  PROBE_POST_DATES,
  roleCounts,
  writeProbePlanFile,
  type AssignmentBrand,
  type BankQuestion,
  type DesignBrand,
  type ProbePlanInput,
} from './write-probe-plan';
import { checkNewExtraArticle, extraBriefAngle, topicArticleId } from '../src/lib/extraArticles';
import {
  allowedTopicIds,
  articleLabel,
  isActive,
  parseProbePlan,
  planArticle,
  PROBE_NAME_BANNED,
  probeNameError,
  roleChip,
  roleOf,
  topicGuard,
  type ProbePlan,
  type ProbeRole,
} from '../src/lib/probePlan';

const checks: [string, boolean, string | undefined][] = [];
/** detail은 실패했을 때만 찍는다(하위 프로세스 출력 등). */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);

// ── 가짜 브랜드 「가상펜션」(질문지 v9) ──────────────────────────────────────
const TEXT: Record<string, string> = {
  'c1-001': '가상시 원도심 걸어 다니기 좋은 숙소 어디야?',
  'c1-002': '가상시 기차역에서 가까운 조용한 숙소 추천해줘',
  'c1-003': '가상시 숙소 주차 편한 곳 후기 어디서 봐?',
  'c1-004': '가상시 독채 숙소 특징이 어때?',
  'c1-005': '가상시 바다 전망 숙소 추천해줘',
  'c1-008': '가상시 겨울에 묵기 좋은 숙소 어디야?',
  'c1-009': '가상시 숙소 체크인 시간 보통 어때?',
  'v9-p001': '가상시 벚꽃 철에 묵기 좋은 숙소 추천해줘',
  'v9-p002': '가상시 부모님 모시고 갈 만한 숙소 추천해줘',
  'v9-p003': '가상시 혼자 쉬다 올 작은 숙소 추천해줘',
  'v9-p004': '가상시 기념일에 묵기 좋은 숙소 추천해줘',
  'v9-p005': '가상시 반려견 동반 숙소 추천해줘',
  'v9-p006': '가상시 꽃구경 시즌에 머물 만한 숙소 알려줘',
};
const art = (ids: string[], name: string, channel: string) => ({
  id: topicArticleId(ids),
  name,
  channel,
  questionIds: [...ids].sort(),
  questionTexts: [...ids].sort().map((id) => TEXT[id]),
});
const A1 = art(['c1-001', 'c1-002'], '원도심 걸어서 다니는 숙소', '자사 사이트');
const A2 = art(['v9-p003', 'v9-p001', 'v9-p002'], '계절 · 동행별 숙소 고르기', '티스토리');
const B1 = art(['c1-003', 'v9-p004'], '주차 · 기념일 숙소 후기', '티스토리');
const ZERO = { id: 'topic:c1-008+c1-009', questionIds: ['c1-008', 'c1-009'] };

/** 매번 새 객체 — 실패 갈래마다 한 곳만 고친다. */
function rawPlan(): Record<string, unknown> {
  const q = (role: ProbeRole, id: string, extra: Record<string, string> = {}) => [id, { role, text: TEXT[id], ...extra }] as const;
  return JSON.parse(
    JSON.stringify({
      format: 'probe-plan/1',
      tenantId: 'demo-probe',
      bankVersion: 'v9',
      activeUntil: '2026-12-28',
      source: { assignment: 'docs/proof/assignment.json', seed: 20261102 },
      // 일부러 2차를 먼저 — 읽으면 차수 순으로 정렬된다.
      rounds: [
        { round: 2, postDate: '2026-12-07', articles: [B1] },
        { round: 1, postDate: '2026-11-23', articles: [A1, A2] },
      ],
      zerothArticle: ZERO,
      questions: Object.fromEntries([
        q('round1', 'c1-001', { articleId: A1.id }),
        q('round1', 'c1-002', { articleId: A1.id }),
        q('round1', 'v9-p001', { articleId: A2.id }),
        q('round1', 'v9-p002', { articleId: A2.id }),
        q('round1', 'v9-p003', { articleId: A2.id }),
        q('round2', 'c1-003', { articleId: B1.id }),
        q('round2', 'v9-p004', { articleId: B1.id }),
        q('control', 'c1-004'),
        q('control', 'v9-p005'),
        q('ineligible', 'c1-005', { reason: '사실과 어긋남 — 바다 전망 없음' }),
        q('zeroth', 'c1-008', { articleId: ZERO.id }),
        q('zeroth', 'c1-009'),
        q('holdout', 'v9-p006', { of: 'v9-p001' }),
      ]),
    }),
  ) as Record<string, unknown>;
}

type Raw = Record<string, unknown>;
const roundsOf = (r: Raw) => r.rounds as { round: number; postDate: string; articles: Raw[] }[];
const questionsOf = (r: Raw) => r.questions as Record<string, Raw>;
/** 1차 글 A1(1차 첫 글)을 고친다. */
const firstArticle = (r: Raw) => roundsOf(r)[1].articles[0];

const parsed = parseProbePlan(rawPlan());
const plan = parsed.plan as ProbePlan;

// ── 읽기 ────────────────────────────────────────────────────────────────────
{
  ok('읽기 — 가짜 배정 파일은 통과', Boolean(parsed.plan) && parsed.error === undefined);
  ok('읽기 — 차수 순으로 정렬(1차 → 2차)', plan.rounds.map((r) => r.round).join(',') === '1,2');
  ok('읽기 — 글 · 질문 · 0차 그대로', plan.rounds[0].articles.length === 2 && Object.keys(plan.questions).length === 13 && plan.zerothArticle.id === ZERO.id);
  ok('읽기 — 이유 · 원래 질문 · 0차 articleId 없는 줄도 그대로', plan.questions['c1-005'].reason === '사실과 어긋남 — 바다 전망 없음' && plan.questions['v9-p006'].of === 'v9-p001' && plan.questions['c1-009'].articleId === undefined);
  ok('읽기 — JSON으로 쓰고 다시 읽어도 같음', JSON.stringify(parseProbePlan(JSON.parse(JSON.stringify(plan))).plan) === JSON.stringify(plan));
  ok('읽기 — 모르는 키는 버림', !('extra' in (parseProbePlan({ ...rawPlan(), extra: 1 }).plan as object)));

  const fails: [string, (r: Raw) => unknown][] = [
    ['형식이 다름', (r) => (r.format = 'probe-plan/2')],
    ['tenantId 없음', (r) => delete r.tenantId],
    ['판 없음', (r) => (r.bankVersion = ' ')],
    ['activeUntil 없는 날짜(2026-02-30)', (r) => (r.activeUntil = '2026-02-30')],
    ['activeUntil 연도 없음(12-28)', (r) => (r.activeUntil = '12-28')],
    ['source 없음', (r) => delete r.source],
    ['seed가 숫자 아님', (r) => ((r.source as Raw).seed = '20261102')],
    ['차수 없음', (r) => (r.rounds = [])],
    ['3차', (r) => (roundsOf(r)[0].round = 3)],
    ['같은 차수 두 번', (r) => (roundsOf(r)[1].round = 2)],
    ['게시일 틀림', (r) => (roundsOf(r)[0].postDate = '2026-12-7')],
    ['차수에 글 없음', (r) => (roundsOf(r)[0].articles = [])],
    ['글 id가 topic:이 아님', (r) => (firstArticle(r).id = 'content:category-agnostic')],
    ['글 id가 질문과 다름', (r) => (firstArticle(r).id = 'topic:c1-001')],
    ['질문 id를 정렬하지 않음', (r) => {
      const a = firstArticle(r);
      a.questionIds = ['c1-002', 'c1-001'];
      a.questionTexts = [TEXT['c1-002'], TEXT['c1-001']];
    }],
    ['문장 수가 질문 수와 다름', (r) => (firstArticle(r).questionTexts = [TEXT['c1-001']])],
    ['네이버 블로그 채널', (r) => (firstArticle(r).channel = '네이버 블로그')],
    ['이름 없음', (r) => (firstArticle(r).name = '  ')],
    ['이름 61자', (r) => (firstArticle(r).name = '가'.repeat(61))],
    ['이름에 공백 두 칸', (r) => (firstArticle(r).name = '원도심  숙소')],
    ['이름 앞뒤 공백', (r) => (firstArticle(r).name = ' 원도심 숙소')],
    ...PROBE_NAME_BANNED.map((w): [string, (r: Raw) => unknown] => [`이름에 '${w}'`, (r) => (firstArticle(r).name = `원도심 숙소 ${w} 글`)]),
    ['같은 질문 두 번', (r) => {
      const a = firstArticle(r);
      a.id = 'topic:c1-001+c1-001';
      a.questionIds = ['c1-001', 'c1-001'];
      a.questionTexts = [TEXT['c1-001'], TEXT['c1-001']];
    }],
    ['한 질문이 두 글에', (r) => {
      const ids = ['c1-001', 'v9-p001', 'v9-p002', 'v9-p003'];
      roundsOf(r)[1].articles[1] = { ...A2, id: topicArticleId(ids), questionIds: ids, questionTexts: ids.map((id) => TEXT[id]) };
    }],
    ['같은 글이 두 번', (r) => (roundsOf(r)[1].articles = [A1, A2, A1])],
    ['글의 질문이 역할 표에 없음', (r) => delete questionsOf(r)['c1-001']],
    ['1차 글 질문의 역할이 round2', (r) => (questionsOf(r)['c1-001'].role = 'round2')],
    ['1차 글 질문의 역할이 대조', (r) => (questionsOf(r)['c1-001'] = { role: 'control', text: TEXT['c1-001'] })],
    ['articleId가 맡은 글과 다름', (r) => (questionsOf(r)['c1-001'].articleId = A2.id)],
    ['역할 표 문장이 글 문장과 다름', (r) => (questionsOf(r)['c1-001'].text = `${TEXT['c1-001']}?`)],
    ['처치 질문을 맡은 글이 없음', (r) => (questionsOf(r)['v9-p005'] = { role: 'round2', text: TEXT['v9-p005'], articleId: B1.id })],
    ['모르는 역할', (r) => (questionsOf(r)['c1-004'].role = 'treated')],
    ['역할 표 문장 없음', (r) => (questionsOf(r)['c1-004'].text = '')],
    ['대조에 articleId', (r) => (questionsOf(r)['c1-004'].articleId = A1.id)],
    ['홀드아웃에 원래 질문 없음', (r) => delete questionsOf(r)['v9-p006'].of],
    ['홀드아웃 원래 질문이 역할 표에 없음', (r) => (questionsOf(r)['v9-p006'].of = 'c1-999')],
    ['홀드아웃 원래 질문이 상속 이름(toString)', (r) => (questionsOf(r)['v9-p006'].of = 'toString')],
    ['홀드아웃이 자기 자신을 바꿔 씀', (r) => (questionsOf(r)['v9-p006'].of = 'v9-p006')],
    ['대상 아님에 articleId', (r) => (questionsOf(r)['c1-005'].articleId = ZERO.id)],
    ['0차 질문이 0차 글에 없음', (r) => (questionsOf(r)['c1-004'].role = 'zeroth')],
    ['0차 글 질문의 역할이 대조', (r) => (questionsOf(r)['c1-009'].role = 'control')],
    ['0차 질문 articleId가 0차 글과 다름', (r) => (questionsOf(r)['c1-008'].articleId = A1.id)],
    ['0차 글 질문이 역할 표에 없음', (r) => delete questionsOf(r)['c1-009']],
    ['0차 글 id가 질문과 다름', (r) => ((r.zerothArticle as Raw).id = 'topic:c1-008')],
    ['0차 글 없음', (r) => delete r.zerothArticle],
    ['0차 글이 배정 글과 같음', (r) => (r.zerothArticle = { id: A1.id, questionIds: A1.questionIds })],
    ['역할 표 없음', (r) => delete r.questions],
  ];
  for (const [label, mutate] of fails) {
    const r = rawPlan();
    mutate(r);
    const res = parseProbePlan(r);
    ok(`읽기 실패 — ${label}`, res.plan === undefined && typeof res.error === 'string' && res.error.length > 0);
  }
  ok('읽기 실패 — 객체가 아님(null · 배열 · 문자열)', [null, [], 'probe-plan/1', undefined].every((x) => parseProbePlan(x).error !== undefined));

  const sixty = rawPlan();
  firstArticle(sixty).name = '가'.repeat(60);
  ok('읽기 — 이름 60자는 통과', parseProbePlan(sixty).plan?.rounds[0].articles[0].name === '가'.repeat(60));
  ok('이름 검사 — 실험 용어 없으면 null, 있으면 그 말을 알림', probeNameError(A1.name) === null && Boolean(probeNameError('홀드아웃 숙소')?.includes('홀드아웃')));
}

// ── 배정 글은 추가 글 검사를 그대로 통과 ────────────────────────────────────
{
  for (const r of plan.rounds) {
    for (const a of r.articles) {
      const res = checkNewExtraArticle({ id: a.id, name: a.name, bankVersion: plan.bankVersion, questionIds: a.questionIds, questionTexts: a.questionTexts }, [], '2026-11-23T00:00:00.000Z');
      ok(`배정 글 ${a.name} — 그대로 보내면 추가 글 검사 통과 · 같은 id · 같은 이름`, res.ok && res.article.id === a.id && res.article.name === a.name);
      ok(`배정 글 ${a.name} — 브리프 각도에 실험 용어 없음`, PROBE_NAME_BANNED.every((w) => !extraBriefAngle(a.name, undefined).includes(w)));
    }
  }
}

// ── 잠금 기간 · 허용 글 ─────────────────────────────────────────────────────
{
  ok('기간 — 마지막 날(12-28)까지 켜짐', isActive(plan, '2026-11-02') && isActive(plan, '2026-12-28'));
  ok('기간 — 다음 날(12-29)부터 꺼짐', !isActive(plan, '2026-12-29') && !isActive(plan, '2027-01-01'));
  ok('기간 — plan 없으면 꺼짐', !isActive(null, '2026-11-02'));
  ok('허용 글 — 배정 글 3편 + 0차 글', JSON.stringify(allowedTopicIds(plan)) === JSON.stringify([A1.id, A2.id, B1.id, ZERO.id]));
  ok('허용 글 — plan 없으면 null(제한 없음)', allowedTopicIds(null) === null);
}

// ── topicGuard 갈래마다 ─────────────────────────────────────────────────────
{
  const TODAY = '2026-11-10';
  const CONTROL_TOPIC = 'topic:c1-004+v9-p005';
  ok('지킴 — plan 없음: 배정 밖 글도 허용(지금과 같다)', topicGuard(null, false, 'v9', CONTROL_TOPIC, TODAY) === null && topicGuard(null, false, null, CONTROL_TOPIC, TODAY) === null);
  const corrupt = topicGuard(null, true, 'v9', A1.id, TODAY);
  ok('지킴 — 배정 파일이 깨짐: 배정 글도 거절(fail closed)', Boolean(corrupt?.includes('깨져')));
  ok('지킴 — 깨졌어도 기간 뒤 · 다른 판이어도 거절', topicGuard(null, true, 'v8', CONTROL_TOPIC, '2027-01-05') !== null);
  ok('지킴 — 깨졌어도 본 글 · 등재형(topic:이 아님)은 규칙 밖', topicGuard(null, true, 'v9', 'content:category-agnostic', TODAY) === null && topicGuard(null, true, 'v9', 'listing:naver-place', TODAY) === null);
  ok('지킴 — 기간 뒤(12-29): 배정 밖 · 다른 판도 허용', topicGuard(plan, false, 'v9', CONTROL_TOPIC, '2026-12-29') === null && topicGuard(plan, false, 'v8', CONTROL_TOPIC, '2026-12-29') === null);
  ok('지킴 — 마지막 날(12-28)은 아직 거절', topicGuard(plan, false, 'v9', CONTROL_TOPIC, '2026-12-28') !== null);
  ok('지킴 — topic:이 아닌 글은 기간 중에도 허용', topicGuard(plan, false, 'v9', 'content:category-agnostic', TODAY) === null && topicGuard(plan, false, 'v8', 'content:category-agnostic', TODAY) === null);
  const otherBank = topicGuard(plan, false, 'v8', A1.id, TODAY);
  ok('지킴 — 판이 다르면 배정 글도 거절하고 두 판을 알림', Boolean(otherBank?.includes('v8') && otherBank.includes('v9')));
  ok('지킴 — 판을 모르는 주(null · 빈 글자)도 거절', topicGuard(plan, false, null, A1.id, TODAY) !== null && topicGuard(plan, false, '', A1.id, TODAY) !== null && topicGuard(plan, false, undefined, A1.id, TODAY) !== null);
  ok('지킴 — 배정 글(1차 · 2차)은 허용', [A1.id, A2.id, B1.id].every((id) => topicGuard(plan, false, 'v9', id, TODAY) === null));
  ok('지킴 — 0차 글 되살리기는 허용', topicGuard(plan, false, 'v9', ZERO.id, TODAY) === null);
  const notAllowed = topicGuard(plan, false, 'v9', CONTROL_TOPIC, TODAY);
  ok('지킴 — 대조 질문 글은 거절(배정표 글만)', Boolean(notAllowed?.includes('배정표 글만') && notAllowed.includes('2026-12-28')));
  ok('지킴 — 배정 글의 일부만 고른 글도 거절', topicGuard(plan, false, 'v9', 'topic:c1-001', TODAY) !== null);
  ok('지킴 — 배정 글 둘을 합친 글도 거절', topicGuard(plan, false, 'v9', topicArticleId([...A1.questionIds, ...B1.questionIds]), TODAY) !== null);
  ok('지킴 — 홀드아웃 · 대상 아님 · 0차 질문 하나 글도 거절', ['topic:v9-p006', 'topic:c1-005', 'topic:c1-008'].every((id) => topicGuard(plan, false, 'v9', id, TODAY) !== null));
}

// ── 역할 · 칩 · 카드 머리 ───────────────────────────────────────────────────
{
  const expect: [string, ProbeRole, string][] = [
    ['c1-001', 'round1', '1차 처치'],
    ['c1-003', 'round2', '2차 처치'],
    ['v9-p005', 'control', '대조 · 글 금지'],
    ['v9-p006', 'holdout', '홀드아웃 · 글 금지'],
    ['c1-005', 'ineligible', '대상 아님'],
    ['c1-009', 'zeroth', '0차'],
  ];
  for (const [id, role, chip] of expect) {
    ok(`역할 — ${id} → ${role} · 「${chip}」`, roleOf(plan, 'v9', id) === role && roleChip(roleOf(plan, 'v9', id)) === chip);
  }
  ok('역할 — 판이 다르면 null(같은 id라도 다른 질문)', roleOf(plan, 'v8', 'c1-001') === null && roleOf(plan, null, 'c1-001') === null);
  ok('역할 — 역할 표에 없는 질문 · 상속 이름은 null', roleOf(plan, 'v9', 'c1-999') === null && roleOf(plan, 'v9', 'toString') === null && roleOf(plan, 'v9', '__proto__') === null);
  ok('역할 — plan 없으면 null · 칩 없음', roleOf(null, 'v9', 'c1-001') === null && roleChip(null) === null);

  ok('카드 머리 — 1차 자사 사이트 글', articleLabel(plan, A1.id) === '1차 · 11-23 게시 · 자사 사이트');
  ok('카드 머리 — 1차 티스토리 글', articleLabel(plan, A2.id) === '1차 · 11-23 게시 · 티스토리');
  ok('카드 머리 — 2차 티스토리 글', articleLabel(plan, B1.id) === '2차 · 12-07 게시 · 티스토리');
  ok('카드 머리 — 0차 글 · 배정 밖 글 · 본 글은 없음', articleLabel(plan, ZERO.id) === null && articleLabel(plan, 'topic:c1-004') === null && articleLabel(plan, 'content:category-agnostic') === null);
  ok('카드 머리 — plan 없으면 없음', articleLabel(null, A1.id) === null);

  const p = planArticle(plan, B1.id);
  ok('배정 글 — 차수 · 게시일 · 이름 · 채널 · 질문 · 문장', p?.round === 2 && p.postDate === '2026-12-07' && p.name === B1.name && p.channel === '티스토리' && p.questionIds.join() === B1.questionIds.join() && p.questionTexts.join() === B1.questionTexts.join());
  p?.questionIds.push('c1-999');
  ok('배정 글 — 돌려준 목록을 고쳐도 plan은 그대로', plan.rounds[1].articles[0].questionIds.length === 2);
  ok('배정 글 — 0차 · 배정 밖 · plan 없음은 null', planArticle(plan, ZERO.id) === null && planArticle(plan, 'topic:c1-004') === null && planArticle(null, A1.id) === null);
}

// ── 실제 배정표의 글 id 규칙 ────────────────────────────────────────────────
{
  // 판독 스크립트(articleIdOf)와 앱(topicArticleId)이 같은 글을 같은 id로 불러야 올린 기록 · 오염 점검이 맞는다. 질문 id 목록만 쓴다.
  const assignment = JSON.parse(readFileSync(new URL('../docs/proof/assignment.json', import.meta.url), 'utf-8')) as { brands: { rounds: { articles: { questionIds: string[] }[] }[] }[] };
  const design = JSON.parse(readFileSync(new URL('../docs/proof/design.json', import.meta.url), 'utf-8')) as { brands: { zeroth: { article: string; questionIds: string[] } }[] };
  const lists = assignment.brands.flatMap((b) => b.rounds.flatMap((r) => r.articles.map((a) => a.questionIds)));
  ok(`배정표 — 글 ${lists.length}편의 id가 판독 스크립트 규칙과 같음`, lists.length === 13 && lists.every((ids) => topicArticleId(ids) === articleIdOf(ids)));
  ok('설계 — 0차 글 id가 질문 id 규칙과 같음', design.brands.every((b) => topicArticleId(b.zeroth.questionIds) === b.zeroth.article));
}

// ── 배정 파일 만들기(write-probe-plan buildProbePlan) ───────────────────────
// 위 가짜 배정 파일(rawPlan)과 같은 배정을 배정표 · 설계 · 질문지 모양으로 주면 같은 글 · 역할이 나와야 한다.
const SEED = 20261102;
const NAMES: Record<string, string> = { [A1.id]: A1.name, [A2.id]: A2.name, [B1.id]: B1.name };
function fakeBank(): { version: string; questions: BankQuestion[] } {
  return {
    version: 'v9',
    questions: [
      { questionId: 'v9-001', text: '가상펜션 체크인 몇 시야?', category: 'brand-direct' },
      ...Object.entries(TEXT).map(([id, text]): BankQuestion => ({
        questionId: id,
        text,
        category: 'category-agnostic',
        ...(id.startsWith('v9-p') ? { probe: true } : {}),
        ...(id === 'v9-p006' ? { paraphraseOf: 'v9-p001' } : {}),
      })),
    ],
  };
}
function fakeAssignment(): AssignmentBrand {
  const poolIds = ['c1-001', 'c1-002', 'c1-003', 'c1-004', 'v9-p001', 'v9-p002', 'v9-p003', 'v9-p004', 'v9-p005'];
  return {
    tenantId: 'demo-probe',
    bankVersion: 'v9',
    excluded: [
      { id: 'c1-005', reason: '대상 아님: 사실과 어긋남 — 바다 전망 없음' },
      { id: 'c1-008', reason: `0차 추가 글이 맡음: ${ZERO.id}` },
      { id: 'c1-009', reason: `0차 추가 글이 맡음: ${ZERO.id}` },
      { id: 'v9-p006', reason: '홀드아웃(v9-p001 바꿔 쓰기)' },
    ],
    pool: poolIds.map((id) => ({ id, text: TEXT[id] })),
    // 일부러 2차를 먼저, 글의 질문 id는 정렬하지 않고 — 만들면 차수 순 · 정렬한 id가 된다.
    rounds: [
      { arm: 'round2', questionIds: ['c1-003', 'v9-p004'], articles: [{ questionIds: ['v9-p004', 'c1-003'], channel: '티스토리' }], holdoutSources: [] },
      {
        arm: 'round1',
        questionIds: ['c1-001', 'c1-002', 'v9-p001', 'v9-p002', 'v9-p003'],
        articles: [
          { questionIds: ['c1-002', 'c1-001'], channel: '자사 사이트' },
          { questionIds: ['v9-p003', 'v9-p001', 'v9-p002'], channel: '티스토리' },
        ],
        holdoutSources: ['v9-p001'],
      },
    ],
    controlIds: ['c1-004', 'v9-p005'],
  };
}
function fakeDesign(): DesignBrand {
  return { tenantId: 'demo-probe', bankVersion: 'v9', zeroth: { article: ZERO.id, questionIds: ['c1-009', 'c1-008'] }, ineligible: [{ id: 'c1-005', reason: '사실과 어긋남 — 바다 전망 없음' }] };
}
function fakeInput(names: Record<string, string> = NAMES): ProbePlanInput {
  return { assignment: fakeAssignment(), design: fakeDesign(), seed: SEED, assignmentSource: 'docs/proof/assignment.json', bank: fakeBank(), names: { ...names } };
}
{
  const built = buildProbePlan(fakeInput());
  const p = built.plan;
  ok('만들기 — 가짜 배정표는 통과 · 이름 다 있음', p !== null && built.errors.length === 0 && built.missingNames.length === 0);
  ok('만들기 — 만든 배정은 parseProbePlan 정규형 그대로', p !== null && JSON.stringify(parseProbePlan(JSON.parse(JSON.stringify(p))).plan) === JSON.stringify(p));
  ok('만들기 — 차수 · 게시일 · 글(id · 이름 · 채널 · 정렬한 질문 · 문장)이 같은 배정과 같음', JSON.stringify(p?.rounds) === JSON.stringify(plan.rounds));
  ok('만들기 — 게시일 11-23 · 12-07, 잠금 12-28', PROBE_POST_DATES[1] === '2026-11-23' && PROBE_POST_DATES[2] === '2026-12-07' && p?.activeUntil === PROBE_ACTIVE_UNTIL && PROBE_ACTIVE_UNTIL === '2026-12-28');
  ok('만들기 — 형식 · 브랜드 · 판 · 출처', p?.format === 'probe-plan/1' && p.tenantId === 'demo-probe' && p.bankVersion === 'v9' && p.source.assignment === 'docs/proof/assignment.json' && p.source.seed === SEED);
  ok('만들기 — 0차 글(정렬한 질문)', p?.zerothArticle.id === ZERO.id && p.zerothArticle.questionIds.join() === 'c1-008,c1-009');
  const sameRoles = p !== null && Object.entries(plan.questions).every(([id, q]) => p.questions[id]?.role === q.role && p.questions[id].text === q.text);
  ok('만들기 — 이름 없는 질문 13개마다 같은 배정과 같은 역할 · 문장, 이름 넣은 질문은 없음', sameRoles && Object.keys(p.questions).length === 13 && !('v9-001' in p.questions));
  ok('만들기 — 처치는 맡은 글, 0차는 모두 0차 글, 홀드아웃은 원래 질문, 대상 아님은 이유(접두 뗌)', p?.questions['c1-002'].articleId === A1.id && p.questions['v9-p004'].articleId === B1.id && p.questions['c1-009'].articleId === ZERO.id && p.questions['v9-p006'].of === 'v9-p001' && p.questions['c1-005'].reason === '사실과 어긋남 — 바다 전망 없음');
  ok('만들기 — 대조 · 대상 아님 · 홀드아웃에는 글이 없음', p !== null && ['c1-004', 'v9-p005', 'c1-005', 'v9-p006'].every((id) => p.questions[id].articleId === undefined));
  ok('만들기 — 역할 수', p !== null && JSON.stringify(roleCounts(p)) === JSON.stringify({ round1: 5, round2: 2, control: 2, holdout: 1, ineligible: 1, zeroth: 2 }));
  ok('만들기 — 같은 입력이면 같은 배정', JSON.stringify(buildProbePlan(fakeInput()).plan) === JSON.stringify(p));
  ok('만들기 — 다른 브랜드 글 id의 이름은 보지 않음', buildProbePlan(fakeInput({ ...NAMES, 'topic:x-001+x-002': '다른 브랜드 글' })).errors.length === 0);

  const unnamed = buildProbePlan(fakeInput({}));
  ok('이름 없음 — 구조 검사는 통과, 이름 없는 글 3편을 알림, 이름은 빈 칸', unnamed.errors.length === 0 && unnamed.missingNames.join() === [A1.id, A2.id, B1.id].join() && unnamed.plan?.rounds.every((r) => r.articles.every((a) => a.name === '')) === true);
  const partly = buildProbePlan(fakeInput({ [A1.id]: '원도심 1차 글' }));
  ok('이름 일부 — 있는 이름은 검사(실험 용어), 없는 이름은 따로 알림', partly.errors.some((e) => e.includes("'1차'")) && partly.missingNames.length === 2);

  type Input = ReturnType<typeof fakeInput>;
  const bad: [string, (i: Input) => unknown, string][] = [
    ['설계 브랜드가 다름', (i) => (i.design.tenantId = 'other'), '설계의 브랜드'],
    ['설계 판이 다름', (i) => (i.design.bankVersion = 'v8'), '설계의 판'],
    ['질문지 판이 다름', (i) => (i.bank.version = 'v8'), '질문지의 판'],
    ['역할 없는 이름 없는 질문', (i) => i.bank.questions.push({ questionId: 'c1-010', text: '가상시 숙소 조식 어때?', category: 'category-agnostic' }), '역할이 없는'],
    ['대조 질문이 글에도 있음', (i) => i.assignment.controlIds.push('c1-001'), '역할이 둘'],
    ['이름 넣은 질문에 역할', (i) => i.assignment.controlIds.push('v9-001'), '이름 없는 질문이 아닙니다'],
    ['질문지에 없는 질문', (i) => i.assignment.controlIds.push('c1-999'), '이름 없는 질문이 아닙니다'],
    ['배정 뒤 질문지 문장이 바뀜', (i) => (i.bank.questions.find((q) => q.questionId === 'c1-004')!.text += '?'), '배정표 문장과 다릅니다'],
    ['차수 질문 목록이 글과 다름', (i) => i.assignment.rounds[0].questionIds.push('c1-004'), '질문 목록이'],
    ['모르는 차수', (i) => (i.assignment.rounds[0].arm = 'round3'), 'round1 · round2가 아닙니다'],
    ['같은 차수 두 번', (i) => (i.assignment.rounds[0].arm = 'round1'), '두 번'],
    ['0차 글 id가 질문과 다름', (i) => (i.design.zeroth.article = 'topic:c1-008'), '0차 글 id'],
    ['홀드아웃 원래 질문이 holdoutSources에 없음', (i) => (i.assignment.rounds[1].holdoutSources = []), 'holdoutSources'],
    ['홀드아웃 질문이 글에 있음', (i) => {
      const r1 = i.assignment.rounds[1];
      r1.articles[1].questionIds.push('v9-p006');
      r1.questionIds.push('v9-p006');
    }, '역할이 둘'],
    ['배정표 제외 이유를 모름', (i) => (i.assignment.excluded[0].reason = '보류: 나중에'), '이유를 알 수 없습니다'],
    ['배정표 0차가 설계 0차에 없음', (i) => i.assignment.excluded.push({ id: 'c1-004', reason: `0차 추가 글이 맡음: ${ZERO.id}` }), '설계 0차 글에 없습니다'],
    ['배정표 홀드아웃이 질문지 홀드아웃이 아님', (i) => i.assignment.excluded.push({ id: 'v9-p005', reason: '홀드아웃(v9-p002 바꿔 쓰기)' }), '질문지의 홀드아웃'],
    ['네이버 블로그 채널', (i) => (i.assignment.rounds[0].articles[0].channel = '네이버 블로그'), '채널'],
    ['이름에 실험 용어', (i) => (i.names[B1.id] = '주차 · 기념일 대조 글'), "'대조'"],
    ['이름 61자', (i) => (i.names[B1.id] = '가'.repeat(61)), '60'],
    ['이름 앞뒤 공백', (i) => (i.names[B1.id] = ` ${B1.name}`), '공백'],
  ];
  for (const [label, mutate, needle] of bad) {
    const input = fakeInput();
    mutate(input);
    const res = buildProbePlan(input);
    ok(`만들기 실패 — ${label}`, res.errors.length > 0 && res.errors.some((e) => e.includes(needle)));
  }
}

// ── 배정 파일 쓰기(writeProbePlanFile) · 스크립트 — 임시 폴더의 가짜 브랜드 ──────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'verify-probe-plan-'));
try {
  const good = buildProbePlan(fakeInput()).plan!;
  const renamed = buildProbePlan(fakeInput({ ...NAMES, [A1.id]: '원도심 걸어서 다니는 조용한 숙소' })).plan!;
  const tenantDir = path.join(tmp, 'direct', 'data', 'demo-probe');
  mkdirSync(tenantDir, { recursive: true });
  const planFile = path.join(tenantDir, 'probe-plan.json');
  const backupsIn = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('before-probe-plan-'));

  const first = await writeProbePlanFile({ tenantDir, plan: good, now: new Date('2026-11-02T03:04:05.678Z') });
  const firstRaw = readFileSync(planFile, 'utf8');
  ok('파일 쓰기 — 처음이면 백업 없음 · 다시 읽은 배정이 같음', first.backupDir === null && first.file === planFile && JSON.stringify(first.plan) === JSON.stringify(good) && JSON.stringify(parseProbePlan(JSON.parse(firstRaw)).plan) === JSON.stringify(good));
  const second = await writeProbePlanFile({ tenantDir, plan: renamed, now: new Date('2026-11-02T03:04:06.000Z') });
  ok('파일 쓰기 — 백업 폴더 이름 before-probe-plan-<시각>', planBackupDirName(new Date('2026-11-02T03:04:06.000Z')) === 'before-probe-plan-2026-11-02T03-04-06-000Z' && path.basename(second.backupDir ?? '') === 'before-probe-plan-2026-11-02T03-04-06-000Z');
  ok('파일 쓰기 — 있던 파일은 백업에 원문 그대로 · 새 파일은 새 이름', second.backupDir !== null && readFileSync(path.join(second.backupDir, 'probe-plan.json'), 'utf8') === firstRaw && parseProbePlan(JSON.parse(readFileSync(planFile, 'utf8'))).plan?.rounds[0].articles[0].name === '원도심 걸어서 다니는 조용한 숙소');
  const beforeBad = readFileSync(planFile, 'utf8');
  const broken = JSON.parse(JSON.stringify(good)) as ProbePlan;
  broken.rounds[0].articles[0].name = '원도심 실증 글';
  let refused = '';
  try {
    await writeProbePlanFile({ tenantDir, plan: broken, now: new Date('2026-11-02T03:05:00.000Z') });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  ok('파일 쓰기 — 검사를 통과하지 못한 배정은 쓰지 않음(파일 · 백업 그대로)', refused.includes('쓰지 않습니다') && readFileSync(planFile, 'utf8') === beforeBad && backupsIn(tenantDir).length === 1);

  // 스크립트 — 하위 프로세스(tsx). 가짜 프로필의 %APPDATA% 아래에 앱 데이터를 두고(Claude 패키지 폴더도 가짜) 써 보는 확인까지 거친다.
  const profile = path.join(tmp, 'fake-profile');
  mkdirSync(path.join(profile, 'Local', 'Packages', 'Claude_fake', 'LocalCache'), { recursive: true });
  const put = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  };
  const seedApp = (root: string) => put(path.join(root, 'data', 'demo-probe', 'question-bank', 'v9.json'), fakeBank());
  const appRoot = path.join(profile, 'Roaming', 'brand-aeo-app');
  seedApp(appRoot);
  const assignmentFile = put(path.join(tmp, 'assignment.json'), { format: 'proof-assignment/2', seed: SEED, brands: [fakeAssignment()] });
  const designFile = put(path.join(tmp, 'design.json'), { seed: SEED, brands: [fakeDesign()] });
  const namesFile = put(path.join(tmp, 'names.json'), NAMES);
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (root: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/write-probe-plan.ts', '--app-data', root, '--assignment', assignmentFile, '--design', designFile, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
    });
  const scriptTenant = path.join(appRoot, 'data', 'demo-probe');
  const scriptPlan = path.join(scriptTenant, 'probe-plan.json');
  const leftovers = () => readdirSync(scriptTenant).filter((n) => n.startsWith('.probe-write-check-'));

  const dry = run(appRoot);
  ok('스크립트 dry-run — 글 · 역할 수 · 이름 필요 · 이름 틀을 보이고 아무것도 안 씀', dry.status === 0 && dry.stdout.includes('글 3편') && dry.stdout.includes('이름 없는 질문 13개 — 1차 처치 5 · 2차 처치 2 · 대조 2 · 홀드아웃 1 · 대상 아님 1 · 0차 2') && dry.stdout.includes('(이름 필요)') && dry.stdout.includes(`"${A1.id}": ""`) && dry.stdout.includes('dry-run — 아무것도 쓰지 않았습니다') && !existsSync(scriptPlan), `${dry.status} ${dry.stdout}${dry.stderr}`);
  const dryNamed = run(appRoot, 'demo-probe', '--names', namesFile);
  ok('스크립트 dry-run — 이름 파일을 주면 이름을 보이고 틀은 안 찍음 · 아무것도 안 씀', dryNamed.status === 0 && dryNamed.stdout.includes(`이름: ${A1.name}`) && !dryNamed.stdout.includes('이름이 없는 글') && !existsSync(scriptPlan), `${dryNamed.status} ${dryNamed.stderr}`);
  const noNames = run(appRoot, '--write');
  ok('스크립트 --write — 이름이 없으면 거절 · 아무것도 안 씀', noNames.status === 1 && noNames.stderr.includes('이름이 없는 글이 3편') && !existsSync(scriptPlan), `${noNames.status} ${noNames.stderr}`);
  const typo = run(appRoot, '--write', '--names', put(path.join(tmp, 'names-typo.json'), { ...NAMES, 'topic:c1-001+c1-003': '오타 글' }));
  ok('스크립트 --write — 이름 파일에 배정표에 없는 글 id가 있으면 거절', typo.status === 1 && typo.stdout.includes('배정표의 글이 아닙니다') && !existsSync(scriptPlan), `${typo.status} ${typo.stdout}${typo.stderr}`);
  const badName = run(appRoot, '--write', '--names', put(path.join(tmp, 'names-bad.json'), { ...NAMES, [B1.id]: '홀드아웃 숙소' }));
  ok('스크립트 --write — 이름에 실험 용어가 있으면 거절', badName.status === 1 && badName.stdout.includes("'홀드아웃'") && !existsSync(scriptPlan), `${badName.status} ${badName.stdout}${badName.stderr}`);
  const unknownTenant = run(appRoot, 'nobody', '--names', namesFile);
  ok('스크립트 — 배정표에 없는 브랜드는 거절', unknownTenant.status === 1 && unknownTenant.stderr.includes('배정표에 없는 브랜드'), `${unknownTenant.status} ${unknownTenant.stderr}`);

  const written = run(appRoot, '--write', '--names', namesFile);
  const savedRaw = existsSync(scriptPlan) ? readFileSync(scriptPlan, 'utf8') : '';
  const goodScript = buildProbePlan({ ...fakeInput(), assignmentSource: assignmentFile }).plan;
  ok('스크립트 --write — 써 보는 확인 뒤 쓰고, 다시 읽은 배정이 buildProbePlan과 같음 · 백업 없음 · 표지 파일 없음', written.status === 0 && written.stdout.includes(`쓰기 확인: ${scriptTenant}`) && written.stdout.includes(`저장: ${scriptPlan}`) && JSON.stringify(parseProbePlan(JSON.parse(savedRaw || 'null')).plan) === JSON.stringify(goodScript) && backupsIn(scriptTenant).length === 0 && leftovers().length === 0, `${written.status} ${written.stdout}${written.stderr}`);
  ok('스크립트 --write — 질문지는 그대로', readFileSync(path.join(scriptTenant, 'question-bank', 'v9.json'), 'utf8') === JSON.stringify(fakeBank(), null, 2));
  const rewritten = run(appRoot, '--write', '--names', put(path.join(tmp, 'names-2.json'), { ...NAMES, [A1.id]: '원도심 걸어서 다니는 조용한 숙소' }));
  const rewriteBackups = backupsIn(scriptTenant);
  ok('스크립트 --write 다시 — 있던 파일을 before-probe-plan-<시각>/에 백업한 뒤 바꿔 씀', rewritten.status === 0 && rewriteBackups.length === 1 && readFileSync(path.join(scriptTenant, rewriteBackups[0], 'probe-plan.json'), 'utf8') === savedRaw && parseProbePlan(JSON.parse(readFileSync(scriptPlan, 'utf8'))).plan?.rounds[0].articles[0].name === '원도심 걸어서 다니는 조용한 숙소', `${rewritten.status} ${rewritten.stdout}${rewritten.stderr}`);

  // 가상화 사본처럼 보이는 경로 — 같은 가짜 데이터를 Packages\Claude_…\ 아래에 둔다.
  const virtualRoot = path.join(tmp, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app');
  seedApp(virtualRoot);
  const virtual = run(virtualRoot, '--write', '--names', namesFile);
  ok('스크립트 --write — 가상화 사본 경로면 거절 · 아무것도 안 씀', virtual.status === 1 && virtual.stderr.includes('가상화 사본') && !existsSync(path.join(virtualRoot, 'data', 'demo-probe', 'probe-plan.json')), `${virtual.status} ${virtual.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
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
