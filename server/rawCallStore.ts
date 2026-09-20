import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { RawCallRecord } from './types.js';

/**
 * 저장된 AI 답변 원문 읽기 — data/<tenant>/<week>/raw-calls.json.
 *
 * 파이프라인은 원문을 처음부터 남겨 왔지만 화면이 한 번도 보여 주지 않았다. 고객이 가장 먼저
 * 묻는 것이 "그래서 AI가 우리를 뭐라고 하는데요?"인데, 우리는 판정 결과(언급률·문장 조각)만
 * 보여 주고 원문은 감춰 두었다. 조각만 보여 주면 "유리한 부분만 잘라 왔다"는 의심을 산다.
 *
 * 질문 하나씩만 내려준다. 한 주차 전체는 실측 215KB(71건)라, 화면이 한 번에 한 질문만
 * 보여 주는데 전부 내려보낼 이유가 없다.
 */
export interface RawAnswer {
  engine: string;
  callIndex: number;
  rawText: string;
  citations: string[];
  usedWebSearch: boolean;
  latencyMs?: number;
  calledAt: string;
}

export async function getRawAnswers(
  tenantId: string,
  weekOf: string,
  questionId: string,
): Promise<RawAnswer[]> {
  const file = path.join(PIPELINE_DATA_DIR, tenantId, weekOf, 'raw-calls.json');
  let records: RawCallRecord[];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    records = parsed as RawCallRecord[];
  } catch {
    // 파일이 없는 주차가 있다(옛 측정·베이킹된 데모). 화면은 "원문 없음"으로 말한다.
    return [];
  }
  return records
    .filter((r) => r.questionId === questionId)
    .map((r) => ({
      engine: r.engine,
      callIndex: r.callIndex,
      rawText: r.rawText ?? '',
      citations: Array.isArray(r.citations) ? r.citations : [],
      usedWebSearch: Boolean(r.usedWebSearch),
      ...(typeof r.latencyMs === 'number' ? { latencyMs: r.latencyMs } : {}),
      calledAt: r.calledAt ?? '',
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine) || a.callIndex - b.callIndex);
}
