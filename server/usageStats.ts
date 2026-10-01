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
 *
 * 웹검색을 쓴 호출 수도 따로 센다. 검색 요금은 검색한 호출에만 붙는데 호출 수 전체에 곱하면
 * 부풀고(판정은 검색을 안 한다 — 2026-W40에 판정 6,811회에 검색 요금 약 $95가 붙었다), 월 무료
 * 한도(Gemini 5,000건)는 달 단위라 그 달에 앞서 쓴 검색 수를 알아야 계산된다.
 */
export interface UsageRow {
  engine: string;
  calls: number;
  tokens: number;
  /** 분리 값을 못 주는 엔진·구버전 데이터에서는 0으로 남는다. tokens와 합이 안 맞을 수 있다. */
  inputTokens: number;
  outputTokens: number;
  /**
   * 엔진이 알려 준 실제 청구액의 합(USD). null이면 그 엔진은 청구액을 주지 않아 단가로
   * 계산해야 한다 — 0과 구분해야 한다(0은 "공짜였다"는 뜻이다).
   */
  billedCost: number | null;
  latencyMs: number;
  tenants: number;
  /** 웹검색을 쓴 호출 수. 판정 줄은 0이다(판정은 검색하지 않는다). */
  searchCalls: number;
  /**
   * 검색 호출을 달별로 나눈 것. priorInMonth는 같은 엔진이 그 달에 이 주차보다 앞서 쓴 검색 수다 —
   * 월 무료 한도를 앞 주차가 얼마나 썼는지 알아야 이 주차 몫을 낼 수 있다.
   */
  searchByMonth: { month: string; searches: number; priorInMonth: number }[];
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

/**
 * 보여 줄 주차보다 앞서 더 읽는 주차 수. 첫 주차의 달 무료 한도를 그 달 앞 주차들이 얼마나 썼는지
 * 세려면 최대 4주(+ 달에 걸친 1주)를 더 봐야 한다. 그 주차들은 검색 수만 세고 줄로 내지 않는다.
 */
const SEARCH_LOOKBACK_WEEKS = 5;

export async function getUsageStats(weeksBack = 4): Promise<UsageStats> {
  const allWeeks = await listWeeks();
  const wantedCount = Math.max(1, Math.min(weeksBack, 12));
  const wanted = allWeeks.slice(0, wantedCount);
  const scanned = allWeeks.slice(0, wantedCount + SEARCH_LOOKBACK_WEEKS);
  let tenants: string[] = [];
  try {
    tenants = await readdir(PIPELINE_DATA_DIR);
  } catch {
    return { weeks: [], filesRead: 0, weeksWithJudge: [] };
  }

  type Acc = {
    calls: number;
    tokens: number;
    input: number;
    output: number;
    latencyMs: number;
    cost: number;
    costCalls: number;
    tenants: Set<string>;
    search: number;
    searchByMonth: Map<string, number>;
  };
  const blank = (): Acc => ({
    calls: 0,
    tokens: 0,
    input: 0,
    output: 0,
    latencyMs: 0,
    cost: 0,
    costCalls: 0,
    tenants: new Set<string>(),
    search: 0,
    searchByMonth: new Map<string, number>(),
  });
  // 엔진·달별로 지금까지(주차 오름차순) 쓴 검색 수.
  const monthSearches = new Map<string, number>();
  const monthKey = (engine: string, month: string) => `${engine}|${month}`;
  const toRows = (per: Map<string, Acc>): UsageRow[] =>
    [...per.entries()]
      .map(([engine, v]) => ({
        engine,
        calls: v.calls,
        tokens: v.tokens,
        inputTokens: v.input,
        outputTokens: v.output,
        // 일부 호출만 청구액을 주면 합계가 실제보다 작아 거짓이 된다 — 전부 줄 때만 쓴다.
        billedCost: v.costCalls > 0 && v.costCalls === v.calls ? v.cost : null,
        latencyMs: v.latencyMs,
        tenants: v.tenants.size,
        searchCalls: v.search,
        searchByMonth: [...v.searchByMonth.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, searches]) => ({
            month,
            searches,
            priorInMonth: monthSearches.get(monthKey(engine, month)) ?? 0,
          })),
      }))
      .sort((a, b) => b.tokens - a.tokens);

  let filesRead = 0;
  const weeksWithJudge: string[] = [];
  const out: UsageWeek[] = [];
  const wantedSet = new Set(wanted);
  for (const weekOf of [...scanned].sort()) {
    const isWanted = wantedSet.has(weekOf);
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
          if (isWanted) filesRead += 1;
          for (const r of records) {
            const row = collect.get(r.engine ?? 'unknown') ?? blank();
            row.calls += 1;
            if (typeof r.tokenUsage === 'number') row.tokens += r.tokenUsage;
            if (typeof r.inputTokens === 'number') row.input += r.inputTokens;
            if (typeof r.outputTokens === 'number') row.output += r.outputTokens;
            if (typeof r.latencyMs === 'number') row.latencyMs += r.latencyMs;
            if (typeof r.billedCost === 'number') {
              row.cost += r.billedCost;
              row.costCalls += 1;
            }
            if (r.usedWebSearch === true) {
              row.search += 1;
              // 달은 실제 호출 시각으로 정한다 — 한 주차가 두 달에 걸칠 수 있다.
              const month = (r.calledAt ?? '').slice(0, 7) || 'unknown';
              row.searchByMonth.set(month, (row.searchByMonth.get(month) ?? 0) + 1);
            }
            row.tenants.add(tenantId);
            collect.set(r.engine ?? 'unknown', row);
          }
        }
      }
      // 앞 주차는 검색 수만 센다(달 무료 한도의 누적용).
      if (!isWanted) continue;

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

    // toRows는 지금까지의 누적(priorInMonth)을 읽으므로, 이 주차 검색을 누적에 더하기 전에 부른다.
    const byEngine = toRows(collect);
    for (const [engine, acc] of collect) {
      for (const [month, n] of acc.searchByMonth) {
        monthSearches.set(monthKey(engine, month), (monthSearches.get(monthKey(engine, month)) ?? 0) + n);
      }
    }
    if (!isWanted) continue;

    if (judgeSeen) weeksWithJudge.push(weekOf);
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
