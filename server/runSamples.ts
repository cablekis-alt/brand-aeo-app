import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { ResultStore, RunMeta, RunReadIssue } from './store.js';
import type { QuestionRepeatAnalysis } from './types.js';

/**
 * 한 주의 「표본」 — 회차 기록(runs/<runId>/) 하나하나와, 회차 기록이 없는 그 주 파일. 올린 글 이력(server/publishedHistory.ts) ·
 * 회차 보기(server/runHistory.ts)가 같은 표본으로 센다 — 두 화면 숫자가 어긋나지 않게.
 *
 * 그 주 파일(question-analyses.json)은 그 주 마지막으로 카드를 저장한 측정이다. 그 측정의 회차 기록과 짝지으면 그 회차에는 그 주
 * 파일의 판정을 쓴다 — 정비 스크립트(rejudge-ranks · resolve-stored-citations)는 그 주 파일만 고친다(store.ts saveRunSnapshot 주석).
 * 짝은 판정 시작 시각의 처음으로 찾는다(정비는 판정 시각을 바꾸지 않는다). 어느 회차와도 맞지 않는 그 주 파일(v0.4.26 전 측정)은 따로
 * 표본 하나다.
 */
export interface WeekSample {
  kind: 'run' | 'week-file';
  runId: string | null;
  meta: RunMeta | null;
  /** 회차 카드(측정 때 조건). week-file이면 그 주 카드. */
  scorecard: WeeklyScorecard;
  analyses: QuestionRepeatAnalysis[];
  /**
   * 이 회차가 측정 때 남긴 판정 그대로 — 회차 보기의 순위 · 점수는 이것으로 다시 센다(정비 스크립트가 짝지은 회차만 고쳐, 같은 주
   * 회차끼리 판정 기준이 섞이지 않게). week-file이면 analyses와 같다.
   */
  ownAnalyses: QuestionRepeatAnalysis[];
  /** 판정이 그 주 파일에서 왔다 — 그 주 화면(핀 · 측정 창)의 기준. */
  isWeekFile: boolean;
  /** 측정을 마친 때 — 회차는 finishedAt, 그 주 파일은 판정 시작의 마지막(근사). */
  at: string | null;
  /** 일부만 들어온 엔진(0 < 성공 < 예정). */
  partialEngines: string[];
  /** 빠진 엔진 — 예정했는데 하나도 못 받았거나, 그 주 카드에는 있는데 이 회차에는 없는 엔진(카드를 덮지 않은 회차). */
  missingEngines: string[];
}

/** 판정 시작 시각(ISO)의 처음과 끝. 시각이 없는 옛 기록이면 null. */
export function judgeSpan(analyses: { timing?: { startedAt?: string } }[]): { first: string; last: string } | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const a of analyses) {
    const t = a.timing?.startedAt;
    if (!t) continue;
    if (!first || t < first) first = t;
    if (!last || t > last) last = t;
  }
  return first && last ? { first, last } : null;
}

/** 같은 측정의 판정인가 — 판정 시작 시각의 처음이 같다. 시각이 없으면 가릴 수 없어 다른 측정으로 본다. */
export function sameMeasurement(a: { timing?: { startedAt?: string } }[], b: { timing?: { startedAt?: string } }[]): boolean {
  const x = judgeSpan(a);
  const y = judgeSpan(b);
  return Boolean(x && y && x.first === y.first);
}

export async function weekSamples(
  store: Pick<ResultStore, 'listRunSnapshots'>,
  tenantId: string,
  card: WeeklyScorecard,
  weekAnalyses: QuestionRepeatAnalysis[],
): Promise<{ samples: WeekSample[]; issues: RunReadIssue[] }> {
  const { runs, issues } = await store.listRunSnapshots(tenantId, card.weekOf);
  const cardEngines = card.enginesUsed ?? [];
  let matched = false;
  const samples: WeekSample[] = runs.map((run) => {
    const isWeekFile = !matched && weekAnalyses.length > 0 && sameMeasurement(weekAnalyses, run.analyses);
    if (isWeekFile) matched = true;
    const engines = Object.entries(run.meta.engines ?? {});
    const seen = new Set<string>(run.analyses.map((a) => a.engine));
    return {
      kind: 'run',
      runId: run.meta.runId,
      meta: run.meta,
      scorecard: run.scorecard,
      analyses: isWeekFile ? weekAnalyses : run.analyses,
      ownAnalyses: run.analyses,
      isWeekFile,
      at: run.meta.finishedAt,
      partialEngines: engines.filter(([, v]) => v.succeeded > 0 && v.succeeded < v.planned).map(([e]) => e).sort(),
      missingEngines: [
        ...new Set([...engines.filter(([, v]) => v.planned > 0 && v.succeeded === 0).map(([e]) => e), ...cardEngines.filter((e) => !seen.has(e))]),
      ].sort(),
    };
  });
  if (!matched && weekAnalyses.length > 0) {
    samples.push({
      kind: 'week-file',
      runId: null,
      meta: null,
      scorecard: card,
      analyses: weekAnalyses,
      ownAnalyses: weekAnalyses,
      isWeekFile: true,
      at: judgeSpan(weekAnalyses)?.last ?? null,
      partialEngines: [],
      missingEngines: [],
    });
  }
  // 측정한 때 순 — 시각을 모르는 표본은 앞에 둔다.
  samples.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return { samples, issues };
}
