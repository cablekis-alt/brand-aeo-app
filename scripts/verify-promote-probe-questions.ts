/**
 * 실증 질문 올리기(scripts/promote-probe-questions.ts)를 확인한다. AI는 부르지 않고(USE_MOCK_ENGINES · 키 비움), 파일은 임시 폴더의
 * 가짜 브랜드에만 쓴다(스크립트는 하위 프로세스로도 돌린다). 브랜드 · 질문은 모두 가짜다.
 *
 * 왜: 올린 판 파일을 다음 측정이 그대로(문항 전부) 재야 한다. 측정이 질문지를 새로 만들거나 자르면(설정의 questionBankSize보다 문항이
 * 많고, 코호트 출처가 어긋나면 멈춘다) 점수 · 추가 글이 다른 질문을 본다. 그래서 실제 질문지 결정 함수(server/pipeline.ts
 * ensureQuestionBank)를 불러, 코호트 공통 질문지를 쓰는 브랜드 · 쓰지 않는 브랜드 모두 저장된 파일이 한 바이트도 바뀌지 않고 그대로
 * 돌아오는지 본다. 가짜 엔진으로 실제 측정(runWeeklyPipeline)도 한 번 돌려 새 판 문항을 모두 묻고 카드 점수가 실증이었던 질문의
 * 응답을 세는지 본다. 점수는 표시를 뗀 질문을 세는지 aggregateWeeklyMetrics로도 본다(점수 코드는 고치지 않았다).
 *
 * 판을 오버레이가 정하지 않는 브랜드(저장소 설정 · 앱에서 고친 경쟁사 목록)는 오버레이를 바꿔도 측정이 그대로라 쓰지 않아야 한다.
 *
 *   npx tsx scripts/verify-promote-probe-questions.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'verify-promote-probe-'));
const appRoot = path.join(tmp, 'app');
process.env.APP_DATA_DIR = appRoot;
process.env.BLOB_READ_WRITE_TOKEN = '';
process.env.BLOB_STORE_ID = '';
process.env.PIPELINE_CRON = '';
process.env.USE_MOCK_ENGINES = 'true';
// 질문지를 새로 만들게 되더라도 실제 엔진을 부르지 않게 키를 비운다 — 새로 만들었는지는 파일 바이트로 잡는다.
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'ANTHROPIC_API_KEY']) process.env[key] = '';
delete process.env.VERCEL;

const checks: [string, boolean, string | undefined][] = [];
/** detail은 실패했을 때만 찍는다(하위 프로세스 출력 등). */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);

// ── 가짜 브랜드 ─────────────────────────────────────────────────────────────
// A 「가상머뭄」: 코호트 공통 질문지(c1) · 판 v6 · 공통 2 + 브랜드 2 + 실증 3(그중 홀드아웃 1). questionBankSize 4는 실증을 뺀 수.
// B 「가상골목」: 코호트 공통 질문지 없음 · 판 v3 · 이름 없는 질문 2 + 브랜드 1 + 실증 2. 주차 카드에 v4가 있어 새 판은 v5.
// C 「가상선연」: 앱에서 고친 경쟁사 목록(competitors.json)이 쓰인다 — 판을 오버레이가 정하지 않으므로 쓰지 않아야 한다.
const INDUSTRY = '가상업종';
const COMPETITORS = [{ name: '가상초원', aliases: ['가상초원'], domains: [] as string[] }];
const tenantOf = (tenantId: string, brandName: string, region: string, version: string, size: number, cohort: boolean) => ({
  tenantId,
  brandName,
  aliases: [brandName],
  ownedDomains: [`${tenantId}.example`],
  industry: INDUSTRY,
  region,
  engines: ['gemini'],
  questionBankSize: size,
  questionBankVersion: version,
  repeatsPerQuestion: 1,
  competitors: COMPETITORS,
  factGraph: [],
  ...(cohort ? { cohortQuestionBank: 'c1' } : {}),
});
const A = tenantOf('fake-promote-a', '가상머뭄', '가상시', 'v6', 4, true);
const B = tenantOf('fake-promote-b', '가상골목', '가상구', 'v3', 3, false);
const C = tenantOf('fake-promote-c', '가상선연', '가상동', 'v6', 4, true);
const keyOf = (region: string) => `${INDUSTRY}__${region}`;

type Spec = Record<string, unknown> & { questionId: string; text: string; category: string };
const q = (questionId: string, text: string, category: string, region: string, extra: Record<string, unknown> = {}): Spec => ({
  questionId,
  text,
  category,
  stage: 'consider',
  topic: '가상 주제',
  industry: INDUSTRY,
  region,
  containsBrandName: category !== 'category-agnostic',
  version: questionId.split('-')[0],
  ...extra,
});
const sharedOf = (region: string) => [
  q('c1-001', `${region} ${INDUSTRY} 추천해줘`, 'category-agnostic', region, { cohortShared: true }),
  q('c1-002', `${region}에서 ${INDUSTRY} 고를 때 뭘 봐야 해?`, 'category-agnostic', region, { cohortShared: true, stage: 'learn' }),
];
const bankA = {
  version: 'v6',
  generatedAt: '2026-10-20T00:00:00.000Z',
  cohortBank: { key: keyOf('가상시'), version: 'c1' },
  questions: [
    ...sharedOf('가상시'),
    q('v6-001', '가상머뭄 체크인 몇 시야?', 'brand-direct', '가상시'),
    q('v6-002', '가상머뭄이랑 가상초원 중 어디가 나아?', 'comparison', '가상시'),
    q('v6-p001', '가상시 바다 보이는 조용한 숙소 있어?', 'category-agnostic', '가상시', { probe: true }),
    q('v6-p002', '가상시 아이랑 묵기 좋은 숙소 추천해줘', 'category-agnostic', '가상시', { probe: true, stage: 'decide' }),
    q('v6-p003', '가상시에서 바다가 보이는 한적한 숙소 알려줘', 'category-agnostic', '가상시', { probe: true, paraphraseOf: 'v6-p001' }),
  ],
};
const bankAOld = { version: 'v5', generatedAt: '2026-09-01T00:00:00.000Z', cohortBank: bankA.cohortBank, questions: bankA.questions.slice(0, 4) };
const bankB = {
  version: 'v3',
  generatedAt: '2026-10-01T00:00:00.000Z',
  questions: [
    q('v3-001', `가상구 ${INDUSTRY} 추천해줘`, 'category-agnostic', '가상구'),
    q('v3-002', `가상구 ${INDUSTRY} 가격 어느 정도야?`, 'category-agnostic', '가상구', { stage: 'learn' }),
    q('v3-003', '가상골목 주차 돼?', 'brand-direct', '가상구'),
    q('v3-p001', '가상구 조용한 숙소 있어?', 'category-agnostic', '가상구', { probe: true }),
    q('v3-p002', '가상구 혼자 묵기 좋은 숙소 알려줘', 'category-agnostic', '가상구', { probe: true }),
  ],
};
const bankC = { version: 'v6', generatedAt: '2026-10-20T00:00:00.000Z', cohortBank: { key: keyOf('가상동'), version: 'c1' }, questions: [...sharedOf('가상동'), q('v6-p001', '가상동 숙소 있어?', 'category-agnostic', '가상동', { probe: true })] };
const cohortFile = (region: string) => ({ key: keyOf(region), industry: INDUSTRY, region, version: 'c1', generatedAt: '2026-09-01T00:00:00.000Z', questions: sharedOf(region) });

const put = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};
/** C의 competitors.json — 지금 쓰이는(베이스 지문이 맞는) 고친 목록. */
const editFileOf = (base: string) => ({
  current: { competitors: [{ name: '가상해돋이', aliases: ['가상해돋이'], domains: [] }], base },
  lastSave: null,
  measured: null,
  updatedAt: '2026-10-25T00:00:00.000Z',
});
function seedApp(root: string, cBase: string) {
  put(path.join(root, 'tenants.overlay.json'), [A, B, C]);
  put(path.join(root, 'cohort-banks', keyOf('가상시'), 'c1.json'), cohortFile('가상시'));
  put(path.join(root, 'cohort-banks', keyOf('가상동'), 'c1.json'), cohortFile('가상동'));
  put(path.join(root, 'data', A.tenantId, 'question-bank', 'v6.json'), bankA);
  put(path.join(root, 'data', A.tenantId, 'question-bank', 'v5.json'), bankAOld);
  put(path.join(root, 'data', B.tenantId, 'question-bank', 'v3.json'), bankB);
  put(path.join(root, 'data', B.tenantId, 'scorecard-history.json'), [{ tenantId: B.tenantId, weekOf: '2026-W40', industry: INDUSTRY, region: '가상구', questionBankVersion: 'v4' }]);
  put(path.join(root, 'data', C.tenantId, 'question-bank', 'v6.json'), bankC);
  put(path.join(root, 'data', C.tenantId, 'competitors.json'), editFileOf(cBase));
}

/** 폴더 안 모든 파일의 상대 경로 → 내용 지문. 아무것도 안 썼는지 볼 때 쓴다. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = createHash('sha1').update(readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const sameSnapshot = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (file: string) => readFileSync(file, 'utf8');

/** 설치본 앱이 켜져 있는지 — 스크립트의 --write는 그때 멈춘다(같은 tasklist 확인). */
function appRunning(): boolean {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Web4AI Brand AEO.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return /^"Web4AI Brand AEO\.exe","\d+"/im.test(out);
}

try {
  const { baseFingerprint } = await import('../server/tenantCompetitorsStore');
  const cBase = baseFingerprint(C as never);
  seedApp(appRoot, cBase);

  const promote = await import('./promote-probe-questions');
  const { planPromotion, promoteOverlay, promoteQuestion, writePromotion, checkPromotion, promoteBackupDirName } = promote;
  const { ensureQuestionBank } = await import('../server/pipeline');
  const { FileResultStore } = await import('../server/store');
  const { loadRuntimeTenants } = await import('../server/tenantRegistry');
  const { aggregateWeeklyMetrics } = await import('../server/aggregate');
  const { resolveExtraArticle } = await import('../src/lib/extraArticles');
  type QuestionBank = import('../server/store').QuestionBank;
  type QuestionRepeatAnalysis = import('../server/types').QuestionRepeatAnalysis;
  type CitationDetail = import('../server/types').CitationDetail;
  type QuestionSpec = import('../src/prompts/types').QuestionSpec;

  const store = new FileResultStore();
  const bankFile = (tenantId: string, version: string) => path.join(appRoot, 'data', tenantId, 'question-bank', `${version}.json`);
  const overlayPath = path.join(appRoot, 'tenants.overlay.json');
  const tenantNow = async (tenantId: string) => (await loadRuntimeTenants()).find((t) => t.tenantId === tenantId)!;
  const NOW = new Date('2026-11-02T01:02:03.004Z');

  // ── 1. 올리기 전: 측정은 v6를 그대로 쓴다(실증 포함) ──────────────────────
  const beforeA = await ensureQuestionBank(await tenantNow(A.tenantId), store);
  ok('올리기 전 — 측정은 v6 질문지를 그대로(실증 3개 포함 7문항)', JSON.stringify(beforeA) === JSON.stringify(bankA.questions) && bytes(bankFile(A.tenantId, 'v6')) === JSON.stringify(bankA, null, 2));

  // ── 2. 문항 하나 · 질문지 계획 ─────────────────────────────────────────────
  const promotedP3 = promoteQuestion(bankA.questions[6] as unknown as QuestionSpec);
  const expectedP3: Record<string, unknown> = { ...bankA.questions[6] };
  delete expectedP3.probe;
  delete expectedP3.paraphraseOf;
  ok('promoteQuestion — probe · paraphraseOf만 떼고 나머지 필드 · 순서 그대로', JSON.stringify(promotedP3) === JSON.stringify(expectedP3) && !('probe' in promotedP3) && !('paraphraseOf' in promotedP3));
  ok('promoteQuestion — 원래 문항을 바꾸지 않음', (bankA.questions[6] as Record<string, unknown>).probe === true);

  const sourceOk = (version: string): import('./promote-probe-questions').PromoteSource => ({ baked: false, overlayVersion: version, competitorEdit: false });
  const cohortA = { key: keyOf('가상시'), version: 'c1' };
  const inputA = { tenantId: A.tenantId, version: 'v6', bank: bankA as unknown as QuestionBank, source: sourceOk('v6'), cohort: cohortA, taken: await store.listQuestionBankVersions(A.tenantId), now: NOW };
  const planA = planPromotion(inputA);
  ok('planPromotion A — v6 → v7 · 문항 7개 순서 · id · 문장 그대로 · 실증 표시 없음', planA.ok && planA.plan.toVersion === 'v7' && planA.plan.bank.questions.map((x) => `${x.questionId}|${x.text}|${x.category}|${x.stage}|${x.topic}|${x.cohortShared ?? ''}`).join() === bankA.questions.map((x) => `${x.questionId}|${x.text}|${x.category}|${x.stage}|${x.topic}|${x.cohortShared ?? ''}`).join() && planA.plan.bank.questions.every((x) => x.probe === undefined && x.paraphraseOf === undefined), JSON.stringify(planA));
  ok('planPromotion A — 질문지 version v7 · generatedAt 올린 시각 · cohortBank 그대로 · 경쟁사 편집 표식 없음', planA.ok && planA.plan.bank.version === 'v7' && planA.plan.bank.generatedAt === NOW.toISOString() && JSON.stringify(planA.plan.bank.cohortBank) === JSON.stringify(bankA.cohortBank) && JSON.stringify(Object.keys(planA.plan.bank)) === JSON.stringify(['version', 'generatedAt', 'questions', 'cohortBank']));
  ok('planPromotion A — 실증 3(홀드아웃 1) · 이름 없는 질문 5 · 점수에 세는 것 2 → 5', planA.ok && planA.plan.probes === 3 && planA.plan.paraphrases === 1 && planA.plan.agnostic === 5 && planA.plan.scoredBefore === 2 && planA.plan.scoredAfter === 5);
  ok('planPromotion A — 입력 질문지를 바꾸지 않음', (bankA.questions[4] as Record<string, unknown>).probe === true && bankA.version === 'v6');
  const historyB = await store.getScorecardHistory(B.tenantId, Number.MAX_SAFE_INTEGER);
  const takenB = [...(await store.listQuestionBankVersions(B.tenantId)), ...historyB.map((c) => c.questionBankVersion).filter((v): v is string => Boolean(v))];
  const planB = planPromotion({ tenantId: B.tenantId, version: 'v3', bank: bankB as unknown as QuestionBank, source: sourceOk('v3'), cohort: null, taken: takenB, now: NOW });
  ok('planPromotion B — 주차 카드의 판(v4)을 피해 v3 → v5 · cohortBank 없음', planB.ok && planB.plan.toVersion === 'v5' && !('cohortBank' in planB.plan.bank) && planB.plan.scoredAfter === 4, JSON.stringify(planB));

  const refused = (over: Partial<typeof inputA>, needle: string, label: string) => {
    const r = planPromotion({ ...inputA, ...over });
    ok(`planPromotion 거절 — ${label}`, !r.ok && r.errors.some((e) => e.includes(needle)), JSON.stringify(r));
  };
  refused({ source: { baked: true, overlayVersion: 'v6', competitorEdit: false } }, '저장소 설정(server/tenants.config.json)', '저장소 설정에 있는 브랜드(오버레이가 판을 정하지 않음)');
  refused({ source: { baked: false, overlayVersion: 'v6', competitorEdit: true } }, '고친 경쟁사 목록', '앱에서 고친 경쟁사 목록이 쓰임');
  refused({ source: { baked: false, competitorEdit: false } }, '오버레이(tenants.overlay.json)에 없는', '오버레이에 없음');
  refused({ source: sourceOk('v5') }, '오버레이의 판(v5)', '오버레이 판이 측정 판과 다름');
  refused({ version: 'v7', source: sourceOk('v7') }, '질문지 파일의 판(v6)', '질문지 파일 판이 측정 판과 다름');
  refused({ bank: { ...(bankA as unknown as QuestionBank), derivedFrom: {} as never } }, 'derivedFrom', '경쟁사 편집이 만든 질문지');
  refused({ cohort: { key: keyOf('가상시'), version: 'c2' } }, '코호트 출처', '코호트 공통 질문지 판이 다름(측정이 멈춤)');
  refused({ bank: { ...(bankA as unknown as QuestionBank), cohortBank: undefined } }, '코호트 출처(없음)', '코호트 출처 없음');
  refused({ bank: { ...(bankA as unknown as QuestionBank), questions: bankA.questions.slice(0, 4) as unknown as QuestionSpec[] } }, '실증 질문이 없습니다', '실증이 없음');
  refused({ bank: { ...(bankA as unknown as QuestionBank), questions: [...bankA.questions, bankA.questions[0]] as unknown as QuestionSpec[] } }, '질문 id가 겹칩니다', '질문 id 겹침');

  // ── 3. 오버레이 ────────────────────────────────────────────────────────────
  const overlayBefore = bytes(overlayPath);
  const overlayParsed = JSON.parse(overlayBefore) as Record<string, unknown>[];
  const changes = [
    { tenantId: A.tenantId, from: 'v6', to: 'v7' },
    { tenantId: B.tenantId, from: 'v3', to: 'v5' },
  ];
  const nextOverlay = promoteOverlay(overlayParsed, changes);
  ok('promoteOverlay — A · B의 questionBankVersion만 바뀜(필드 순서 · questionBankSize 그대로), C는 같은 객체', nextOverlay.ok && JSON.stringify(nextOverlay.overlay[0]) === JSON.stringify({ ...A, questionBankVersion: 'v7' }) && JSON.stringify(nextOverlay.overlay[1]) === JSON.stringify({ ...B, questionBankVersion: 'v5' }) && nextOverlay.overlay[2] === overlayParsed[2] && overlayParsed[0]!.questionBankVersion === 'v6', JSON.stringify(nextOverlay));
  const overlayRefused = (value: unknown, change: { tenantId: string; from: string; to: string }, needle: string, label: string) => {
    const r = promoteOverlay(value, [change]);
    ok(`promoteOverlay 거절 — ${label}`, !r.ok && r.errors.some((e) => e.includes(needle)), JSON.stringify(r));
  };
  overlayRefused({}, changes[0]!, '배열이 아닙니다', '배열이 아님');
  overlayRefused(overlayParsed, { tenantId: 'nobody', from: 'v1', to: 'v2' }, '이 브랜드(nobody)가 0개', '없는 브랜드');
  overlayRefused([A, A], changes[0]!, `이 브랜드(${A.tenantId})가 2개`, '같은 브랜드가 둘');
  overlayRefused(overlayParsed, { tenantId: A.tenantId, from: 'v5', to: 'v6' }, '판(v6)이 기대한 판(v5)과 다릅니다', '판이 기대와 다름');

  // ── 4. 파일 쓰기 ───────────────────────────────────────────────────────────
  if (!planA.ok || !planB.ok || !nextOverlay.ok) throw new Error('계획이 없어 쓰기 검사를 할 수 없습니다(위 실패).');
  const itemOf = (tenantId: string, from: string, plan: { toVersion: string; bank: QuestionBank }) => ({
    tenantDir: path.join(appRoot, 'data', tenantId),
    fromPath: bankFile(tenantId, from),
    before: bytes(bankFile(tenantId, from)),
    toPath: bankFile(tenantId, plan.toVersion),
    bank: plan.bank,
  });
  const writeInput = { items: [itemOf(A.tenantId, 'v6', planA.plan), itemOf(B.tenantId, 'v3', planB.plan)], overlayPath, overlayBefore, overlay: nextOverlay.overlay, now: NOW };
  const rejects = async (p: Promise<unknown>, needle: string) => p.then(() => 'resolved', (err: unknown) => (err instanceof Error && err.message.includes(needle) ? 'ok' : String(err)));

  const pristine = snapshot(appRoot);
  ok('writePromotion 거절 — 오버레이가 그 사이 바뀜 · 아무것도 안 씀', (await rejects(writePromotion({ ...writeInput, overlayBefore: overlayBefore + ' ' }), '오버레이가 그 사이 바뀌었습니다')) === 'ok' && sameSnapshot(snapshot(appRoot), pristine));
  ok('writePromotion 거절 — 질문지가 그 사이 바뀜 · 아무것도 안 씀', (await rejects(writePromotion({ ...writeInput, items: [{ ...writeInput.items[0]!, before: 'x' }] }), '질문지가 그 사이 바뀌었습니다')) === 'ok' && sameSnapshot(snapshot(appRoot), pristine));
  ok('writePromotion 거절 — 새 판 파일이 이미 있음(v5 자리) · 아무것도 안 씀', (await rejects(writePromotion({ ...writeInput, items: [{ ...writeInput.items[0]!, toPath: bankFile(A.tenantId, 'v5') }] }), '새 판 파일이 이미 있습니다')) === 'ok' && sameSnapshot(snapshot(appRoot), pristine));

  const { backups } = await writePromotion(writeInput);
  const backupName = promoteBackupDirName(NOW);
  ok('writePromotion — 브랜드마다 before-promote-<시각>/에 옛 질문지 · 오버레이 원문', backups.length === 2 && backups.every((b) => path.basename(b) === backupName) && bytes(path.join(backups[0]!, 'v6.json')) === writeInput.items[0]!.before && bytes(path.join(backups[1]!, 'v3.json')) === writeInput.items[1]!.before && backups.every((b) => bytes(path.join(b, 'tenants.overlay.json')) === overlayBefore), backups.join(', '));
  ok('checkPromotion — 다시 읽은 새 판 · 오버레이가 쓴 그대로, 옛 판 그대로', (await checkPromotion(writeInput)).length === 0);
  ok('옛 판 파일 · 코호트 공통 질문지 · C 질문지 그대로', bytes(bankFile(A.tenantId, 'v6')) === JSON.stringify(bankA, null, 2) && bytes(bankFile(A.tenantId, 'v5')) === JSON.stringify(bankAOld, null, 2) && bytes(path.join(appRoot, 'cohort-banks', keyOf('가상시'), 'c1.json')) === JSON.stringify(cohortFile('가상시'), null, 2) && bytes(bankFile(C.tenantId, 'v6')) === JSON.stringify(bankC, null, 2));
  ok('writePromotion 다시 — 새 판 파일이 있어 거절(덮지 않음)', (await rejects(writePromotion({ ...writeInput, overlayBefore: bytes(overlayPath) }), '새 판 파일이 이미 있습니다')) === 'ok');
  ok('checkPromotion — 오버레이를 다른 값으로 바꾸면 알림', (await checkPromotion({ ...writeInput, overlay: overlayParsed })).some((p) => p.includes('오버레이가 쓴 내용과 다릅니다')));

  // ── 5. 다음 측정이 새 판을 그대로 쓰는가 — 실제 ensureQuestionBank(AI 없음) ─
  const runtimeA = await tenantNow(A.tenantId);
  const runtimeB = await tenantNow(B.tenantId);
  const runtimeC = await tenantNow(C.tenantId);
  ok('런타임 설정 — A v7 · B v5(questionBankSize 4 · 3 그대로), C는 고친 경쟁사 목록 그대로', runtimeA.questionBankVersion === 'v7' && runtimeA.questionBankSize === 4 && runtimeB.questionBankVersion === 'v5' && runtimeB.questionBankSize === 3 && runtimeC.competitors[0]?.name === '가상해돋이', `${runtimeA.questionBankVersion} ${runtimeB.questionBankVersion} ${runtimeC.competitors[0]?.name}`);
  const v7Before = bytes(bankFile(A.tenantId, 'v7'));
  const usedA = await ensureQuestionBank(runtimeA, store);
  ok('측정 A(코호트 공통 질문지) — 새 판 문항 7개 그대로(자르지 않음 · questionBankSize 4보다 많아도)', usedA.length === 7 && JSON.stringify(usedA) === JSON.stringify(planA.plan.bank.questions), JSON.stringify(usedA.map((x) => x.questionId)));
  ok('측정 A — 저장된 v7 파일이 한 바이트도 안 바뀜(새로 만들지 않음) · 질문지 폴더에 다른 파일 없음', bytes(bankFile(A.tenantId, 'v7')) === v7Before && readdirSync(path.dirname(bankFile(A.tenantId, 'v7'))).sort().join() === 'v5.json,v6.json,v7.json');
  ok('측정 A — 코호트 공통 질문지 파일 그대로', bytes(path.join(appRoot, 'cohort-banks', keyOf('가상시'), 'c1.json')) === JSON.stringify(cohortFile('가상시'), null, 2));
  const v5Before = bytes(bankFile(B.tenantId, 'v5'));
  const usedB = await ensureQuestionBank(runtimeB, store);
  ok('측정 B(코호트 공통 질문지 없음) — 새 판 문항 5개 그대로 · 파일 그대로(하한 보정이 고쳐 쓰지 않음)', usedB.length === 5 && JSON.stringify(usedB) === JSON.stringify(planB.plan.bank.questions) && bytes(bankFile(B.tenantId, 'v5')) === v5Before, JSON.stringify(usedB.map((x) => x.questionId)));
  ok('측정 — 실증 표시가 남은 문항 없음', [...usedA, ...usedB].every((x) => x.probe === undefined && x.paraphraseOf === undefined));

  // ── 5-1. 실제 측정 한 번(runWeeklyPipeline · 가짜 엔진) — 새 판 문항을 모두 묻고, 실증이었던 질문의 응답이 카드 점수에 든다 ──
  // 가짜 엔진은 실증이었던 질문에서만 브랜드를 말한다(가짜 판정은 응답에 그 이름이 있으면 언급으로 본다). 카드 언급률이 3/5면
  // 이름 없는 질문 5개(실증이었던 3개 포함)를 모두 셌다는 뜻이다 — 실증 표시가 남았다면 원래 일반 질문 2개만 세어 0이다.
  const { runWeeklyPipeline } = await import('../server/pipeline');
  const { MockEngineClient } = await import('../server/engines/mockEngineClient');
  const engineCall = MockEngineClient.prototype.call;
  const formerProbeTexts = bankA.questions.filter((x) => x.probe === true).map((x) => String(x.text));
  MockEngineClient.prototype.call = async function (prompt, options) {
    const result = await engineCall.call(this, prompt, options);
    const formerProbe = formerProbeTexts.some((text) => prompt.user.includes(text) || prompt.system.includes(text));
    return {
      ...result,
      text: formerProbe ? '가상머뭄(뷰성형외과)을 많이 추천합니다. 가상초원도 있습니다.' : '여러 선택지가 있으니 후기를 비교해 보세요.',
      citations: [],
    };
  };
  const collectEnginesBefore = process.env.COLLECT_ENGINES;
  process.env.COLLECT_ENGINES = 'gemini';
  try {
    const run = await runWeeklyPipeline(runtimeA, store, new Date('2026-11-04T03:00:00Z'));
    const saved = await store.getQuestionAnalyses(A.tenantId, run.scorecard.weekOf);
    const askedIds = [...new Set(saved.map((x) => x.questionId))].sort().join();
    ok('실제 측정 A — 새 판 7문항을 모두 물음(실증이었던 3개 포함) · 카드 판 v7', askedIds === planA.plan.bank.questions.map((x) => x.questionId).sort().join() && saved.length === 7 && run.scorecard.questionBankVersion === 'v7', `${askedIds} · ${saved.length} · ${run.scorecard.questionBankVersion}`);
    ok('실제 측정 A — 저장된 v7 파일이 한 바이트도 안 바뀜 · 질문지 폴더 그대로', bytes(bankFile(A.tenantId, 'v7')) === v7Before && readdirSync(path.dirname(bankFile(A.tenantId, 'v7'))).sort().join() === 'v5.json,v6.json,v7.json');
    const flagged = aggregateWeeklyMetrics({ competitors: [{ name: '가상초원' }] }, bankA.questions as unknown as QuestionSpec[], saved);
    ok('실제 측정 A — 카드 언급률 3/5(실증이었던 질문의 응답이 점수에 듦), 같은 응답을 실증 표시로 세면 0', Math.abs(run.scorecard.mentionRate - 3 / 5) < 1e-9 && flagged.mentionRate === 0, `${run.scorecard.mentionRate} · ${flagged.mentionRate}`);
  } finally {
    MockEngineClient.prototype.call = engineCall;
    if (collectEnginesBefore === undefined) delete process.env.COLLECT_ENGINES;
    else process.env.COLLECT_ENGINES = collectEnginesBefore;
  }

  // ── 6. 점수 — 표시를 뗀 질문이 점수에 든다(점수 코드는 그대로) ─────────────
  const citation = (domain: string, ownerType: CitationDetail['ownerType']): CitationDetail => ({ raw: `https://${domain}/page`, domain, ownerType, supportsBrandMention: ownerType === 'brand-owned' });
  const analysis = (questionId: string, mentioned: boolean, rank: number | null, citations: CitationDetail[] = []): QuestionRepeatAnalysis => ({
    questionId,
    engine: 'gemini',
    callIndex: 1,
    mentioned,
    mentionSentences: mentioned ? [{ sentence: '가상머뭄을 추천합니다.', sentiment: 'positive' }] : [],
    competitorMentions: [{ name: '가상초원', mentionCount: 1, sentences: [] }],
    shareOfMention: mentioned ? 0.5 : 0,
    citations,
    topRecommendation: null,
    brandRank: rank,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: citations.some((c) => c.ownerType === 'brand-owned'),
  });
  // 원래 일반 질문(c1-*)에서는 안 나오고, 실증이었던 질문에서 나온다 — 올리기 전에는 점수에 안 들고 올린 뒤에는 든다.
  const analyses = [
    analysis('c1-001', false, null),
    analysis('c1-002', false, null),
    analysis('v6-001', true, 1, [citation('blog.example', 'third-party-ugc')]),
    analysis('v6-002', true, null),
    analysis('v6-p001', true, 1, [citation(`${A.tenantId}.example`, 'brand-owned')]),
    analysis('v6-p002', true, 2, [citation(`${A.tenantId}.example`, 'brand-owned')]),
    analysis('v6-p003', false, null, [citation(`${A.tenantId}.example`, 'brand-owned')]),
  ];
  const tenantForScore = { competitors: [{ name: '가상초원' }] };
  const scoredBefore = aggregateWeeklyMetrics(tenantForScore, bankA.questions as unknown as QuestionSpec[], analyses);
  const scoredAfter = aggregateWeeklyMetrics(tenantForScore, usedA, analyses);
  const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;
  ok('점수 전 — 실증 응답을 뺌: 언급률 0 · 자사 인용률 0(원래 일반 질문 2 · 전체 인용 1)', near(scoredBefore.mentionRate, 0) && near(scoredBefore.brandOwnedCitationRate, 0) && scoredBefore.rankedResponses === 0, JSON.stringify(scoredBefore));
  ok('점수 뒤 — 이름 없는 질문 5개 모두: 언급률 2/5 · 추천 순위 (1+2)/2 · 자사 인용률 3/4', near(scoredAfter.mentionRate, 2 / 5) && near(scoredAfter.avgRecommendationRank, 1.5) && scoredAfter.rankedResponses === 2 && near(scoredAfter.brandOwnedCitationRate, 3 / 4), JSON.stringify(scoredAfter));
  ok('점수 뒤 — 종합 점수가 실증이었던 응답만큼 오름', scoredAfter.score > scoredBefore.score, `${scoredBefore.score} → ${scoredAfter.score}`);
  ok('점수 뒤 — 이름 넣은 질문(v6-001 순위 1)은 여전히 순위에 안 셈', scoredAfter.rankedResponses === 2);

  // ── 7. 추가 글 — 판이 바뀌어도 같은 문장으로 질문을 다시 찾는다 ────────────
  const def = { bankVersion: 'v6', questionIds: ['v6-p001', 'c1-002'], questionTexts: [String(bankA.questions[4]!.text), String(bankA.questions[1]!.text)] };
  const resolved = resolveExtraArticle(def, 'v7', usedA);
  ok('추가 글(v6에서 만든 글) — v7 주에서 같은 id로 다시 찾음(문장 그대로)', resolved.how === 'by-text' && resolved.currentIds.join() === 'v6-p001,c1-002' && resolved.missingTexts.length === 0, JSON.stringify(resolved));

  // ── 8. 스크립트(하위 프로세스) ─────────────────────────────────────────────
  const scriptRoot = path.join(tmp, 'script-app');
  seedApp(scriptRoot, cBase);
  const profile = path.join(tmp, 'profile');
  mkdirSync(path.join(profile, 'Local', 'Packages'), { recursive: true });
  mkdirSync(path.join(profile, 'Roaming'), { recursive: true });
  const tsxCli = path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (root: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, 'scripts/promote-probe-questions.ts', '--app-data', root, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, APP_DATA_DIR: '', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
    });
  const scriptBefore = snapshot(scriptRoot);

  const dryAll = run(scriptRoot, A.tenantId, B.tenantId, C.tenantId);
  ok(
    '스크립트 dry-run — 판 · 문항 수 · 실증 수 · 점수 질문 수 · 오버레이 변경을 보이고, C는 ✗(고친 경쟁사 목록), 아무것도 안 씀',
    dryAll.status === 1 &&
      dryAll.stdout.includes('판 v6 → v7 · 문항 7개 그대로') &&
      dryAll.stdout.includes('실증 표시를 뗄 질문 3개(그중 바꿔 쓴 질문 1개)') &&
      dryAll.stdout.includes('이름 없는 질문 5개 — 점수에 세는 것 2 → 5') &&
      dryAll.stdout.includes('오버레이: questionBankVersion v6 → v7 (questionBankSize 4 그대로') &&
      dryAll.stdout.includes(`코호트 공통 질문지: ${keyOf('가상시')}/c1 — 있음`) &&
      dryAll.stdout.includes('판 v3 → v5 · 문항 5개 그대로') &&
      dryAll.stdout.includes('✗ 앱에서 고친 경쟁사 목록') &&
      dryAll.stdout.includes('dry-run — 아무것도 쓰지 않았습니다') &&
      sameSnapshot(snapshot(scriptRoot), scriptBefore),
    `${dryAll.status} ${dryAll.stdout}${dryAll.stderr}`,
  );
  const dryAB = run(scriptRoot, A.tenantId, B.tenantId, A.tenantId);
  ok('스크립트 dry-run A · B(A 두 번) — 통과 · A는 한 번만 · 아무것도 안 씀', dryAB.status === 0 && dryAB.stdout.split(`■ ${A.tenantId}`).length === 2 && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${dryAB.status} ${dryAB.stdout}${dryAB.stderr}`);
  const unknown = run(scriptRoot, 'nobody');
  ok('스크립트 — 없는 브랜드는 ✗', unknown.status === 1 && unknown.stdout.includes('브랜드를 찾을 수 없습니다'), `${unknown.status} ${unknown.stdout}${unknown.stderr}`);
  const badFlag = run(scriptRoot, A.tenantId, '--force');
  ok('스크립트 — 모르는 옵션은 거절', badFlag.status === 1 && badFlag.stderr.includes('모르는 옵션입니다: --force'), `${badFlag.status} ${badFlag.stderr}`);
  const writeWithC = run(scriptRoot, A.tenantId, C.tenantId, '--write');
  ok('스크립트 --write — 한 브랜드라도 걸리면 아무것도 안 씀', writeWithC.status === 1 && writeWithC.stderr.includes('쓰지 않았습니다') && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${writeWithC.status} ${writeWithC.stdout}${writeWithC.stderr}`);
  const virtualRoot = path.join(tmp, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app');
  seedApp(virtualRoot, cBase);
  const virtual = run(virtualRoot, A.tenantId, '--write');
  ok('스크립트 --write — 가상화 사본 경로면 거절 · 아무것도 안 씀', virtual.status === 1 && virtual.stderr.includes('가상화 사본') && !existsSync(path.join(virtualRoot, 'data', A.tenantId, 'question-bank', 'v7.json')), `${virtual.status} ${virtual.stderr}`);

  const running = appRunning();
  const written = run(scriptRoot, A.tenantId, B.tenantId, '--write');
  if (running) {
    ok('스크립트 --write — 설치본 앱이 켜져 있어 앱 확인에서 멈춤 · 아무것도 안 씀(앱을 끄면 쓰기까지 확인)', written.status === 1 && written.stderr.includes('앱이 실행 중입니다') && sameSnapshot(snapshot(scriptRoot), scriptBefore), `${written.status} ${written.stdout}${written.stderr}`);
  } else {
    const scriptOverlay = JSON.parse(bytes(path.join(scriptRoot, 'tenants.overlay.json'))) as { tenantId: string; questionBankVersion: string }[];
    const backupDirs = readdirSync(path.join(scriptRoot, 'data', A.tenantId)).filter((n) => n.startsWith('before-promote-'));
    const savedA = JSON.parse(bytes(path.join(scriptRoot, 'data', A.tenantId, 'question-bank', 'v7.json'))) as QuestionBank;
    ok(
      '스크립트 --write — 써 보는 확인 · 백업 · 새 판 파일 · 오버레이 · 다시 읽기',
      written.status === 0 &&
        written.stdout.includes('쓰기 확인:') &&
        written.stdout.includes('다시 읽음') &&
        backupDirs.length === 1 &&
        savedA.version === 'v7' &&
        JSON.stringify(savedA.questions) === JSON.stringify(planA.plan.bank.questions) &&
        existsSync(path.join(scriptRoot, 'data', B.tenantId, 'question-bank', 'v5.json')) &&
        scriptOverlay.map((t) => t.questionBankVersion).join() === 'v7,v5,v6' &&
        bytes(path.join(scriptRoot, 'data', A.tenantId, 'question-bank', 'v6.json')) === JSON.stringify(bankA, null, 2),
      `${written.status} ${written.stdout}${written.stderr}`,
    );
    const again = run(scriptRoot, A.tenantId);
    ok('스크립트 — 올린 뒤 다시 보면 실증이 없어 ✗(두 번 올리지 않음)', again.status === 1 && again.stdout.includes('실증 질문이 없습니다'), `${again.status} ${again.stdout}${again.stderr}`);
  }
  console.log(`(설치본 앱 ${running ? '켜짐 — 스크립트 --write는 앱 확인에서 멈추는 것만 확인' : '꺼짐 — 스크립트 --write까지 확인'})`);
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
