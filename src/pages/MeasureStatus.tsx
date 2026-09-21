import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { measureStageLabel, type ActiveMeasure } from '../components/MeasureProgress'
import { Link } from 'react-router-dom'
import {
  cancelMeasureRun,
  loadCiSyncStatus,
  loadMeasureRuns,
  loadPricing,
  loadUsage,
  runCiSync,
  savePricing,
  type CiSyncSummary,
  type EnginePricing,
  type MeasureRunInfo,
  type UsageStats,
} from '../lib/api'
import { formatMoney, rowCost } from '../lib/engineCost'
import { ENGINE_LABEL, weekLabel } from '../lib/format'
import { BRAND_DOCS } from '../lib/brandDocs'
import { useTenant } from '../context/useTenant'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'
import measureLogRaw from '../data/measure-log.json'
import scorecardsRaw from '../data/demo-scorecards.json'

// best-effort — tenantId → 최신 스코어카드(주차·AEO). 성공 run의 주차·AEO 열에 붙인다.
interface ScRow {
  tenantId: string
  weekOf: string
  aeoScore: { current: number }
}
const latestByTenant: Record<string, { weekOf: string; aeo: number }> = {}
for (const c of scorecardsRaw as ScRow[]) {
  const prev = latestByTenant[c.tenantId]
  if (!prev || c.weekOf > prev.weekOf) latestByTenant[c.tenantId] = { weekOf: c.weekOf, aeo: c.aeoScore.current }
}
function runTenantId(title: string): string | null {
  const m = title.match(/^measure\s+(.+)$/)
  const id = m?.[1]?.trim()
  return !id || id === '__queue__' ? null : id
}

// 로컬 측정 기록(measure:local이 커밋). GitHub Actions 실행 목록과 별도로 표시한다.
interface LocalMeasureLog {
  tenantId: string
  brandName: string
  weekOf: string
  aeoScore: number
  at: string
  durationSec?: number
  source?: string
  engines?: string[]
}

// 엔진 코드 → 표시 라벨. 수집에 실제 성공한 엔진만 기록되므로, 예: ['gemini'] → "Gemini".
// ENGINE_LABEL은 src/lib/format.ts 것을 쓴다. 여기 사본이 따로 있었는데 mock('목(테스트)')이
// 빠져 있어, 목 엔진으로 돌린 측정이 이 화면에서만 'mock'으로 보였다.
function fmtEngines(engines?: string[]): string {
  if (!engines || engines.length === 0) return '-'
  return engines.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')
}
const localLog = measureLogRaw as LocalMeasureLog[]

// 초 → "N분 M초" / "N초"
function fmtSec(sec?: number): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-'
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

// GitHub Actions 실행 상태 → 한국어 배지 + B9에서 쓰는 status-pill 색상 클래스.
function statusBadge(run: MeasureRunInfo): { label: string; cls: string } {
  if (run.status !== 'completed') {
    if (run.status === 'in_progress') return { label: '진행 중', cls: 'st-warn' }
    return { label: '대기', cls: 'st-ok' }
  }
  switch (run.conclusion) {
    case 'success':
      return { label: '성공', cls: 'st-good' }
    case 'failure':
      return { label: '실패', cls: 'st-bad' }
    case 'cancelled':
      return { label: '취소', cls: 'st-unknown' }
    case 'skipped':
      return { label: '건너뜀', cls: 'st-unknown' }
    default:
      return { label: run.conclusion ?? '완료', cls: 'st-warn' }
  }
}

// run-name "measure <tenantId>"(소문자) → 대상 라벨. tenantId는 nameMap으로 실제 브랜드명으로 치환.
function targetLabel(title: string, nameMap: Record<string, string>): string {
  const m = title.match(/^measure\s+(.+)$/)
  if (!m) return title
  const id = m[1].trim()
  if (id === '__queue__') return '대기열 전체'
  return nameMap[id] || id // 삭제됐거나 미매칭이면 tenantId 그대로
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '-'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s}초 전`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}분 전`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.round(h / 24)}일 전`
}

function duration(run: MeasureRunInfo): string {
  const start = new Date(run.createdAt).getTime()
  const end = run.status === 'completed' ? new Date(run.updatedAt).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '-'
  const s = Math.max(0, Math.round((end - start) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}분 ${s % 60}초` : `${s}초`
}

/**
 * 이 브랜드의 실행 항목 요약 — 측정이 끝난 직후 "그래서 뭘 하지"에 바로 답한다.
 *
 * 예전에는 여기 손으로 적은 문서 링크 배열(brandDocs)이 있었다. 브랜드가 늘 때마다 사람이
 * 줄을 추가해야 했고, 실제로 k-wonjin 하나만 채워져 있었다. 지금은 저장된 측정에서 계산해
 * 모든 브랜드가 자동으로 목록을 갖는다.
 */
function ActionSummary() {
  const { tenant } = useTenant()
  const { plan, weekOf, loading, neverMeasured } = useGapActionPlan(tenant?.tenantId ?? '')
  if (!tenant) return null

  const open = plan.actions.filter(isOpenAction)
  return (
    <section style={{ marginTop: '8px' }}>
      <h3>실행 항목</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        측정이 찾아낸 격차를 할 일로 바꾼 목록입니다. <b>{tenant.brandName}</b>
        {weekOf && ` · ${weekOf}`} 기준이며, 저장된 측정에서 계산합니다.
      </p>
      {loading ? (
        <p className="muted">불러오는 중…</p>
      ) : plan.actions.length === 0 ? (
        <p className="muted">
          {neverMeasured ? '아직 측정된 적이 없습니다.' : '이 주차에 분석 데이터가 없습니다.'}
        </p>
      ) : (
        <>
          <ul className="doc-links">
            {open.slice(0, 4).map((a) => (
              <li key={a.id}>
                <Link to="/gap-actions">{a.title}</Link>
                <span className="doc-meta">
                  {a.badge} · 영향 {a.reach}
                  {a.questionTexts[0] && ` · ${a.questionTexts[0]}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">
            남은 {open.length}건 중 {Math.min(4, open.length)}건입니다 ·{' '}
            <Link to="/gap-actions">실행 항목 전체 보기</Link>
            {plan.satisfiedCount > 0 && ` (데이터가 충족을 확인한 항목 ${plan.satisfiedCount}건은 따로 표시됩니다)`}
          </p>
        </>
      )}
    </section>
  )
}

/**
 * CI 결과를 이 앱으로 끌어오는 버튼. 데스크톱에서만 의미가 있다(웹은 번들이 곧 CI 결과).
 *
 * 왜 여기 있나. GitHub Actions 실행 목록 바로 옆이다 — "CI가 측정했는데 앱에 왜 없지"가
 * 생기는 자리에서 바로 해결한다. 토큰이 없으면 무엇을 어디에 넣어야 하는지 그 자리에서 말한다.
 */
function CiSyncPanel({ onSynced }: { onSynced: () => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; repo: string } | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CiSyncSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void loadCiSyncStatus().then(setStatus)
  }, [])
  if (status === undefined || status === null) return null // 웹(라우트 없음)이거나 아직 모름

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await runCiSync()
      setResult(r)
      if (r.cardsAdded + r.analysesAdded + r.banksAdded > 0) onSynced()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ci-sync">
      {!status.enabled ? (
        <p className="muted" style={{ margin: 0 }}>
          CI 결과를 이 앱으로 가져오려면 <code>%APPDATA%\brand-aeo-app\.env</code>에{' '}
          <code>GH_MEASURE_TOKEN=…</code>(GitHub PAT, 이 저장소 <b>contents 읽기</b> 권한)을 한 줄 넣고 앱을 다시
          켜세요. 토큰은 이 PC 밖으로 나가지 않습니다.
        </p>
      ) : (
        <>
          <button type="button" onClick={() => void run()} disabled={busy}>
            {busy ? '가져오는 중…' : 'CI 결과 가져오기'}
          </button>
          <span className="doc-meta">
            {status.repo}의 <code>src/data</code>에서 이 앱에 <b>없는 주차만</b> 채웁니다. 이미 있는 주차는 덮지
            않습니다.
          </span>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="hint" style={{ marginBottom: 0 }}>
          {result.cardsAdded + result.analysesAdded + result.banksAdded === 0
            ? `새로 가져올 것이 없습니다 — 이미 있는 주차 ${result.skippedExisting}건은 건너뛰었습니다.`
            : `스코어카드 ${result.cardsAdded} · 분석 ${result.analysesAdded} · 질문 은행 ${result.banksAdded} 추가, 순위 ${result.ranksUpdated}건 재계산 (${result.tenantsTouched.join(', ')}). 이미 있던 주차 ${result.skippedExisting}건은 그대로 뒀습니다.`}
        </p>
      )}
    </div>
  )
}

export default function MeasureStatus() {
  const [runs, setRuns] = useState<MeasureRunInfo[]>([])
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /*
   * 엔진 사용량 — 크레딧이 어디로 갔는지. 측정 실행과 같은 화면에 두는 이유는, 돌리기 직전에
   * "지금까지 얼마나 썼는지"를 보는 자리가 여기이기 때문이다.
   * 자동 새로고침을 타지 않는다 — 측정 중에 초 단위로 바뀌는 값이 아니고, 파일을 훑는 조회라
   * 8초마다 부를 이유가 없다.
   */
  const [usage, setUsage] = useState<UsageStats | null>(null)
  /*
   * 단가는 서버 파일에서 읽는다(server/pricingStore.ts). 기본값이 없어서, 사용자가 넣기 전에는
   * 비용 칸이 "단가 미설정"으로 남는다 — 틀린 기본값으로 그럴듯한 금액을 보여 주지 않는다.
   */
  const [pricing, setPricing] = useState<EnginePricing | null>(null)
  const [priceOpen, setPriceOpen] = useState(false)
  const [priceNote, setPriceNote] = useState<string | null>(null)
  // 단가를 받을 엔진 목록은 **실제로 쓴 엔진**에서 뽑는다. 안 쓰는 엔진 칸을 만들어 두면
  // 설정해야 할 것처럼 보이고, 새 엔진을 쓰기 시작하면 코드를 고쳐야 한다.
  const pricedEngines = useMemo<string[]>(() => {
    const seen = new Set<string>()
    for (const w of usage?.weeks ?? []) {
      for (const e of w.byEngine) seen.add(e.engine)
      for (const e of w.judgeByEngine) seen.add(e.engine)
    }
    for (const id of Object.keys(pricing?.engines ?? {})) seen.add(id)
    const order = ['openai', 'gemini', 'claude', 'perplexity']
    return [...order.filter((e) => seen.has(e)), ...[...seen].filter((e) => !order.includes(e))]
  }, [usage, pricing])
  useEffect(() => {
    let alive = true
    void loadPricing().then((v) => {
      if (alive) setPricing(v)
    })
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    let alive = true
    void loadUsage(4).then((v) => {
      if (alive) setUsage(v)
    })
    return () => {
      alive = false
    }
  }, [])

  const [auto, setAuto] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [nameMap, setNameMap] = useState<Record<string, string>>({})
  const [cancelling, setCancelling] = useState<number | null>(null)
  // 이 앱이 직접 돌린 로컬 측정(진행 중 + 완료). /api/measure-status에서 폴링.
  const [localActive, setLocalActive] = useState<ActiveMeasure[]>([])
  const [localDone, setLocalDone] = useState<LocalMeasureLog[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    // GitHub Actions 실행 목록(배포 토큰 필요) — 실패해도 로컬 상태는 계속 본다.
    try {
      const data = await loadMeasureRuns()
      setEnabled(data.enabled)
      setRuns(data.runs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다.')
    }
    // 앱의 로컬 측정 상태(진행 중 + 완료)
    try {
      const r = await fetch('/api/measure-status')
      if (r.ok) {
        const d = (await r.json()) as {
          active?: ActiveMeasure[]
          completed?: LocalMeasureLog[]
        }
        setLocalActive(Array.isArray(d.active) ? d.active : [])
        setLocalDone(Array.isArray(d.completed) ? d.completed : [])
      }
    } catch {
      /* 로컬 상태 엔드포인트 없음(배포 등) — 무시 */
    }
    setUpdatedAt(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // tenantId → 브랜드명 매핑(GitHub 표 "대상"에 실제 이름 표시). 경쟁사 포함(all=1).
  useEffect(() => {
    let alive = true
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return
        const map: Record<string, string> = {}
        for (const t of list) if (t?.tenantId) map[t.tenantId] = t.brandName || t.tenantId
        setNameMap(map)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 진행 중인 실행이 있으면 자동 새로고침을 계속한다.
  useEffect(() => {
    if (!auto) {
      if (timer.current) window.clearInterval(timer.current)
      return
    }
    timer.current = window.setInterval(() => void load(), 8000)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [auto, load])

  // 진행 중 측정의 경과시간을 1초마다 갱신(리얼타임 표시).
  useEffect(() => {
    if (localActive.length === 0) return
    const t = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [localActive.length])

  const active = runs.some((r) => r.status !== 'completed') || localActive.length > 0

  // 로컬 완료 기록: 앱이 방금 돌린 것(API, userData) + 커밋된 CLI 기록(정적). tenantId+at로 중복 제거, 최신순.
  const localRows: LocalMeasureLog[] = (() => {
    const seen = new Set<string>()
    const all = [...localDone, ...localLog]
    const out: LocalMeasureLog[] = []
    for (const e of all) {
      const key = `${e.tenantId}-${e.at}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50)
  })()

  async function onCancel(run: MeasureRunInfo) {
    if (!run.id) return
    if (!window.confirm(`'${targetLabel(run.title, nameMap)}' 측정을 취소할까요?`)) return
    setCancelling(run.id)
    try {
      await cancelMeasureRun(run.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '취소 실패')
    } finally {
      setCancelling(null)
    }
  }

  return (
    <>
      <p className="brand">측정</p>
      <h1>측정 상태</h1>
      <p className="lead">
        이 앱에서 직접 실행한 측정을 먼저 보여주고, 그 아래에 GitHub Actions 측정 실행을 둡니다. 완료·배포 후 새로고침하면 결과가 반영됩니다.
      </p>

      <div className="filters no-print" style={{ alignItems: 'center' }}>
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          자동 새로고침(8초)
        </label>
        {updatedAt && <span className="hint">마지막 갱신 {updatedAt.toLocaleTimeString()}</span>}
        {active && <span className="status-pill st-warn">진행 중인 측정 있음</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <ActionSummary />

      {BRAND_DOCS.length > 0 && (
        <section style={{ marginTop: '8px' }}>
          <h3>직접 작성한 문서</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            측정에서 자동으로 나오지 않는 작업을 사람이 정리한 문서입니다(사이트 구조 감점 등).
            체크한 결과가 저장돼 다음에 열 때 이어서 볼 수 있습니다. <b>비공개 페이지</b>라 다른
            분에게 보낼 때는 공유가 필요합니다.
          </p>
          <ul className="doc-links">
            {BRAND_DOCS.map((doc) => (
              <li key={doc.url}>
                <a href={doc.url} target="_blank" rel="noopener noreferrer">
                  {doc.title} ↗
                </a>
                <span className="doc-meta">
                  {doc.brandName} · {doc.moves}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {usage && usage.weeks.length > 0 && (
        <section style={{ marginTop: '8px' }}>
          <h3>엔진 사용량</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            모든 브랜드를 합친 값입니다 — API 키를 브랜드마다 따로 쓰지 않으므로 크레딧이 왜 줄었는지는 전체를
            봐야 답이 나옵니다. <b>수집</b>은 엔진에 질문한 호출, <b>판정</b>은 그 답변을 읽고 언급·인용·순위·
            사실성을 가르는 호출입니다(답변 하나마다 2~4회).
          </p>
          <p className="hint">
            <b>비용은 계산하지 않습니다</b> — 모델 단가를 코드에 박으면 단가가 바뀐 뒤에도 그대로 거짓을 말하기
            때문입니다. 대신 <b>입력·출력을 나눠</b> 드립니다: 출력 토큰이 입력보다 몇 배 비싼데 비중이 엔진마다
            완전히 달라, 합계만으로는 환산조차 되지 않습니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>주차</th>
                  <th className="cell-text">구분</th>
                  <th className="cell-text">엔진</th>
                  <th className="num">호출</th>
                  <th className="num">입력</th>
                  <th className="num">출력</th>
                  <th className="num">호출당</th>
                  <th className="num">비용</th>
                  <th className="num">소요</th>
                </tr>
              </thead>
              <tbody>
                {usage.weeks.map((w) => {
                  const rows = [
                    ...w.byEngine.map((e) => ({ kind: '수집', e })),
                    ...w.judgeByEngine.map((e) => ({ kind: '판정', e })),
                  ]
                  return rows.map(({ kind, e }, i) => (
                    <tr key={`${w.weekOf}|${kind}|${e.engine}`}>
                      {i === 0 && (
                        <td className="cell-text" rowSpan={rows.length}>
                          {weekLabel(w.weekOf)}
                          <span className="sentence-meta" style={{ display: 'block' }}>
                            수집 {w.calls.toLocaleString()}회 · {w.tokens.toLocaleString()} 토큰
                          </span>
                          <span className="sentence-meta" style={{ display: 'block' }}>
                            {w.judgeCalls > 0
                              ? `판정 ${w.judgeCalls.toLocaleString()}회 · ${w.judgeTokens.toLocaleString()} 토큰`
                              : '판정 기록 없음'}
                          </span>
                        </td>
                      )}
                      <td className="cell-text">
                        <span className={`status-pill ${kind === '수집' ? 'st-info' : 'st-ok'}`}>{kind}</span>
                      </td>
                      <td className="cell-text">{ENGINE_LABEL[e.engine] ?? e.engine}</td>
                      <td className="num">{e.calls.toLocaleString()}</td>
                      {/* 분리 값이 없으면 합계만 있는 것이다 — 0으로 적지 않고 "—"로 둔다. */}
                      <td className="num">
                        {e.inputTokens > 0 ? e.inputTokens.toLocaleString() : <span className="muted">—</span>}
                      </td>
                      <td className="num">
                        {e.outputTokens > 0 ? e.outputTokens.toLocaleString() : <span className="muted">—</span>}
                      </td>
                      <td className="num">
                        {e.calls > 0 ? Math.round(e.tokens / e.calls).toLocaleString() : '—'}
                      </td>
                      {(() => {
                        const c = rowCost(e, pricing?.engines[e.engine])
                        if (c.reason === 'ok' && c.amount !== null) {
                          return (
                            <td className="num">
                              {formatMoney(c.amount, pricing?.currency ?? '')}
                              {/* 요청당 요금이 섞여 있으면 밝힌다 — 토큰만 보면 싸 보이는 엔진이 있다. */}
                              {c.requestPart !== null && c.requestPart > 0 && (
                                <span className="sentence-meta" style={{ display: 'block' }}>
                                  요청료 {formatMoney(c.requestPart, pricing?.currency ?? '')}
                                </span>
                              )}
                            </td>
                          )
                        }
                        return (
                          <td className="num muted" title={c.reason === 'noRate' ? '이 엔진의 단가가 설정되지 않았습니다' : '입력·출력이 기록되기 전에 측정한 주차라 계산할 수 없습니다'}>
                            —
                          </td>
                        )
                      })()}
                      <td className="num">{e.latencyMs > 0 ? `${(e.latencyMs / 60000).toFixed(0)}분` : '—'}</td>
                    </tr>
                  ))
                })}
              </tbody>
            </table>
          </div>
          {usage.weeks.some((w) => w.judgeCalls === 0) && (
            <p className="hint">
              ※ 판정 기록이 없는 주차가 있습니다 — 그 기능이 생기기 전에 측정한 데이터입니다. 없는 것을 0으로
              세면 「판정을 안 했다」가 되므로 비워 뒀습니다. 다음 측정부터 채워집니다.
            </p>
          )}
          {usage.weeks.some((w) => [...w.byEngine, ...w.judgeByEngine].some((e) => e.inputTokens === 0)) && (
            <p className="hint">
              ※ 입력·출력이 「—」인 줄은 그 값을 기록하기 전에 측정한 데이터입니다. 합계(호출당)는 그대로
              유효합니다.
            </p>
          )}
          <p className="hint">
            「호출당」이 크레딧이 어디로 가는지 말해 줍니다 — 호출 수가 적어도 이 값이 크면 비용은 그쪽이 큽니다.
            원문 {usage.filesRead}개 파일에서 집계했습니다.
          </p>

          {/*
            단가 편집기. 코드에 박지 않고 여기서 받는 이유는, 박아 두면 벤더가 가격을 바꾼 뒤에도
            화면이 그대로 거짓을 말하기 때문이다. 기본값도 두지 않는다 — 비어 있으면 "미설정"이
            보이는 편이 틀린 기본값으로 그럴듯한 금액을 보여 주는 것보다 낫다.
          */}
          <button type="button" className="gap-more-toggle" onClick={() => setPriceOpen((v) => !v)}>
            {priceOpen ? '▾' : '▸'} 단가 설정
            {pricing?.updatedAt ? ` · 마지막 수정 ${pricing.updatedAt}` : ' · 아직 설정하지 않았습니다'}
          </button>
          {priceOpen && (
            <div className="pricing-editor">
              <p className="hint" style={{ marginTop: 0 }}>
                100만 토큰당 가격을 넣으세요. <b>요청당</b>은 토큰과 별개로 호출마다 붙는 고정 요금입니다(웹검색
                수수료 등) — 없으면 비워 두세요. 통화는 표시용 꼬리표일 뿐이며 <b>환율 환산은 하지 않습니다</b>.
                넣으신 통화 그대로 계산합니다.
              </p>
              <label className="field" style={{ maxWidth: 200 }}>
                <span>통화 표기</span>
                <input
                  type="text"
                  value={pricing?.currency ?? 'USD'}
                  onChange={(e) =>
                    setPricing((p) => ({ currency: e.target.value, updatedAt: p?.updatedAt ?? '', engines: p?.engines ?? {} }))
                  }
                />
              </label>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="cell-text">엔진</th>
                      <th className="cell-text">모델 메모</th>
                      <th className="num">입력 / 1M</th>
                      <th className="num">출력 / 1M</th>
                      <th className="num">요청당</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricedEngines.map((id) => {
                      const rate = pricing?.engines[id] ?? {}
                      const set = (patch: Partial<typeof rate>) =>
                        setPricing((p) => ({
                          currency: p?.currency ?? 'USD',
                          updatedAt: p?.updatedAt ?? '',
                          engines: { ...(p?.engines ?? {}), [id]: { ...rate, ...patch } },
                        }))
                      const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
                      return (
                        <tr key={id}>
                          <td className="cell-text">{ENGINE_LABEL[id] ?? id}</td>
                          <td className="cell-text">
                            <input
                              type="text"
                              placeholder="예: gpt-4o"
                              value={rate.model ?? ''}
                              onChange={(e) => set({ model: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={rate.inputPerM ?? ''}
                              onChange={(e) => set({ inputPerM: num(e.target.value) })}
                            />
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={rate.outputPerM ?? ''}
                              onChange={(e) => set({ outputPerM: num(e.target.value) })}
                            />
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              min="0"
                              step="0.001"
                              value={rate.perRequest ?? ''}
                              onChange={(e) => set({ perRequest: num(e.target.value) })}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="filters" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    if (!pricing) return
                    setPriceNote('저장 중…')
                    void savePricing(pricing).then((r) => {
                      if ('error' in r) {
                        setPriceNote(`저장 실패 — ${r.error}`)
                        return
                      }
                      setPricing(r)
                      setPriceNote(`저장했습니다 (${r.updatedAt})`)
                    })
                  }}
                >
                  단가 저장
                </button>
                {priceNote && <span className="hint">{priceNote}</span>}
              </div>
              <p className="hint">
                ※ 단가는 벤더 콘솔에서 확인해 넣으세요. 저희가 기본값을 채워 드리지 않는 것은, 가격이 바뀐 뒤에도
                화면이 그대로 거짓을 말하게 되기 때문입니다.
              </p>
            </div>
          )}
        </section>
      )}

      {(localActive.length > 0 || localRows.length > 0) && (
        <section style={{ marginTop: '8px' }}>
          <h3>로컬 측정 (이 앱)</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            이 앱에서 직접 실행한 측정입니다(진행 중은 실시간, 완료는 이 PC에 기록). CLI(<code>measure:local</code>)로 커밋한 기록도 함께 표시됩니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>대상</th>
                  <th>측정 엔진</th>
                  <th>주차</th>
                  <th>AEO</th>
                  <th>측정시간</th>
                  <th>경과</th>
                </tr>
              </thead>
              <tbody>
                {localActive.map((a) => (
                  <tr key={`active-${a.tenantId}`}>
                    <td>
                      <span className="status-pill st-warn">진행 중</span>
                    </td>
                    <td>{a.brandName || a.tenantId}</td>
                    {/* 서버가 단계·건수를 준다. 여기가 "측정 중…"에 머무르면 전용 화면이
                        온보딩보다 덜 보여 주는 역전이 된다. */}
                    <td className="muted">{measureStageLabel(a)}</td>
                    <td>-</td>
                    <td className="num">-</td>
                    <td className="num">{fmtSec(Math.max(0, (nowMs - new Date(a.startedAt).getTime()) / 1000))}</td>
                    <td>{timeAgo(a.startedAt)} 시작</td>
                  </tr>
                ))}
                {localRows.map((e, i) => (
                  <tr key={`${e.tenantId}-${e.at}-${i}`}>
                    <td>
                      <span className="status-pill st-good">로컬 완료</span>
                    </td>
                    <td>{e.brandName || e.tenantId}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtEngines(e.engines)}</td>
                    <td>{e.weekOf}</td>
                    <td className="num">{e.aeoScore}</td>
                    <td className="num">{fmtSec(e.durationSec)}</td>
                    <td>{timeAgo(e.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section style={{ marginTop: '24px' }}>
        <h3>GitHub Actions 측정 실행</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          주차·AEO는 성공 run에 한해 해당 브랜드의 <b>최신 스코어카드</b>를 붙인 best-effort 값입니다(실패·미매칭은 <code>-</code>).
        </p>
        <CiSyncPanel onSynced={() => window.location.reload()} />
        {!enabled ? (
          <p className="muted">
            배포 환경에서 <code>GH_MEASURE_TOKEN</code>이 설정되어야 실행 상태를 볼 수 있습니다. 아래 로컬 측정 기록은 토큰 없이도 보입니다.
          </p>
        ) : !loading && runs.length === 0 ? (
          <p className="muted">
            최근 GitHub Actions 실행이 없습니다. <Link to="/measure-tenant">테넌트 골라 측정</Link>에서 시작하거나, 로컬에서{' '}
            <code>npm run measure:local</code>을 쓰세요.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th>대상</th>
                  <th>주차</th>
                  <th>AEO</th>
                  <th>측정시간</th>
                  <th>경과</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const badge = statusBadge(run)
                  const id = runTenantId(run.title)
                  const sc = run.conclusion === 'success' && id ? latestByTenant[id] : undefined
                  return (
                    <tr key={run.runNumber}>
                      <td>
                        <span className={`status-pill ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td>{targetLabel(run.title, nameMap)}</td>
                      <td>{sc?.weekOf ?? '-'}</td>
                      <td className="num">{sc?.aeo ?? '-'}</td>
                      <td className="num">{duration(run)}</td>
                      <td>{timeAgo(run.createdAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {run.status !== 'completed' && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void onCancel(run)}
                            disabled={cancelling === run.id}
                            style={{ marginRight: '8px' }}
                          >
                            {cancelling === run.id ? '취소 중…' : '취소'}
                          </button>
                        )}
                        <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="rec-link">
                          로그 →
                        </a>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
