/**
 * 설치본에 담는 브랜드 질문지(src/data/question-banks/<tenantId>/<판>.json, server/bundledBanks.ts)와 그 만들기
 * (scripts/promote-probe-questions.ts --bundle-out)를 확인한다. AI는 부르지 않고, 파일은 임시 폴더의 가짜 브랜드에만 쓴다.
 *
 * 왜: 여러 PC가 같은 판 이름으로 같은 질문을 재려면(v0.4.49 브랜드 통일) 동봉본이 측정이 쓰는 그대로여야 한다 — 실증 표시가 남으면
 * 점수에서 빠지고, 코호트 공통 문항이 저장소 cohort-banks/의 기준본과 다르면 같은 코호트의 경쟁사와 다른 시험지를 푼다. 기준본이
 * 저장소에 없으면 다른 PC가 측정 때 코호트 질문지를 AI로 새로 만든다.
 *
 *   npx tsx scripts/verify-bundled-banks.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = path.join(repoRoot, 'src', 'data', 'question-banks');
const COHORT_DIR = path.join(repoRoot, 'cohort-banks');

const checks: [string, boolean, string | undefined][] = [];
/** 이 확인 앞의 저장소 상태 — 확인이 저장소 동봉본 · 코호트 폴더를 건드리지 않았는지 끝에 견준다. */
const gitBefore = execFileSync('git', ['status', '--porcelain', '--', 'cohort-banks', 'src/data/question-banks'], { cwd: repoRoot, encoding: 'utf8' });
/** detail은 실패했을 때만 찍는다. */
const ok = (label: string, cond: boolean, detail?: string) => checks.push([label, cond, detail]);

interface Q {
  questionId: string;
  text: string;
  category: string;
  cohortShared?: boolean;
  probe?: boolean;
  paraphraseOf?: string;
}
interface Bank {
  version: string;
  generatedAt: string;
  questions: Q[];
  cohortBank?: { key: string; version: string };
  derivedFrom?: unknown;
  regeneratedFrom?: unknown;
}
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

// ── 1. 저장소의 동봉본 ───────────────────────────────────────────────────────
/** 결정(2026-11-03): 스테이,머뭄 v6(= v5에서 실증 표시만 뗌) · 군산각 지역형 v7(= v6에서 뗌) · 군산각 전국형 v3(그대로). */
const EXPECTED: Record<string, { version: string; questions: number; agnostic: number; cohort: string }> = {
  web4ai: { version: 'v6', questions: 66, agnostic: 50, cohort: '펜션__전북_군산/c1' },
  gunsan: { version: 'v7', questions: 62, agnostic: 48, cohort: '관광정보서비스__전북_군산/c1' },
  'gunsan-national': { version: 'v3', questions: 36, agnostic: 22, cohort: '관광안내__국내/c1' },
};
const bundledTenants = existsSync(BUNDLE_DIR) ? readdirSync(BUNDLE_DIR).filter((n) => statSync(path.join(BUNDLE_DIR, n)).isDirectory()).sort() : [];
ok('동봉 브랜드 — web4ai · gunsan · gunsan-national', bundledTenants.join() === Object.keys(EXPECTED).sort().join(), bundledTenants.join());
ok('동봉 폴더에 브랜드 폴더 말고 다른 파일 없음', existsSync(BUNDLE_DIR) && readdirSync(BUNDLE_DIR).every((n) => bundledTenants.includes(n)), existsSync(BUNDLE_DIR) ? readdirSync(BUNDLE_DIR).join() : '없음');

for (const tenantId of bundledTenants) {
  const dir = path.join(BUNDLE_DIR, tenantId);
  const files = readdirSync(dir);
  for (const file of files) {
    const where = `${tenantId}/${file}`;
    let bank: Bank;
    try {
      bank = readJson<Bank>(path.join(dir, file));
    } catch (err) {
      ok(`${where} — JSON으로 읽힘`, false, err instanceof Error ? err.message : String(err));
      continue;
    }
    const ids = bank.questions.map((q) => q.questionId);
    ok(`${where} — 파일 이름 = 판(${bank.version}) · 문항 있음 · id 겹치지 않음`, file === `${bank.version}.json` && ids.length > 0 && new Set(ids).size === ids.length);
    ok(`${where} — 실증 표시(probe · paraphraseOf) 0개`, bank.questions.every((q) => q.probe === undefined && q.paraphraseOf === undefined));
    ok(`${where} — 경쟁사 편집 표식(derivedFrom · regeneratedFrom) 없음`, !bank.derivedFrom && !bank.regeneratedFrom);
    ok(`${where} — 문항마다 id · 문장 · 범주가 있음`, bank.questions.every((q) => typeof q.questionId === 'string' && typeof q.text === 'string' && q.text.trim() !== '' && typeof q.category === 'string'));
    const shared = bank.questions.filter((q) => q.cohortShared);
    if (!bank.cohortBank) {
      ok(`${where} — 코호트 공통 문항이 없으면 코호트 출처도 없음`, shared.length === 0);
      continue;
    }
    const cohortFile = path.join(COHORT_DIR, bank.cohortBank.key, `${bank.cohortBank.version}.json`);
    ok(`${where} — 코호트 공통 질문지 ${bank.cohortBank.key}/${bank.cohortBank.version}가 저장소 cohort-banks/에 있음`, existsSync(cohortFile), cohortFile);
    if (!existsSync(cohortFile)) continue;
    const cohort = readJson<{ key: string; version: string; questions: Q[] }>(cohortFile);
    ok(`${where} — 코호트 기준본의 key · version이 출처와 같음`, cohort.key === bank.cohortBank.key && cohort.version === bank.cohortBank.version);
    ok(
      `${where} — 코호트 공통 문항 ${shared.length}개가 기준본과 순서 · id · 문장까지 같음`,
      shared.length === cohort.questions.length && shared.every((q, i) => q.questionId === cohort.questions[i]!.questionId && q.text === cohort.questions[i]!.text),
      `${shared.length} vs ${cohort.questions.length}`,
    );
  }
  const expected = EXPECTED[tenantId];
  if (!expected) continue;
  const file = path.join(dir, `${expected.version}.json`);
  ok(`${tenantId} — 결정한 판 ${expected.version}이 있음`, existsSync(file));
  if (!existsSync(file)) continue;
  const bank = readJson<Bank>(file);
  const agnostic = bank.questions.filter((q) => q.category === 'category-agnostic').length;
  ok(
    `${tenantId} ${expected.version} — 문항 ${expected.questions}개 · 이름 없는 질문 ${expected.agnostic}개 · 코호트 ${expected.cohort}`,
    bank.questions.length === expected.questions && agnostic === expected.agnostic && `${bank.cohortBank?.key}/${bank.cohortBank?.version}` === expected.cohort,
    `${bank.questions.length} · ${agnostic} · ${bank.cohortBank?.key}/${bank.cohortBank?.version}`,
  );
}

// ── 2. 저장소 설정(server/tenants.config.json)과 맞는가 ──────────────────────
interface Tenant {
  tenantId: string;
  industry: string;
  region: string;
  questionBankVersion: string;
  cohortQuestionBank?: string;
  marketScope?: string;
  cohortOnly?: boolean;
  factGraph?: { id: string; value: string }[];
}
const config = readJson<Tenant[]>(path.join(repoRoot, 'server', 'tenants.config.json'));
const { cohortKey } = await import('../server/cohortQuestionBank');
ok('저장소 설정 — tenantId가 겹치지 않음', new Set(config.map((t) => t.tenantId)).size === config.length);
for (const tenantId of bundledTenants) {
  const t = config.find((x) => x.tenantId === tenantId);
  ok(`${tenantId} — 저장소 설정에 구운 고객 브랜드(동봉본은 저장소 설정이 판을 정하는 브랜드만)`, Boolean(t && !t.cohortOnly));
  if (!t) continue;
  const file = path.join(BUNDLE_DIR, tenantId, `${t.questionBankVersion}.json`);
  ok(`${tenantId} — 저장소 설정의 판 ${t.questionBankVersion}이 동봉돼 있음`, existsSync(file), file);
  if (!existsSync(file)) continue;
  const bank = readJson<Bank>(file);
  ok(
    `${tenantId} — 동봉본의 코호트 출처가 설정의 업종 · 지역 · 공통 질문지(${cohortKey(t.industry, t.region)}/${t.cohortQuestionBank})와 같음`,
    bank.cohortBank?.key === cohortKey(t.industry, t.region) && bank.cohortBank?.version === t.cohortQuestionBank,
    JSON.stringify(bank.cohortBank),
  );
}
const tenantOf = (id: string) => config.find((t) => t.tenantId === id);
ok(
  '저장소 설정 — web4ai v6 · gunsan v7(관광정보서비스 · 전북 군산 · 지역형) · gunsan-national v3(관광안내 · 국내 · 전국형)',
  tenantOf('web4ai')?.questionBankVersion === 'v6' &&
    tenantOf('gunsan')?.questionBankVersion === 'v7' &&
    tenantOf('gunsan')?.industry === '관광정보서비스' &&
    tenantOf('gunsan')?.region === '전북 군산' &&
    tenantOf('gunsan')?.marketScope === undefined &&
    tenantOf('gunsan-national')?.questionBankVersion === 'v3' &&
    tenantOf('gunsan-national')?.industry === '관광안내' &&
    tenantOf('gunsan-national')?.region === '국내' &&
    tenantOf('gunsan-national')?.marketScope === 'national',
);
ok(
  '저장소 설정 — 군산각 사실에 옛 오버레이의 대구 주소(brand-address)가 없음(운영 PC의 fact-graph.json을 구움)',
  ['gunsan', 'gunsan-national'].every((id) => (tenantOf(id)?.factGraph ?? []).length > 0 && (tenantOf(id)?.factGraph ?? []).every((f) => f.id !== 'brand-address' && !f.value.includes('대구'))),
);
// 군산각은 데스크톱에서만 잰다 — CI가 재면 웹 데모 데이터 · 첫 실행 시드에 실린다.
const srcData = readdirSync(path.join(repoRoot, 'src', 'data'));
const demoCards = readJson<{ tenantId: string }[]>(path.join(repoRoot, 'src', 'data', 'demo-scorecards.json'));
ok(
  '웹 데모 데이터 — 군산각(gunsan*) 질문지 · 분석 · 카드 · liveRegistry 없음',
  !srcData.some((n) => /^live-gunsan/.test(n)) &&
    !demoCards.some((c) => c.tenantId.startsWith('gunsan')) &&
    !/gunsan/.test(readFileSync(path.join(repoRoot, 'server', 'liveRegistry.ts'), 'utf8')),
);

// ── 3. 동봉본 만들기(--bundle-out) — 가짜 앱 데이터 ──────────────────────────
const tmp = mkdtempSync(path.join(tmpdir(), 'verify-bundled-banks-'));
try {
  const promote = await import('./promote-probe-questions');
  const { planBundle, sameBundledBank, bundleFileText } = promote;
  type QuestionBank = import('../server/store').QuestionBank;

  const INDUSTRY = '가상업종';
  const tenantOf = (tenantId: string, brandName: string, region: string, version: string, extra: Record<string, unknown> = {}) => ({
    tenantId,
    brandName,
    aliases: [brandName],
    ownedDomains: [`${tenantId}.example`],
    industry: INDUSTRY,
    region,
    engines: ['gemini'],
    questionBankSize: 4,
    questionBankVersion: version,
    repeatsPerQuestion: 1,
    competitors: [{ name: '가상초원', aliases: ['가상초원'], domains: [] as string[] }],
    factGraph: [],
    cohortQuestionBank: 'c1',
    ...extra,
  });
  const keyOf = (region: string) => `${INDUSTRY}__${region}`;
  const q = (questionId: string, text: string, category: string, region: string, extra: Record<string, unknown> = {}) => ({
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
  const cohortFileOf = (region: string) => ({ key: keyOf(region), industry: INDUSTRY, region, version: 'c1', generatedAt: '2026-09-01T00:00:00.000Z', questions: sharedOf(region) });
  // P 「가상머뭄」: 실증 2개 → 다음 판. Q 「가상골목」: 실증 없음 → 그대로. R 「가상선연」: 앱에서 고친 경쟁사 목록 → 담지 않음.
  const P = tenantOf('fake-bundle-p', '가상머뭄', '가상시', 'v5');
  const Qt = tenantOf('fake-bundle-q', '가상골목', '가상구', 'v3', { marketScope: 'national' });
  const R = tenantOf('fake-bundle-r', '가상선연', '가상동', 'v4');
  const bankP = {
    version: 'v5',
    generatedAt: '2026-10-13T00:00:00.000Z',
    cohortBank: { key: keyOf('가상시'), version: 'c1' },
    questions: [
      ...sharedOf('가상시'),
      q('v5-001', '가상머뭄 체크인 몇 시야?', 'brand-direct', '가상시'),
      q('v5-p001', '가상시 바다 보이는 숙소 있어?', 'category-agnostic', '가상시', { probe: true }),
      q('v5-p002', '가상시에서 바다가 보이는 숙소 알려줘', 'category-agnostic', '가상시', { probe: true, paraphraseOf: 'v5-p001' }),
    ],
  };
  const bankQ = {
    version: 'v3',
    generatedAt: '2026-10-17T00:00:00.000Z',
    cohortBank: { key: keyOf('가상구'), version: 'c1' },
    questions: [...sharedOf('가상구'), q('v3-001', '가상골목 주차 돼?', 'brand-direct', '가상구')],
  };
  const bankR = { version: 'v4', generatedAt: '2026-10-01T00:00:00.000Z', cohortBank: { key: keyOf('가상동'), version: 'c1' }, questions: [...sharedOf('가상동')] };
  const put = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  };
  const { baseFingerprint } = await import('../server/tenantCompetitorsStore');
  const seedApp = (root: string) => {
    put(path.join(root, 'tenants.overlay.json'), [P, Qt, R]);
    for (const region of ['가상시', '가상구', '가상동']) put(path.join(root, 'cohort-banks', keyOf(region), 'c1.json'), cohortFileOf(region));
    put(path.join(root, 'data', P.tenantId, 'question-bank', 'v5.json'), bankP);
    put(path.join(root, 'data', P.tenantId, 'question-bank', 'v4.json'), { ...bankP, version: 'v4', questions: bankP.questions.slice(0, 3) });
    put(path.join(root, 'data', Qt.tenantId, 'question-bank', 'v3.json'), bankQ);
    put(path.join(root, 'data', R.tenantId, 'question-bank', 'v4.json'), bankR);
    put(path.join(root, 'data', R.tenantId, 'competitors.json'), {
      current: { competitors: [{ name: '가상해돋이', aliases: ['가상해돋이'], domains: [] }], base: baseFingerprint(R as never) },
      lastSave: null,
      measured: null,
      updatedAt: '2026-10-25T00:00:00.000Z',
    });
  };
  const snapshot = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else out[path.relative(root, full)] = createHash('sha1').update(readFileSync(full)).digest('hex');
      }
    };
    if (existsSync(root)) walk(root);
    return out;
  };
  const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);

  // 2-1. 계획(순수 함수)
  const NOW = new Date('2026-11-03T00:00:00.000Z');
  const cohortP = { key: keyOf('가상시'), version: 'c1' };
  const planP = planBundle({ tenantId: P.tenantId, version: 'v5', bank: bankP as unknown as QuestionBank, source: { baked: false, overlayVersion: 'v5', competitorEdit: false }, cohort: cohortP, taken: ['v4', 'v5'], now: NOW });
  ok(
    'planBundle P — 실증이 있으면 다음 판 v6 · 표시만 뗌 · id · 순서 · 문장 그대로',
    planP.ok &&
      planP.plan.promoted &&
      planP.plan.version === 'v6' &&
      planP.plan.bank.version === 'v6' &&
      planP.plan.probes === 2 &&
      planP.plan.paraphrases === 1 &&
      planP.plan.agnostic === 4 &&
      planP.plan.bank.questions.map((x) => `${x.questionId}|${x.text}`).join() === bankP.questions.map((x) => `${x.questionId}|${x.text}`).join() &&
      planP.plan.bank.questions.every((x) => x.probe === undefined && x.paraphraseOf === undefined),
    JSON.stringify(planP),
  );
  const planPBaked = planBundle({ tenantId: P.tenantId, version: 'v5', bank: bankP as unknown as QuestionBank, source: { baked: true, competitorEdit: false }, cohort: cohortP, taken: ['v4', 'v5'], now: NOW });
  ok('planBundle P — 저장소 설정 브랜드여도 같은 계획(판은 릴리스가 정함)', planPBaked.ok && planP.ok && JSON.stringify(planPBaked.plan) === JSON.stringify(planP.plan));
  const planQ = planBundle({ tenantId: Qt.tenantId, version: 'v3', bank: bankQ as unknown as QuestionBank, source: { baked: false, overlayVersion: 'v3', competitorEdit: false }, cohort: { key: keyOf('가상구'), version: 'c1' }, taken: ['v3'], now: NOW });
  ok(
    'planBundle Q — 실증이 없으면 지금 판 v3를 한 글자도 바꾸지 않고 담음(generatedAt 포함)',
    planQ.ok && !planQ.plan.promoted && planQ.plan.version === 'v3' && JSON.stringify(planQ.plan.bank) === JSON.stringify(bankQ),
    JSON.stringify(planQ),
  );
  const planQEdit = planBundle({ tenantId: Qt.tenantId, version: 'v3', bank: bankQ as unknown as QuestionBank, source: { baked: false, overlayVersion: 'v3', competitorEdit: true }, cohort: { key: keyOf('가상구'), version: 'c1' }, taken: ['v3'], now: NOW });
  const planQCohort = planBundle({ tenantId: Qt.tenantId, version: 'v3', bank: bankQ as unknown as QuestionBank, source: { baked: false, competitorEdit: false }, cohort: { key: keyOf('가상동'), version: 'c1' }, taken: ['v3'], now: NOW });
  const planQDerived = planBundle({ tenantId: Qt.tenantId, version: 'v3', bank: { ...bankQ, derivedFrom: { version: 'v2' } } as unknown as QuestionBank, source: { baked: false, competitorEdit: false }, cohort: { key: keyOf('가상구'), version: 'c1' }, taken: ['v3'], now: NOW });
  const planPEdit = planBundle({ tenantId: P.tenantId, version: 'v5', bank: bankP as unknown as QuestionBank, source: { baked: false, competitorEdit: true }, cohort: cohortP, taken: ['v5'], now: NOW });
  ok(
    'planBundle — 고친 경쟁사 목록 · 코호트 출처 어긋남 · 경쟁사 편집 질문지는 담지 않음(실증 있든 없든)',
    !planQEdit.ok && !planQCohort.ok && !planQDerived.ok && !planPEdit.ok,
    JSON.stringify([planQEdit, planQCohort, planQDerived, planPEdit]),
  );
  ok(
    'sameBundledBank — generatedAt만 다르면 같음, 문항 · 코호트 출처가 다르면 다름',
    planP.ok &&
      sameBundledBank(planP.plan.bank, { ...planP.plan.bank, generatedAt: '2030-01-01T00:00:00.000Z' }) &&
      !sameBundledBank(planP.plan.bank, { ...planP.plan.bank, questions: planP.plan.bank.questions.slice(1) }) &&
      !sameBundledBank(planP.plan.bank, { ...planP.plan.bank, cohortBank: { key: 'x', version: 'c1' } }),
  );

  // 2-2. 스크립트(하위 프로세스)
  const appRoot = path.join(tmp, 'app');
  seedApp(appRoot);
  const out = path.join(tmp, 'repo');
  const bankOut = path.join(out, 'question-banks');
  const cohortOut = path.join(out, 'cohort-banks');
  // 저장소에 이미 있는 코호트(가상시)는 같은 내용 · 줄 끝 CRLF로 둔다(autocrlf 작업 트리처럼) — 내용으로 비교해야 한다.
  mkdirSync(path.join(cohortOut, keyOf('가상시')), { recursive: true });
  writeFileSync(path.join(cohortOut, keyOf('가상시'), 'c1.json'), JSON.stringify(cohortFileOf('가상시'), null, 2).replace(/\n/g, '\r\n'));
  const profile = path.join(tmp, 'profile');
  mkdirSync(path.join(profile, 'Local', 'Packages'), { recursive: true });
  mkdirSync(path.join(profile, 'Roaming'), { recursive: true });
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const run = (root: string, ...extra: string[]) =>
    spawnSync(process.execPath, [tsxCli, path.join(repoRoot, 'scripts', 'promote-probe-questions.ts'), '--app-data', root, ...extra], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, APP_DATA_DIR: '', APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local') },
    });
  const appBefore = snapshot(appRoot);

  const withR = run(appRoot, P.tenantId, Qt.tenantId, R.tenantId, '--bundle-out', bankOut, '--cohort-out', cohortOut);
  ok(
    '스크립트 --bundle-out — 한 브랜드라도 걸리면(R 고친 경쟁사 목록) 아무것도 안 씀 · 앱 데이터 그대로',
    withR.status === 1 && withR.stdout.includes('✗ 앱에서 고친 경쟁사 목록') && !existsSync(bankOut) && same(snapshot(appRoot), appBefore),
    `${withR.status} ${withR.stdout}${withR.stderr}`,
  );
  const first = run(appRoot, P.tenantId, Qt.tenantId, '--bundle-out', bankOut, '--cohort-out', cohortOut);
  const outP = path.join(bankOut, P.tenantId, 'v6.json');
  const outQ = path.join(bankOut, Qt.tenantId, 'v3.json');
  const writtenP = existsSync(outP) ? readJson<Bank>(outP) : null;
  ok(
    '스크립트 --bundle-out — P는 v6(표시 뗌) · Q는 v3 그대로를 쓰고 앱 데이터는 한 바이트도 안 바뀜',
    first.status === 0 &&
      writtenP !== null &&
      writtenP.version === 'v6' &&
      writtenP.questions.every((x) => x.probe === undefined && x.paraphraseOf === undefined) &&
      readFileSync(outQ, 'utf8') === bundleFileText(bankQ) &&
      first.stdout.includes('넣어 구우세요(지금 없음)') &&
      same(snapshot(appRoot), appBefore),
    `${first.status} ${first.stdout}${first.stderr}`,
  );
  ok(
    '스크립트 --bundle-out — 저장소에 없는 코호트(가상구)는 앱 데이터 파일을 그대로 복사, 있는 코호트(가상시 · CRLF)는 내용이 같아 그대로',
    readFileSync(path.join(cohortOut, keyOf('가상구'), 'c1.json'), 'utf8') === readFileSync(path.join(appRoot, 'cohort-banks', keyOf('가상구'), 'c1.json'), 'utf8') &&
      readFileSync(path.join(cohortOut, keyOf('가상시'), 'c1.json'), 'utf8').includes('\r\n') &&
      first.stdout.includes('저장소에 같은 내용으로 있음') &&
      !existsSync(path.join(cohortOut, keyOf('가상동'))),
    first.stdout,
  );
  const outBefore = snapshot(out);
  const again = run(appRoot, P.tenantId, Qt.tenantId, '--bundle-out', bankOut, '--cohort-out', cohortOut);
  ok('스크립트 --bundle-out — 다시 실행하면 같은 내용이라 그대로(generatedAt도 그대로)', again.status === 0 && again.stdout.includes('이미 같은 내용(그대로 둠)') && same(snapshot(out), outBefore), `${again.status} ${again.stdout}${again.stderr}`);

  // 굽고 난 뒤(저장소 설정이 v6을 가리킴 — 여기서는 오버레이로 흉내) 다시 실행: 이 PC에 v6이 없고 동봉본이 있으면 그대로 둔다.
  const bakedRoot = path.join(tmp, 'app-baked');
  seedApp(bakedRoot);
  put(path.join(bakedRoot, 'tenants.overlay.json'), [{ ...P, questionBankVersion: 'v6' }, Qt]);
  const afterBake = run(bakedRoot, P.tenantId, Qt.tenantId, '--bundle-out', bankOut, '--cohort-out', cohortOut);
  ok('스크립트 --bundle-out — 판이 이미 동봉본을 가리키고 이 PC에 그 판이 없으면 ✗ 없이 그대로', afterBake.status === 0 && afterBake.stdout.includes('이 PC에 아직 없고 동봉본이 있습니다') && same(snapshot(out), outBefore), `${afterBake.status} ${afterBake.stdout}${afterBake.stderr}`);

  const changed = { ...writtenP!, questions: writtenP!.questions.map((x, i) => (i === 2 ? { ...x, text: `${x.text} (고침)` } : x)) };
  writeFileSync(outP, bundleFileText(changed));
  const changedBefore = snapshot(out);
  const conflict = run(appRoot, P.tenantId, Qt.tenantId, '--bundle-out', bankOut, '--cohort-out', cohortOut);
  ok('스크립트 --bundle-out — 같은 자리에 내용이 다른 동봉본이 있으면 ✗ · 덮지 않음', conflict.status === 1 && conflict.stdout.includes('내용이 다른 동봉본') && same(snapshot(out), changedBefore), `${conflict.status} ${conflict.stdout}${conflict.stderr}`);
  writeFileSync(outP, bundleFileText(writtenP));

  const cohortConflictOut = path.join(tmp, 'repo2');
  put(path.join(cohortConflictOut, 'cohort-banks', keyOf('가상구'), 'c1.json'), { ...cohortFileOf('가상구'), questions: sharedOf('가상구').slice(0, 1) });
  const cohortConflict = run(appRoot, Qt.tenantId, '--bundle-out', path.join(cohortConflictOut, 'qb'), '--cohort-out', path.join(cohortConflictOut, 'cohort-banks'));
  ok('스크립트 --bundle-out — 저장소 코호트 질문지가 내용이 다르면 ✗ · 아무것도 안 씀', cohortConflict.status === 1 && cohortConflict.stdout.includes('내용이 다릅니다 — 덮지 않습니다') && !existsSync(path.join(cohortConflictOut, 'qb')), `${cohortConflict.status} ${cohortConflict.stdout}${cohortConflict.stderr}`);

  const withWrite = run(appRoot, P.tenantId, '--bundle-out', bankOut, '--write');
  ok('스크립트 --bundle-out --write — 거절(앱 데이터에 쓰지 않음)', withWrite.status === 1 && withWrite.stderr.includes('함께 쓸 수 없습니다') && same(snapshot(appRoot), appBefore), `${withWrite.status} ${withWrite.stderr}`);
  const inside = run(appRoot, P.tenantId, '--bundle-out', path.join(appRoot, 'qb'));
  ok('스크립트 --bundle-out — 앱 데이터 폴더 안이면 거절', inside.status === 1 && inside.stderr.includes('앱 데이터 폴더 안에는 쓰지 않습니다') && same(snapshot(appRoot), appBefore), `${inside.status} ${inside.stderr}`);
  const cohortOnlyFlag = run(appRoot, P.tenantId, '--cohort-out', cohortOut);
  ok('스크립트 --cohort-out만 — 거절', cohortOnlyFlag.status === 1 && cohortOnlyFlag.stderr.includes('--bundle-out과 함께만'), `${cohortOnlyFlag.status} ${cohortOnlyFlag.stderr}`);
  const virtualRoot = path.join(tmp, 'Packages', 'Claude_fake', 'LocalCache', 'Roaming', 'brand-aeo-app');
  seedApp(virtualRoot);
  const virtual = run(virtualRoot, P.tenantId, '--bundle-out', path.join(tmp, 'virtual-out'));
  ok('스크립트 --bundle-out — 가상화 사본 경로면 거절', virtual.status === 1 && virtual.stderr.includes('가상화 사본') && !existsSync(path.join(tmp, 'virtual-out')), `${virtual.status} ${virtual.stderr}`);
  ok('git — 저장소 cohort-banks/ · src/data/question-banks/는 이 확인이 건드리지 않음', execFileSync('git', ['status', '--porcelain', '--', 'cohort-banks', 'src/data/question-banks'], { cwd: repoRoot, encoding: 'utf8' }) === gitBefore);
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
