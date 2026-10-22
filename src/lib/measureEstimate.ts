/**
 * 측정 진행 표시의 남은 시간(components/MeasureProgress.tsx) — 화면 부품 파일은 부품만 내보내야 해서(빠른 새로 고침) 따로 둔다.
 *
 * 두 층으로 나눈다.
 *  1) 어림(estimateFinishAt): 폴링 응답을 받을 때만 한 번 계산해 「측정이 끝날 시각」을 낸다.
 *  2) 표시(stepEta): 1초마다 부른다. 끝날 시각을 향해 숫자를 줄여 가고, 새 어림이 와도 크게 다를 때만 숫자를 고친다.
 *  화면은 둘을 tickEta 하나로 부른다.
 *
 * v0.4.22까지의 어림은 매 렌더마다 「남은 건수 × 경과 ÷ 끝낸 건수」를 다시 계산했다. 그래서
 *  - 수집 끝자락(이미 보낸 호출의 응답만 기다릴 때)에도 속도로 셌다. 이 구간은 응답 시간에 묶인다 — 1분 52초에 「약 26초」,
 *    실제로는 2분 30초가 남았다(gunsan-national W43, 남은 Perplexity 5건이 69~83초째 응답을 기다리고 있었다).
 *  - 수집 뒤 단계(인용 정리 · 분석 · 집계)를 수집 남은 시간의 0.15배로만 셌다 — 수집이 끝나 갈수록 사라졌다.
 *  - 분석 단계에서 측정 전체 경과를 분석 건수로 나눠 수백 ~ 수천 초가 튀었다.
 *  - 폴링 사이에 경과만 1초씩 늘어 숫자가 거꾸로 올라갔다(22 → 23 → 24).
 *
 * 측정이 끝나는 때 = 가장 늦게 끝나는 수집 호출 + 그 뒤 꼬리(인용 정리 · 분석 · 집계). 화면이 띄운 측정은 리포트를 기다리지 않는다.
 *
 *  수집 — 엔진마다(슬롯 · 분당 상한은 모든 줄이 함께 쓴다) 남은 호출을 둘로 나눈다.
 *   · 아직 안 보낸 호출: 보낼 수 있는 간격(분당 상한 · 「평균 응답 시간 ÷ 슬롯」 중 느린 쪽, 실제로 끝낸 속도가 확실히 더 느리면 그것)으로
 *     차례로 나간다.
 *   · 보내고 기다리는 호출: 이미 기다린 시간(나이)을 안다. 남은 시간은 「나이만큼 기다렸다」는 조건을 건 응답 시간 분포에서 나온다.
 *   응답 시간 분포는 이번 측정에서 끝난 호출(사건)과 기다리는 호출(그 나이에서 잘린 관측)로 Kaplan–Meier를 세우고, 표본이 얇아지는
 *   곳부터는 지수 꼬리로 잇는다. 꼬리 평균은 잘린 관측까지 넣은 최대 우도라, 오래 기다리는 호출이 있으면 꼬리가 무거워진다.
 *   「남은 호출이 모두 τ 안에 끝날 확률」 = 호출마다 끝날 확률의 곱. 그 확률이 finishQuantile이 되는 τ를 수집 끝으로 본다.
 *   (로그정규로 맞춰 보기도 했다 — 빠른 응답 덩어리 때문에 퍼짐이 커져, 코호트 수집 끝자락에서 2배 가까이 길게 말했다.)
 *
 *  꼬리 — 분석은 줄마다 동시 24건이라 건수에 비례한다(한 건당 약 0.33초). 분석에 들어간 줄이 있으면 그 줄들이 실제로 쓴 시간으로
 *   한 건당 몫을 고쳐 가고(판정이 느린 날), 분석 중인 줄은 끝낸 건수만큼 실제 속도로 옮겨 간다.
 *
 * 조정값은 2026-W38~W43 측정 33묶음(199줄)을 지금 수집 설정으로 다시 짠 재생 시뮬레이터로 골랐다 — 바꾸면 거기서 다시 잰다.
 */

// ───────────────────────────── 서버 필드(/api/measure-status active 항목) ─────────────────────────────

/** 수집 단계의 엔진 하나(server/measureTracker.ts ActiveMeasure.engines). done · total은 v0.4.21부터, 나머지는 그다음 릴리스부터(옛 서버에는 없다). */
export interface EngineProgress {
  done: number
  total: number
  /** 보내고 응답을 기다리는 호출이 실제로 나간 시각(epoch ms) — 슬롯 · 분당 간격 대기가 끝난 뒤. */
  inflightSentAt?: number[]
  /** 이 줄에서 끝난(성공한) 호출의 응답 시간(ms, RawCallRecord.latencyMs). 실패는 넣지 않는다. */
  latencyMs?: number[]
  /** 이 엔진의 수집 동시 슬롯 — 모든 줄이 함께 쓴다(server/concurrency.ts collectLimit). */
  slots?: number
  /** 분당 시작 상한(0 = 없음, concurrency.ts collectRpm). */
  rpm?: number
}

/** 진행 중인 줄 하나에서 어림에 쓰는 값 — /api/measure-status의 active 항목(MeasureProgress.tsx ActiveMeasure). */
export interface ProgressRow {
  tenantId?: string
  stage?: string
  done?: number
  total?: number
  /** 지금 단계에 들어간 시각(epoch ms) — 남은 시간 재료와 같은 릴리스부터. */
  stageStartedAt?: number
  engines?: Record<string, EngineProgress>
}

/** 조정값 — 시뮬레이터로 맞췄다. 사전 · 꼬리 값을 ±50% 바꿔도 MAE는 1~2초 안에서 움직인다. */
export const ESTIMATE_PARAMS = {
  /** 수집이 이 확률로 끝나는 시각을 쓴다(0.5 = 중앙). 조금 높여 짧게 말하는 쪽을 줄인다. */
  finishQuantile: 0.6,
  /**
   * 남은 일이 있는 엔진마다 끝난 응답이 이만큼 모이기 전에는 숫자를 내지 않는다. 사전 분포만으로 낸 첫 숫자는 실제의 절반쯤이라
   * 곧 크게 올려야 했다(재생에서 측정당 「숫자가 올라감」 0.72 → 0.44회, 첫 숫자 약 4초 → 19초).
   */
  minLatencySamples: 3,
  /** 응답 시간 사전 분포의 중앙값(ms)과 가짜 관측 수 — 이번 측정에서 끝난 호출이 쌓이면 묻힌다. */
  priorMedianMs: 15_000,
  priorWeight: 8,
  /** 지수 꼬리: 사전 꼬리 평균 = 이 배수 × 중앙 응답 시간, 그 무게(가짜 사건 수). */
  tailMinOverMedian: 0.8,
  tailPriorEvents: 2,
  /** 꼬리를 잇는 곳 — 위험 집합이 이 건수 넘게 남은 마지막 사건, 적어도 이 분위. */
  tailAnchorAtRisk: 10,
  tailAnchorMinQ: 0.75,
  /**
   * 실제로 끝낸 속도(첫 응답까지 걸린 평균 응답 시간을 뺀 경과 ÷ 끝낸 건수)가 이론 간격보다 이 배수 넘게 느리면 그것을 쓴다 —
   * 줄의 일꾼이 다른 엔진 대기에 묶이거나 슬롯 설정과 실제 처리량이 어긋날 때. 끝낸 건수 · 경과가 이만큼은 돼야 잰다.
   */
  observedMinRatio: 1.3,
  observedMinDone: 10,
  observedMinRunMs: 15_000,
  /** 분석: 한 건당 사전 몫(ms)과 그 무게(가짜 건수). 동시 24 · 인용 많은 답부터로 다시 돌린 기록의 중앙. */
  analysisPerItemMs: 330,
  analysisPriorItems: 72,
  /** 분석 중인 줄: 사전 어림에서 실제 속도로 옮겨 가는 빠르기(끝낸 건수가 이만큼이면 반반). */
  analysisBlendItems: 24,
  /** 첫 물결(동시 24건)이 끝나기까지 — 끝낸 건수로 속도를 잴 때 뺀다. 이 건수를 넘기 전에는 속도를 쓰지 않는다. */
  analysisStartupMs: 6_000,
  analysisMinDone: 12,
  /** 인용 정리: Gemini 리다이렉트 풀기가 있으면 몇 초(중앙 3.4초), 없으면 거의 0. */
  citeGapGeminiMs: 3_500,
  citeGapOtherMs: 300,
  /** 집계(카드 저장, 실측 30ms 안팎)와 리포트 단계(화면 밖에서 시작한 측정만 기다린다, 실측 16초). */
  aggregateMs: 300,
  reportMs: 16_000,
  /** 남은 일이 있는 단계는 적어도 이만큼. */
  stageFloorMs: 1_000,
}

export type EstimateParams = typeof ESTIMATE_PARAMS

// ───────────────────────────── 응답 시간 분포 ─────────────────────────────

/** 사전 분포의 모양(중앙값 배수) — 2026-W38~W43 수집 호출 1.7만 건을 측정 · 엔진마다 중앙값으로 나눈 분위를 줄인 것. */
const PRIOR_SHAPE = [0.5, 0.65, 0.75, 0.85, 0.95, 1.05, 1.2, 1.4, 1.8, 2.6]

interface LatencyModel {
  /** 응답 시간이 x(ms)보다 길 확률. */
  survival(x: number): number
  meanMs: number
}

/**
 * 가중 Kaplan–Meier + 지수 꼬리. done = 끝난 호출의 응답 시간(사건), ages = 기다리는 호출의 나이(그때 잘린 관측).
 * 사전 가짜 관측을 priorWeight만큼의 무게로 섞는다.
 */
function latencyModel(done: number[], ages: number[], p: EstimateParams): LatencyModel {
  const pts: Array<{ t: number; ev: number; w: number }> = []
  for (const d of done) pts.push({ t: Math.max(1, d), ev: 1, w: 1 })
  const pw = p.priorWeight / PRIOR_SHAPE.length
  for (const k of PRIOR_SHAPE) pts.push({ t: k * p.priorMedianMs, ev: 1, w: pw })
  for (const a of ages) pts.push({ t: Math.max(1, a), ev: 0, w: 1 })
  pts.sort((a, b) => a.t - b.t || b.ev - a.ev)

  let atRisk = pts.reduce((n, x) => n + x.w, 0)
  let s = 1
  const ts: number[] = [] // 사건 시각
  const ss: number[] = [] // 그 뒤 생존
  const rs: number[] = [] // 그 직전 위험 집합 무게
  for (let i = 0; i < pts.length; ) {
    const t = pts[i]!.t
    let d = 0
    let gone = 0
    for (; i < pts.length && pts[i]!.t === t; i += 1) {
      if (pts[i]!.ev) d += pts[i]!.w
      gone += pts[i]!.w
    }
    if (d > 0 && atRisk > 0) {
      s *= 1 - d / atRisk
      ts.push(t)
      ss.push(s)
      rs.push(atRisk)
    }
    atRisk -= gone
  }
  const quantile = (q: number): number | null => {
    for (let j = 0; j < ss.length; j += 1) if (ss[j]! <= 1 - q) return ts[j]!
    return null
  }
  const km = (x: number): number => {
    let lo = 0
    let hi = ts.length - 1
    let k = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (ts[mid]! <= x) {
        k = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return k < 0 ? 1 : ss[k]!
  }
  const median = quantile(0.5) ?? ts[ts.length - 1] ?? p.priorMedianMs
  // 꼬리를 이을 곳: 위험 집합이 아직 tailAnchorAtRisk건 넘게 남은 마지막 사건(표본이 많으면 높은 분위까지 실측 모양을 쓴다).
  // 적어도 tailAnchorMinQ 분위 — 그 분위가 없으면(기다리는 호출이 많아 생존이 거기까지 안 내려가면) 마지막 사건.
  let anchor = quantile(p.tailAnchorMinQ) ?? ts[ts.length - 1] ?? median
  for (let j = ts.length - 1; j >= 0; j -= 1) {
    if (rs[j]! >= p.tailAnchorAtRisk) {
      anchor = Math.max(anchor, ts[j]!)
      break
    }
  }
  const sAnchor = Math.max(1e-6, km(anchor))
  // 꼬리 평균 = 잘린 관측이 있는 지수 분포의 최대 우도: anchor 뒤에서 보낸 시간 합 ÷ anchor 뒤에서 끝난 호출 수.
  // 기다리는 호출도 「여기까지는 안 끝났다」로 시간을 보탠다. 사전 꼬리를 가짜 사건 tailPriorEvents건으로 섞는다.
  let exposure = 0
  let events = 0
  for (const d of done) {
    if (d > anchor) {
      exposure += d - anchor
      events += 1
    }
  }
  for (const a of ages) if (a > anchor) exposure += a - anchor
  const theta0 = Math.max(1_000, p.tailMinOverMedian * median)
  const theta = Math.max(1_000, (exposure + p.tailPriorEvents * theta0) / (events + p.tailPriorEvents))
  const survival = (x: number): number => (x <= anchor ? km(x) : sAnchor * Math.exp(-(x - anchor) / theta))
  // 평균 = ∫S — 계단 넓이 + 꼬리.
  let mean = 0
  let prevT = 0
  let prevS = 1
  for (let j = 0; j < ts.length && ts[j]! <= anchor; j += 1) {
    mean += prevS * (ts[j]! - prevT)
    prevT = ts[j]!
    prevS = ss[j]!
  }
  mean += prevS * (anchor - prevT) + sAnchor * theta
  return { survival, meanMs: mean }
}

// ───────────────────────────── 수집 ─────────────────────────────

interface EngineState {
  /** 기다리는 호출의 나이(ms). */
  ages: number[]
  /** 아직 안 보낸 호출. */
  unsent: number
  latency: LatencyModel
  /** 안 보낸 호출이 나가는 간격(ms). */
  intervalMs: number
}

/**
 * 수집 중인 줄들을 엔진마다 합친다(슬롯 · 분당 상한은 모든 줄이 함께 쓴다).
 * null = 셀 수 없다 — 새 필드가 없는 줄(옛 서버)이 있거나, 남은 일이 있는 엔진의 응답이 아직 minLatencySamples건 안 모였다.
 * finished = 이번 측정에서 수집을 먼저 끝낸 줄(기억) — 남은 일은 없지만 응답 시간 표본과 끝낸 건수(속도)에 넣는다.
 * 빼면 한 줄이 분석으로 넘어가는 순간 끝낸 건수가 줄어 실제 속도가 느려 보이고 숫자가 튄다.
 */
function collectEngines(rows: ProgressRow[], finished: RowMemory[], nowMs: number, p: EstimateParams): EngineState[] | null {
  const acc = new Map<string, { left: number; ages: number[]; done: number[]; doneCount: number; slots: number; rpm: number; since: number }>()
  const add = (engine: string, e: EngineProgress, since: number | undefined, ages: number[]) => {
    const a = acc.get(engine) ?? { left: 0, ages: [], done: [], doneCount: 0, slots: 0, rpm: 0, since: Infinity }
    if (since !== undefined) a.since = Math.min(a.since, since)
    a.left += Math.max(0, e.total - e.done)
    a.ages.push(...ages)
    a.done.push(...(e.latencyMs ?? []))
    a.doneCount += e.done
    a.slots = Math.max(a.slots, e.slots ?? 0)
    a.rpm = Math.max(a.rpm, e.rpm ?? 0)
    acc.set(engine, a)
  }
  for (const r of rows) {
    for (const [engine, e] of Object.entries(r.engines ?? {})) {
      if (!e.inflightSentAt || !e.latencyMs) return null
      add(engine, e, r.stageStartedAt, e.inflightSentAt.map((t) => Math.max(0, nowMs - t)))
    }
  }
  for (const m of finished) for (const [engine, e] of Object.entries(m.engines)) if (acc.has(engine)) add(engine, { ...e, total: e.done }, m.collectSince, [])
  const out: EngineState[] = []
  for (const a of acc.values()) {
    if (a.left <= 0) continue
    if (a.done.length < p.minLatencySamples) return null
    const latency = latencyModel(a.done, a.ages, p)
    const unsent = Math.max(0, a.left - a.ages.length)
    const paceMs = a.rpm > 0 ? 60_000 / a.rpm : 0
    const slotMs = latency.meanMs / (a.slots > 0 ? a.slots : 24)
    const theory = Math.max(paceMs, slotMs)
    const run = nowMs - a.since - latency.meanMs
    const seenMs = a.doneCount >= p.observedMinDone && run >= p.observedMinRunMs ? run / a.doneCount : 0
    out.push({ ages: a.ages, unsent, latency, intervalMs: seenMs > theory * p.observedMinRatio ? seenMs : theory })
  }
  return out
}

/**
 * 남은 호출이 모두 τ(ms, 지금부터) 안에 끝날 확률의 로그.
 * 기다리는 호출: 1 − S(나이 + τ)/S(나이). 안 보낸 k번째 호출(k · 간격 뒤에 나감): 1 − S(τ − k · 간격).
 */
function logAllDoneBy(engines: EngineState[], tau: number): number {
  let lp = 0
  for (const e of engines) {
    const S = e.latency.survival
    for (const a of e.ages) {
      const s0 = S(a)
      const r = s0 > 0 ? S(a + tau) / s0 : 0
      lp += Math.log(Math.max(1e-12, 1 - r))
    }
    for (let k = 1; k <= e.unsent; k += 1) {
      const x = tau - k * e.intervalMs
      if (x <= 0) return -Infinity
      lp += Math.log(Math.max(1e-12, 1 - S(x)))
    }
  }
  return lp
}

/** 수집이 확률 q로 끝나는 데 걸리는 시간(ms, 지금부터) — 이분 탐색. */
function collectionFinishMs(engines: EngineState[], q: number): number {
  if (engines.length === 0) return 0
  const target = Math.log(q)
  let lo = 0
  for (const e of engines) lo = Math.max(lo, e.unsent * e.intervalMs)
  let hi = Math.max(30_000, lo * 2)
  for (let i = 0; i < 20 && logAllDoneBy(engines, hi) < target; i += 1) hi *= 2
  for (let i = 0; i < 30 && hi - lo > 200; i += 1) {
    const mid = (lo + hi) / 2
    if (logAllDoneBy(engines, mid) >= target) hi = mid
    else lo = mid
  }
  return hi
}

// ───────────────────────────── 꼬리 ─────────────────────────────

function citeGapMs(engineNames: string[], p: EstimateParams): number {
  return engineNames.includes('gemini') ? p.citeGapGeminiMs : p.citeGapOtherMs
}

/**
 * 분석 한 건당 몫(ms) — 사전 몫(가짜 analysisPriorItems건)에 분석 중인 줄들이 실제로 쓴 시간을 섞는다.
 * 판정이 느린 날(2026-10-13 판정 한 건 wall이 평소의 몇 배)에는 먼저 분석에 들어간 줄이 알려 준다.
 * 첫 물결(동시 24건)이 끝나기 전에는 끝낸 건이 거의 없어 속도가 크게 튄다 — 첫 물결 시간을 빼고, analysisMinDone건을 넘긴 줄만 센다.
 */
function analysisPerItemMs(active: ProgressRow[], nowMs: number, p: EstimateParams): number {
  let spent = 0
  let done = 0
  for (const r of active) {
    if (r.stage !== '분석' || r.stageStartedAt === undefined || (r.done ?? 0) < p.analysisMinDone) continue
    spent += Math.max(0, nowMs - r.stageStartedAt - p.analysisStartupMs)
    done += r.done ?? 0
  }
  return (spent + p.analysisPriorItems * p.analysisPerItemMs) / (done + p.analysisPriorItems)
}

/** 분석 중인 줄의 남은 시간 — 사전 어림(건수 × 한 건당 몫 − 지난 시간)에서 이 줄의 실제 속도로, 끝낸 건수만큼 옮겨 간다. */
function analysisLeftMs(r: ProgressRow, nowMs: number, perItemMs: number, p: EstimateParams): number {
  const total = r.total ?? 0
  const done = r.done ?? 0
  const left = Math.max(0, total - done)
  if (left === 0) return p.aggregateMs
  const spent = r.stageStartedAt !== undefined ? Math.max(0, nowMs - r.stageStartedAt) : 0
  const prior = Math.max(0, total * perItemMs - spent)
  let est = prior
  if (done >= p.analysisMinDone) {
    const rate = (left * Math.max(0, spent - p.analysisStartupMs)) / done
    const w = done / (done + p.analysisBlendItems)
    est = (1 - w) * prior + w * rate
  }
  return Math.max(p.stageFloorMs, est) + p.aggregateMs
}

// ───────────────────────────── 측정 전체 ─────────────────────────────

/** 줄 하나에 대해 기억해 두는 것 — 인용 정리 단계에서는 서버가 건수를 0으로 보내고, 수집을 끝낸 줄은 엔진 건수를 더 보내지 않는다. */
export interface RowMemory {
  engineNames: string[]
  calls: number
  collectSince?: number
  engines: Record<string, EngineProgress>
}

/** 측정 하나 동안의 기억(tenantId별). 바꾸지 않고 새로 만든다(rememberRows). */
export type EstimateMemory = Readonly<Record<string, RowMemory>>

/** 수집 중인 줄의 엔진 건수 · 응답 시간을 기억에 옮긴다. */
export function rememberRows(memory: EstimateMemory, active: ProgressRow[]): EstimateMemory {
  const next: Record<string, RowMemory> = { ...memory }
  for (const r of active) {
    if (r.stage !== '수집' || !r.engines || !r.tenantId) continue
    next[r.tenantId] = {
      engineNames: Object.keys(r.engines),
      calls: r.total ?? 0,
      ...(r.stageStartedAt !== undefined ? { collectSince: r.stageStartedAt } : {}),
      engines: Object.fromEntries(Object.entries(r.engines).map(([k, e]) => [k, { ...e, inflightSentAt: [] }])),
    }
  }
  return next
}

/**
 * 측정이 끝날 시각(epoch ms). 모르면 null — 모든 줄이 아직 준비 중이거나, 수집 중인 줄에 새 필드가 없거나(옛 서버),
 * 남은 일이 있는 엔진의 응답이 아직 minLatencySamples건 안 모였을 때.
 * memory = rememberRows로 이번 폴링까지 쌓은 기억.
 */
export function estimateFinishAt(active: ProgressRow[], nowMs: number, memory: EstimateMemory = {}, p: EstimateParams = ESTIMATE_PARAMS): number | null {
  if (active.length === 0) return null
  const collecting = active.filter((r) => r.stage === '수집' && r.engines)
  const collectingIds = new Set(collecting.map((r) => r.tenantId))
  const finished = Object.entries(memory)
    .filter(([id]) => !collectingIds.has(id))
    .map(([, m]) => m)

  // 준비 중인 줄(단계 없음)은 일감을 모른다 — 수집 중인 가장 큰 줄과 같은 일을 아직 하나도 안 했다고 본다.
  const preparing = active.filter((r) => !r.stage || r.stage === '준비')
  const template = collecting.reduce<ProgressRow | null>((a, b) => (!a || (b.total ?? 0) > (a.total ?? 0) ? b : a), null)
  if (preparing.length && !template) return null
  const pseudo: ProgressRow[] = template
    ? preparing.map(() => ({
        stage: '수집',
        total: template.total ?? 0,
        done: 0,
        engines: Object.fromEntries(
          Object.entries(template.engines ?? {}).map(([k, e]) => [k, { done: 0, total: e.total, inflightSentAt: [], latencyMs: [], slots: e.slots ?? 0, rpm: e.rpm ?? 0 }]),
        ),
      }))
    : []

  const perItem = analysisPerItemMs(active, nowMs, p)
  let latest = 0
  const collectRows = [...collecting, ...pseudo]
  if (collectRows.length) {
    const engines = collectEngines(collectRows, finished, nowMs, p)
    if (!engines) return null
    let tail = 0
    for (const r of collectRows) tail = Math.max(tail, citeGapMs(Object.keys(r.engines ?? {}), p) + (r.total ?? 0) * perItem + p.aggregateMs)
    latest = collectionFinishMs(engines, p.finishQuantile) + tail
  }
  for (const r of active) {
    const spent = r.stageStartedAt !== undefined ? Math.max(0, nowMs - r.stageStartedAt) : 0
    const known = r.tenantId ? memory[r.tenantId] : undefined
    let left = 0
    if (r.stage === '인용 정리') {
      const gap = Math.max(p.stageFloorMs, citeGapMs(known?.engineNames ?? ['gemini'], p) - spent)
      left = gap + (known?.calls ?? 100) * perItem + p.aggregateMs
    } else if (r.stage === '분석') left = analysisLeftMs(r, nowMs, perItem, p)
    else if (r.stage === '집계') left = p.aggregateMs
    else if (r.stage === '리포트') left = Math.max(p.stageFloorMs, p.reportMs - spent)
    latest = Math.max(latest, left)
  }
  return nowMs + latest
}

// ───────────────────────────── 표시(카운트다운) ─────────────────────────────

/** 표시 상태 — 측정 하나 동안 이어진다. */
export interface EtaState {
  /** 지금 보이는 남은 시간(ms). null = 아직 숫자를 낸 적 없음. */
  shownMs: number | null
  /** shownMs를 계산한 시각. */
  atMs: number
  /** 1초에 몇 초씩 줄이나(minSpeed ~ maxSpeed). 새 어림 쪽으로 천천히 다가간다. */
  speed: number
  /** 마지막 어림의 끝날 시각(ms). */
  targetEndMs: number | null
  /** 숫자가 floorMs 밑으로 내려가 「마무리 중」을 보이는 중. */
  overdue: boolean
  /** 마지막으로 숫자를 올린 시각. */
  lastUpAtMs?: number
}

export type EtaView = { kind: 'none' } | { kind: 'number'; ms: number } | { kind: 'text'; text: string }

export function createEtaState(): EtaState {
  return { shownMs: null, atMs: 0, speed: 1, targetEndMs: null, overdue: false }
}

/** 표시 규칙 — 시뮬레이터로 고른 값. */
export const ETA_RULES = {
  /** 새 어림이 지금 숫자보다 이만큼 넘게 길면 숫자를 올린다: max(abs, 비율 × 지금 숫자). 그 아래면 줄어드는 속도만 늦춘다. */
  upAbsMs: 20_000,
  upRatio: 0.3,
  /** 새 어림이 이만큼 넘게 짧으면 바로 내린다. 그 아래면 줄어드는 속도만 높인다. */
  downAbsMs: 8_000,
  downRatio: 0.3,
  /** 차이를 이 시간에 걸쳐 메운다 — 카운트다운 속도를 minSpeed ~ maxSpeed배에서 바꾼다. 0.5배면 같은 숫자가 두 번 보일 뿐 멈추거나 오르지 않는다. */
  glideMs: 10_000,
  minSpeed: 0.5,
  maxSpeed: 2,
  /** 이 아래로 내려가면 숫자 대신 문구. */
  floorMs: 3_000,
  /** 「마무리 중」 중에 새 어림이 이만큼 넘으면 숫자로 돌아간다. */
  reviveMs: 20_000,
  overdueText: '마무리 중',
  /**
   * 숫자를 올린 뒤 이 시간 안에는 다시 올리지 않는다 — 느린 호출 하나를 기다리는 동안 톱니처럼 오르내리지 않게.
   * 30초로 두면 2026-W43 군산각 전국 1분 52초에 새 어림(약 1분 50초)을 막고 「약 1분 7초」에 붙들렸다(실제 약 2분).
   */
  upCooldownMs: 15_000,
}

/**
 * 1초 시계마다 부른다. endMs는 새 폴링 응답으로 어림한 시계에서만 넘긴다(estimateFinishAt 결과) — 그 밖에는 생략.
 * 표시는 카운트다운이다. 폴링 사이에는 숫자가 늘 줄어든다. 새 어림이 오면:
 *  - 지금 숫자보다 많이 길면(upAbsMs · upRatio) 그 값으로 올린다 — 느린 호출이 걸린 경우다. 측정 한 번에 1회 안팎이고,
 *    올린 뒤 upCooldownMs 안에는 다시 올리지 않는다(그동안은 0.5배속으로만 줄인다).
 *  - 많이 짧으면(downAbsMs · downRatio) 그 값으로 내린다.
 *  - 그 사이면 숫자는 그대로 두고 줄어드는 속도만 바꿔 glideMs 동안 새 어림에 맞춘다.
 *  - 숫자가 floorMs 밑으로 내려가면 「마무리 중」. 측정이 아직 안 끝났어도 0초나 음수를 보이지 않는다.
 *    새 어림이 reviveMs를 넘을 때만 숫자로 돌아간다(마지막 판정 한 건이 오래 걸리는 날).
 * endMs가 null(어림 불가)이면 이미 보이던 카운트다운은 그대로 이어 간다.
 */
export function stepEta(prev: EtaState, nowMs: number, endMs?: number | null): { state: EtaState; view: EtaView } {
  const R = ETA_RULES
  const s: EtaState = { ...prev }
  if (s.shownMs !== null) s.shownMs = Math.max(0, s.shownMs - s.speed * Math.max(0, nowMs - s.atMs))
  if (endMs !== undefined && endMs !== null) {
    s.targetEndMs = endMs
    const target = Math.max(0, endMs - nowMs)
    if (s.shownMs === null) {
      s.shownMs = target
      s.speed = 1
      s.overdue = target < R.floorMs
    } else if (s.overdue) {
      if (target >= R.reviveMs) {
        s.shownMs = target
        s.speed = 1
        s.overdue = false
      }
    } else {
      const v = s.shownMs
      const up = target > v + Math.max(R.upAbsMs, R.upRatio * v)
      const cooling = s.lastUpAtMs !== undefined && nowMs - s.lastUpAtMs < R.upCooldownMs
      if ((up && !cooling) || target < v - Math.max(R.downAbsMs, R.downRatio * v)) {
        if (up) s.lastUpAtMs = nowMs
        s.shownMs = target
        s.speed = 1
      } else {
        s.speed = Math.min(R.maxSpeed, Math.max(R.minSpeed, 1 + (v - target) / R.glideMs))
      }
    }
  } else if (s.targetEndMs !== null && s.shownMs !== null && !s.overdue) {
    // 폴링 사이: 목표를 따라잡으면 속도를 1로 돌린다(지나치지 않게).
    const target = Math.max(0, s.targetEndMs - nowMs)
    if ((s.speed > 1 && s.shownMs <= target) || (s.speed < 1 && s.shownMs >= target)) s.speed = 1
  }
  s.atMs = nowMs
  if (s.shownMs === null) return { state: s, view: { kind: 'none' } }
  if (s.overdue || s.shownMs < R.floorMs) {
    s.overdue = true
    return { state: s, view: { kind: 'text', text: R.overdueText } }
  }
  return { state: s, view: { kind: 'number', ms: s.shownMs } }
}

// ───────────────────────────── 화면 한 개의 상태 ─────────────────────────────

/** 화면 한 개가 측정 하나 동안 들고 다니는 상태 — 기억(어림)과 표시. 새 측정이면 createEtaTracker로 새로 만든다. */
export interface EtaTracker {
  memory: EstimateMemory
  display: EtaState
}

export function createEtaTracker(): EtaTracker {
  return { memory: {}, display: createEtaState() }
}

/**
 * 1초 시계 하나 — 순수 함수. fresh = 지난 시계 뒤로 새로 받은 폴링 응답(그때만 다시 어림한다), 없으면 null.
 * 폴링 사이에는 어림하지 않고 카운트다운만 한다 — 같은 서버 상태로 매초 다시 어림하면 경과만 늘어 숫자가 오르내린다.
 */
export function tickEta(tracker: EtaTracker, fresh: ProgressRow[] | null, nowMs: number, p: EstimateParams = ESTIMATE_PARAMS): { tracker: EtaTracker; view: EtaView } {
  let memory = tracker.memory
  let endMs: number | null | undefined
  if (fresh) {
    memory = rememberRows(memory, fresh)
    endMs = estimateFinishAt(fresh, nowMs, memory, p)
  }
  const r = stepEta(tracker.display, nowMs, endMs)
  return { tracker: { memory, display: r.state }, view: r.view }
}

// ───────────────────────────── 무엇을 기다리나 ─────────────────────────────

/** 기다리는 호출이 이만큼 오래되면 무엇을 기다리는지 함께 보인다 — 짧게 기다리는 끝자락마다 문구가 깜박이지 않게. */
const WAITING_NOTE_MIN_AGE_MS = 30_000

/** "3분 12초" · "45초". 시간 단위는 쓰지 않는다 — 측정은 분으로 세는 편이 읽기 쉽다. */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s ? `${m}분 ${s}초` : `${m}분`
}

/**
 * 수집 중인 줄이 모두 「보낼 호출은 다 보냈고 응답만 기다리는」 때, 무엇을 기다리는지 —
 * 「Perplexity 응답 5건 기다리는 중(가장 오래된 것 1분 22초째)」. 이때 남은 시간은 가장 늦은 응답 한 건이 정해 크게 흔들린다
 * (한 건이 168초 걸린 날이 있다). 숫자는 그대로 두고 까닭을 함께 보인다.
 * 그 밖에는 null — 아직 보낼 호출이 남았거나, 수집 중인 줄이 없거나, 새 필드가 없거나, 가장 오래 기다린 호출이 30초 안쪽일 때.
 * labels = 엔진 이름표(format.ts ENGINE_LABEL).
 */
export function waitingNote(active: ProgressRow[], nowMs: number, labels: Record<string, string> = {}): string | null {
  const collecting = active.filter((a) => a.stage === '수집')
  if (collecting.length === 0) return null
  const byEngine = new Map<string, number>()
  let oldest = Infinity
  for (const a of collecting) {
    for (const [engine, e] of Object.entries(a.engines ?? {})) {
      const sent = e.inflightSentAt
      if (!sent) return null
      if (e.total - e.done > sent.length) return null
      if (sent.length) byEngine.set(engine, (byEngine.get(engine) ?? 0) + sent.length)
      for (const t of sent) oldest = Math.min(oldest, t)
    }
  }
  if (byEngine.size === 0 || nowMs - oldest < WAITING_NOTE_MIN_AGE_MS) return null
  const list = [...byEngine].sort((a, b) => b[1] - a[1])
  const label = (e: string) => labels[e] ?? e
  const what =
    list.length === 1 ? `${label(list[0]![0])} 응답 ${list[0]![1]}건` : `${list.map(([e, n]) => `${label(e)} ${n}건`).join(' · ')} 응답`
  return `${what} 기다리는 중(가장 오래된 것 ${formatDuration(nowMs - oldest)}째)`
}
