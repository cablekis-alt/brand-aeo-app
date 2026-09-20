import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { RawCallRecord } from './types.js';

/**
 * 엔진 사용량 — 호출 수·토큰·소요 시간.
 *
 * 왜 필요한가. 오늘 OpenAI 크레딧이 소진된 것을 **측정이 실패한 뒤에야** 알았다. 화면 어디에도
 * "얼마나 썼는지"가 없었다. tokenUsage는 처음부터 raw-calls에 100% 기록돼 있었는데 아무도
 * 보여 주지 않았을 뿐이다.
 *
 * 브랜드별이 아니라 **전체**로 낸다. API 키는 브랜드마다 따로 있지 않고 한 벌을 같이 쓰므로,
 * 크레딧이 왜 말랐는지는 전체를 봐야 답이 나온다.
 *
 * 비용은 계산하지 않는다. 모델 단가를 코드에 박으면 단가가 바뀐 뒤에도 그대로 거짓을 말한다 —
 * 오늘 가중치 표에서 겪은 것과 같은 종류다. 토큰까지만 보여 주고 환산은 사람이 한다.
 */
export interface UsageWeek {
  weekOf: string;
  byEngine: { engine: string; calls: number; tokens: number; latencyMs: number; tenants: number }[];
  calls: number;
  tokens: number;
}

export interface UsageStats {
  weeks: UsageWeek[];
  /** 읽은 raw-calls 파일 수. 0이면 저장된 원문이 없다는 뜻이다. */
  filesRead: number;
}

/** data/ 아래 존재하는 주차 키를 최신순으로. 디렉터리 이름만 보므로 파일을 열지 않는다. */
async function listWeeks(): Promise<string[]> {
  const weeks = new Set<string>();
  let tenants: string[];
  try {
    tenants = await readdir(PIPELINE_DATA_DIR);
  } catch {
    return [];
  }
  for (const t of tenants) {
    let entries: string[];
    try {
      entries = await readdir(path.join(PIPELINE_DATA_DIR, t));
    } catch {
      continue;
    }
    for (const e of entries) if (/^\d{4}-W\d{2}$/.test(e)) weeks.add(e);
  }
  return [...weeks].sort().reverse();
}

export async function getUsageStats(weeksBack = 4): Promise<UsageStats> {
  const allWeeks = await listWeeks();
  const wanted = allWeeks.slice(0, Math.max(1, Math.min(weeksBack, 12)));
  let tenants: string[] = [];
  try {
    tenants = await readdir(PIPELINE_DATA_DIR);
  } catch {
    return { weeks: [], filesRead: 0 };
  }

  let filesRead = 0;
  const out: UsageWeek[] = [];
  for (const weekOf of [...wanted].sort()) {
    const per = new Map<string, { calls: number; tokens: number; latencyMs: number; tenants: Set<string> }>();
    for (const tenantId of tenants) {
      const file = path.join(PIPELINE_DATA_DIR, tenantId, weekOf, 'raw-calls.json');
      // stat으로 먼저 걸러 읽기 시도를 줄인다 — 테넌트가 136곳이라 대부분은 그 주차가 없다.
      try {
        await stat(file);
      } catch {
        continue;
      }
      let records: RawCallRecord[];
      try {
        const parsed = JSON.parse(await readFile(file, 'utf-8')) as unknown;
        if (!Array.isArray(parsed)) continue;
        records = parsed as RawCallRecord[];
      } catch {
        continue;
      }
      filesRead += 1;
      for (const r of records) {
        const engine = r.engine ?? 'unknown';
        const row = per.get(engine) ?? { calls: 0, tokens: 0, latencyMs: 0, tenants: new Set<string>() };
        row.calls += 1;
        if (typeof r.tokenUsage === 'number') row.tokens += r.tokenUsage;
        if (typeof r.latencyMs === 'number') row.latencyMs += r.latencyMs;
        row.tenants.add(tenantId);
        per.set(engine, row);
      }
    }
    const byEngine = [...per.entries()]
      .map(([engine, v]) => ({
        engine,
        calls: v.calls,
        tokens: v.tokens,
        latencyMs: v.latencyMs,
        tenants: v.tenants.size,
      }))
      .sort((a, b) => b.tokens - a.tokens);
    out.push({
      weekOf,
      byEngine,
      calls: byEngine.reduce((a, b) => a + b.calls, 0),
      tokens: byEngine.reduce((a, b) => a + b.tokens, 0),
    });
  }
  return { weeks: out, filesRead };
}
