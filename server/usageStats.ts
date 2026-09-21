import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { QuestionRepeatAnalysis, RawCallRecord } from './types.js';

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
 *
 * 다만 입력·출력은 나눠서 준다. 합계만으로는 환산조차 못 한다 — 출력이 입력보다 몇 배 비싼데
 * 비중이 엔진마다 완전히 다르다(실측 W38: ChatGPT 출력 7%, Perplexity 84%).
 *
 * 수집(collect)과 판정(judge)을 나눠 센다. 판정은 응답 하나마다 2~4회를 더 부르고 프롬프트에
 * 답변 원문이 통째로 들어가, 수집보다 클 수 있는데 지금까지 아무 데도 안 잡혔다.
 */
export interface UsageRow {
  engine: string;
  calls: number;
  tokens: number;
  /** 분리 값을 못 주는 엔진·구버전 데이터에서는 0으로 남는다. tokens와 합이 안 맞을 수 있다. */
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  tenants: number;
}

export interface UsageWeek {
  weekOf: string;
  /** 답변 수집 호출. */
  byEngine: UsageRow[];
  /** 판정 호출. 구버전 데이터에는 기록이 없어 빈 배열이 된다. */
  judgeByEngine: UsageRow[];
  calls: number;
  tokens: number;
  judgeCalls: number;
  judgeTokens: number;
}

export interface UsageStats {
  weeks: UsageWeek[];
  /** 읽은 raw-calls 파일 수. 0이면 저장된 원문이 없다는 뜻이다. */
  filesRead: number;
  /** 판정 기록이 있는 주차. 없는 주차는 그 기능이 생기기 전에 측정한 것이다. */
  weeksWithJudge: string[];
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
    return { weeks: [], filesRead: 0, weeksWithJudge: [] };
  }

  type Acc = { calls: number; tokens: number; input: number; output: number; latencyMs: number; tenants: Set<string> };
  const blank = (): Acc => ({ calls: 0, tokens: 0, input: 0, output: 0, latencyMs: 0, tenants: new Set<string>() });
  const toRows = (per: Map<string, Acc>): UsageRow[] =>
    [...per.entries()]
      .map(([engine, v]) => ({
        engine,
        calls: v.calls,
        tokens: v.tokens,
        inputTokens: v.input,
        outputTokens: v.output,
        latencyMs: v.latencyMs,
        tenants: v.tenants.size,
      }))
      .sort((a, b) => b.tokens - a.tokens);

  let filesRead = 0;
  const weeksWithJudge: string[] = [];
  const out: UsageWeek[] = [];
  for (const weekOf of [...wanted].sort()) {
    const collect = new Map<string, Acc>();
    const judge = new Map<string, Acc>();
    let judgeSeen = false;

    for (const tenantId of tenants) {
      const dir = path.join(PIPELINE_DATA_DIR, tenantId, weekOf);

      // ── 수집 ────────────────────────────────────────────────────────────
      const rawFile = path.join(dir, 'raw-calls.json');
      // stat으로 먼저 걸러 읽기 시도를 줄인다 — 테넌트가 136곳이라 대부분은 그 주차가 없다.
      let hasRaw = true;
      try {
        await stat(rawFile);
      } catch {
        hasRaw = false;
      }
      if (hasRaw) {
        let records: RawCallRecord[] | null = null;
        try {
          const parsed = JSON.parse(await readFile(rawFile, 'utf-8')) as unknown;
          if (Array.isArray(parsed)) records = parsed as RawCallRecord[];
        } catch {
          records = null;
        }
        if (records) {
          filesRead += 1;
          for (const r of records) {
            const row = collect.get(r.engine ?? 'unknown') ?? blank();
            row.calls += 1;
            if (typeof r.tokenUsage === 'number') row.tokens += r.tokenUsage;
            if (typeof r.inputTokens === 'number') row.input += r.inputTokens;
            if (typeof r.outputTokens === 'number') row.output += r.outputTokens;
            if (typeof r.latencyMs === 'number') row.latencyMs += r.latencyMs;
            row.tenants.add(tenantId);
            collect.set(r.engine ?? 'unknown', row);
          }
        }
      }

      // ── 판정 ────────────────────────────────────────────────────────────
      // 원문(raw-calls)은 분석 전에 저장되므로 판정 사용량은 분석 레코드에 실려 있다.
      const anFile = path.join(dir, 'question-analyses.json');
      try {
        await stat(anFile);
      } catch {
        continue;
      }
      let analyses: QuestionRepeatAnalysis[] | null = null;
      try {
        const parsed = JSON.parse(await readFile(anFile, 'utf-8')) as unknown;
        if (Array.isArray(parsed)) analyses = parsed as QuestionRepeatAnalysis[];
      } catch {
        analyses = null;
      }
      if (!analyses) continue;
      for (const a of analyses) {
        const u = a.judgeUsage;
        // 이 기능이 생기기 전 측정에는 기록이 없다. 없는 것을 0으로 세면 "판정을 안 했다"가
        // 되어 뜻이 달라지므로 건너뛰고, 화면이 그 주차를 따로 밝힌다.
        if (!u) continue;
        judgeSeen = true;
        const row = judge.get(u.engine) ?? blank();
        row.calls += u.calls;
        row.tokens += u.tokens;
        row.input += u.inputTokens;
        row.output += u.outputTokens;
        row.tenants.add(tenantId);
        judge.set(u.engine, row);
      }
    }

    if (judgeSeen) weeksWithJudge.push(weekOf);
    const byEngine = toRows(collect);
    const judgeByEngine = toRows(judge);
    out.push({
      weekOf,
      byEngine,
      judgeByEngine,
      calls: byEngine.reduce((a, b) => a + b.calls, 0),
      tokens: byEngine.reduce((a, b) => a + b.tokens, 0),
      judgeCalls: judgeByEngine.reduce((a, b) => a + b.calls, 0),
      judgeTokens: judgeByEngine.reduce((a, b) => a + b.tokens, 0),
    });
  }
  return { weeks: out, filesRead, weeksWithJudge };
}
