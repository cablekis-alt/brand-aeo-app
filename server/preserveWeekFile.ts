import { judgeSpan, sameMeasurement } from './runSamples.js';
import type { ResultStore } from './store.js';

/**
 * 회차 기록이 없는 그 주 파일을 다음 측정이 덮기 전에 회차 기록(runs/)으로 옮겨 둔다 — v0.4.26 전에 잰 측정과 회차 기록 저장에
 * 실패한 측정. 옮기지 않으면 같은 주에 다시 잴 때 그 측정이 사라진다(2026-W43 스테이,머뭄 · 군산각: 글을 올린 다음 날 측정).
 *
 * 그 주 판정이 없거나, 그 주 카드가 없거나, 이미 회차 기록과 짝이 맞으면 아무것도 쓰지 않고 null. 회차 번호는 그 측정의 판정 시각으로
 * 정한다 — 회차 이름 순서가 측정 순서와 맞게.
 */
export async function preserveUnrecordedWeekFile(
  store: Pick<ResultStore, 'getQuestionAnalyses' | 'getScorecardHistory' | 'listRunSnapshots' | 'saveRunSnapshot'>,
  tenantId: string,
  weekOf: string,
  now: Date = new Date(),
): Promise<string | null> {
  const analyses = await store.getQuestionAnalyses(tenantId, weekOf);
  if (analyses.length === 0) return null;
  const card = (await store.getScorecardHistory(tenantId, 12)).find((c) => c.weekOf === weekOf);
  if (!card) {
    console.warn(`[preserveWeekFile] ${tenantId} ${weekOf} 판정은 있는데 그 주 카드가 없어 옮겨 두지 않습니다`);
    return null;
  }
  const { runs } = await store.listRunSnapshots(tenantId, weekOf);
  if (runs.some((r) => sameMeasurement(analyses, r.analyses))) return null;

  const span = judgeSpan(analyses);
  const responses = new Map<string, number>();
  for (const a of analyses) responses.set(a.engine, (responses.get(a.engine) ?? 0) + 1);
  const stamp = span?.last ?? now.toISOString();
  return store.saveRunSnapshot(tenantId, weekOf, {
    scorecard: card,
    analyses,
    meta: {
      runId: `${stamp.replace(/[:.]/g, '-')}-preserved`,
      tenantId,
      weekOf,
      startedAt: span?.first ?? stamp,
      finishedAt: stamp,
      selfOnly: false,
      inCohortRun: false,
      weekCard: 'saved',
      // 원래 예정 호출 수는 모른다 — 받은 응답 수로 둔다(일부만 들어왔는지는 가릴 수 없다).
      engines: Object.fromEntries([...responses].map(([engine, n]) => [engine, { planned: n, succeeded: n }])),
      engineIssues: [],
      contextFingerprint: '',
      collectUsage: {},
      preserved: { from: 'week-file', preservedAt: now.toISOString() },
    },
  });
}
