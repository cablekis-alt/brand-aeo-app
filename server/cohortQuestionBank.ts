import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  agnosticQuota,
  buildBrandQuestionBankPrompt,
  buildCohortQuestionBankPrompt,
  learnQuota,
  questionMentionsName,
} from '../src/prompts/b1-question-bank.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import { BUNDLED_COHORT_BANK_DIR, COHORT_BANK_DIR } from './appPaths.js';
import { getJudgeClient } from './engines/index.js';
import { parseJsonLoose } from './jsonParse.js';
import { tagJourneyStages } from './journeyStage.js';
import type { ResultStore } from './store.js';
import type { TenantConfig } from './types.js';

/**
 * 코호트 공통 질문지 — 같은 코호트(업종·지역)의 브랜드가 **똑같은 일반 질문**을 받게 한다.
 *
 * 왜 필요한가. 브랜드마다 은행을 만들면 일반 질문(브랜드 이름 없는 질문)도 브랜드마다 달라진다.
 * 실측 통신 5사 v3: 일반 질문 22개씩, 10개 조합 모두 겹침 0개. 점수의 약 59%(언급률·SoM)가 여기서
 * 나오는데, 그러면 KT 72.7%와 SK텔레콤 82.9%의 차이가 가시성 차이인지 질문 차이인지 가릴 수 없다.
 *
 * 구조:
 *   - 코호트 은행  cohort-banks/<코호트 키>/<버전>.json — 일반 질문만. 업종·지역만 주고 만든다.
 *   - 브랜드 은행  data/<브랜드>/question-bank/<버전>.json — 코호트 일반 질문 + 브랜드 전용 질문을
 *     **합쳐서** 저장한다. 은행을 읽는 기존 코드(판정·집계·재계산·화면·웹 baking)는 그대로 동작한다.
 */
export interface CohortQuestionBank {
  key: string;
  industry: string;
  region: string;
  version: string;
  generatedAt: string;
  questions: QuestionSpec[];
}

const MAX_ATTEMPTS = 3;

/** 코호트 키 — 코호트 순위와 같은 기준(업종·지역 정확히 일치). 파일 이름에 못 쓰는 문자는 바꾼다. */
export function cohortKey(industry: string, region: string): string {
  return `${industry}__${region}`.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

function cohortBankPath(key: string, version: string): string {
  return path.join(COHORT_BANK_DIR, key, `${version}.json`);
}

/** 파일이 없으면 null. 깨졌거나 읽을 수 없으면 그대로 던진다 — 조용히 새로 만들면 질문지가 갈린다. */
async function readBankFile(file: string): Promise<CohortQuestionBank | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as CohortQuestionBank;
}

/**
 * 코호트 질문지를 읽는다. 없으면 null.
 *
 * 설치본은 userData에 없을 때 동봉된 저장소 기준본을 userData로 복사해 쓴다. 기준본이 있는 코호트를
 * 데스크톱이 새로 만들면 CI·다른 설치본과 다른 질문지가 된다.
 */
export async function readCohortBank(key: string, version: string): Promise<CohortQuestionBank | null> {
  const file = cohortBankPath(key, version);
  const local = await readBankFile(file);
  if (local || !BUNDLED_COHORT_BANK_DIR) return local;
  const bundledFile = path.join(BUNDLED_COHORT_BANK_DIR, key, `${version}.json`);
  const bundled = await readBankFile(bundledFile);
  if (!bundled) return null;
  // copyFile 대신 읽은 값을 같은 형식으로 쓴다 — 동봉본은 asar 안이라 읽기 API로 다루는 편이 안전하다.
  await saveCohortBank(bundled);
  console.log(`[B1-코호트] ${key}/${version} 동봉 기준본을 가져왔습니다.`);
  return bundled;
}

export async function saveCohortBank(bank: CohortQuestionBank): Promise<void> {
  const file = cohortBankPath(bank.key, bank.version);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(bank, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}

/** 질문에 들어가면 안 되는 이름 — 이 브랜드와 경쟁사(= 코호트)의 이름·별칭. */
function cohortNames(tenant: TenantConfig): string[] {
  return [
    tenant.brandName,
    ...tenant.aliases,
    ...tenant.competitors.flatMap((c) => [c.name, ...c.aliases]),
  ].filter((name) => name.trim().length > 0);
}

const pad3 = (n: number) => String(n).padStart(3, '0');

async function generateCohortBank(tenant: TenantConfig, key: string, version: string): Promise<CohortQuestionBank> {
  const judge = getJudgeClient();
  const count = agnosticQuota(tenant.questionBankSize);
  const names = cohortNames(tenant);
  let note: string | undefined;
  let questions: QuestionSpec[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await judge.call(
      buildCohortQuestionBankPrompt({
        industry: tenant.industry,
        region: tenant.region,
        excludedNames: names,
        count,
        learnMin: learnQuota(tenant.questionBankSize),
        version,
        previousVersionDiffNote: note,
        language: tenant.questionLanguage,
        marketScope: tenant.marketScope,
        buyer: tenant.buyer,
      }),
    );
    const parsed = parseJsonLoose<Array<Partial<QuestionSpec>>>(result.text);
    if (!parsed) {
      note = '직전 출력이 JSON 배열이 아니었다. 스키마에 맞는 JSON 배열만 출력하라.';
      continue;
    }
    // 이름이 들어간 질문은 버린다 — 공통 시험지에 특정 브랜드 이름이 있으면 그 브랜드만 유리하다.
    const seen = new Set<string>();
    const clean = parsed.filter((q): q is Partial<QuestionSpec> & { text: string } => {
      if (typeof q.text !== 'string' || !q.text.trim()) return false;
      if (questionMentionsName(q.text, names)) return false;
      const norm = q.text.replace(/\s+/g, '');
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
    if (clean.length >= count) {
      questions = clean.slice(0, count).map((q, i) => ({
        questionId: `${version}-${pad3(i + 1)}`,
        text: q.text.trim(),
        category: 'category-agnostic',
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.topic ? { topic: q.topic } : {}),
        industry: tenant.industry,
        region: tenant.region,
        containsBrandName: false,
        version,
        cohortShared: true,
      }));
      break;
    }
    note = `직전 생성은 쓸 수 있는 질문이 ${clean.length}개뿐이었다(이름이 들어간 질문·중복은 버렸다). 정확히 ${count}개를 만들어라.`;
    console.warn(`[B1-코호트] ${key}/${version} 질문 ${clean.length}/${count} — 다시 생성 (${attempt}/${MAX_ATTEMPTS})`);
  }

  if (questions.length < count) {
    throw new Error(`[B1-코호트] 코호트 질문지 생성 실패: ${key}/${version} — ${MAX_ATTEMPTS}번 시도했지만 ${count}개를 채우지 못했다.`);
  }

  questions = await tagJourneyStages(questions, judge);
  const learn = questions.filter((q) => q.stage === 'learn').length;
  if (learn < learnQuota(tenant.questionBankSize)) {
    console.warn(`[B1-코호트] ${key}/${version} 탐색(learn) ${learn}개 — 하한 ${learnQuota(tenant.questionBankSize)}개 미달`);
  }
  return {
    key,
    industry: tenant.industry,
    region: tenant.region,
    version,
    generatedAt: new Date().toISOString(),
    questions,
  };
}

const inflight = new Map<string, Promise<CohortQuestionBank>>();

/**
 * 코호트 질문지를 준비한다 — 있으면 읽고, 없으면 한 번만 만든다.
 *
 * 코호트는 동시에 측정되므로(measureAndBake) 여러 브랜드가 같은 순간에 여기로 온다. 진행 중인
 * 생성을 공유하지 않으면 브랜드마다 다른 질문지를 만들어 저장한다 — 공통 시험지의 뜻이 사라진다.
 *
 * 기준본은 저장소 cohort-banks/에 커밋된 것이다. CI는 없는 코호트를 만들어 저장소에 커밋하고
 * (measure.yml), 설치본은 동봉된 기준본을 먼저 쓴다(readCohortBank). 새 코호트를 데스크톱과 CI가
 * 같은 주에 처음 재면 각자 만들 수 있다 — 그때는 저장소 기준본을 데스크톱으로 가져온다
 * (scripts/generate-cohort-bank.ts가 두 벌이면 멈춰서 알려준다).
 */
export function ensureCohortBank(tenant: TenantConfig): Promise<CohortQuestionBank> {
  const version = tenant.cohortQuestionBank;
  if (!version) return Promise.reject(new Error(`${tenant.tenantId}: cohortQuestionBank가 설정되지 않았습니다.`));
  const key = cohortKey(tenant.industry, tenant.region);
  const id = `${key}/${version}`;
  const running = inflight.get(id);
  if (running) return running;

  const task = (async () => {
    const existing = await readCohortBank(key, version);
    if (existing) return existing;
    const bank = await generateCohortBank(tenant, key, version);
    await saveCohortBank(bank);
    console.log(`[B1-코호트] ${id} 생성 — 일반 질문 ${bank.questions.length}개`);
    return bank;
  })();
  inflight.set(id, task);
  // 끝나면(성공·실패 모두) 비운다 — 실패했을 때 다음 측정이 다시 시도할 수 있게. 오류 자체는 task를
  // 기다리는 호출부가 받는다.
  task.then(
    () => inflight.delete(id),
    () => inflight.delete(id),
  );
  return task;
}

/**
 * 코호트 질문지를 쓰는 브랜드의 은행 — 코호트 일반 질문 + 브랜드 전용 질문을 합쳐 브랜드 은행으로 저장한다.
 *
 * 같은 버전의 브랜드 은행이 이미 있는데 코호트 출처가 다르면 멈춘다. 브랜드 전용으로 만든 은행
 * (예: v3)에 설정만 바꿔 붙이면 일반 질문이 공통이 아닌데 공통인 것처럼 기록된다 — 버전을 올려야 한다.
 */
export async function ensureComposedQuestionBank(tenant: TenantConfig, store: ResultStore): Promise<QuestionSpec[]> {
  const cohort = await ensureCohortBank(tenant);
  const existing = await store.getQuestionBank(tenant.tenantId, tenant.questionBankVersion);
  if (existing) {
    if (existing.cohortBank?.key === cohort.key && existing.cohortBank.version === cohort.version) {
      return existing.questions;
    }
    throw new Error(
      `${tenant.tenantId} 질문 은행 ${tenant.questionBankVersion}은 코호트 질문지 ${cohort.key}/${cohort.version}로 ` +
        `만든 것이 아닙니다 — questionBankVersion을 새 값으로 올리세요.`,
    );
  }

  const judge = getJudgeClient();
  const count = Math.max(0, tenant.questionBankSize - cohort.questions.length);
  let brandQuestions: QuestionSpec[] = [];
  let note: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && count > 0; attempt += 1) {
    const result = await judge.call(
      buildBrandQuestionBankPrompt({
        industry: tenant.industry,
        region: tenant.region,
        brandName: tenant.brandName,
        competitorNames: tenant.competitors.map((c) => c.name),
        count,
        version: tenant.questionBankVersion,
        previousVersionDiffNote: note,
        language: tenant.questionLanguage,
        marketScope: tenant.marketScope,
        buyer: tenant.buyer,
      }),
    );
    const parsed = parseJsonLoose<Array<Partial<QuestionSpec>>>(result.text);
    // 일반 질문은 코호트 질문지가 맡는다 — 여기서 category-agnostic이 오면 버린다. 전국형 · B2B형은 지역 특화
    // 질문도 버린다(프롬프트가 만들지 말라고 했는데 온 것).
    const regionalAllowed = !tenant.marketScope || tenant.marketScope === 'local';
    const clean = (parsed ?? []).filter(
      (q): q is Partial<QuestionSpec> & { text: string; category: QuestionSpec['category'] } =>
        typeof q.text === 'string' &&
        q.text.trim().length > 0 &&
        !!q.category &&
        q.category !== 'category-agnostic' &&
        (regionalAllowed || q.category !== 'local-regional'),
    );
    if (clean.length >= count) {
      brandQuestions = clean.slice(0, count).map((q, i) => ({
        questionId: `${tenant.questionBankVersion}-${pad3(i + 1)}`,
        text: q.text.trim(),
        category: q.category,
        ...(q.stage ? { stage: q.stage } : {}),
        ...(q.topic ? { topic: q.topic } : {}),
        industry: tenant.industry,
        region: tenant.region,
        containsBrandName: true,
        version: tenant.questionBankVersion,
      }));
      break;
    }
    note = `직전 생성은 쓸 수 있는 브랜드 전용 질문이 ${clean.length}개뿐이었다. 정확히 ${count}개를 만들어라.`;
    console.warn(`[B1-브랜드] ${tenant.tenantId} 브랜드 전용 질문 ${clean.length}/${count} — 다시 생성 (${attempt}/${MAX_ATTEMPTS})`);
  }
  if (brandQuestions.length < count) {
    throw new Error(`[B1-브랜드] ${tenant.tenantId} 브랜드 전용 질문 생성 실패 — ${count}개를 채우지 못했다.`);
  }
  brandQuestions = await tagJourneyStages(brandQuestions, judge);

  const questions: QuestionSpec[] = [
    ...cohort.questions.map((q) => ({ ...q, industry: tenant.industry, region: tenant.region, cohortShared: true })),
    ...brandQuestions,
  ];
  await store.saveQuestionBank(tenant.tenantId, {
    version: tenant.questionBankVersion,
    generatedAt: new Date().toISOString(),
    questions,
    cohortBank: { key: cohort.key, version: cohort.version },
  });
  return questions;
}
