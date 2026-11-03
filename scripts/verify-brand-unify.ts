/**
 * v0.4.49 브랜드 통일의 런타임을 확인한다 — 설치본에 동봉한 질문지를 가져오기 · 멈추기(server/store.ts getQuestionBank ·
 * server/pipeline.ts assertBundledBank)와 시작 때 한 번 하는 정리 · 점검(server/brandUnify.ts). AI는 부르지 않고(USE_MOCK_ENGINES · 키 비움), 파일은 임시 폴더에만 쓴다.
 *
 * server/appPaths.ts의 경로는 모듈을 읽을 때 정해지므로 PC 상태마다 하위 프로세스로 돌린다(이 파일을 --child로 다시 부른다). 설치본처럼
 * APP_DATA_DIR=임시 폴더, SEED_DATA_DIR=저장소 src/data(읽기만), BUNDLED_COHORT_BANK_DIR=저장소 cohort-banks로 돈다.
 *
 *   empty       브랜드가 없는 PC — 측정 · 질문 화면이 동봉본을 가져오고 AI로 만들지 않는다. 가짜 엔진으로 실제 측정(runWeeklyPipeline).
 *   same-id     같은 id의 옛 오버레이 · 옛 판 · 고친 경쟁사 목록 · 툼스톤 · 엔진 · 시장 범위 파일이 있는 PC — 저장소 설정이 이기고 v7을
 *               잰다. 엔진 · 시장 범위 파일은 한 번만 백업 폴더로 옮기고, 사실 · 자사 주소 · 발행 설정 · 브랜드 페이지는 그대로.
 *   other-id    군산각을 다른 id(all-about-gunsan 등)로 등록한 PC — 점검이 알린다(옮기거나 지우지 않는다).
 *   collision   백업 자리에 이미 파일이 있는 PC — 덮지 않고 표식도 남기지 않는다(다음 시작 때 다시).
 *   conflict    같은 판 이름의 다른 질문지 · 읽지 못하는 질문지가 있는 PC — 덮지 않고 측정을 멈춘다.
 *   missing     동봉본에 저장소 설정의 판이 없는 설치본 — AI로 만들지 않고 멈춘다. 저장소 설정과 다른 판(「모두 새로 쓰기」)은 막지 않는다.
 *   unbundled   동봉하지 않는 브랜드 — 예전과 같다(가져오지도 멈추지도 않는다).
 *   append      동봉한 판에 같은 판 이름으로 문항을 덧붙이는 운영 스크립트(add-learn-questions · add-probe-questions)는 쓰기 전에
 *               거절한다 — 덧붙이면 그 PC 질문지가 동봉본과 달라져 그 판의 측정이 멈춘다.
 *   id-collision 구운 id를 이 PC가 다른 업체(경쟁사로 잰 gunsan.go.kr 등)로 쓰고 있다 — 점검이 알리고 정리는 그 id를 건너뛴다.
 *   retry       첫 정리가 멈춘 PC — 다음 시작은 첫 시도의 대상만 다시 하고, 그 사이 사람이 앱에서 저장한 파일은 옮기지 않는다.
 *   vercel      웹 — 동봉 폴더가 없어 아무것도 하지 않는다. 정리 · 점검도 하지 않는다.
 *   real        이 운영 PC 데이터의 사본(있으면) — web4ai v6 66문항 · gunsan v7 62문항을 AI 없이 재고, 실증이었던 질문이 점수에 든다.
 *               정리는 옮길 파일이 없고, 점검 결과를 찍는다.
 *
 *   npx tsx scripts/verify-brand-unify.ts [--real-app-data <userData>]
 *     --real-app-data  운영 PC 앱 데이터(읽기만 — 필요한 폴더만 임시 폴더로 복사). 없으면 //localhost/C$/Users/<사용자>/AppData/Roaming/brand-aeo-app
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = path.join(repoRoot, 'src', 'data', 'question-banks');
const REPO_COHORT_DIR = path.join(repoRoot, 'cohort-banks');
const SELF = fileURLToPath(import.meta.url);

type Check = { label: string; pass: boolean; detail?: string };
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const put = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
};
interface Q {
  questionId: string;
  text: string;
  category: string;
  probe?: boolean;
}
interface Bank {
  version: string;
  generatedAt: string;
  questions: Q[];
  cohortBank?: { key: string; version: string };
}
const bundled = (tenantId: string, version: string) => readJson<Bank>(path.join(BUNDLE_DIR, tenantId, `${version}.json`));
/** 실증이었던 질문 — 동봉본에서는 표시가 없고 id 꼴(v5-p001 · v6-p001)로만 남는다. */
const formerProbe = (q: { questionId: string }) => /-p\d+$/.test(q.questionId);

// ── 하위 프로세스: PC 상태 하나 ─────────────────────────────────────────────
async function child(scenario: string, root: string): Promise<void> {
  const results: Check[] = [];
  const ok = (label: string, pass: boolean, detail?: string) => results.push({ label: `[${scenario}] ${label}`, pass, ...(pass || !detail ? {} : { detail }) });
  try {
    await runScenario(scenario, root, ok);
  } catch (err) {
    ok('예외 없이 끝남', false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  process.stdout.write(`\n@@RESULTS@@${JSON.stringify(results)}\n`);
}

async function runScenario(scenario: string, root: string, ok: (label: string, pass: boolean, detail?: string) => void): Promise<void> {
  const appPaths = await import('../server/appPaths');
  const { FileResultStore } = await import('../server/store');
  const { ensureQuestionBank, runWeeklyPipeline } = await import('../server/pipeline');
  const { loadRuntimeTenants, findBakedTenant } = await import('../server/tenantRegistry');
  const { MockEngineClient } = await import('../server/engines/mockEngineClient');
  const unify = await import('../server/brandUnify');
  type UnifyCheck = import('../server/brandUnify').UnifyCheck;
  type TenantConfig = import('../server/types').TenantConfig;
  const store = new FileResultStore();
  const bankFile = (tenantId: string, version: string) => path.join(root, 'data', tenantId, 'question-bank', `${version}.json`);
  const tenantNow = async (tenantId: string) => (await loadRuntimeTenants()).find((t) => t.tenantId === tenantId);
  const errorOf = async (task: () => Promise<unknown>): Promise<string | null> => {
    try {
      await task();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const sameQuestions = (a: { questions: Q[] } | null, b: { questions: Q[] }) => JSON.stringify(a?.questions ?? null) === JSON.stringify(b.questions);

  /** 가짜 엔진 — 실증이었던 질문의 답에서만 브랜드를 말한다(가짜 판정은 「뷰성형외과」가 있으면 언급으로 본다). */
  const measure = async (tenant: TenantConfig, probeTexts: string[]) => {
    const engineCall = MockEngineClient.prototype.call;
    MockEngineClient.prototype.call = async function (prompt, options) {
      const result = await engineCall.call(this, prompt, options);
      const probe = probeTexts.some((text) => prompt.user.includes(text) || prompt.system.includes(text));
      return { ...result, text: probe ? `${tenant.brandName}(뷰성형외과)을 많이 추천합니다.` : '여러 선택지가 있으니 후기를 비교해 보세요.', citations: [] };
    };
    try {
      const run = await runWeeklyPipeline(tenant, store, new Date('2026-11-04T03:00:00Z'));
      const analyses = await store.getQuestionAnalyses(tenant.tenantId, run.scorecard.weekOf);
      return { run, analyses };
    } finally {
      MockEngineClient.prototype.call = engineCall;
    }
  };
  /** 실제 측정 한 번 — 동봉본 그대로를 묻고, AI로 질문지를 만들지 않고, 실증이었던 질문이 점수에 드는가. */
  const measureBundled = async (tenantId: string, version: string, expect: { questions: number; agnostic: number }, probeTexts?: string[]) => {
    const tenant = await tenantNow(tenantId);
    const bundle = bundled(tenantId, version);
    const texts = probeTexts ?? bundle.questions.filter(formerProbe).map((q) => q.text);
    const scoredProbes = bundle.questions.filter((q) => q.category === 'category-agnostic' && texts.includes(q.text)).length;
    const { run, analyses } = await measure(tenant!, texts);
    const asked = [...new Set(analyses.map((a) => a.questionId))].sort().join();
    ok(
      `실제 측정 ${tenantId} — 판 ${version} · ${expect.questions}문항을 모두 물음(동봉본 그대로)`,
      run.scorecard.questionBankVersion === version && asked === bundle.questions.map((q) => q.questionId).sort().join() && analyses.length === expect.questions && bundle.questions.length === expect.questions,
      `${run.scorecard.questionBankVersion} · ${analyses.length} · ${bundle.questions.length}`,
    );
    ok(`실제 측정 ${tenantId} — 저장된 ${version} 질문지가 동봉본과 같음(AI로 만들지 않음)`, sameQuestions(readJson<Bank>(bankFile(tenantId, version)), bundle));
    ok(
      `실제 측정 ${tenantId} — 카드 언급률 ${scoredProbes}/${expect.agnostic}(실증이었던 질문의 응답이 점수에 듦)`,
      scoredProbes > 0 && bundle.questions.filter((q) => q.category === 'category-agnostic').length === expect.agnostic && Math.abs(run.scorecard.mentionRate - scoredProbes / expect.agnostic) < 1e-9,
      `${run.scorecard.mentionRate} vs ${scoredProbes}/${expect.agnostic}`,
    );
  };

  if (scenario === 'empty') {
    ok('동봉 폴더 = SEED_DATA_DIR/question-banks', appPaths.BUNDLED_BANK_DIR === path.join(process.env.SEED_DATA_DIR!, 'question-banks'), String(appPaths.BUNDLED_BANK_DIR));
    const runtime = await loadRuntimeTenants();
    const v = (id: string) => runtime.find((t) => t.tenantId === id)?.questionBankVersion;
    ok('브랜드 목록 — web4ai v6 · gunsan v7(저장소 설정) · gunsan-national 없음(통일에서 뺌)', v('web4ai') === 'v6' && v('gunsan') === 'v7' && v('gunsan-national') === undefined, `${v('web4ai')} ${v('gunsan')} ${v('gunsan-national')}`);
    ok('처음에는 질문지 파일이 없음', !existsSync(path.join(root, 'data')));
    const got = await store.getQuestionBank('web4ai', 'v6');
    const file = bankFile('web4ai', 'v6');
    ok('질문 화면(getQuestionBank) — 없는 v6을 동봉본에서 가져와 돌려주고 이 PC에 씀', sameQuestions(got, bundled('web4ai', 'v6')) && existsSync(file) && sameQuestions(readJson<Bank>(file), bundled('web4ai', 'v6')));
    const mtime = statSync(file).mtimeMs;
    const again = await store.getQuestionBank('web4ai', 'v6');
    ok('다시 읽으면 이 PC 파일을 그대로 읽음(다시 쓰지 않음)', sameQuestions(again, bundled('web4ai', 'v6')) && statSync(file).mtimeMs === mtime);
    const parallel = await Promise.all([store.getQuestionBank('gunsan', 'v7'), store.getQuestionBank('gunsan', 'v7'), store.getQuestionBank('gunsan', 'v7')]);
    ok('같은 순간 세 번 읽어도 모두 같은 질문지(먼저 가져온 파일을 읽음)', parallel.every((b) => sameQuestions(b, bundled('gunsan', 'v7'))));
    ok('gunsan-national은 동봉하지 않음 — 없는 v3은 null · 파일을 만들지 않음', (await store.getQuestionBank('gunsan-national', 'v3')) === null && !existsSync(bankFile('gunsan-national', 'v3')));
    ok('동봉본에 없는 판은 null · 파일을 만들지 않음', (await store.getQuestionBank('web4ai', 'v5')) === null && !existsSync(bankFile('web4ai', 'v5')));
    await measureBundled('gunsan', 'v7', { questions: 62, agnostic: 48 });
    ok(
      '코호트 공통 질문지 관광정보서비스__전북_군산/c1 — 동봉 기준본을 그대로 가져옴(AI로 만들지 않음)',
      JSON.stringify(readJson(path.join(root, 'cohort-banks', '관광정보서비스__전북_군산', 'c1.json'))) === JSON.stringify(readJson(path.join(REPO_COHORT_DIR, '관광정보서비스__전북_군산', 'c1.json'))),
    );
    const web4ai = await ensureQuestionBank((await tenantNow('web4ai'))!, store);
    ok('측정 web4ai — 질문지 결정이 v6 66문항 그대로', web4ai.length === 66 && JSON.stringify(web4ai) === JSON.stringify(bundled('web4ai', 'v6').questions));
    await unify.runBrandUnify(store);
    const marker = readJson<{ moved: unknown[] }>(path.join(root, unify.UNIFY_MARKER_FILE));
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok('정리 · 점검 — 옮길 파일 없음 · 표식 · unify-check.json · 알릴 것 없음', marker.moved.length === 0 && check.issues.length === 0 && check.sameSite.length === 0, JSON.stringify(check.issues));
    ok(
      '점검 — 이 PC 질문지는 동봉본과 같음(가져온 판) · 코호트 공통 질문지 같음 · 남은 PC별 파일 없음',
      check.tenants.gunsan!.banks.every((b) => b.state === 'same') &&
        check.tenants.web4ai!.banks.every((b) => b.state === 'same') &&
        check.cohortBanks.filter((c) => c.key === '관광정보서비스__전북_군산').every((c) => c.state === 'same') &&
        Object.values(check.tenants).every((t) => t.files.length === 0 && !t.hidden && t.overlayDiffers === null),
      JSON.stringify(check, null, 1),
    );
    return;
  }

  if (scenario === 'same-id') {
    const gunsan = await tenantNow('gunsan');
    const baked = await findBakedTenant('gunsan');
    ok(
      '같은 id — 저장소 설정이 옛 오버레이를 이김(v7 · 저장소 설정의 경쟁사), 옛 판으로 고친 경쟁사 목록은 꺼짐',
      gunsan?.questionBankVersion === 'v7' && JSON.stringify(gunsan.competitors) === JSON.stringify(baked?.competitors) && gunsan.industry === '관광정보서비스',
      JSON.stringify({ v: gunsan?.questionBankVersion, competitors: gunsan?.competitors.map((c) => c.name) }),
    );
    ok('툼스톤에 걸린 gunsan-national은 목록에서 숨은 채', !(await tenantNow('gunsan-national')));
    const v6Before = readFileSync(bankFile('gunsan', 'v6'), 'utf8');
    const used = await ensureQuestionBank(gunsan!, store);
    ok('측정 — 동봉 v7 62문항을 가져와 씀 · 옛 v6 파일 그대로', used.length === 62 && JSON.stringify(used) === JSON.stringify(bundled('gunsan', 'v7').questions) && readFileSync(bankFile('gunsan', 'v6'), 'utf8') === v6Before);

    const tenantDir = path.join(root, 'data', 'gunsan');
    const kept = ['fact-graph.json', 'owned-domains.json', 'publish-settings.json', 'brand-page.json'];
    const keptBefore = kept.map((n) => readFileSync(path.join(tenantDir, n), 'utf8'));
    const movedBefore = ['engines.json', 'market-scope.json'].map((n) => readFileSync(path.join(tenantDir, n), 'utf8'));
    const webEnginesBefore = readFileSync(path.join(root, 'data', 'web4ai', 'engines.json'), 'utf8');
    const preUnify = (await tenantNow('gunsan'))!;
    ok('정리 전 — 이 PC의 엔진 · 시장 범위 파일이 저장소 설정을 덮고 있음', preUnify.engines.join() === 'gemini' && preUnify.marketScope === 'national', `${preUnify.engines} ${preUnify.marketScope}`);
    await unify.runBrandUnify(store);
    const backup = path.join(tenantDir, unify.UNIFY_BACKUP_DIR);
    ok(
      '정리 — 엔진 · 시장 범위 파일을 before-unify-0.4.49/로 옮김(내용 그대로 · 지우지 않음) · web4ai도',
      !existsSync(path.join(tenantDir, 'engines.json')) &&
        !existsSync(path.join(tenantDir, 'market-scope.json')) &&
        ['engines.json', 'market-scope.json'].every((n, i) => readFileSync(path.join(backup, n), 'utf8') === movedBefore[i]) &&
        readFileSync(path.join(root, 'data', 'web4ai', unify.UNIFY_BACKUP_DIR, 'engines.json'), 'utf8') === webEnginesBefore,
    );
    ok('정리 — 사실 · 자사 주소 · 발행 설정 · 브랜드 페이지 파일은 그대로', kept.every((n, i) => readFileSync(path.join(tenantDir, n), 'utf8') === keptBefore[i]));
    const postUnify = (await tenantNow('gunsan'))!;
    const repoGunsan = (await findBakedTenant('gunsan'))!;
    ok('정리 뒤 — 엔진 · 시장 범위가 저장소 설정 값', postUnify.engines.join() === repoGunsan.engines.join() && (postUnify.marketScope ?? 'local') === 'local', `${postUnify.engines} ${postUnify.marketScope}`);
    const marker = readJson<{ moved: { from: string }[] }>(path.join(root, unify.UNIFY_MARKER_FILE));
    const movedList = marker.moved.map((m) => m.from.split(path.sep).join('/')).sort().join();
    ok('정리 — 표식에 옮긴 파일 3개', movedList === 'gunsan/engines.json,gunsan/market-scope.json,web4ai/engines.json', JSON.stringify(marker));
    // 정리 뒤 앱에서 다시 고친 엔진은 사람이 고친 것 — 다시 시작해도 옮기지 않는다.
    put(path.join(tenantDir, 'engines.json'), { engines: ['openai'] });
    await unify.runBrandUnify(store);
    ok('다시 시작 — 표식이 있어 다시 옮기지 않음', existsSync(path.join(tenantDir, 'engines.json')) && readFileSync(path.join(backup, 'engines.json'), 'utf8') === movedBefore[0]);
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    const kinds = check.issues.map((i) => `${i.kind}:${i.tenantId}`).sort().join();
    ok('점검 — 코호트 공통 질문지 다름(gunsan)을 알림 · gunsan-national 툼스톤은 통일 대상이 아니라 알리지 않음', kinds === 'cohort-differs:gunsan', kinds);
    ok(
      '점검 — 옛 오버레이의 범위 · 업종 차이 · 남은 PC별 파일을 적음',
      check.tenants.gunsan!.overlayDiffers?.industry?.overlay === '관광안내' &&
        check.tenants.gunsan!.overlayDiffers?.marketScope?.overlay === 'national' &&
        ['brand-page.json', 'competitors.json', 'engines.json', 'fact-graph.json', 'owned-domains.json', 'publish-settings.json'].every((n) => check.tenants.gunsan!.files.includes(n)) &&
        !('gunsan-national' in check.tenants),
      JSON.stringify(check.tenants.gunsan),
    );
    return;
  }

  if (scenario === 'conflict') {
    const file = bankFile('web4ai', 'v6');
    const before = readFileSync(file, 'utf8');
    const web4ai = (await tenantNow('web4ai'))!;
    const err = await errorOf(() => ensureQuestionBank(web4ai, store));
    ok('같은 판 이름의 다른 질문지 — 측정을 멈추고 이유를 알림', (err ?? '').includes('설치본에 담긴 v6과 질문이 다릅니다') && (err ?? '').includes('덮지 않고 측정을 멈춥니다'), String(err));
    ok('같은 판 이름의 다른 질문지 — 파일 한 바이트도 안 바뀜 · 질문 화면은 이 PC 파일을 보여 줌', readFileSync(file, 'utf8') === before && (await store.getQuestionBank('web4ai', 'v6'))?.questions[0]?.text === readJson<Bank>(file).questions[0]!.text);
    const broken = bankFile('gunsan', 'v7');
    const brokenBefore = readFileSync(broken, 'utf8');
    const err3 = await errorOf(async () => ensureQuestionBank((await tenantNow('gunsan'))!, store));
    ok('읽지 못하는 같은 판 질문지 — 동봉본으로 덮지 않고 멈춤', (err3 ?? '').includes('읽지 못했습니다') && readFileSync(broken, 'utf8') === brokenBefore, String(err3));
    return;
  }

  if (scenario === 'missing') {
    const gunsan = (await tenantNow('gunsan'))!;
    const err = await errorOf(() => ensureQuestionBank(gunsan, store));
    ok('저장소 설정의 판(v7)이 동봉본에 없음 — AI로 만들지 않고 멈춤 · 파일 없음', (err ?? '').includes('이 PC에도 설치본에도 없습니다') && !existsSync(bankFile('gunsan', 'v7')), String(err));
    const err8 = await errorOf(() => ensureQuestionBank({ ...gunsan, questionBankVersion: 'v8' }, store));
    ok('저장소 설정과 다른 판(「모두 새로 쓰기」의 v8)은 막지 않음', !(err8 ?? '').includes('설치본'), String(err8));
    return;
  }

  if (scenario === 'unbundled') {
    const fake = (await tenantNow('fake-unify-x'))!;
    const file = bankFile('fake-unify-x', 'v2');
    const before = readFileSync(file, 'utf8');
    const used = await ensureQuestionBank(fake, store);
    ok('동봉하지 않는 브랜드 — 저장된 질문지 그대로 · 파일 그대로', JSON.stringify(used) === JSON.stringify(readJson<Bank>(file).questions) && readFileSync(file, 'utf8') === before);
    ok('동봉하지 않는 브랜드 — 없는 판은 null · 파일을 만들지 않음(예전과 같음)', (await store.getQuestionBank('fake-unify-x', 'v9')) === null && !existsSync(bankFile('fake-unify-x', 'v9')));
    ok('dev · CI — 동봉 폴더는 저장소 src/data/question-banks', appPaths.BUNDLED_BANK_DIR === path.resolve(repoRoot, 'src', 'data', 'question-banks'), String(appPaths.BUNDLED_BANK_DIR));
    return;
  }

  if (scenario === 'other-id') {
    const before = readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8');
    const ids = (await loadRuntimeTenants()).map((t) => t.tenantId);
    ok('다른 id — 저장소 설정의 gunsan과 옛 id all-about-gunsan이 둘 다 목록에 있음(병합은 홈페이지를 보지 않음)', ids.includes('gunsan') && ids.includes('all-about-gunsan'));
    await unify.runBrandUnify(store);
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    const issues = check.issues.filter((i) => i.kind === 'same-site').map((i) => i.tenantId).sort().join();
    ok('점검 — 보이는 고객 브랜드(all-about-gunsan · co)만 알림, 숨은 gunsan-local · 경쟁사 측정 브랜드는 목록에만', issues === 'all-about-gunsan,co', JSON.stringify(check.sameSite));
    const row = (id: string) => check.sameSite.find((r) => r.tenantId === id);
    ok(
      '점검 — 같은 홈페이지 목록에 숨김 · 경쟁사 여부 · 겹친 브랜드를 적음',
      row('gunsan-local')?.hidden === true &&
        row('comp-gunsan')?.cohortOnly === true &&
        row('all-about-gunsan')?.sharesWith.includes('gunsan') === true &&
        row('co')?.sharesWith.join() === 'web4ai',
      JSON.stringify(check.sameSite),
    );
    ok('점검은 오버레이 · 옛 id 데이터를 바꾸지 않음', readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8') === before && existsSync(path.join(root, 'data', 'all-about-gunsan', 'engines.json')));
    return;
  }

  if (scenario === 'collision') {
    const tenantDir = path.join(root, 'data', 'web4ai');
    const before = readFileSync(path.join(tenantDir, 'engines.json'), 'utf8');
    const err = await errorOf(() => unify.unifyCleanupOnce());
    ok(
      '백업 자리에 파일이 있으면 — 덮지 않고 원래 파일 그대로 · 표식 없음(다음 시작 때 다시)',
      (err ?? '').includes('덮지 않음') && readFileSync(path.join(tenantDir, 'engines.json'), 'utf8') === before && !existsSync(path.join(root, unify.UNIFY_MARKER_FILE)),
      String(err),
    );
    await unify.runBrandUnify(store);
    ok('그래도 점검 파일은 남김', existsSync(path.join(root, unify.UNIFY_CHECK_FILE)));
    return;
  }

  if (scenario === 'append') {
    const { bankQuestionsDiffer, bundledAppendBlocker } = await import('../server/bundledBanks');
    const v6 = bundled('web4ai', 'v6');
    const appended = { ...v6, questions: [...v6.questions, { ...v6.questions[0]!, questionId: 'v6-l001', text: '덧붙인 탐색 질문' }] };
    ok('같은 판에 덧붙이면 동봉본과 달라짐(그 PC 측정이 멈추는 까닭)', bankQuestionsDiffer(appended as never, v6 as never) === '문항 67개 · 동봉본 66개');
    const blocks = await Promise.all(
      [
        ['web4ai', 'v6'],
        ['gunsan', 'v7'],
      ].map(([t, v]) => bundledAppendBlocker(t!, v!)),
    );
    ok('동봉한 판(web4ai v6 · gunsan v7)은 덧붙이기를 막음', blocks.every((b) => (b ?? '').includes('설치본에 담아 배포하는 질문지')), JSON.stringify(blocks));
    ok(
      '동봉하지 않은 판 · 브랜드는 막지 않음(web4ai v5 · 「모두 새로 쓰기」 gunsan v8 · 통일에서 뺀 gunsan-national v3 · 동봉하지 않는 브랜드)',
      (await bundledAppendBlocker('web4ai', 'v5')) === null &&
        (await bundledAppendBlocker('gunsan', 'v8')) === null &&
        (await bundledAppendBlocker('gunsan-national', 'v3')) === null &&
        (await bundledAppendBlocker('fake-unify-x', 'v2')) === null,
    );
    return;
  }

  if (scenario === 'id-collision') {
    await unify.runBrandUnify(store);
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    const marker = readJson<{ moved: { from: string }[]; skipped?: { tenantId: string }[] }>(path.join(root, unify.UNIFY_MARKER_FILE));
    const collided = check.issues.filter((i) => i.kind === 'id-collision').map((i) => i.tenantId).sort().join();
    ok('점검 — 구운 id를 이 PC가 다른 업체(경쟁사 gunsan · 이름이 다른 web4ai)로 쓰고 있으면 알림', collided === 'gunsan,web4ai', JSON.stringify(check.issues));
    ok(
      '점검 — 오버레이 차이에 이름 · 경쟁사 여부를 적음',
      check.tenants.gunsan?.overlayDiffers?.cohortOnly?.overlay === 'true' &&
        check.tenants.gunsan?.overlayDiffers?.brandName?.overlay === '군산시 문화관광' &&
        check.tenants.web4ai?.overlayDiffers?.brandName?.overlay === '다른 업체',
      JSON.stringify(check.tenants),
    );
    const file = (id: string, name: string) => path.join(root, 'data', id, name);
    ok(
      '정리 — 겹친 id(gunsan · web4ai)의 파일은 옮기지 않음 · 통일에서 뺀 gunsan-national의 파일도 그대로',
      existsSync(file('gunsan', 'engines.json')) &&
        existsSync(file('gunsan', 'market-scope.json')) &&
        existsSync(file('web4ai', 'engines.json')) &&
        existsSync(file('gunsan-national', 'engines.json')) &&
        marker.moved.length === 0 &&
        (marker.skipped ?? []).map((s) => s.tenantId).sort().join() === 'gunsan,web4ai',
      JSON.stringify(marker),
    );
    return;
  }

  if (scenario === 'retry' || scenario === 'retry-edited') {
    const dir = (id: string) => path.join(root, 'data', id);
    const backup = (id: string, name: string) => path.join(dir(id), unify.UNIFY_BACKUP_DIR, name);
    const markerFile = path.join(root, unify.UNIFY_MARKER_FILE);
    const norm = (rel: string) => rel.split(path.sep).join('/');
    const engines = path.join(dir('web4ai'), 'engines.json');
    const err1 = await errorOf(() => unify.unifyCleanupOnce());
    if (scenario === 'retry-edited') {
      ok('1회차 — 백업 자리가 막혀 멈춤 · 원래 파일 그대로', (err1 ?? '').includes('덮지 않음') && existsSync(engines) && !existsSync(markerFile), String(err1));
      // 막혀 있는 사이 사람이 앱에서 엔진을 고쳐 저장하고, 운영자가 백업 자리의 옛 파일을 치웠다.
      put(engines, { engines: ['openai', 'gemini'], updatedAt: '2026-11-04T00:00:00.000Z' });
      const human = readFileSync(engines, 'utf8');
      renameSync(backup('web4ai', 'engines.json'), backup('web4ai', 'engines.stale.json'));
      const done = await unify.unifyCleanupOnce();
      ok(
        '막혀 있던 사이 앱에서 고친 파일은 옮기지 않고 표식에 남김(사람이 고친 값)',
        done.ran && done.cleanup.moved.length === 0 && (done.cleanup.skipped ?? []).some((s) => norm(s.from ?? '') === 'web4ai/engines.json') && readFileSync(engines, 'utf8') === human && existsSync(markerFile),
        JSON.stringify(done.cleanup),
      );
      return;
    }
    const scopeBackup = existsSync(backup('web4ai', 'market-scope.json')) ? readFileSync(backup('web4ai', 'market-scope.json'), 'utf8') : null;
    ok(
      '1회차 — 옮길 수 있는 파일은 옮기고, 막힌 파일 때문에 표식 없이 멈춤',
      (err1 ?? '').includes('덮지 않음') && scopeBackup !== null && !existsSync(path.join(dir('web4ai'), 'market-scope.json')) && existsSync(engines) && !existsSync(markerFile),
      String(err1),
    );
    // 사람이 앱에서 저장 — 처음에 없던 gunsan 시장 범위, 이미 옮긴 web4ai 시장 범위를 다시.
    const gunsanScope = put(path.join(dir('gunsan'), 'market-scope.json'), { marketScope: 'national', updatedAt: '2026-11-04T00:00:00.000Z' });
    const webScope = put(path.join(dir('web4ai'), 'market-scope.json'), { marketScope: 'local', updatedAt: '2026-11-04T00:00:00.000Z' });
    const humanGunsan = readFileSync(gunsanScope, 'utf8');
    const humanWeb = readFileSync(webScope, 'utf8');
    const err2 = await errorOf(() => unify.unifyCleanupOnce());
    ok(
      '2회차 — 처음에 없던 파일 · 옮긴 뒤 다시 저장한 파일은 옮기지 않음(막힌 파일만 다시)',
      (err2 ?? '').includes('덮지 않음') &&
        readFileSync(gunsanScope, 'utf8') === humanGunsan &&
        readFileSync(webScope, 'utf8') === humanWeb &&
        !existsSync(path.join(dir('gunsan'), unify.UNIFY_BACKUP_DIR)) &&
        readFileSync(backup('web4ai', 'market-scope.json'), 'utf8') === scopeBackup,
      String(err2),
    );
    await unify.runBrandUnify(store);
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok('점검 — 정리를 마치지 못한 것을 알림(cleanup-failed)', check.cleanup === null && check.issues.some((i) => i.kind === 'cleanup-failed' && i.message.includes('덮지 않음')), JSON.stringify(check.issues));
    // 운영자가 백업 자리의 옛 파일을 치웠다(다른 이름으로).
    renameSync(backup('web4ai', 'engines.json'), backup('web4ai', 'engines.stale.json'));
    const done = await unify.unifyCleanupOnce();
    const moved = done.cleanup.moved.map((m) => norm(m.from)).sort().join();
    ok(
      '막힌 파일이 풀리면 — 그 파일만 옮기고, 표식에 두 회차에 옮긴 파일이 모두 남음 · 사람이 저장한 파일 그대로',
      done.ran && moved === 'web4ai/engines.json,web4ai/market-scope.json' && !existsSync(engines) && existsSync(markerFile) && readFileSync(gunsanScope, 'utf8') === humanGunsan && readFileSync(webScope, 'utf8') === humanWeb,
      JSON.stringify(done.cleanup),
    );
    return;
  }

  if (scenario === 'vercel') {
    ok('웹 — 동봉 폴더 없음(null)', appPaths.BUNDLED_BANK_DIR === null);
    ok('웹 — 없는 판은 null · 아무것도 쓰지 않음', (await store.getQuestionBank('web4ai', 'v6')) === null && !existsSync(path.join(root, 'data')));
    await unify.runBrandUnify(store);
    ok('웹 — 정리 · 점검 안 함(파일 없음)', !existsSync(path.join(root, unify.UNIFY_CHECK_FILE)) && !existsSync(path.join(root, unify.UNIFY_MARKER_FILE)));
    return;
  }

  if (scenario === 'real') {
    const runtime = await loadRuntimeTenants();
    const t = (id: string) => runtime.find((x) => x.tenantId === id);
    ok(
      '운영 PC 사본 — web4ai v6 · gunsan v7(저장소 설정) · gunsan-national은 이 PC 오버레이의 v3(저장소 설정에 없음)',
      t('web4ai')?.questionBankVersion === 'v6' && t('gunsan')?.questionBankVersion === 'v7' && t('gunsan-national')?.questionBankVersion === 'v3' && !(await findBakedTenant('gunsan-national')),
    );
    ok('운영 PC 사본 — 판 v6(web4ai) · v7(gunsan)은 아직 이 PC에 없음', !existsSync(bankFile('web4ai', 'v6')) && !existsSync(bankFile('gunsan', 'v7')));
    const snap = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
    const keep = ['data/web4ai/question-bank/v5.json', 'data/gunsan/question-bank/v6.json', 'data/gunsan-national/question-bank/v3.json', 'cohort-banks/펜션__전북_군산/c1.json', 'cohort-banks/관광정보서비스__전북_군산/c1.json', 'cohort-banks/관광안내__국내/c1.json'];
    const before = keep.map(snap);
    // 실증이었던 질문은 이 PC의 옛 판(web4ai v5 · gunsan v6)의 probe 표시로 고른다.
    const probesOf = (id: string, v: string) => readJson<Bank>(bankFile(id, v)).questions.filter((q) => q.probe === true).map((q) => q.text);
    const probeWeb = probesOf('web4ai', 'v5');
    const probeGunsan = probesOf('gunsan', 'v6');
    ok('운영 PC 사본 — 옛 판의 실증 질문 web4ai 24개 · gunsan 26개', probeWeb.length === 24 && probeGunsan.length === 26, `${probeWeb.length} ${probeGunsan.length}`);
    await measureBundled('web4ai', 'v6', { questions: 66, agnostic: 50 }, probeWeb);
    await measureBundled('gunsan', 'v7', { questions: 62, agnostic: 48 }, probeGunsan);
    const national = await ensureQuestionBank(t('gunsan-national')!, store);
    ok('운영 PC 사본 — gunsan-national은 이 PC의 v3 36문항 그대로(동봉하지 않아 가져오거나 멈추지 않음)', national.length === 36);
    ok('운영 PC 사본 — 옛 판 · 코호트 공통 질문지 파일이 한 바이트도 안 바뀜', keep.map(snap).every((s, i) => s === before[i]));
    const factBefore = ['gunsan', 'gunsan-national', 'web4ai'].map((id) => snap(`data/${id}/fact-graph.json`));
    await unify.runBrandUnify(store);
    const marker = readJson<{ moved: unknown[] }>(path.join(root, unify.UNIFY_MARKER_FILE));
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok('운영 PC 사본 — 정리할 엔진 · 시장 범위 파일 없음 · 사실 파일 그대로', marker.moved.length === 0 && ['gunsan', 'gunsan-national', 'web4ai'].every((id, i) => snap(`data/${id}/fact-graph.json`) === factBefore[i]));
    ok(
      '운영 PC 사본 — 점검: 같은 홈페이지의 gunsan-national(통일에서 뺌)만 알림 · 질문지 · 코호트 공통 질문지 모두 동봉본과 같음',
      check.issues.map((i) => `${i.kind}:${i.tenantId}`).join() === 'same-site:gunsan-national' && Object.values(check.tenants).every((t) => t.banks.every((b) => b.state === 'same')) && check.cohortBanks.every((c) => c.state === 'same'),
      JSON.stringify({ issues: check.issues, banks: Object.fromEntries(Object.entries(check.tenants).map(([k, v]) => [k, v.banks])), cohorts: check.cohortBanks }),
    );
    return;
  }
  ok(`모르는 상태: ${scenario}`, false);
}

// ── 부모: PC 상태를 만들고 하위 프로세스로 돌린다 ──────────────────────────────
async function parent(): Promise<void> {
  const args = process.argv.slice(2);
  const realFlag = args.indexOf('--real-app-data');
  const realAppData =
    realFlag >= 0 ? path.resolve(args[realFlag + 1] ?? '') : `//localhost/C$/Users/${process.env.USERNAME ?? ''}/AppData/Roaming/brand-aeo-app`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'verify-brand-unify-'));
  const checks: Check[] = [];
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BLOB_READ_WRITE_TOKEN: '',
    BLOB_STORE_ID: '',
    PIPELINE_CRON: '',
    USE_MOCK_ENGINES: 'true',
    COLLECT_ENGINES: 'gemini',
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    PERPLEXITY_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  };
  delete baseEnv.VERCEL;
  delete baseEnv.SEED_DATA_DIR;
  delete baseEnv.BUNDLED_COHORT_BANK_DIR;
  const packaged = (root: string): NodeJS.ProcessEnv => ({
    APP_DATA_DIR: root,
    SEED_DATA_DIR: path.join(repoRoot, 'src', 'data'),
    BUNDLED_COHORT_BANK_DIR: REPO_COHORT_DIR,
  });
  const runChild = (scenario: string, root: string, env: NodeJS.ProcessEnv) => {
    mkdirSync(root, { recursive: true });
    const r = spawnSync(process.execPath, [tsxCli, SELF, '--child', scenario, root], { cwd: repoRoot, encoding: 'utf8', env: { ...baseEnv, ...env }, maxBuffer: 64 * 1024 * 1024 });
    const marker = r.stdout.lastIndexOf('@@RESULTS@@');
    if (marker < 0) {
      checks.push({ label: `[${scenario}] 하위 프로세스가 결과를 냄`, pass: false, detail: `${r.status}\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}` });
      return;
    }
    checks.push(...(JSON.parse(r.stdout.slice(marker + '@@RESULTS@@'.length).trim()) as Check[]));
  };
  const config = readJson<{ tenantId: string }[]>(path.join(repoRoot, 'server', 'tenants.config.json'));
  const baked = (id: string) => config.find((t) => t.tenantId === id) as Record<string, unknown> & { tenantId: string };

  try {
    // empty — 아무것도 없는 PC.
    runChild('empty', path.join(tmp, 'empty'), packaged(path.join(tmp, 'empty')));

    // same-id — 옛 오버레이(v6 · 옛 경쟁사) · 옛 판 질문지 · 옛 베이스로 고친 경쟁사 목록 · gunsan-national 툼스톤.
    {
      const root = path.join(tmp, 'same-id');
      const oldGunsan = { ...baked('gunsan'), questionBankVersion: 'v6', competitors: [{ name: '옛 경쟁사', aliases: ['옛 경쟁사'], domains: [] }] };
      put(path.join(root, 'tenants.overlay.json'), [oldGunsan, { ...baked('web4ai'), questionBankVersion: 'v5' }]);
      put(path.join(root, 'tenants.deleted.json'), ['gunsan-national']);
      put(path.join(root, 'data', 'gunsan', 'question-bank', 'v6.json'), { ...bundled('gunsan', 'v7'), version: 'v6', questions: bundled('gunsan', 'v7').questions.slice(0, 30) });
      const { baseFingerprint } = await import('../server/tenantCompetitorsStore');
      put(path.join(root, 'data', 'gunsan', 'competitors.json'), {
        current: { competitors: [{ name: '앱에서 고친 경쟁사', aliases: ['앱에서 고친 경쟁사'], domains: [] }], base: baseFingerprint(oldGunsan as never) },
        lastSave: null,
        measured: null,
        updatedAt: '2026-10-25T00:00:00.000Z',
      });
      // 옛 오버레이는 업종 · 범위도 달랐다(전국형으로 먼저 등록한 PC 흉내). 엔진 · 시장 범위 파일이 저장소 설정을 덮고 있다.
      const overlay = readJson<Record<string, unknown>[]>(path.join(root, 'tenants.overlay.json'));
      overlay[0] = { ...overlay[0], industry: '관광안내', marketScope: 'national' };
      put(path.join(root, 'tenants.overlay.json'), overlay);
      put(path.join(root, 'data', 'gunsan', 'engines.json'), { engines: ['gemini'], updatedAt: '2026-10-20T00:00:00.000Z' });
      put(path.join(root, 'data', 'gunsan', 'market-scope.json'), { marketScope: 'national', updatedAt: '2026-10-20T00:00:00.000Z' });
      put(path.join(root, 'data', 'web4ai', 'engines.json'), { engines: ['gemini', 'perplexity'], updatedAt: '2026-10-20T00:00:00.000Z' });
      put(path.join(root, 'data', 'gunsan', 'fact-graph.json'), [{ id: 'fact-other-x', type: 'other', claim: '가짜 사실', value: '가짜 값', updatedAt: '2026-10-20' }]);
      put(path.join(root, 'data', 'gunsan', 'owned-domains.json'), { extra: ['gunsan-extra.example'], updatedAt: '2026-10-20T00:00:00.000Z' });
      put(path.join(root, 'data', 'gunsan', 'publish-settings.json'), { photoRights: 'own', updatedAt: '2026-10-20T00:00:00.000Z' });
      put(path.join(root, 'data', 'gunsan', 'brand-page.json'), { url: 'https://gunsan.webforai.kr/about', updatedAt: '2026-10-20T00:00:00.000Z' });
      // 이 PC가 따로 만든 같은 키의 코호트 공통 질문지(문장 하나 다름).
      const cohort = readJson<{ questions: Q[] }>(path.join(REPO_COHORT_DIR, '관광정보서비스__전북_군산', 'c1.json'));
      put(path.join(root, 'cohort-banks', '관광정보서비스__전북_군산', 'c1.json'), { ...cohort, questions: cohort.questions.map((q, i) => (i === 0 ? { ...q, text: `${q.text} 이 PC` } : q)) });
      runChild('same-id', root, packaged(root));
    }

    // conflict — 이 PC에 이미 다른 web4ai v6(다른 PC가 「모두 새로 쓰기」 등으로 만든 것) · 읽지 못하는 gunsan v7.
    {
      const root = path.join(tmp, 'conflict');
      const other = bundled('web4ai', 'v6');
      put(path.join(root, 'data', 'web4ai', 'question-bank', 'v6.json'), { ...other, questions: other.questions.map((q, i) => (i === 30 ? { ...q, text: `${q.text} 다른 PC` } : q)) });
      mkdirSync(path.join(root, 'data', 'gunsan', 'question-bank'), { recursive: true });
      writeFileSync(path.join(root, 'data', 'gunsan', 'question-bank', 'v7.json'), '{ 쓰다 만 파일');
      runChild('conflict', root, packaged(root));
    }

    // missing — 동봉 폴더에 gunsan v7이 빠진 설치본(동봉 목록에는 gunsan이 있다).
    {
      const root = path.join(tmp, 'missing');
      const seed = path.join(tmp, 'missing-seed');
      put(path.join(seed, 'question-banks', 'gunsan', 'v3.json'), { ...bundled('gunsan', 'v7'), version: 'v3' });
      runChild('missing', root, { ...packaged(root), SEED_DATA_DIR: seed });
    }

    // unbundled — 동봉하지 않는 오버레이 브랜드(dev 경로: SEED_DATA_DIR 없음 → 저장소 src/data/question-banks).
    {
      const root = path.join(tmp, 'unbundled');
      const region = '가상시';
      const shared = [{ questionId: 'c1-001', text: `${region} 가상업종 추천해줘`, category: 'category-agnostic', stage: 'consider', industry: '가상업종', region, containsBrandName: false, version: 'c1', cohortShared: true }];
      put(path.join(root, 'tenants.overlay.json'), [
        { tenantId: 'fake-unify-x', brandName: '가상집', aliases: ['가상집'], ownedDomains: ['x.example'], industry: '가상업종', region, engines: ['gemini'], questionBankSize: 2, questionBankVersion: 'v2', repeatsPerQuestion: 1, competitors: [], factGraph: [], cohortQuestionBank: 'c1' },
      ]);
      put(path.join(root, 'cohort-banks', `가상업종__${region}`, 'c1.json'), { key: `가상업종__${region}`, industry: '가상업종', region, version: 'c1', generatedAt: '2026-09-01T00:00:00.000Z', questions: shared });
      put(path.join(root, 'data', 'fake-unify-x', 'question-bank', 'v2.json'), {
        version: 'v2',
        generatedAt: '2026-10-01T00:00:00.000Z',
        cohortBank: { key: `가상업종__${region}`, version: 'c1' },
        questions: [...shared, { questionId: 'v2-001', text: '가상집 주차 돼?', category: 'brand-direct', stage: 'decide', industry: '가상업종', region, containsBrandName: true, version: 'v2' }],
      });
      runChild('unbundled', root, { APP_DATA_DIR: root });
    }

    // other-id — 군산각을 다른 id로 등록한 PC: 고객 all-about-gunsan(보임) · gunsan-local(지움) · 경쟁사 측정 comp-gunsan · co.webforai.kr로 등록한 co.
    {
      const root = path.join(tmp, 'other-id');
      const like = (tenantId: string, extra: Record<string, unknown>) => ({ ...baked('gunsan'), tenantId, ...extra });
      put(path.join(root, 'tenants.overlay.json'), [
        like('all-about-gunsan', { ownedDomains: ['all-about-gunsan.vercel.app'], industry: '펜션', questionBankVersion: 'v5' }),
        like('gunsan-local', { ownedDomains: ['gunsan.webforai.kr'] }),
        like('comp-gunsan', { ownedDomains: ['gunsan.webforai.kr'], cohortOnly: true }),
        like('co', { brandName: '스테이머뭄', ownedDomains: ['co.webforai.kr'], industry: '숙박' }),
      ]);
      put(path.join(root, 'tenants.deleted.json'), ['gunsan-local']);
      put(path.join(root, 'data', 'all-about-gunsan', 'engines.json'), { engines: ['gemini'] });
      runChild('other-id', root, packaged(root));
    }

    // collision — 백업 자리에 이미 engines.json이 있는 PC.
    {
      const root = path.join(tmp, 'collision');
      put(path.join(root, 'data', 'web4ai', 'engines.json'), { engines: ['gemini'] });
      put(path.join(root, 'data', 'web4ai', 'before-unify-0.4.49', 'engines.json'), { engines: ['openai'] });
      runChild('collision', root, packaged(root));
    }

    // append — 동봉한 판에 문항을 덧붙이는 운영 스크립트(add-learn-questions · add-probe-questions)는 쓰기 전에 거절한다. 가짜 엔진 ·
    // 빈 키로 돌리므로 막지 못해도 AI를 부르지 않고, 쓰더라도 임시 폴더에만 쓴다(appDataDir · --app-data · --out).
    {
      const root = path.join(tmp, 'append');
      const files = [put(path.join(root, 'data', 'web4ai', 'question-bank', 'v6.json'), bundled('web4ai', 'v6')), put(path.join(root, 'data', 'gunsan', 'question-bank', 'v7.json'), bundled('gunsan', 'v7'))];
      put(path.join(root, 'tenants.overlay.json'), []);
      const before = files.map((f) => readFileSync(f, 'utf8'));
      const out = path.join(root, 'out');
      mkdirSync(out, { recursive: true });
      const script = (name: string, scriptArgs: string[]) =>
        spawnSync(process.execPath, [tsxCli, path.join(repoRoot, 'scripts', name), ...scriptArgs], { cwd: repoRoot, encoding: 'utf8', env: baseEnv, maxBuffer: 64 * 1024 * 1024 });
      const refused = (r: ReturnType<typeof script>) => r.status === 1 && r.stderr.includes('설치본에 담아 배포하는 질문지');
      const learn = script('add-learn-questions.ts', ['web4ai', '2', root]);
      checks.push({ label: '[append] add-learn-questions — 동봉한 web4ai v6에 덧붙이기를 거절', pass: refused(learn), detail: `${learn.status}\n${learn.stdout.slice(-1500)}\n${learn.stderr.slice(-1500)}` });
      const probeRun = script('add-probe-questions.ts', ['gunsan', '--app-data', root, '--out', out]);
      checks.push({ label: '[append] add-probe-questions — 동봉한 gunsan v7에 덧붙이기를 거절(후보도 만들지 않음)', pass: refused(probeRun) && readdirSync(out).length === 0, detail: `${probeRun.status}\n${probeRun.stdout.slice(-1500)}\n${probeRun.stderr.slice(-1500)}` });
      checks.push({ label: '[append] 질문지 파일 그대로', pass: files.every((f, i) => readFileSync(f, 'utf8') === before[i]) });
      runChild('append', root, { APP_DATA_DIR: root });
    }

    // id-collision — 이 PC가 구운 id를 다른 업체로 쓰고 있다: 경쟁사로 잰 군산시 문화관광(gunsan.go.kr → id gunsan) · 이름이 다른 web4ai.
    {
      const root = path.join(tmp, 'id-collision');
      put(path.join(root, 'tenants.overlay.json'), [
        { ...baked('gunsan'), brandName: '군산시 문화관광', aliases: ['군산시 문화관광'], ownedDomains: ['gunsan.go.kr'], industry: '펜션', cohortOnly: true },
        { ...baked('web4ai'), brandName: '다른 업체', aliases: ['다른 업체'], ownedDomains: ['web4ai.example'] },
      ]);
      put(path.join(root, 'data', 'gunsan', 'engines.json'), { engines: ['gemini'] });
      put(path.join(root, 'data', 'gunsan', 'market-scope.json'), { marketScope: 'national' });
      put(path.join(root, 'data', 'web4ai', 'engines.json'), { engines: ['gemini'] });
      put(path.join(root, 'data', 'gunsan-national', 'engines.json'), { engines: ['gemini'] });
      runChild('id-collision', root, packaged(root));
    }

    // retry — 첫 정리가 백업 자리 충돌로 멈춘 PC. 그 사이 사람이 앱에서 저장한 파일을 다음 시작이 옮기면 안 된다.
    {
      const root = path.join(tmp, 'retry');
      put(path.join(root, 'data', 'web4ai', 'engines.json'), { engines: ['gemini'] });
      put(path.join(root, 'data', 'web4ai', 'before-unify-0.4.49', 'engines.json'), { engines: ['openai'], note: '전에 남은 파일' });
      put(path.join(root, 'data', 'web4ai', 'market-scope.json'), { marketScope: 'national', updatedAt: '2026-10-20T00:00:00.000Z' });
      runChild('retry', root, packaged(root));
    }
    {
      const root = path.join(tmp, 'retry-edited');
      put(path.join(root, 'data', 'web4ai', 'engines.json'), { engines: ['gemini'] });
      put(path.join(root, 'data', 'web4ai', 'before-unify-0.4.49', 'engines.json'), { engines: ['openai'], note: '전에 남은 파일' });
      runChild('retry-edited', root, packaged(root));
    }

    // vercel — 웹.
    runChild('vercel', path.join(tmp, 'vercel'), { APP_DATA_DIR: path.join(tmp, 'vercel'), VERCEL: '1' });

    // real — 운영 PC 앱 데이터의 사본(읽기만 하고 필요한 폴더만 복사).
    if (existsSync(path.join(realAppData, 'tenants.overlay.json'))) {
      const root = path.join(tmp, 'real');
      mkdirSync(root, { recursive: true });
      for (const name of ['tenants.overlay.json', 'tenants.deleted.json']) {
        if (existsSync(path.join(realAppData, name))) cpSync(path.join(realAppData, name), path.join(root, name));
      }
      for (const id of ['web4ai', 'gunsan', 'gunsan-national']) cpSync(path.join(realAppData, 'data', id), path.join(root, 'data', id), { recursive: true });
      for (const key of ['펜션__전북_군산', '관광정보서비스__전북_군산', '관광안내__국내']) {
        cpSync(path.join(realAppData, 'cohort-banks', key), path.join(root, 'cohort-banks', key), { recursive: true });
      }
      runChild('real', root, packaged(root));
    } else {
      console.log(`(운영 PC 앱 데이터가 없어 real은 건너뜀: ${realAppData})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  let failed = 0;
  for (const { label, pass, detail } of checks) {
    console.log(`${pass ? '✓' : '✗'} ${label}`);
    if (!pass && detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`);
    if (!pass) failed += 1;
  }
  if (failed > 0 || checks.length === 0) {
    console.error(`\n${failed}건 실패`);
    process.exit(1);
  }
  console.log(`\n모두 통과 (${checks.length}건)`);
}

const childAt = process.argv.indexOf('--child');
if (childAt >= 0) await child(process.argv[childAt + 1]!, process.argv[childAt + 2]!);
else await parent();
