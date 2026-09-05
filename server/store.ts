import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { QuestionRepeatAnalysis, RawCallRecord } from './types.js';

export interface QuestionBank {
  version: string;
  generatedAt: string;
  questions: QuestionSpec[];
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
  getCohortScorecards(industry: string, region: string, weekOf: string): Promise<WeeklyScorecard[]>;
}

const DATA_DIR = PIPELINE_DATA_DIR;

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
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
    await writeFile(historyPath, JSON.stringify(withoutSameWeek, null, 2), 'utf-8');
  }

  async getScorecardHistory(tenantId: string, weeksBack: number): Promise<WeeklyScorecard[]> {
    const historyPath = path.join(DATA_DIR, tenantId, 'scorecard-history.json');
    const history = await readJsonArray<WeeklyScorecard>(historyPath);
    return history.sort((a, b) => a.weekOf.localeCompare(b.weekOf)).slice(-weeksBack);
  }

  async getCohortScorecards(industry: string, region: string, weekOf: string): Promise<WeeklyScorecard[]> {
    await ensureDir(DATA_DIR);
    const tenantDirs = await readdir(DATA_DIR);
    const results: WeeklyScorecard[] = [];
    for (const tenantId of tenantDirs) {
      const historyPath = path.join(DATA_DIR, tenantId, 'scorecard-history.json');
      const history = await readJsonArray<WeeklyScorecard>(historyPath);
      const match = history.find((s) => s.industry === industry && s.region === region && s.weekOf === weekOf);
      if (match) results.push(match);
    }
    return results;
  }
}
