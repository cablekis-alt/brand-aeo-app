import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isExcluded, readCohortExclusions, type CohortExclusion } from './cohortExclusionStore.js';
import { readDeletedTenants } from './tenantTombstone.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import type { DerivedFrom } from './questionHandoff.js';
import type { QuestionRepeatAnalysis, RawCallRecord } from './types.js';

export interface QuestionBank {
  version: string;
  generatedAt: string;
  questions: QuestionSpec[];
  /** 일반 질문을 가져온 코호트 은행. 코호트 공통 질문지를 쓰는 브랜드만 있다. */
  cohortBank?: { key: string; version: string };
  /** 경쟁사 편집이 앞 버전에서 바뀐 경쟁사 질문만 고쳐 만든 은행(questionHandoff.ts). 측정은 이 은행을 그대로 쓴다. */
  derivedFrom?: DerivedFrom;
  /**
   * 경쟁사 편집의 「브랜드 질문 모두 새로 쓰기」로 측정이 새로 만든 은행 — 앞 버전과 저장할 때의 저장소 지문(baseFingerprint).
   * 저장소가 나중에 같은 버전 이름을 따로 쓰면 측정을 멈추는 데 쓴다(pipeline.ts assertDerivedBankInUse).
   */
  regeneratedFrom?: { version: string; by: 'competitor-edit'; base: string };
}

/**
 * 측정 1회의 기록 요약(data/<tenant>/<weekOf>/runs/<runId>/run.json). 주차 카드는 그 주 마지막 측정 하나만 남지만(saveScorecard),
 * 회차 기록은 같은 주에 여러 번 재도 회차마다 남는다 — 집중 관찰 중 「올린 글이 며칠째 처음 인용됐나」를 잃지 않게.
 */
export interface RunMeta {
  runId: string;
  tenantId: string;
  weekOf: string;
  startedAt: string;
  finishedAt: string;
  /** 측정 화면의 「이 브랜드만 측정」. */
  selfOnly: boolean;
  /** 다른 브랜드의 측정 안에서 경쟁사로 잰 회차. */
  inCohortRun: boolean;
  /** 이 회차가 그 주 카드가 됐는가. kept면 앞서 잰 그 주 카드를 그대로 두었다(pipeline.ts weekCardKeepReason). */
  weekCard: 'saved' | 'kept';
  weekCardKeptReason?: string;
  /** 엔진별 예정 · 성공 호출 수 — 엔진 구성이 같아도 일부만 들어온 회차(도중에 지출 한도)를 가린다. */
  engines: Record<string, { planned: number; succeeded: number }>;
  /** 이번 측정에서 끊긴 엔진(「Gemini 지출 한도 초과」 등, engineExhaustion.ts). */
  engineIssues: string[];
  /**
   * 판정 맥락 지문 — 별칭 · 소유 도메인 · 경쟁사 · 순위 후보 목록. 질문지 · 엔진이 같아도 이것이 바뀌면 언급 · 순위 판정이 달라진다
   * (카드의 조건 비교 comparability.ts는 보지 않는 값).
   */
  contextFingerprint: string;
  /** 수집 사용량 — 회차 기록에는 원문(raw-calls)을 남기지 않아 여기 요약한다. 판정 사용량은 question-analyses.json의 judgeUsage. */
  collectUsage: Record<
    string,
    { calls: number; tokens: number; inputTokens: number; outputTokens: number; billedCost: number | null; searchCalls: number }
  >;
  /**
   * 회차 기록이 없던 그 주 파일을 다음 측정이 덮기 전에 옮겨 둔 회차(server/preserveWeekFile.ts) — v0.4.26 전 측정이나 회차 기록 저장에
   * 실패한 측정. 측정 방식 · 예정 호출 수 · 판정 맥락은 모른다(engines는 응답 수, contextFingerprint는 빈 문자열).
   */
  preserved?: { from: 'week-file'; preservedAt: string };
}

/** 읽은 회차 하나. */
export interface RunSnapshot {
  meta: RunMeta;
  scorecard: WeeklyScorecard;
  analyses: QuestionRepeatAnalysis[];
}

/** 읽지 못한 회차 — 화면이 「회차 기록 n개를 읽지 못해 뺐습니다」로 알린다. */
export interface RunReadIssue {
  weekOf: string;
  runId: string;
  reason: string;
}

export interface ResultStore {
  getQuestionBank(tenantId: string, version: string): Promise<QuestionBank | null>;
  saveQuestionBank(tenantId: string, bank: QuestionBank): Promise<void>;
  /** 새 버전 은행을 만든다 — 같은 버전 파일이 이미 있으면 거절한다(덮어쓰지 않는다). */
  createQuestionBank(tenantId: string, bank: QuestionBank): Promise<void>;
  removeQuestionBank(tenantId: string, version: string): Promise<void>;
  /** 은행 파일 이름(버전) — 읽을 수 없는 파일도 센다(그 이름은 이미 쓰였다). */
  listQuestionBankVersions(tenantId: string): Promise<string[]>;
  saveRawCalls(tenantId: string, weekOf: string, calls: RawCallRecord[]): Promise<void>;
  saveQuestionAnalyses(tenantId: string, weekOf: string, analyses: QuestionRepeatAnalysis[]): Promise<void>;
  getQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]>;
  saveScorecard(scorecard: WeeklyScorecard): Promise<void>;
  saveReport(tenantId: string, weekOf: string, reportMarkdown: string): Promise<void>;
  /** 측정 1회 기록을 남긴다 — 같은 회차 번호가 이미 있으면 뒤에 번호를 붙인다. 실제로 쓴 회차 번호를 돌려준다. */
  saveRunSnapshot(
    tenantId: string,
    weekOf: string,
    snapshot: { scorecard: WeeklyScorecard; analyses: QuestionRepeatAnalysis[]; meta: RunMeta },
  ): Promise<string>;
  /** 그 주의 회차 기록 — 측정을 마친 시각 순. run.json이 없는 폴더(쓰다 만 회차)는 건너뛰고, 읽지 못한 회차는 issues에 남긴다. */
  listRunSnapshots(tenantId: string, weekOf: string): Promise<{ runs: RunSnapshot[]; issues: RunReadIssue[] }>;
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
    // 쓰다 만 파일을 측정이 읽으면 getQuestionBank가 null로 보고 은행을 새로 만든다 — 원자적으로 쓴다.
    await writeJsonAtomic(path.join(dir, `${bank.version}.json`), bank);
  }

  async createQuestionBank(tenantId: string, bank: QuestionBank): Promise<void> {
    const dir = path.join(DATA_DIR, tenantId, 'question-bank');
    await ensureDir(dir);
    const target = path.join(dir, `${bank.version}.json`);
    // 있는지 본 뒤 rename한다(rename은 있는 파일을 덮는다). 이 은행을 쓰는 다른 곳(측정)은 경쟁사 편집 저장과 겹치지 않는다
    // (저장은 측정 중이면 거절하고 한 줄로 돈다 — competitorEditor.ts).
    const exists = await access(target).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      },
    );
    if (exists) throw new Error(`${tenantId} 질문 은행 ${bank.version}이 이미 있습니다.`);
    await writeJsonAtomic(target, bank);
  }

  async removeQuestionBank(tenantId: string, version: string): Promise<void> {
    await unlink(path.join(DATA_DIR, tenantId, 'question-bank', `${version}.json`)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async listQuestionBankVersions(tenantId: string): Promise<string[]> {
    try {
      const names = await readdir(path.join(DATA_DIR, tenantId, 'question-bank'));
      return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
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

  /*
   * 주차 폴더 안 runs/<runId>/에 쓴다. 주차를 훑는 곳(usageStats listWeeks · rescore-local · rejudge-ranks)은 주차 이름의 폴더에서
   * 정해진 파일만 읽고, 코호트는 scorecard-history.json만 읽어 이 폴더를 보지 않는다. run.json을 맨 마지막에 쓴다 — run.json이
   * 없는 폴더는 쓰다 만 회차다.
   *
   * 회차 기록은 측정한 그때의 값이다. 측정 끝의 코호트 순위 다시 세기(cohortRank.ts)와 정비 스크립트(rescore-local · rejudge-ranks ·
   * resolve-stored-citations)는 그 주 파일만 고치므로, 회차 카드의 cohortRank는 다시 세기 전 값이고 정비 뒤에는 그 주 파일과
   * 다를 수 있다. 회차끼리 견줄 때는 판정(question-analyses.json)에서 다시 집계한다.
   */
  async saveRunSnapshot(
    tenantId: string,
    weekOf: string,
    snapshot: { scorecard: WeeklyScorecard; analyses: QuestionRepeatAnalysis[]; meta: RunMeta },
  ): Promise<string> {
    const runsDir = path.join(DATA_DIR, tenantId, weekOf, 'runs');
    await ensureDir(runsDir);
    let runId = snapshot.meta.runId;
    // 같은 밀리초에 같은 브랜드를 두 번 끝낼 일은 없지만, 덮으면 회차 하나를 소리 없이 잃는다.
    for (let n = 2; ; n += 1) {
      try {
        await mkdir(path.join(runsDir, runId));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        runId = `${snapshot.meta.runId}-${n}`;
      }
    }
    const dir = path.join(runsDir, runId);
    await writeJsonAtomic(path.join(dir, 'scorecard.json'), snapshot.scorecard);
    await writeJsonAtomic(path.join(dir, 'question-analyses.json'), snapshot.analyses);
    await writeJsonAtomic(path.join(dir, 'run.json'), { ...snapshot.meta, runId });
    return runId;
  }

  /*
   * 회차 폴더는 run.json을 쓴 뒤로 바뀌지 않으므로 읽은 회차를 폴더 경로로 붙잡아 둔다 — 성과 화면이 올린 글 이력 · 회차 보기를 함께
   * 부르면 같은 판정 파일(회당 약 0.45MB)을 여러 번 읽는다. 지운 회차는 폴더 목록에서 빠지므로 캐시가 되살리지 않는다.
   */
  private runCache = new Map<string, RunSnapshot>();

  async listRunSnapshots(tenantId: string, weekOf: string): Promise<{ runs: RunSnapshot[]; issues: RunReadIssue[] }> {
    const runsDir = path.join(DATA_DIR, tenantId, weekOf, 'runs');
    let names: string[];
    try {
      names = await readdir(runsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], issues: [] };
      throw err;
    }
    const runs: RunSnapshot[] = [];
    const issues: RunReadIssue[] = [];
    for (const runId of names) {
      const dir = path.join(runsDir, runId);
      const cached = this.runCache.get(dir);
      if (cached) {
        runs.push(cached);
        continue;
      }
      let metaText: string;
      try {
        metaText = await readFile(path.join(dir, 'run.json'), 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // run.json이 없으면 쓰다 만 회차다(saveRunSnapshot은 run.json을 맨 마지막에 쓴다). 회차 폴더가 아닌 파일도 건너뛴다.
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        issues.push({ weekOf, runId, reason: `run.json: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      try {
        const snapshot: RunSnapshot = {
          meta: JSON.parse(metaText) as RunMeta,
          scorecard: JSON.parse(await readFile(path.join(dir, 'scorecard.json'), 'utf-8')) as WeeklyScorecard,
          analyses: JSON.parse(await readFile(path.join(dir, 'question-analyses.json'), 'utf-8')) as QuestionRepeatAnalysis[],
        };
        if (!Array.isArray(snapshot.analyses)) throw new Error('question-analyses.json이 배열이 아닙니다');
        if (typeof snapshot.meta?.finishedAt !== 'string') throw new Error('run.json에 finishedAt이 없습니다');
        snapshot.meta.runId = runId;
        if (this.runCache.size >= 64) this.runCache.delete(this.runCache.keys().next().value!);
        this.runCache.set(dir, snapshot);
        runs.push(snapshot);
      } catch (err) {
        issues.push({ weekOf, runId, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const issue of issues) console.warn(`[store] ${tenantId}/${weekOf} 회차 ${issue.runId}를 읽지 못했습니다: ${issue.reason}`);
    runs.sort((a, b) => a.meta.finishedAt.localeCompare(b.meta.finishedAt) || a.meta.runId.localeCompare(b.meta.runId));
    return { runs, issues };
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
