/**
 * 작성자 배정(scripts/writer-plan.ts)과 운영 모드 배정 파일 형식(src/lib/probePlan.ts probe-plan/2)을 확인한다. 서버 · AI는 부르지 않고,
 * 파일은 임시 폴더의 가짜 브랜드에만 쓴다(스크립트는 하위 프로세스로 돌린다). 가짜 질문지의 브랜드 · 질문은 모두 가짜다.
 *
 * 왜: 브랜드마다 작성자 8명이 10편씩 80편을 나눠 쓴다. 같은 질문 조합의 글이 둘이면 글 id가 부딪히고(추가 글 · 초안 · 올린 기록이 id로
 * 붙는다), 한 작성자가 같은 질문(바꿔 쓴 질문 포함)을 두 번 맡으면 한 사람이 같은 글을 두 번 쓰고, 질문마다 글 수가 고르지 않으면 어떤
 * 질문은 글이 몰리고 어떤 질문은 빈다. 규칙은 배정을 만든 함수(checkWriterRules)와 별개로 이 파일이 다시 센다.
 *
 * 실제 질문지(설계 docs/proof/design.json의 브랜드)는 --app-data(없으면 %APPDATA%/brand-aeo-app)에서 읽기만 한다. 없으면 그 검사는
 * 건너뛴다고 찍는다(통과로 세지 않는다).
 *
 *   npx tsx scripts/verify-writer-plan.ts [--app-data "<userData>"]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  allocateQuestions,
  buildWriterPlan,
  checkWriterRules,
  intentsOf,
  newestBankVersion,
  paraphrasePairs,
  PER_WRITER,
  suggestName,
  WRITER_ACTIVE_UNTIL,
  WRITER_PLAN_SEED,
  writerHandouts,
  writerPlanBackupDirName,
  writerPool,
  writeWriterPlanFile,
  type BankQuestion,
  type Cluster,
  type PoolQuestion,
  type WriterPlanBuild,
  type WriterPlanInput,
  type WriterSpec,
} from './writer-plan';
import { checkNewExtraArticle, topicArticleId } from '../src/lib/extraArticles';
import { extraArticleCap, parseWriterPlan, planWriters, PROBE_NAME_BANNED, topicGuard, type WriterPlan } from '../src/lib/probePlan';

const checks: [string, boolean, string | undefined][] = [];
/** detail은 실패했을 때만 찍는다(하위 프로세스 출력 등). */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);
const notes: string[] = [];

// ── 가짜 질문지 ─────────────────────────────────────────────────────────────
const STAGES = ['learn', 'consider', 'decide'] as const;
const pad = (i: number) => String(i).padStart(3, '0');

/**
 * 가짜 질문지 — 이름 없는 질문 base개(c1-…)와 실증 질문 probes개(<판>-p…), 그 가운데 뒤 twins개는 앞 twins개를 바꿔 쓴 질문(같은 주제 ·
 * 단계). 브랜드 질문 3개(category brand-direct)는 글을 쓸 질문이 아니다. marks가 false면 probe · paraphraseOf 표시를 뗀다(승격 뒤 판).
 */
function fakeBank(version: string, base: number, probes: number, twins: number, marks = true): { version: string; questions: BankQuestion[] } {
  const qs: BankQuestion[] = [];
  for (let i = 1; i <= base; i += 1) {
    qs.push({ questionId: `c1-${pad(i)}`, text: `가상시 숙소 질문 ${i}번은 어때?`, category: 'category-agnostic', stage: STAGES[i % 3], topic: `주제 ${i % 7}` });
  }
  for (let i = 1; i <= probes; i += 1) {
    const twinOf = i > probes - twins ? i - (probes - twins) : 0;
    const topic = `덧붙인 주제 ${twinOf || i}`;
    qs.push({
      questionId: `${version}-p${pad(i)}`,
      text: twinOf ? `가상시 덧붙인 질문 ${twinOf}번을 바꿔 물으면?` : `가상시 덧붙인 질문 ${i}번은 어때?`,
      category: 'category-agnostic',
      stage: STAGES[(twinOf || i) % 3],
      topic,
      ...(marks ? { probe: true } : {}),
      ...(marks && twinOf ? { paraphraseOf: `${version}-p${pad(twinOf)}` } : {}),
    });
  }
  for (let i = 1; i <= 3; i += 1) qs.push({ questionId: `${version}-${pad(i)}`, text: `가상펜션 ${i}번 질문`, category: 'brand-direct' });
  return { version, questions: qs };
}
/** 승격처럼 실증 표시(probe · paraphraseOf)만 뗀다 — id · 문장 · 주제 · 단계는 그대로. */
function unmark(q: BankQuestion): BankQuestion {
  const next = { ...q };
  delete next.probe;
  delete next.paraphraseOf;
  return next;
}

const WRITERS: WriterSpec[] = [
  ['가족 여행', '아이나 부모님과 함께 가는 가족 여행자의 눈으로 정리'],
  ['커플 여행', '둘이 가는 여행자의 눈으로 정리'],
  ['혼자 여행', '혼자 가는 여행자의 눈으로 정리'],
  ['처음 가는 사람', '처음 가는 사람의 눈으로 정리'],
  ['코스 · 일정표', '일정표를 짜듯이 정리'],
  ['비용 · 예약 정리', '비용과 예약의 관점에서 정리'],
  ['준비 체크리스트', '체크리스트처럼 정리'],
  ['계절별', '계절과 시기에 따라 정리'],
].map(([label, angle], i) => ({ key: `w${i + 1}`, name: `가상 작성자 ${i + 1}`, label: label!, angle: angle!, blog: i % 2 ? `https://blog.example.com/w${i + 1}` : '' }));

/** 가짜 브랜드 하나의 배정 입력. */
interface Case {
  label: string;
  input: WriterPlanInput;
  /** 같은 의미 묶음 짝의 최소 기대(모든 질문이 최소 글 수일 때 묶음 안에서 만들 수 있는 짝 수). */
  clusterFloor: number;
}
const C = (name: string, ids: string[]): Cluster => ({ name, ids });
function inputOf(tenantId: string, bank: { version: string; questions: BankQuestion[] }, excluded: string[], clusters: Cluster[], extra: Partial<WriterPlanInput> = {}): WriterPlanInput {
  const { pool } = writerPool(bank.questions, excluded);
  return {
    tenantId,
    bankVersion: bank.version,
    bank,
    excluded,
    clusters,
    avoid: paraphrasePairs(pool, [bank]),
    writers: WRITERS,
    perWriter: PER_WRITER,
    seed: WRITER_PLAN_SEED,
    activeUntil: WRITER_ACTIVE_UNTIL,
    writersSource: 'docs/writers.json',
    names: {},
    ...extra,
  };
}
/** 묶음 크기 s · 질문마다 최소 글 수 d — 묶음 안에서 만들 수 있는 짝 수의 하한. */
const floorOf = (sizes: number[], d: number) => sizes.reduce((s, n) => s + Math.min((n * (n - 1)) / 2, Math.floor((n * d) / 2)), 0);

// 스테이 꼴: 이름 없는 질문 50(c1 26 + 실증 24, 바꿔 쓴 질문 8) − 대상 아님 10 = 40 → 질문마다 4편.
const bankStay = fakeBank('v9', 26, 24, 8);
const stayExcluded = ['c1-003', 'c1-017', 'c1-019', 'c1-022', 'c1-024', 'c1-002', 'c1-016', 'c1-018', 'c1-020', 'c1-025'];
const stayClusters = [C('원도심 도보', ['c1-001', 'c1-011', 'v9-p009', 'v9-p004']), C('조용한 독채', ['c1-004', 'c1-015', 'v9-p010', 'v9-p003', 'v9-p007']), C('요금', ['c1-023', 'v9-p013']), C('후기', ['c1-026', 'v9-p012', 'v9-p015'])];
// 관광 꼴: 48(c1 22 + 실증 26, 바꿔 쓴 질문 8) → 3~4편.
const bankTour = fakeBank('v7', 22, 26, 8);
const tourClusters = [C('정보 채널', ['c1-006', 'c1-010', 'c1-011']), C('지도', ['c1-007', 'v7-p018']), C('도보', ['c1-004', 'v7-p001']), C('일정', ['c1-002', 'c1-012', 'v7-p007']), C('먹거리', ['c1-008', 'v7-p005', 'v7-p014']), C('계절', ['c1-003', 'v7-p010', 'v7-p011', 'v7-p013'])];
const cases: Case[] = [
  { label: '스테이 꼴(40개 · 4편씩)', input: inputOf('demo-stay', bankStay, stayExcluded, stayClusters), clusterFloor: floorOf([4, 5, 2, 3], 4) },
  { label: '관광 꼴(48개 · 3~4편)', input: inputOf('demo-tour', bankTour, [], tourClusters), clusterFloor: floorOf([3, 2, 2, 3, 3, 4], 3) },
  { label: '37개 · 4~5편 · 바꿔 쓴 질문 없음', input: inputOf('demo-37', fakeBank('v3', 37, 0, 0), [], [C('앞', ['c1-001', 'c1-002', 'c1-003'])]), clusterFloor: floorOf([3], 4) },
  { label: '20개 · 8편씩(작성자 수와 같음)', input: inputOf('demo-20', fakeBank('v2', 20, 0, 0), [], []), clusterFloor: 0 },
];

/** 규칙을 checkWriterRules와 따로 센다 — 위반 문장 목록. */
function independentRules(build: WriterPlanBuild, input: WriterPlanInput): string[] {
  const out: string[] = [];
  const plan = build.plan!;
  const pool = new Set(build.pool.map((q) => q.questionId));
  const twin = new Map<string, string>();
  for (const [a, b] of input.avoid) {
    twin.set(a, b);
    twin.set(b, a);
  }
  const meaning = (q: string) => [q, twin.get(q) ?? q].sort()[0]!;
  const ids = plan.articles.map((a) => a.id);
  if (new Set(ids).size !== ids.length) out.push('같은 글 id');
  const meanings = plan.articles.map((a) => a.questionIds.map(meaning).sort().join('+'));
  if (new Set(meanings).size !== meanings.length) out.push('같은 뜻 조합');
  for (const a of plan.articles) {
    if (a.questionIds.length !== 2 || a.questionIds[0] === a.questionIds[1]) out.push(`${a.id} 질문 2개 아님`);
    if (a.questionIds.some((q) => !pool.has(q) || input.excluded.includes(q))) out.push(`${a.id} 글을 쓸 질문 밖`);
    if (meaning(a.questionIds[0]!) === meaning(a.questionIds[1]!)) out.push(`${a.id} 바꿔 쓴 짝을 한 글에`);
    if (a.id !== topicArticleId(a.questionIds)) out.push(`${a.id} id`);
  }
  for (let x = 0; x < plan.articles.length; x += 1) {
    for (let y = x + 1; y < plan.articles.length; y += 1) {
      const shared = plan.articles[x]!.questionIds.filter((q) => plan.articles[y]!.questionIds.includes(q)).length;
      if (shared > 1) out.push(`겹침 ${shared}: ${plan.articles[x]!.id} · ${plan.articles[y]!.id}`);
    }
  }
  for (const w of input.writers) {
    const mine = plan.articles.filter((a) => a.writer.key === w.key);
    if (mine.length !== input.perWriter) out.push(`${w.key} ${mine.length}편`);
    const qs = mine.flatMap((a) => a.questionIds);
    if (new Set(qs).size !== qs.length) out.push(`${w.key} 같은 질문 두 번`);
    if (new Set(qs.map(meaning)).size !== qs.length) out.push(`${w.key} 같은 뜻 두 번`);
    if (mine.some((a) => a.angle !== w.angle || a.blog !== w.blog || a.writer.name !== w.name)) out.push(`${w.key} 각도 · 블로그 · 이름`);
  }
  const counts = build.pool.map((q) => plan.articles.filter((a) => a.questionIds.includes(q.questionId)).length);
  if (Math.max(...counts) - Math.min(...counts) > 1) out.push(`글 수 ${Math.min(...counts)}~${Math.max(...counts)}`);
  if (counts.reduce((s, c) => s + c, 0) !== input.writers.length * input.perWriter * 2) out.push('칸 수');
  const names = plan.articles.map((a) => a.name);
  if (new Set(names).size !== names.length) out.push('같은 이름');
  for (const a of plan.articles) {
    if (a.name.length > 60) out.push(`${a.id} 이름 60자 넘음`);
    if (PROBE_NAME_BANNED.some((w) => a.name.includes(w))) out.push(`${a.id} 실험 용어`);
    const c = checkNewExtraArticle({ id: a.id, name: a.name, angle: a.angle, bankVersion: plan.bankVersion, questionIds: a.questionIds, questionTexts: a.questionTexts }, [], '2026-11-02T00:00:00.000Z');
    if (!c.ok) out.push(`${a.id} 추가 글 검사: ${c.error}`);
  }
  return out;
}

// ── 배정 — 가짜 질문지 ─────────────────────────────────────────────────────
for (const c of cases) {
  const build = buildWriterPlan(c.input);
  const plan = build.plan;
  ok(`${c.label} — 배정 만듦 · 오류 없음`, plan !== null && build.errors.length === 0, build.errors.join(' / '));
  if (!plan) continue;
  const bad = independentRules(build, c.input);
  ok(`${c.label} — 규칙 (1)~(5) · 같은 뜻 · 이름 · 추가 글 검사를 따로 세어 위반 0`, bad.length === 0, bad.join(' / '));
  ok(`${c.label} — 글 80편 · 작성자 8명 × 10편 · 보고서 위반 0 · 겹침 최대 1`, plan.articles.length === 80 && build.report!.violations.length === 0 && build.report!.maxOverlap === 1 && build.report!.perWriter.every((w) => w.articles === 10 && w.questions === 20));
  ok(`${c.label} — 같은 의미 묶음 짝이 하한 이상(${c.clusterFloor})`, build.report!.kinds.cluster >= c.clusterFloor, `${build.report!.kinds.cluster}`);
  ok(`${c.label} — parseWriterPlan 통과 · 다시 읽어도 같음`, JSON.stringify(parseWriterPlan(JSON.parse(JSON.stringify(plan))).plan) === JSON.stringify(plan));
  ok(`${c.label} — 앱이 배정 글 80편을 모두 허용 · 추가 글 상한 80편(운영 기간)`, extraArticleCap(plan, '2026-11-03') === 80 && plan.articles.every((a) => topicGuard(plan, false, plan.bankVersion, a.id, '2026-11-03') === null));
  const again = buildWriterPlan(c.input);
  ok(`${c.label} — 같은 입력이면 같은 배정(결정적)`, JSON.stringify(again.plan) === JSON.stringify(plan) && JSON.stringify(again.report) === JSON.stringify(build.report));
}
{
  const [stay] = cases;
  const base = buildWriterPlan(stay!.input).plan!;
  const otherSeed = buildWriterPlan({ ...stay!.input, seed: WRITER_PLAN_SEED + 1 }).plan;
  ok('시드가 다르면 다른 배정 · 그래도 규칙 위반 0', otherSeed !== null && JSON.stringify(otherSeed.articles) !== JSON.stringify(base.articles) && independentRules(buildWriterPlan({ ...stay!.input, seed: WRITER_PLAN_SEED + 1 }), stay!.input).length === 0);
  const otherTenant = buildWriterPlan({ ...stay!.input, tenantId: 'demo-stay-2' }).plan;
  ok('브랜드가 다르면 같은 시드라도 다른 난수(FNV-1a("<seed>:<tenantId>"))', otherTenant !== null && JSON.stringify(otherTenant.articles.map((a) => a.id)) !== JSON.stringify(base.articles.map((a) => a.id)));
  ok('대상 아님 10개는 어느 글에도 없음 · 브랜드 질문(brand-direct)도 없음', base.articles.every((a) => a.questionIds.every((q) => !stayExcluded.includes(q) && !/^v9-\d+$/.test(q))));
  ok('파일 모양 — format probe-plan/2 · 판 · 운영 기간 · 출처', base.format === 'probe-plan/2' && base.bankVersion === 'v9' && base.activeUntil === '2027-03-31' && base.source.writers === 'docs/writers.json' && base.source.seed === WRITER_PLAN_SEED);
  ok('글 순서 — 작성자 순(w1 … w8), 작성자 안에서는 질문지 순', planWriters(base).map((w) => w.key).join(',') === WRITERS.map((w) => w.key).join(',') && WRITERS.every((w) => base.articles.filter((a) => a.writer.key === w.key).length === 10));
  const clusterNamed = base.articles.filter((a) => stayClusters.some((c) => a.questionIds.every((q) => c.ids.includes(q))));
  // 한 작성자가 같은 묶음의 글을 둘 맡으면 둘째는 「주제 · 주제」로 비켜 간다 — 그래서 묶음 이름의 글이 그 작성자에게 하나는 있는지 본다.
  const labelOf = (key: string) => WRITERS.find((w) => w.key === key)!.label;
  ok(
    '이름 — 같은 의미 묶음 글은 「묶음 이름 (작성자 label)」(한 작성자 안에서 겹치면 둘째부터 주제 이름) · 모두 (label)로 끝남',
    clusterNamed.length > 0 &&
      clusterNamed.every((a) => {
        const c = stayClusters.find((x) => a.questionIds.every((q) => x.ids.includes(q)))!;
        return base.articles.some((b) => b.writer.key === a.writer.key && b.name === `${c.name} (${labelOf(a.writer.key)})`);
      }) &&
      base.articles.every((a) => a.name.endsWith(`(${labelOf(a.writer.key)})`)),
    clusterNamed.map((a) => a.name).join(' / '),
  );
  ok('각도 — 작성자 angle 그대로(추가 글의 다룰 각도)', base.articles.every((a) => a.angle === WRITERS.find((w) => w.key === a.writer.key)!.angle));

  // 이름 덮어쓰기
  const target = base.articles[3]!;
  const renamed = buildWriterPlan({ ...stay!.input, names: { [target.id]: '원도심 숙소 고르는 법' } });
  ok('--names — 그 글 이름만 바뀜 · 다른 글은 그대로', renamed.plan?.articles.find((a) => a.id === target.id)?.name === '원도심 숙소 고르는 법' && renamed.overridden === 1 && renamed.plan!.articles.filter((a) => a.id !== target.id).every((a) => a.name === base.articles.find((b) => b.id === a.id)!.name));
  const stray = buildWriterPlan({ ...stay!.input, names: { 'topic:c1-001+c1-003': '없는 글' } });
  ok('--names — 배정에 없는 글 id는 거절', stray.plan === null && stray.errors.some((e) => e.includes('이 브랜드 배정의 글이 아닙니다')), stray.errors.join(' / '));
  const banned = buildWriterPlan({ ...stay!.input, names: { [target.id]: '홀드아웃 숙소' } });
  ok('--names — 실험 용어는 거절', banned.plan === null && banned.errors.some((e) => e.includes("'홀드아웃'")), banned.errors.join(' / '));
  const taken = buildWriterPlan({ ...stay!.input, names: { [target.id]: base.articles[5]!.name } });
  ok('--names — 다른 글의 제안 이름을 쓰면 그 글의 제안이 비켜 감(이름은 모두 다름)', taken.plan !== null && taken.plan.articles.find((a) => a.id === target.id)!.name === base.articles[5]!.name && taken.plan.articles[5]!.name !== base.articles[5]!.name, taken.errors.join(' / '));
  const dupName = buildWriterPlan({ ...stay!.input, names: { [target.id]: '같은 이름', [base.articles[5]!.id]: '같은 이름' } });
  ok('--names — 두 글에 같은 이름을 주면 거절', dupName.plan === null && dupName.errors.some((e) => e.includes('주제 이름이 같습니다')), dupName.errors.join(' / '));
  const longName = buildWriterPlan({ ...stay!.input, names: { [target.id]: '가'.repeat(61) } });
  ok('--names — 60자를 넘으면 거절', longName.plan === null && longName.errors.some((e) => e.includes('60자')), longName.errors.join(' / '));
}

// ── 이름 제안 — 긴 주제 ─────────────────────────────────────────────────────
{
  // 주제 + label이 60자를 넘으면 주제를 줄인다. 번호까지 잘라 내면 번호가 달라도 이름이 같아져 번호 붙이기가 끝나지 않았다.
  const q = (id: string, topic: string): PoolQuestion => ({ questionId: id, text: `${id} 가짜 질문`, topic });
  const longTopic = '가상 숙소 주변 관광지와 대중교통 접근성 안내 정리 모음과 주차 및 체크인 시간 안내';
  const label = '비용 · 예약 정리';
  const fit = (names: string[]) => new Set(names).size === names.length && names.every((n) => n.length <= 60 && n.endsWith(`(${label})`));
  const sameUsed = new Set<string>();
  const same = [...Array(12).keys()].map((i) => suggestName(q(`c1-${pad(i * 2)}`, longTopic), q(`c1-${pad(i * 2 + 1)}`, longTopic), label, new Map(), sameUsed));
  ok('이름 제안 — 같은 긴 주제의 글 12편: 끝남 · 이름이 모두 다름 · 60자 이하 · (label)로 끝남', fit(same) && same.slice(1).every((n, i) => n.endsWith(` ${i + 2} (${label})`)), same.join(' / '));
  const pairUsed = new Set<string>();
  const pair = [...Array(6).keys()].map((i) => suggestName(q(`c1-${pad(i * 2)}`, longTopic), q(`c1-${pad(i * 2 + 1)}`, `${longTopic} 두 번째`), label, new Map(), pairUsed));
  ok('이름 제안 — 서로 다른 긴 주제 두 개로 6편(「ta · tb」 · 「tb · ta」를 다 쓴 뒤 번호): 끝남 · 이름이 모두 다름 · 60자 이하', fit(pair), pair.join(' / '));
  const shortUsed = new Set<string>();
  const short = [...Array(3).keys()].map((i) => suggestName(q(`c1-${pad(i * 2)}`, '주차'), q(`c1-${pad(i * 2 + 1)}`, '주차'), label, new Map(), shortUsed));
  ok('이름 제안 — 짧은 주제는 그대로 「주차 (label)」 · 「주차 2 (label)」 · 「주차 3 (label)」', short.join('|') === [`주차 (${label})`, `주차 2 (${label})`, `주차 3 (${label})`].join('|'), short.join(' / '));
}

// ── 입력 검사 ───────────────────────────────────────────────────────────────
{
  const stay = cases[0]!.input;
  const refused = (label: string, input: WriterPlanInput, needle: string) => {
    const b = buildWriterPlan(input);
    ok(`입력 거절 — ${label}`, b.plan === null && b.errors.some((e) => e.includes(needle)), b.errors.join(' / '));
  };
  refused('질문지 판이 배정 판과 다름', { ...stay, bankVersion: 'v8' }, '배정할 판(v8)');
  refused('글을 쓰지 않을 질문이 질문지에 없음', { ...stay, excluded: [...stay.excluded, 'c1-999'] }, 'c1-999');
  refused('의미 묶음의 질문이 질문지에 없음', { ...stay, clusters: [C('없는 묶음', ['c1-001', 'c1-998'])] }, 'c1-998');
  refused('작성자 key가 두 번', { ...stay, writers: WRITERS.map((w, i) => (i === 1 ? { ...w, key: 'w1' } : w)) }, '같은 key');
  refused('작성자 label이 빔', { ...stay, writers: WRITERS.map((w, i) => (i === 2 ? { ...w, label: ' ' } : w)) }, 'label');
  refused('작성자 각도에 실험 용어', { ...stay, writers: WRITERS.map((w, i) => (i === 2 ? { ...w, angle: '대조 질문을 피해서 정리' } : w)) }, '각도에');
  const tooFew = allocateQuestions({ pool: writerPool(fakeBank('v1', 19, 0, 0).questions, []).pool, clusters: [], avoid: [], writers: 8, perWriter: 10, seed: 1 });
  ok('배정 거절 — 질문 19개면 작성자 한 명의 20칸을 서로 다른 질문으로 못 채움', !tooFew.ok && tooFew.error.includes('19개'));
  const twinBank = fakeBank('v1', 0, 20, 10);
  const twinPool = writerPool(twinBank.questions, []).pool;
  const allTwins = allocateQuestions({ pool: twinPool, clusters: [], avoid: paraphrasePairs(twinPool, [twinBank]), writers: 8, perWriter: 10, seed: 1 });
  ok('배정 거절 — 바꿔 쓴 짝으로 뜻이 10개뿐이면(뜻 조합 45 < 80)', !allTwins.ok && allTwins.error.includes('80개보다 적습니다'), allTwins.ok ? '만들어짐' : allTwins.error);
}

// ── 규칙 검사(checkWriterRules)가 위반을 잡는지 ────────────────────────────
{
  const input = cases[0]!.input;
  const build = buildWriterPlan(input);
  const plan = build.plan!;
  const rows = () => plan.articles.map((a) => ({ id: a.id, writerKey: a.writer.key, questionIds: [...a.questionIds] }));
  const rule = (articles: ReturnType<typeof rows>) => checkWriterRules({ pool: build.pool, avoid: input.avoid, writerKeys: WRITERS.map((w) => w.key), perWriter: 10, articles });
  ok('규칙 검사 — 만든 배정은 위반 0', rule(rows()).length === 0);
  const dup = rows();
  dup[1] = { ...dup[0]!, writerKey: dup[1]!.writerKey };
  ok('규칙 검사 — 같은 조합 글 두 번 → (1)', rule(dup).some((v) => v.startsWith('(1) 같은 질문 조합')));
  const moved = rows();
  moved[0] = { ...moved[0]!, writerKey: 'w2' };
  ok('규칙 검사 — 작성자 편수가 9 · 11 → (5)', rule(moved).some((v) => v.includes('(5) 작성자 w1의 글이 9편')) && rule(moved).some((v) => v.includes('(5) 작성자 w2의 글이 11편')));
  const w1 = rows().filter((a) => a.writerKey === 'w1');
  const repeat = rows().map((a) => (a.id === w1[1]!.id ? { ...a, questionIds: [w1[0]!.questionIds[0]!, a.questionIds[1]!].sort(), id: topicArticleId([w1[0]!.questionIds[0]!, a.questionIds[1]!]) } : a));
  ok('규칙 검사 — 한 작성자가 같은 질문 두 번 → (3)', rule(repeat).some((v) => v.startsWith('(3) 작성자 w1가 같은 질문')), rule(repeat).join(' / '));
  const [p, q] = input.avoid[0]!;
  const twinArticle = rows();
  twinArticle[0] = { ...twinArticle[0]!, questionIds: [p, q].sort(), id: topicArticleId([p, q]) };
  ok('규칙 검사 — 바꿔 쓴 짝을 한 글에 → 같은 뜻', rule(twinArticle).some((v) => v.includes('바꿔 쓴 질문 짝(같은 뜻)을 한 글에')));
  // p가 든 글의 p를 q로 바꾸면 같은 뜻 조합이 생기거나 같은 작성자가 같은 뜻을 두 번 맡는다.
  const withP = rows().filter((a) => a.questionIds.includes(p));
  const swapped = rows().map((a) => (a.id === withP[0]!.id ? { ...a, questionIds: a.questionIds.map((x) => (x === p ? q : x)).sort(), id: topicArticleId(a.questionIds.map((x) => (x === p ? q : x))) } : a));
  ok('규칙 검사 — 질문 하나를 바꿔 쓴 짝으로 바꾸면 글 수가 고르지 않음(4)', rule(swapped).some((v) => v.startsWith('(4)')), rule(swapped).join(' / '));
  const intents = intentsOf(build.pool.map((x) => x.questionId), input.avoid);
  ok('같은 뜻 — 바꿔 쓴 짝은 같은 번호, 나머지는 자기 번호', input.avoid.every(([a, b]) => intents[build.pool.findIndex((x) => x.questionId === a)] === intents[build.pool.findIndex((x) => x.questionId === b)]) && new Set(intents).size === build.pool.length - input.avoid.length);
}

// ── 바꿔 쓴 짝 · 판 고르기 ─────────────────────────────────────────────────
{
  const marked = fakeBank('v9', 26, 24, 8);
  const promoted = fakeBank('v10', 26, 24, 8, false);
  // 승격 뒤 판(v10)은 id가 v9-p…가 아니라 v10-p…라 같은 id가 없다 — 실제 승격은 id를 그대로 두므로, v9 문항을 표시만 떼어 v10으로 쓴다.
  const promotedSameIds = { version: 'v10', questions: marked.questions.map(unmark) };
  const pool = writerPool(promotedSameIds.questions, []).pool;
  ok('바꿔 쓴 짝 — 표시가 있는 판에서 8쌍', paraphrasePairs(writerPool(marked.questions, []).pool, [marked]).length === 8);
  ok('바꿔 쓴 짝 — 승격 뒤 판(표시 없음)은 옛 판에서 같은 id · 문장으로 찾음', JSON.stringify(paraphrasePairs(pool, [promotedSameIds, marked])) === JSON.stringify(paraphrasePairs(writerPool(marked.questions, []).pool, [marked])) && paraphrasePairs(pool, [promotedSameIds]).length === 0);
  const edited = { version: 'v9', questions: marked.questions.map((x) => (x.questionId === 'v9-p017' ? { ...x, text: '다른 질문이 된 문장' } : x)) };
  ok('바꿔 쓴 짝 — 옛 판 문장이 다르면 짝으로 보지 않음', paraphrasePairs(pool, [edited]).length === 7);
  ok('바꿔 쓴 짝 — 다른 id 체계의 판은 짝을 주지 않음', paraphrasePairs(pool, [promoted]).length === 0);
  ok('판 고르기 — 가장 높은 v<N>(v10 > v9 > v2), 숫자가 아닌 판은 보지 않음', newestBankVersion(['v2', 'v10', 'v9', 'draft', 'c1']) === 'v10' && newestBankVersion(['draft']) === null);
  const before = buildWriterPlan(inputOf('demo-stay', marked, stayExcluded, stayClusters)).plan!;
  const afterInput = inputOf('demo-stay', promotedSameIds, stayExcluded, stayClusters);
  const after = buildWriterPlan({ ...afterInput, avoid: paraphrasePairs(writerPool(promotedSameIds.questions, stayExcluded).pool, [promotedSameIds, marked]) }).plan!;
  ok('승격 전후 같은 배정 — 판 이름만 다르고 글 · 작성자 · 이름은 같음', JSON.stringify(after.articles) === JSON.stringify(before.articles) && after.bankVersion === 'v10' && before.bankVersion === 'v9');
}

// ── 읽기(parseWriterPlan) 거절 ─────────────────────────────────────────────
{
  const plan = buildWriterPlan(cases[0]!.input).plan!;
  type Raw = Record<string, unknown> & { articles: Record<string, unknown>[] };
  const raw = () => JSON.parse(JSON.stringify(plan)) as Raw;
  const refused = (label: string, edit: (r: Raw) => void, needle: string) => {
    const r = raw();
    edit(r);
    const p = parseWriterPlan(r);
    ok(`읽기 거절 — ${label}`, p.error !== undefined && p.error.includes(needle), p.error ?? '통과함');
  };
  refused('형식이 probe-plan/1', (r) => (r.format = 'probe-plan/1'), '형식이 probe-plan/2');
  refused('운영 기간이 없는 날', (r) => (r.activeUntil = '2027-02-30'), 'activeUntil');
  refused('출처 시드가 숫자가 아님', (r) => (r.source = { writers: 'docs/writers.json', seed: '1' }), 'source');
  refused('글이 없음', (r) => (r.articles = []), '글(articles)이 없습니다');
  refused('글 id가 질문 조합과 다름', (r) => (r.articles[0]!.id = 'topic:c1-001+c1-004'), '정렬한 질문 id');
  refused('질문 id가 정렬되지 않음', (r) => {
    const a = r.articles[0]!;
    a.questionIds = [...(a.questionIds as string[])].reverse();
    a.questionTexts = [...(a.questionTexts as string[])].reverse();
  }, '정렬한 질문 id');
  refused('이름에 실험 용어', (r) => (r.articles[0]!.name = '실증 숙소 글'), "'실증'");
  refused('이름 앞뒤 공백', (r) => (r.articles[0]!.name = ` ${r.articles[0]!.name as string}`), '공백');
  refused('각도가 없음', (r) => (r.articles[0]!.angle = ''), '각도가 없습니다');
  refused('각도에 실험 용어', (r) => (r.articles[0]!.angle = '처치 글로 정리'), "'처치'");
  refused('이름 + 각도가 브리프 한 줄을 넘음', (r) => (r.articles[0]!.angle = '각'.repeat(195)), '합쳐서');
  refused('작성자 key가 틀림', (r) => (r.articles[0]!.writer = { key: 'w 1', name: '가상 작성자 1' }), 'writer.key');
  refused('같은 작성자 key인데 이름이 다름', (r) => (r.articles[1]!.writer = { key: 'w1', name: '다른 사람' }), '이름이나 블로그가 글마다 다릅니다');
  refused('같은 작성자 key인데 블로그가 다름', (r) => (r.articles[1]!.blog = 'https://other.example.com'), '이름이나 블로그가 글마다 다릅니다');
  refused('같은 글 id 두 번', (r) => r.articles.push({ ...r.articles[0]!, name: '다른 이름의 같은 글' }), '같은 질문 조합의 글이 두 번');
  refused('두 글의 이름이 같음', (r) => (r.articles[1]!.name = r.articles[0]!.name), '주제 이름이 같습니다');
  refused('같은 질문 id의 문장이 글마다 다름', (r) => {
    const qid = (r.articles[0]!.questionIds as string[])[0]!;
    const other = r.articles.find((a, i) => i > 0 && (a.questionIds as string[]).includes(qid))!;
    (other.questionTexts as string[])[(other.questionIds as string[]).indexOf(qid)] = '바뀐 문장';
  }, '문장이 글마다 다릅니다');
  refused('한 작성자가 같은 질문을 두 글에서', (r) => {
    const a0 = r.articles[0]!;
    const other = r.articles.find((a, i) => i > 0 && a.writer && (a.writer as { key: string }).key !== (a0.writer as { key: string }).key && (a.questionIds as string[]).includes((a0.questionIds as string[])[0]!))!;
    other.writer = a0.writer;
    other.blog = a0.blog;
  }, '두 글에서 맡습니다');
  ok('읽기 — 모르는 키는 버림', !('extra' in (parseWriterPlan({ ...raw(), extra: 1 }).plan as object)));
}

// ── 배정표 · 파일 쓰기 ──────────────────────────────────────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'verify-writer-plan-'));
try {
  const stay = buildWriterPlan(cases[0]!.input);
  const tour = buildWriterPlan(cases[1]!.input);
  const files = writerHandouts(
    [
      { tenantId: 'demo-stay', brandName: '가상스테이', plan: stay.plan!, report: stay.report! },
      { tenantId: 'demo-tour', brandName: '가상관광', plan: tour.plan!, report: tour.report! },
    ],
    WRITERS,
  );
  const fileOf = (name: string) => files.find((f) => f.file === name)?.content ?? '';
  ok('배정표 — 작성자마다 .md · .csv, all.csv, overlap-report.md', files.length === WRITERS.length * 2 + 2 && WRITERS.every((w) => fileOf(`${w.key}.md`) && fileOf(`${w.key}.csv`)) && fileOf('all.csv') !== '' && fileOf('overlap-report.md') !== '');
  const csvRows = fileOf('all.csv').split('\r\n').filter(Boolean);
  ok('배정표 — all.csv: BOM · 머리 1줄 + 160줄 · CRLF', fileOf('all.csv').startsWith('﻿') && csvRows.length === 161 && !/[^\r]\n/.test(fileOf('all.csv')), `${csvRows.length}`);
  const w3 = fileOf('w3.md');
  const w3Articles = [...stay.plan!.articles, ...tour.plan!.articles].filter((a) => a.writer.key === 'w3');
  ok('배정표 — w3.md: 두 브랜드 10편씩 · 글 이름 · 질문 2개 · 각도 · 블로그(미정)', w3.includes('## 가상스테이 (demo-stay · 질문지 v9) — 10편') && w3.includes('## 가상관광 (demo-tour · 질문지 v7) — 10편') && w3Articles.every((a) => w3.includes(a.name) && a.questionTexts.every((t) => w3.includes(t))) && w3.includes(WRITERS[2]!.angle) && w3.includes('블로그: (미정)'));
  ok('배정표 — w2.csv: 머리 + 20줄, 블로그 주소', fileOf('w2.csv').split('\r\n').filter(Boolean).length === 21 && fileOf('w2.csv').includes('https://blog.example.com/w2'));
  ok('배정표 — 겹침 보고서에 브랜드마다 위반 0 · 질문별 글 수 표', (fileOf('overlap-report.md').match(/규칙 위반 0건/g) ?? []).length === 2 && fileOf('overlap-report.md').includes('| 질문 | 글 수 | 작성자 |'));

  // writeWriterPlanFile
  const tenantDir = path.join(tmp, 'direct', 'data', 'demo-stay');
  mkdirSync(tenantDir, { recursive: true });
  const planFile = path.join(tenantDir, 'probe-plan.json');
  const backupsIn = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('before-writer-plan-'));
  const first = await writeWriterPlanFile({ tenantDir, plan: stay.plan!, now: new Date('2026-11-02T03:04:05.678Z') });
  const firstRaw = readFileSync(planFile, 'utf8');
  ok('파일 쓰기 — 처음이면 백업 없음 · 다시 읽은 배정이 같음', first.backupDir === null && JSON.stringify(parseWriterPlan(JSON.parse(firstRaw)).plan) === JSON.stringify(stay.plan));
  const renamedPlan = buildWriterPlan({ ...cases[0]!.input, names: { [stay.plan!.articles[0]!.id]: '원도심 숙소 고르는 법' } }).plan!;
  const second = await writeWriterPlanFile({ tenantDir, plan: renamedPlan, now: new Date('2026-11-02T03:04:06.000Z') });
  ok('파일 쓰기 — 백업 before-writer-plan-<시각>/에 원문 · 새 파일은 새 이름', writerPlanBackupDirName(new Date('2026-11-02T03:04:06.000Z')) === 'before-writer-plan-2026-11-02T03-04-06-000Z' && path.basename(second.backupDir ?? '') === 'before-writer-plan-2026-11-02T03-04-06-000Z' && readFileSync(path.join(second.backupDir!, 'probe-plan.json'), 'utf8') === firstRaw && parseWriterPlan(JSON.parse(readFileSync(planFile, 'utf8'))).plan?.articles[0]!.name === '원도심 숙소 고르는 법');
  const beforeBad = readFileSync(planFile, 'utf8');
  const broken = JSON.parse(JSON.stringify(stay.plan)) as WriterPlan;
  broken.articles[0]!.name = '대조 숙소 글';
  let refused = '';
  try {
    await writeWriterPlanFile({ tenantDir, plan: broken, now: new Date('2026-11-02T03:05:00.000Z') });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  ok('파일 쓰기 — 검사를 통과하지 못한 배정은 쓰지 않음(파일 · 백업 그대로)', refused.includes('쓰지 않습니다') && readFileSync(planFile, 'utf8') === beforeBad && backupsIn(tenantDir).length === 1);
  let sameNow = '';
  try {
    await writeWriterPlanFile({ tenantDir, plan: stay.plan!, now: new Date('2026-11-02T03:04:06.000Z') });
  } catch (err) {
    sameNow = err instanceof Error ? err.message : String(err);
  }
  ok('파일 쓰기 — 같은 시각의 백업이 있으면 덮지 않고 멈춤', sameNow.includes('있는 백업을 덮지 않음') && readFileSync(planFile, 'utf8') === beforeBad && backupsIn(tenantDir).length === 1, sameNow);

  // ── 스크립트 — 하위 프로세스(tsx). 가짜 프로필의 %APPDATA% 아래에 앱 데이터를 두고 써 보는 확인까지 거친다. ──
  const profile = path.join(tmp, 'fake-profile');
  mkdirSync(path.join(profile, 'Local', 'Packages', 'Claude_fake', 'LocalCache'), { recursive: true });
  const put = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  };
  const TENANT = 'demo-writers';
  // v9는 표시가 있는 옛 판, v10은 같은 문항에서 표시만 뗀 새 판(승격 뒤) — 스크립트는 가장 높은 판(v10)을 고르고 짝은 v9에서 찾는다.
  const v9 = fakeBank('v9', 26, 24, 8);
  const v10 = { version: 'v10', questions: v9.questions.map(unmark) };
  const seedApp = (root: string) => {
    put(path.join(root, 'data', TENANT, 'question-bank', 'v9.json'), v9);
    put(path.join(root, 'data', TENANT, 'question-bank', 'v10.json'), v10);
  };
  const appRoot = path.join(profile, 'Roaming', 'brand-aeo-app');
  seedApp(appRoot);
  const designFile = put(path.join(tmp, 'design.json'), { seed: 1, brands: [{ tenantId: TENANT, ineligible: stayExcluded.map((id) => ({ id, reason: '가짜 이유' })), clusters: stayClusters }] });
  const writersFile = put(path.join(tmp, 'writers.json'), { format: 'writers/1', writers: WRITERS });
  const placeholderFile = put(path.join(tmp, 'writers-placeholder.json'), { format: 'writers/1', placeholder: true, writers: WRITERS });
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (root: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/writer-plan.ts', '--app-data', root, '--design', designFile, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
    });
  const scriptTenant = path.join(appRoot, 'data', TENANT);
  const scriptPlan = path.join(scriptTenant, 'probe-plan.json');
  const listing = () => readdirSync(scriptTenant).sort().join(',');
  const pristine = listing();
  const expected = (bank: { version: string; questions: BankQuestion[] }, others: { questions: BankQuestion[] }[]) => {
    const input = inputOf(TENANT, bank, stayExcluded, stayClusters, { writersSource: writersFile });
    return buildWriterPlan({ ...input, avoid: paraphrasePairs(writerPool(bank.questions, stayExcluded).pool, [bank, ...others]) }).plan!;
  };

  const dry = run(appRoot, '--writers', writersFile);
  const dry2 = run(appRoot, '--writers', writersFile);
  ok('스크립트 dry-run — 가장 높은 판(v10) · 짝 8개(옛 판에서) · 위반 0 · 아무것도 안 씀', dry.status === 0 && dry.stdout.includes('question-bank') && dry.stdout.includes('v10.json (가장 높은 판)') && dry.stdout.includes('바꿔 쓴 질문 짝 8개') && dry.stdout.includes('규칙 위반 0건') && dry.stdout.includes('브랜드 목록에 없음') && dry.stdout.includes('dry-run — 앱 데이터에는 아무것도 쓰지 않았습니다') && listing() === pristine, `${dry.status} ${dry.stdout}${dry.stderr}`);
  ok('스크립트 dry-run — 두 번 돌려도 출력이 같음(결정적)', dry.stdout === dry2.stdout);
  const out = path.join(tmp, 'handouts');
  const ho = run(appRoot, '--writers', writersFile, '--out', out);
  ok('스크립트 --out — 배정표 18개를 그 폴더에 · 앱 데이터는 그대로', ho.status === 0 && existsSync(out) && readdirSync(out).length === 18 && readFileSync(path.join(out, 'w1.md'), 'utf8').includes('# w1 · 가상 작성자 1 — 글 10편') && listing() === pristine, `${ho.status} ${ho.stdout}${ho.stderr}`);
  const placeholder = run(appRoot, '--writers', placeholderFile, '--write');
  ok('스크립트 --write — 작성자 설정이 자리표시면 거절 · 아무것도 안 씀', placeholder.status === 1 && placeholder.stderr.includes('자리표시') && !existsSync(scriptPlan), `${placeholder.status} ${placeholder.stderr}`);
  const badFlag = run(appRoot, '--writers', writersFile, '--bank-version', 'v9');
  ok('스크립트 — --bank-version은 <tenantId>=<판> 꼴만', badFlag.status === 1 && badFlag.stderr.includes('<tenantId>=<판>'), `${badFlag.status} ${badFlag.stderr}`);
  for (const until of ['2027-13-40', '2027-02-30', '2027-3-31']) {
    const badUntil = run(appRoot, '--writers', writersFile, '--active-until', until);
    ok(`스크립트 — --active-until ${until}은 안내로 거절(예외 스택 없음) · 아무것도 안 씀`, badUntil.status === 1 && badUntil.stderr.includes(`--active-until은 YYYY-MM-DD여야 합니다: ${until}`) && !badUntil.stderr.includes('RangeError') && listing() === pristine, `${badUntil.status} ${badUntil.stderr}`);
  }
  const unknown = run(appRoot, '--writers', writersFile, '--wirte');
  ok('스크립트 — 모르는 옵션은 거절', unknown.status === 1 && unknown.stderr.includes('모르는 옵션'), `${unknown.status} ${unknown.stderr}`);
  const strayNames = run(appRoot, '--writers', writersFile, '--names', put(path.join(tmp, 'names-stray.json'), { nobody: {} }));
  ok('스크립트 — 이름 파일의 브랜드가 고른 브랜드에 없으면 거절', strayNames.status === 1 && strayNames.stderr.includes('nobody'), `${strayNames.status} ${strayNames.stderr}`);

  const written = run(appRoot, '--writers', writersFile, '--write');
  const savedRaw = existsSync(scriptPlan) ? readFileSync(scriptPlan, 'utf8') : '';
  const want = expected(v10, [v9]);
  ok('스크립트 --write — 써 보는 확인 뒤 쓰고, 다시 읽은 배정이 buildWriterPlan(v10 · 옛 판 짝)과 같음 · 백업 · 표지 파일 없음', written.status === 0 && written.stdout.includes(`쓰기 확인: ${scriptTenant}`) && written.stdout.includes(`저장: ${scriptPlan}`) && JSON.stringify(parseWriterPlan(JSON.parse(savedRaw || 'null')).plan) === JSON.stringify(want) && !readdirSync(scriptTenant).some((n) => n.startsWith('before-writer-plan-') || n.startsWith('.probe-write-check-')), `${written.status} ${written.stdout}${written.stderr}`);
  ok('스크립트 --write — 질문지는 그대로', readFileSync(path.join(scriptTenant, 'question-bank', 'v10.json'), 'utf8') === JSON.stringify(v10, null, 2) && readFileSync(path.join(scriptTenant, 'question-bank', 'v9.json'), 'utf8') === JSON.stringify(v9, null, 2));
  const older = run(appRoot, TENANT, TENANT, '--writers', writersFile, '--bank-version', `${TENANT}=v9`, '--write');
  const backups = readdirSync(scriptTenant).filter((n) => n.startsWith('before-writer-plan-'));
  ok('스크립트 --write --bank-version — 그 판으로 다시 쓰고 있던 파일은 백업(같은 브랜드 두 번은 한 번만)', older.status === 0 && older.stdout.split('저장: ').length === 2 && backups.length === 1 && readFileSync(path.join(scriptTenant, backups[0]!, 'probe-plan.json'), 'utf8') === savedRaw && JSON.stringify(parseWriterPlan(JSON.parse(readFileSync(scriptPlan, 'utf8'))).plan) === JSON.stringify(expected(v9, [v10])), `${older.status} ${older.stdout}${older.stderr}`);
  ok('스크립트 — 판만 다른 배정은 글이 같음(승격 전후 id가 같으므로)', JSON.stringify(expected(v9, [v10]).articles) === JSON.stringify(want.articles));

  const virtualRoot = path.join(tmp, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app');
  seedApp(virtualRoot);
  const virtual = run(virtualRoot, '--writers', writersFile, '--write');
  ok('스크립트 --write — 가상화 사본 경로면 거절 · 아무것도 안 씀', virtual.status === 1 && virtual.stderr.includes('가상화 사본') && !existsSync(path.join(virtualRoot, 'data', TENANT, 'probe-plan.json')), `${virtual.status} ${virtual.stderr}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 실제 질문지(읽기만) ─────────────────────────────────────────────────────
{
  const i = process.argv.indexOf('--app-data');
  const appData = i >= 0 ? process.argv[i + 1] : process.env.APPDATA ? path.join(process.env.APPDATA, 'brand-aeo-app') : undefined;
  const design = JSON.parse(readFileSync(path.resolve('docs', 'proof', 'design.json'), 'utf8')) as { brands: { tenantId: string; ineligible: { id: string }[]; clusters: Cluster[] }[] };
  const writers = JSON.parse(readFileSync(path.resolve('docs', 'writers.json'), 'utf8')) as { format: string; writers: WriterSpec[] };
  ok('docs/writers.json — writers/1 · 작성자 8명 w1…w8 · 각도 8개가 모두 다름', writers.format === 'writers/1' && writers.writers.map((w) => w.key).join(',') === 'w1,w2,w3,w4,w5,w6,w7,w8' && new Set(writers.writers.map((w) => w.label)).size === 8 && new Set(writers.writers.map((w) => w.angle)).size === 8);
  for (const b of design.brands) {
    const bankDir = appData ? path.join(appData, 'data', b.tenantId, 'question-bank') : '';
    const versions = bankDir && existsSync(bankDir) ? readdirSync(bankDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
    const version = newestBankVersion(versions);
    if (!version) {
      notes.push(`실제 질문지 ${b.tenantId}: ${bankDir || '(앱 데이터 경로 없음)'}에 없어 건너뜀`);
      continue;
    }
    const read = (v: string) => JSON.parse(readFileSync(path.join(bankDir, `${v}.json`), 'utf8')) as { version: string; questions: BankQuestion[] };
    const bank = read(version);
    const excluded = b.ineligible.map((e) => e.id);
    const { pool } = writerPool(bank.questions, excluded);
    const input: WriterPlanInput = {
      tenantId: b.tenantId,
      bankVersion: version,
      bank,
      excluded,
      clusters: b.clusters,
      avoid: paraphrasePairs(pool, [bank, ...versions.filter((v) => v !== version).map(read)]),
      writers: writers.writers,
      perWriter: PER_WRITER,
      seed: WRITER_PLAN_SEED,
      activeUntil: WRITER_ACTIVE_UNTIL,
      writersSource: 'docs/writers.json',
      names: {},
    };
    const build = buildWriterPlan(input);
    const r = build.report;
    ok(`실제 ${b.tenantId}(${version}) — 배정 만듦 · 오류 없음`, build.plan !== null, build.errors.join(' / '));
    if (!build.plan || !r) continue;
    const bad = independentRules(build, input);
    ok(`실제 ${b.tenantId}(${version}) — 규칙을 따로 세어 위반 0 · 대상 아님 ${excluded.length}개 빠짐`, bad.length === 0 && build.plan.articles.every((a) => a.questionIds.every((q) => !excluded.includes(q))), bad.join(' / '));
    const sizes = b.clusters.map((c) => c.ids.filter((id) => pool.some((q) => q.questionId === id)).length);
    ok(`실제 ${b.tenantId}(${version}) — 같은 의미 묶음 짝이 하한 이상`, r.kinds.cluster >= floorOf(sizes, r.min), `${r.kinds.cluster} < ${floorOf(sizes, r.min)}`);
    ok(`실제 ${b.tenantId}(${version}) — 같은 입력이면 같은 배정`, JSON.stringify(buildWriterPlan(input).plan) === JSON.stringify(build.plan));
    notes.push(`실제 ${b.tenantId}(${version}): 질문 ${r.questions}개 · 글 ${r.articles}편 · 질문마다 ${r.min}~${r.max}편 · 같은 의미 묶음 ${r.kinds.cluster} · 같은 주제 ${r.kinds.topic} · 같은 단계 ${r.kinds.stage} · 그 밖 ${r.kinds.other} · 바꿔 쓴 짝 ${input.avoid.length}`);
  }
}

let failed = 0;
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass && detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`);
  if (!pass) failed += 1;
}
for (const n of notes) console.log(`· ${n}`);
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
