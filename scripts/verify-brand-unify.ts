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
 *   national    오버레이에 군산각 전국형(gunsan-national)이 있는 PC — 시작 때 한 번, 화면의 「빼기」와 같이 지운다(툼스톤 · 되살리기
 *               백업 · 대기열 · 최근 실패 · 순위 다시 매김). 측정 기록과 gunsan은 그대로. 되살린 뒤 다시 시작해도 다시 지우지 않는다.
 *   national-absent  gunsan-national이 없는 PC — 없음을 남기고 아무것도 하지 않는다(그 뒤 새로 만든 것도 지우지 않는다).
 *   national-busy    측정 중에 시작 — 지우지 않고 다음 시작으로 미룬다.
 *   national-resume  오버레이에서 뺀 뒤 측정 대기열(-tombstone은 툼스톤) 쓰기가 실패한 PC — 다음 시작이 남은 단계를 마저 하고 deleted로 남긴다.
 *   national-collision  이 PC의 gunsan-national이 다른 업체(이름 · 홈페이지가 다르거나 경쟁사로만 잼) — 지우지 않고 알린다.
 *   national-dev     dev · CI(APP_DATA_DIR 없음) — 지우지 않는다.
 *   vercel      웹 — 동봉 폴더가 없어 아무것도 하지 않는다. 정리 · 점검 · gunsan-national 지우기도 하지 않는다.
 *   real        이 운영 PC 데이터의 사본(있으면) — 시작 때 gunsan-national을 지우고(기록 · data/ 그대로, gunsan · web4ai 그대로),
 *               web4ai v6 66문항 · gunsan v7 62문항을 AI 없이 재고, 실증이었던 질문이 점수에 든다. 정리는 옮길 파일이 없다.
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
  /** 폴더 아래 모든 파일의 내용(상대 경로 → 내용) — 지우기 전후를 견준다. 없으면 빈 객체. */
  const snapshot = (rel: string): Record<string, string> => {
    const base = path.join(root, rel);
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name);
        if (e.isDirectory()) walk(file);
        else out[path.relative(base, file).split(path.sep).join('/')] = readFileSync(file, 'utf8');
      }
    };
    if (existsSync(base)) walk(base);
    return out;
  };
  const sameSnapshot = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b);
  /** 시작 때 정리 · 점검을 돌리며 로그를 모은다 — 결과 표식(@@RESULTS@@) 앞의 출력을 늘리지 않는다. */
  const unifyWithLogs = async (): Promise<string[]> => {
    const logs: string[] = [];
    const { log, warn } = console;
    const collect = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
    console.log = collect;
    console.warn = collect;
    try {
      await unify.runBrandUnify(store);
    } finally {
      console.log = log;
      console.warn = warn;
    }
    return logs;
  };
  const NATIONAL = 'gunsan-national';
  type NationalRemoval = import('../server/brandUnify').NationalRemoval;
  const nationalMarker = () => path.join(root, unify.NATIONAL_REMOVAL_MARKER_FILE);

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
    ok(
      '이미 지운(툼스톤) gunsan-national — 없음(absent · hidden)으로 남기고 건드리지 않음',
      check.nationalRemoval?.action === 'absent' && check.nationalRemoval.hidden === true && readJson<string[]>(path.join(root, 'tenants.deleted.json')).join() === NATIONAL,
      JSON.stringify(check.nationalRemoval),
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
    ok(
      '웹 — 정리 · 점검 · gunsan-national 지우기 안 함(파일 없음 · 오버레이 그대로)',
      !existsSync(path.join(root, unify.UNIFY_CHECK_FILE)) &&
        !existsSync(path.join(root, unify.UNIFY_MARKER_FILE)) &&
        !existsSync(nationalMarker()) &&
        !existsSync(path.join(root, 'tenants.deleted.json')) &&
        readJson<{ tenantId: string }[]>(path.join(root, 'tenants.overlay.json')).some((t) => t.tenantId === NATIONAL),
    );
    return;
  }

  if (scenario === 'national') {
    const { readRemovedTenants, restoreRemovedTenant } = await import('../server/tenantRemovedStore');
    const { readDeletedTenants } = await import('../server/tenantTombstone');
    const { readOverlay } = await import('../server/tenantOverlay');
    const { readMeasureRequests } = await import('../server/measureRequests');
    const { flushMeasureFailures } = await import('../server/measureTracker');
    const overlayBefore = await readOverlay();
    const nationalEntry = overlayBefore.find((t) => t.tenantId === NATIONAL);
    ok('지우기 전 — 오버레이의 gunsan-national이 목록에 있음(저장소 설정에는 없음)', Boolean(await tenantNow(NATIONAL)) && Boolean(nationalEntry) && !(await findBakedTenant(NATIONAL)));
    const nationalBefore = snapshot(`data/${NATIONAL}`);
    const gunsanBefore = snapshot('data/gunsan');
    const cohortBefore = snapshot('cohort-banks');
    const gunsanEntryBefore = JSON.stringify(overlayBefore.find((t) => t.tenantId === 'gunsan'));
    const logs = await unifyWithLogs();
    await flushMeasureFailures();
    ok(
      '시작 — gunsan-national을 화면의 「빼기」처럼 지움: 목록에서 빠짐 · 툼스톤 · 오버레이에서 빠짐',
      !(await tenantNow(NATIONAL)) && (await readDeletedTenants()).includes(NATIONAL) && !(await readOverlay()).some((t) => t.tenantId === NATIONAL),
    );
    const backup = (await readRemovedTenants()).find((r) => r.tenantId === NATIONAL);
    ok('되살리기용 — 지우기 전 오버레이 설정을 「지운 브랜드」에 남김', JSON.stringify(backup?.overlay) === JSON.stringify(nationalEntry) && backup?.snapshot?.tenantId === NATIONAL, JSON.stringify(backup));
    const queued = (await readMeasureRequests()).map((r) => r.tenant.tenantId).join();
    ok('측정 대기열 — gunsan-national 요청만 빠지고 gunsan 요청은 그대로', queued === 'gunsan', queued);
    const failures = readJson<{ tenantId: string }[]>(path.join(root, 'measure-failures.json')).map((f) => f.tenantId).join();
    ok('「최근 실패」 — gunsan-national 줄만 빠지고 gunsan 줄은 그대로', failures === 'gunsan', failures);
    ok('측정 기록 — data/gunsan-national/의 파일이 모두 그대로(카드 · 주차 폴더 · 질문지 · 사실 · 올린 글)', sameSnapshot(snapshot(`data/${NATIONAL}`), nationalBefore), Object.keys(nationalBefore).join());
    const gunsan = await tenantNow('gunsan');
    ok(
      'gunsan(지역형)은 그대로 — data/gunsan(카드 · 추가 글 · 올린 글 · 작성자 배정) · 오버레이 항목 · 코호트 공통 질문지 · 목록의 v7',
      sameSnapshot(snapshot('data/gunsan'), gunsanBefore) &&
        sameSnapshot(snapshot('cohort-banks'), cohortBefore) &&
        JSON.stringify((await readOverlay()).find((t) => t.tenantId === 'gunsan')) === gunsanEntryBefore &&
        gunsan?.questionBankVersion === 'v7',
    );
    const comp = (await store.getScorecardHistory('comp-nat', 10))[0];
    ok('같은 코호트 순위를 다시 매김(화면의 빼기와 같음) — 남은 경쟁사 2/2 → 1/1', comp?.cohortRank?.position === 1 && comp.cohortRank.totalTenants === 1, JSON.stringify(comp?.cohortRank));
    const marker = readJson<NationalRemoval>(nationalMarker());
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      '표식 — 지웠음(deleted)을 남김 · 점검 파일에도 적음 · 알릴 것 없음',
      marker.action === 'deleted' && check.nationalRemoval?.action === 'deleted' && check.issues.length === 0,
      JSON.stringify({ marker, issues: check.issues }),
    );
    ok('로그 — gunsan-national을 지운 것을 남김', logs.some((l) => l.startsWith('[unify]') && l.includes(NATIONAL) && l.includes('지움')), logs.join('\n'));
    const markerRaw = readFileSync(nationalMarker(), 'utf8');

    // 운영자가 「되살리기」를 누른 뒤 다시 시작 — 다시 지우지 않는다.
    await restoreRemovedTenant(NATIONAL, store);
    ok('되살리기 — 목록에 다시 있음(측정 기록 그대로)', Boolean(await tenantNow(NATIONAL)) && sameSnapshot(snapshot(`data/${NATIONAL}`), nationalBefore));
    const logs2 = await unifyWithLogs();
    const check2 = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      '되살린 뒤 다시 시작 — 다시 지우지 않음(표식 그대로) · 툼스톤 없음',
      Boolean(await tenantNow(NATIONAL)) && !(await readDeletedTenants()).includes(NATIONAL) && readFileSync(nationalMarker(), 'utf8') === markerRaw && !logs2.some((l) => l.includes('지움')),
      logs2.join('\n'),
    );
    ok(
      '되살린 뒤 점검 — 지난번에 지운 기록(deleted)을 그대로 보이고, 같은 홈페이지의 다른 id로 알림(예전 점검 그대로)',
      check2.nationalRemoval?.action === 'deleted' && check2.issues.map((i) => `${i.kind}:${i.tenantId}`).join() === `same-site:${NATIONAL}`,
      JSON.stringify(check2.issues),
    );
    return;
  }

  if (scenario === 'national-absent') {
    const { readOverlay, writeOverlay } = await import('../server/tenantOverlay');
    const overlayBefore = readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8');
    const logs = await unifyWithLogs();
    const marker = readJson<NationalRemoval>(nationalMarker());
    ok(
      '없는 PC — 없음(absent)을 남기고 아무것도 하지 않음(툼스톤 · 지운 브랜드 파일 없음 · 오버레이 그대로)',
      marker.action === 'absent' &&
        marker.hidden === false &&
        !existsSync(path.join(root, 'tenants.deleted.json')) &&
        !existsSync(path.join(root, 'tenants.removed.json')) &&
        readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8') === overlayBefore,
      JSON.stringify(marker),
    );
    ok(
      '없는 PC — 점검 · 로그에 적음',
      readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE)).nationalRemoval?.action === 'absent' && logs.some((l) => l.includes(NATIONAL) && l.includes('없음')),
      logs.join('\n'),
    );
    // 그 뒤 운영자가 「하나 더 등록」으로 전국형을 다시 만들었다 — 다음 시작은 지우지 않는다.
    const gunsanEntry = (await readOverlay()).find((t) => t.tenantId === 'gunsan')!;
    await writeOverlay([...(await readOverlay()), { ...gunsanEntry, tenantId: NATIONAL, industry: '관광안내', region: '국내', marketScope: 'national', questionBankVersion: 'v1' }]);
    await unifyWithLogs();
    ok('그 뒤 새로 만든 gunsan-national은 다음 시작에도 지우지 않음', Boolean(await tenantNow(NATIONAL)) && readJson<NationalRemoval>(nationalMarker()).action === 'absent');
    return;
  }

  if (scenario === 'national-busy') {
    const tracker = await import('../server/measureTracker');
    tracker.beginMeasureRun();
    await unifyWithLogs();
    tracker.endMeasureRun();
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      '측정 중에 시작 — 지우지 않고 표식 없이 미룸 · 점검이 알림',
      Boolean(await tenantNow(NATIONAL)) && !existsSync(nationalMarker()) && check.nationalRemoval === null && check.issues.some((i) => i.kind === 'national-deferred' && i.tenantId === NATIONAL),
      JSON.stringify(check.issues),
    );
    await unifyWithLogs();
    ok('측정이 끝난 뒤 다음 시작 — 지움', !(await tenantNow(NATIONAL)) && readJson<NationalRemoval>(nationalMarker()).action === 'deleted');
    return;
  }

  if (scenario === 'national-resume' || scenario === 'national-resume-tombstone') {
    const { readRemovedTenants } = await import('../server/tenantRemovedStore');
    const { readDeletedTenants } = await import('../server/tenantTombstone');
    const { readOverlay } = await import('../server/tenantOverlay');
    const { readMeasureRequests } = await import('../server/measureRequests');
    const { flushMeasureFailures } = await import('../server/measureTracker');
    const nationalEntry = (await readOverlay()).find((t) => t.tenantId === NATIONAL);
    // 첫 시작 — 오버레이에서 뺀 뒤의 쓰기가 실패한다(백신 · 색인기가 파일을 잡은 것처럼). 그 자리에 폴더를 두어 writeFile이 던지게 한다.
    const blocked = path.join(root, scenario === 'national-resume' ? 'measure-requests.json' : 'tenants.deleted.json');
    const blockedRaw = existsSync(blocked) ? readFileSync(blocked, 'utf8') : null;
    rmSync(blocked, { force: true });
    mkdirSync(blocked);
    await unifyWithLogs();
    const check1 = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      '첫 시작 — 오버레이에서 뺀 뒤 쓰기 실패: 표식 없이 national-delete-failed로 알림',
      !existsSync(nationalMarker()) && !(await readOverlay()).some((t) => t.tenantId === NATIONAL) && check1.issues.some((i) => i.kind === 'national-delete-failed' && i.tenantId === NATIONAL),
      JSON.stringify(check1.issues),
    );
    // 파일이 풀린 뒤 다음 시작 — 남은 단계(대기열 · 툼스톤 · 순위 · 최근 실패)를 마저 한다.
    rmSync(blocked, { recursive: true, force: true });
    if (blockedRaw !== null) writeFileSync(blocked, blockedRaw);
    const logs = await unifyWithLogs();
    await flushMeasureFailures();
    const marker = readJson<NationalRemoval>(nationalMarker());
    const check2 = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok('다음 시작 — 남은 단계를 마저 해 툼스톤을 닮 · 목록에 없음', (await readDeletedTenants()).includes(NATIONAL) && !(await tenantNow(NATIONAL)));
    const queued = (await readMeasureRequests()).map((r) => r.tenant.tenantId).join();
    ok('다음 시작 — 측정 대기열에서 gunsan-national만 빠짐', queued === 'gunsan', queued);
    const failures = readJson<{ tenantId: string }[]>(path.join(root, 'measure-failures.json')).map((f) => f.tenantId).join();
    ok('다음 시작 — 「최근 실패」에서 gunsan-national 줄만 빠짐', failures === 'gunsan', failures);
    const comp = (await store.getScorecardHistory('comp-nat', 10))[0];
    ok('다음 시작 — 같은 코호트 순위를 다시 매김(2/2 → 1/1)', comp?.cohortRank?.position === 1 && comp.cohortRank.totalTenants === 1, JSON.stringify(comp?.cohortRank));
    ok(
      '다음 시작 — 표식 deleted(마저 함) · 점검 알릴 것 없음 · 로그',
      marker.action === 'deleted' && marker.resumed === true && marker.brandName === '군산각' && check2.issues.length === 0 && logs.some((l) => l.includes(NATIONAL) && l.includes('지움')),
      JSON.stringify({ marker, issues: check2.issues, logs }),
    );
    const backup = (await readRemovedTenants()).find((r) => r.tenantId === NATIONAL);
    ok('되살리기 백업 — 첫 시작에 남긴 오버레이 설정 그대로', JSON.stringify(backup?.overlay) === JSON.stringify(nationalEntry), JSON.stringify(backup));
    return;
  }

  if (scenario.startsWith('national-collision')) {
    const { readOverlay } = await import('../server/tenantOverlay');
    const overlayBefore = readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8');
    const entry = (await readOverlay()).find((t) => t.tenantId === NATIONAL)!;
    const logs = await unifyWithLogs();
    const marker = readJson<NationalRemoval>(nationalMarker());
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      `다른 업체의 gunsan-national(${entry.brandName} · ${entry.ownedDomains.join()}${entry.cohortOnly ? ' · 경쟁사로만' : ''}) — 지우지 않음(목록 · 오버레이 그대로 · 툼스톤 · 지운 브랜드 없음)`,
      Boolean(await tenantNow(NATIONAL)) &&
        !existsSync(path.join(root, 'tenants.deleted.json')) &&
        !existsSync(path.join(root, 'tenants.removed.json')) &&
        readFileSync(path.join(root, 'tenants.overlay.json'), 'utf8') === overlayBefore,
    );
    ok('표식 — skipped-collision과 까닭 · 그 브랜드 이름', marker.action === 'skipped-collision' && Boolean(marker.reason) && marker.brandName === entry.brandName, JSON.stringify(marker));
    ok(
      '점검 · 로그 — id-collision:gunsan-national로 알림 · 「지움」 없음',
      check.issues.some((i) => i.kind === 'id-collision' && i.tenantId === NATIONAL) && logs.some((l) => l.includes(NATIONAL) && l.includes('다른 업체')) && !logs.some((l) => l.includes('지움')),
      JSON.stringify({ issues: check.issues, logs }),
    );
    await unifyWithLogs();
    ok('다음 시작 — 여전히 지우지 않음', Boolean(await tenantNow(NATIONAL)) && readJson<NationalRemoval>(nationalMarker()).action === 'skipped-collision');
    return;
  }

  if (scenario === 'national-dev') {
    await unify.runBrandUnify(store);
    ok(
      'dev · CI(APP_DATA_DIR 없음) — 지우지 않음 · 표식 · 툼스톤 · 점검 파일 없음',
      Boolean(await tenantNow(NATIONAL)) &&
        !existsSync(path.join(root, 'server', unify.NATIONAL_REMOVAL_MARKER_FILE)) &&
        !existsSync(path.join(root, 'server', 'tenants.deleted.json')) &&
        !existsSync(path.join(root, 'server', unify.UNIFY_CHECK_FILE)),
    );
    return;
  }

  if (scenario === 'real') {
    const runtime = await loadRuntimeTenants();
    const t = (id: string) => runtime.find((x) => x.tenantId === id);
    ok(
      '운영 PC 사본 — web4ai v6 · gunsan v7(저장소 설정) · gunsan-national은 이 PC 오버레이의 v3(저장소 설정에 없음)',
      t('web4ai')?.questionBankVersion === 'v6' && t('gunsan')?.questionBankVersion === 'v7' && t('gunsan-national')?.questionBankVersion === 'v3' && !(await findBakedTenant('gunsan-national')),
    );
    const { selectCohortTargets } = await import('../server/cohortPlan');
    const gunsanNow = t('gunsan')!;
    const peers = selectCohortTargets(gunsanNow, runtime);
    ok(
      '운영 PC 사본 — gunsan(openai · gemini · perplexity)과 함께 재는 경쟁사는 오버레이의 옛 초안(openai · perplexity)이어도 gunsan과 같은 엔진으로 잼',
      gunsanNow.engines.join() === 'openai,gemini,perplexity' && peers.length > 0 && peers.every((p) => p.engines.join() === gunsanNow.engines.join()),
      JSON.stringify(peers.map((p) => [p.tenantId, p.engines])),
    );
    ok('운영 PC 사본 — 판 v6(web4ai) · v7(gunsan)은 아직 이 PC에 없음',!existsSync(bankFile('web4ai', 'v6')) && !existsSync(bankFile('gunsan', 'v7')));
    const snap = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
    const keep = ['data/web4ai/question-bank/v5.json', 'data/gunsan/question-bank/v6.json', 'data/gunsan-national/question-bank/v3.json', 'cohort-banks/펜션__전북_군산/c1.json', 'cohort-banks/관광정보서비스__전북_군산/c1.json', 'cohort-banks/관광안내__국내/c1.json'];
    const before = keep.map(snap);
    const { readDeletedTenants } = await import('../server/tenantTombstone');
    const { readRemovedTenants } = await import('../server/tenantRemovedStore');
    const nationalBefore = snapshot(`data/${NATIONAL}`);
    const gunsanBefore = snapshot('data/gunsan');
    const webBefore = snapshot('data/web4ai');
    const nationalWeeks = (await store.getScorecardHistory(NATIONAL, Number.MAX_SAFE_INTEGER)).map((c) => c.weekOf).join();
    // 시작 — 한 번 하는 정리 · gunsan-national 지우기 · 점검.
    const logs = await unifyWithLogs();
    const marker = readJson<{ moved: unknown[] }>(path.join(root, unify.UNIFY_MARKER_FILE));
    const removal = readJson<NationalRemoval>(nationalMarker());
    const check = readJson<UnifyCheck>(path.join(root, unify.UNIFY_CHECK_FILE));
    ok(
      '운영 PC 사본 — 시작: gunsan-national을 지움(목록에서 빠짐 · 툼스톤 · 되살리기 백업 · 표식 deleted · 로그)',
      !(await tenantNow(NATIONAL)) &&
        (await readDeletedTenants()).includes(NATIONAL) &&
        (await readRemovedTenants()).some((r) => r.tenantId === NATIONAL && r.overlay?.tenantId === NATIONAL) &&
        removal.action === 'deleted' &&
        check.nationalRemoval?.action === 'deleted' &&
        logs.some((l) => l.includes(NATIONAL) && l.includes('지움')),
      JSON.stringify({ removal, logs }),
    );
    ok(
      `운영 PC 사본 — data/gunsan-national/ 파일이 모두 그대로 · 카드 ${nationalWeeks} 남음(측정 기록)`,
      sameSnapshot(snapshot(`data/${NATIONAL}`), nationalBefore) && nationalWeeks !== '' && existsSync(path.join(root, 'data', NATIONAL, 'scorecard-history.json')),
    );
    ok('운영 PC 사본 — 지우기가 data/gunsan · data/web4ai를 건드리지 않음(카드 · 추가 글 · 올린 글 · 작성자 배정 포함)', sameSnapshot(snapshot('data/gunsan'), gunsanBefore) && sameSnapshot(snapshot('data/web4ai'), webBefore));
    ok('운영 PC 사본 — 정리할 엔진 · 시장 범위 파일 없음', marker.moved.length === 0);
    ok(
      '운영 PC 사본 — 점검: 알릴 것 없음 · 질문지는 아직 없음(측정 때 가져옴) · 코호트 공통 질문지 모두 동봉본과 같음',
      check.issues.length === 0 && Object.values(check.tenants).every((t) => t.banks.every((b) => b.state === 'missing')) && check.cohortBanks.every((c) => c.state === 'same'),
      JSON.stringify({ issues: check.issues, banks: Object.fromEntries(Object.entries(check.tenants).map(([k, v]) => [k, v.banks])), cohorts: check.cohortBanks }),
    );
    // 지운 뒤 측정 — 실증이었던 질문은 이 PC의 옛 판(web4ai v5 · gunsan v6)의 probe 표시로 고른다.
    const probesOf = (id: string, v: string) => readJson<Bank>(bankFile(id, v)).questions.filter((q) => q.probe === true).map((q) => q.text);
    const probeWeb = probesOf('web4ai', 'v5');
    const probeGunsan = probesOf('gunsan', 'v6');
    ok('운영 PC 사본 — 옛 판의 실증 질문 web4ai 24개 · gunsan 26개', probeWeb.length === 24 && probeGunsan.length === 26, `${probeWeb.length} ${probeGunsan.length}`);
    await measureBundled('web4ai', 'v6', { questions: 66, agnostic: 50 }, probeWeb);
    await measureBundled('gunsan', 'v7', { questions: 62, agnostic: 48 }, probeGunsan);
    ok('운영 PC 사본 — 옛 판 · 코호트 공통 질문지 파일이 한 바이트도 안 바뀜', keep.map(snap).every((s, i) => s === before[i]));
    ok('운영 PC 사본 — 측정 뒤에도 gunsan-national은 목록에 없고 기록은 그대로', !(await tenantNow(NATIONAL)) && sameSnapshot(snapshot(`data/${NATIONAL}`), nationalBefore));
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
  /** cwd — dev 체크아웃 흉내(APP_DATA_DIR 없음)는 임시 폴더를 저장소 자리로 삼아 저장소의 data/ · server/ 상태 파일을 건드리지 않는다. */
  const runChild = (scenario: string, root: string, env: NodeJS.ProcessEnv, cwd: string = repoRoot) => {
    mkdirSync(root, { recursive: true });
    const r = spawnSync(process.execPath, [tsxCli, SELF, '--child', scenario, root], { cwd, encoding: 'utf8', env: { ...baseEnv, ...env }, maxBuffer: 64 * 1024 * 1024 });
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

    // gunsan-national 한 번 지우기 — 「하나 더 등록」으로 만든 군산각 전국형이 오버레이에 있는 PC(운영 PC와 같은 모양).
    const gunsanEntry = { ...baked('gunsan') };
    const nationalEntry = { ...baked('gunsan'), tenantId: 'gunsan-national', industry: '관광안내', region: '국내', marketScope: 'national', questionBankVersion: 'v3', engines: ['openai', 'perplexity'] };
    const template = readJson<Record<string, unknown>[]>(path.join(repoRoot, 'src', 'data', 'demo-scorecards.json'))[0]!;
    const card = (tenantId: string, industry: string, region: string, score: number, members: { tenantId: string; aeoScore: number }[]) => {
      const position = 1 + members.filter((m) => m.aeoScore > score).length;
      return { ...template, tenantId, brandName: tenantId, industry, region, weekOf: '2026-W44', aeoScore: { current: score, ma4: score, previousWeek: null, ciLow: score, ciHigh: score }, cohortRank: { position, totalTenants: members.length, tiedCount: 1, members } };
    };
    const nationalMembers = [
      { tenantId: 'comp-nat', aeoScore: 2 },
      { tenantId: 'gunsan-national', aeoScore: 4 },
    ];
    const withNational = (root: string, entries: Record<string, unknown>[]) => {
      put(path.join(root, 'tenants.overlay.json'), entries);
      put(path.join(root, 'data', 'gunsan', 'scorecard-history.json'), [card('gunsan', '관광정보서비스', '전북 군산', 5, [{ tenantId: 'gunsan', aeoScore: 5 }])]);
      put(path.join(root, 'data', 'gunsan', 'extra-articles.json'), { articles: [{ id: 'fake-extra-1', title: '가짜 추가 글' }] });
      put(path.join(root, 'data', 'gunsan', 'published-posts.json'), [{ id: 'fake-post-1', url: 'https://example.com/fake-post' }]);
      put(path.join(root, 'data', 'gunsan', 'probe-plan.json'), { format: 'fake', articles: [] });
      put(path.join(root, 'data', 'gunsan-national', 'scorecard-history.json'), [card('gunsan-national', '관광안내', '국내', 4, nationalMembers)]);
      put(path.join(root, 'data', 'gunsan-national', '2026-W44', 'scorecard.json'), card('gunsan-national', '관광안내', '국내', 4, nationalMembers));
      put(path.join(root, 'data', 'gunsan-national', 'question-bank', 'v3.json'), { ...bundled('gunsan', 'v7'), version: 'v3' });
      put(path.join(root, 'data', 'gunsan-national', 'fact-graph.json'), [{ id: 'fact-other-x', type: 'other', claim: '가짜 사실', value: '가짜 값', updatedAt: '2026-10-20' }]);
      put(path.join(root, 'data', 'gunsan-national', 'published-posts.json'), [{ id: 'fake-post-2', url: 'https://example.com/fake-post-2' }]);
      put(path.join(root, 'data', 'comp-nat', 'scorecard-history.json'), [card('comp-nat', '관광안내', '국내', 2, nationalMembers)]);
      put(path.join(root, 'measure-requests.json'), [
        { tenant: nationalEntry, requestedAt: '2026-11-02T00:00:00.000Z' },
        { tenant: gunsanEntry, requestedAt: '2026-11-02T00:00:00.000Z' },
      ]);
      put(path.join(root, 'measure-failures.json'), [
        { tenantId: 'gunsan-national', brandName: '군산각', at: '2026-11-02T00:00:00.000Z', error: '가짜 실패' },
        { tenantId: 'gunsan', brandName: '군산각', at: '2026-11-02T00:00:00.000Z', error: '가짜 실패' },
      ]);
    };
    const compNat = { ...nationalEntry, tenantId: 'comp-nat', brandName: '가상 전국여행', aliases: ['가상 전국여행'], ownedDomains: ['comp-nat.example'], cohortOnly: true, competitors: [] };
    {
      const root = path.join(tmp, 'national');
      withNational(root, [gunsanEntry, nationalEntry, compNat]);
      runChild('national', root, packaged(root));
    }
    {
      const root = path.join(tmp, 'national-absent');
      put(path.join(root, 'tenants.overlay.json'), [gunsanEntry]);
      runChild('national-absent', root, packaged(root));
    }
    for (const scenario of ['national-resume', 'national-resume-tombstone']) {
      const root = path.join(tmp, scenario);
      withNational(root, [gunsanEntry, nationalEntry, compNat]);
      runChild(scenario, root, packaged(root));
    }
    // id-collision — 이 PC의 gunsan-national이 군산각 전국형이 아니다: gunsan.go.kr(군산시 문화관광 → id gunsan)의 「하나 더 등록」 ·
    // 이름만 같고 홈페이지가 다른 브랜드 · 경쟁사로만 재는 브랜드.
    const otherNational: Record<string, Record<string, unknown>> = {
      'national-collision': { brandName: '군산시 문화관광', aliases: ['군산시 문화관광'], ownedDomains: ['gunsan.go.kr'] },
      'national-collision-site': { ownedDomains: ['gunsan-national.example'] },
      'national-collision-comp': { cohortOnly: true, competitors: [] },
    };
    for (const [scenario, extra] of Object.entries(otherNational)) {
      const root = path.join(tmp, scenario);
      put(path.join(root, 'tenants.overlay.json'), [gunsanEntry, { ...nationalEntry, ...extra }]);
      runChild(scenario, root, packaged(root));
    }
    {
      const root = path.join(tmp, 'national-busy');
      withNational(root, [gunsanEntry, nationalEntry, compNat]);
      runChild('national-busy', root, packaged(root));
    }
    {
      // dev · CI — APP_DATA_DIR 없이 임시 폴더를 저장소 자리로(server/ 아래 상태 파일 · data/).
      const root = path.join(tmp, 'national-dev');
      put(path.join(root, 'server', 'tenants.config.json'), config);
      put(path.join(root, 'server', 'tenants.overlay.json'), [nationalEntry]);
      runChild('national-dev', root, {}, root);
    }

    // vercel — 웹(오버레이에 gunsan-national이 있어도 지우지 않는다).
    put(path.join(tmp, 'vercel', 'tenants.overlay.json'), [nationalEntry]);
    runChild('vercel', path.join(tmp, 'vercel'), { APP_DATA_DIR: path.join(tmp, 'vercel'), VERCEL: '1' });

    // real — 운영 PC 앱 데이터의 사본(읽기만 하고 필요한 폴더만 복사).
    if (existsSync(path.join(realAppData, 'tenants.overlay.json'))) {
      const root = path.join(tmp, 'real');
      mkdirSync(root, { recursive: true });
      for (const name of ['tenants.overlay.json', 'tenants.deleted.json', 'tenants.removed.json', 'measure-requests.json', 'measure-failures.json']) {
        if (existsSync(path.join(realAppData, name))) cpSync(path.join(realAppData, name), path.join(root, name));
      }
      // 세 브랜드와, 그 카드의 코호트 순위에 든 브랜드(지우기가 순위를 다시 매긴다).
      const ids = new Set(['web4ai', 'gunsan', 'gunsan-national']);
      for (const id of [...ids]) {
        for (const c of readJson<{ cohortRank?: { members?: { tenantId: string }[] } }[]>(path.join(realAppData, 'data', id, 'scorecard-history.json'))) {
          for (const m of c.cohortRank?.members ?? []) ids.add(m.tenantId);
        }
      }
      for (const id of ids) if (existsSync(path.join(realAppData, 'data', id))) cpSync(path.join(realAppData, 'data', id), path.join(root, 'data', id), { recursive: true });
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
