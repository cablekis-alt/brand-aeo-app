import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isExcluded, readCohortExclusions, type CohortExclusion } from './cohortExclusionStore.js';
import { readDeletedTenants } from './tenantTombstone.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { QuestionRepeatAnalysis, RawCallRecord } from './types.js';

export interface QuestionBank {
  version: string;
  generatedAt: string;
  questions: QuestionSpec[];
  /** 일반 질문을 가져온 코호트 은행. 코호트 공통 질문지를 쓰는 브랜드만 있다. */
  cohortBank?: { key: string; version: string };
}

export interface ResultStore {
  getQuestionBank(tenantId: string, version: string): Promise<QuestionBank | null>;
  saveQuestionBank(tenantId: string, bank: QuestionBank): Promise<void>;
  saveRawCalls(tenantId: string, weekOf: string, calls: RawCallRecord[]): Promise<void>;
  saveQuestionAnalyses(tenantId: string, weekOf: string, analyses: QuestionRepeatAnalysis[]): Promise<void>;
  getQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]>;
  saveScorecard(scorecard: WeeklyScorecard): Promise<void>;
  saveReport(tenantId: string, weekOf: string, reportMarkdown: string): Promise<void>;
  getScorecardHistory(tenantId: string, weeksBack: number): Promise<WeeklyScorecard[]>;
  /**
   * 코호트(업종 · 지역 · 주차)의 카드 — 지운 브랜드와 코호트 제외 목록(cohortExclusionStore.ts)에 든 카드는 뺀다.
   * opts.exclusions를 주면 파일 대신 그 목록으로 뺀다(미리보기 · 예전 경쟁사 목록).
   */
  getCohortScorecards(
    industry: string,
    region: string,
    weekOf: string,
    opts?: { exclusions?: readonly CohortExclusion[] },
  ): Promise<WeeklyScorecard[]>;
}

const DATA_DIR = PIPELINE_DATA_DIR;

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

/**
 * 임시 파일에 쓰고 rename으로 갈아끼운다 — 부분적으로 쓰인 파일이 읽히지 않게.
 *
 * scorecard-history.json은 **다른 테넌트가 읽는** 유일한 파일이다(getCohortScorecards).
 * 코호트를 병렬로 측정하면 A가 쓰는 중에 B가 읽을 수 있고, readJsonArray는 파싱 실패를
 * 조용히 []로 삼키므로 그 브랜드가 코호트 순위 분모에서 소리 없이 빠진다.
 * rename은 같은 볼륨에서 원자적이다(Windows도 MoveFileEx 대체 의미).
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, filePath);
}

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
}

/**
 * 로컬 파일 기반 스토어. 실제 배포에서는 이 인터페이스를 그대로 구현하는
 * DB 어댑터(Postgres 등)로 교체하면 pipeline.ts 쪽 코드는 변경할 필요가 없다.
 */
export class FileResultStore implements ResultStore {
  async getQuestionBank(tenantId: string, version: string): Promise<QuestionBank | null> {
    const filePath = path.join(DATA_DIR, tenantId, 'question-bank', `${version}.json`);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as QuestionBank;
    } catch {
      return null;
    }
  }

  async saveQuestionBank(tenantId: string, bank: QuestionBank): Promise<void> {
    const dir = path.join(DATA_DIR, tenantId, 'question-bank');
    await ensureDir(dir);
    await writeFile(path.join(dir, `${bank.version}.json`), JSON.stringify(bank, null, 2), 'utf-8');
  }

  async saveReport(tenantId: string, weekOf: string, reportMarkdown: string): Promise<void> {
    const dir = path.join(DATA_DIR, tenantId, weekOf);
    await ensureDir(dir);
    await writeFile(path.join(dir, 'report.md'), reportMarkdown, 'utf-8');
  }

  async saveRawCalls(tenantId: string, weekOf: string, calls: RawCallRecord[]): Promise<void> {
    const dir = path.join(DATA_DIR, tenantId, weekOf);
    await ensureDir(dir);
    await writeFile(path.join(dir, 'raw-calls.json'), JSON.stringify(calls, null, 2), 'utf-8');
  }

  async saveQuestionAnalyses(
    tenantId: string,
    weekOf: string,
    analyses: QuestionRepeatAnalysis[],
  ): Promise<void> {
    const dir = path.join(DATA_DIR, tenantId, weekOf);
    await ensureDir(dir);
    await writeFile(path.join(dir, 'question-analyses.json'), JSON.stringify(analyses, null, 2), 'utf-8');
  }

  async getQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]> {
    return readJsonArray<QuestionRepeatAnalysis>(path.join(DATA_DIR, tenantId, weekOf, 'question-analyses.json'));
  }

  async saveScorecard(scorecard: WeeklyScorecard): Promise<void> {
    const dir = path.join(DATA_DIR, scorecard.tenantId, scorecard.weekOf);
    await ensureDir(dir);
    await writeFile(path.join(dir, 'scorecard.json'), JSON.stringify(scorecard, null, 2), 'utf-8');

    const historyPath = path.join(DATA_DIR, scorecard.tenantId, 'scorecard-history.json');
    const history = await readJsonArray<WeeklyScorecard>(historyPath);
    const withoutSameWeek = history.filter((s) => s.weekOf !== scorecard.weekOf);
    withoutSameWeek.push(scorecard);
    await ensureDir(path.dirname(historyPath));
    await writeJsonAtomic(historyPath, withoutSameWeek);
  }

  async getScorecardHistory(tenantId: string, weeksBack: number): Promise<WeeklyScorecard[]> {
    const historyPath = path.join(DATA_DIR, tenantId, 'scorecard-history.json');
    const history = await readJsonArray<WeeklyScorecard>(historyPath);
    return history.sort((a, b) => a.weekOf.localeCompare(b.weekOf)).slice(-weeksBack);
  }

  async getCohortScorecards(
    industry: string,
    region: string,
    weekOf: string,
    opts?: { exclusions?: readonly CohortExclusion[] },
  ): Promise<WeeklyScorecard[]> {
    await ensureDir(DATA_DIR);
    // 코호트는 디렉터리 목록으로 만든다. 브랜드를 삭제해도 이미 측정한 data/<tenant>/는 남으므로
    // (측정 결과는 지우지 않는다), 삭제된 브랜드가 순위표에 계속 끼는 것을 여기서 걸러낸다.
    // 「지난 기록에서도 빼기」로 뺀 경쟁사도 그 코호트 · 주차에서만 걸러낸다(카드는 남는다).
    const [tenantDirs, deleted, exclusions] = await Promise.all([
      readdir(DATA_DIR),
      readDeletedTenants(),
      opts?.exclusions ? Promise.resolve(opts.exclusions) : readCohortExclusions(),
    ]);
    const deletedIds = new Set(deleted);
    const results: WeeklyScorecard[] = [];
    for (const tenantId of tenantDirs) {
      if (deletedIds.has(tenantId)) continue;
      const historyPath = path.join(DATA_DIR, tenantId, 'scorecard-history.json');
      const history = await readJsonArray<WeeklyScorecard>(historyPath);
      const match = history.find((s) => s.industry === industry && s.region === region && s.weekOf === weekOf);
      if (match && !isExcluded(exclusions, match)) results.push(match);
    }
    return results;
  }
}
