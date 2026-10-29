import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MeasureProgress from '../components/MeasureProgress'
import { Link, useNavigate } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
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
import { costPartText, costTotalText, formatMoney, mergeCost, rowCost, sumCost } from '../lib/engineCost'
import { ENGINE_LABEL, weekLabel } from '../lib/format'
import { BRAND_DOCS } from '../lib/brandDocs'
import { brandLabel, type VariantBrand } from '../lib/brandVariant'
import { failureReason, useMeasureStatus } from '../lib/measureStatus'
import { durationText, groupMeasureRuns, type LocalRun, type RunGroup } from '../lib/measureRuns'
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

// 엔진 코드 → 표시 라벨. 수집에 실제 성공한 엔진만 기록되므로, 예: ['gemini'] → "Gemini".
// ENGINE_LABEL은 src/lib/format.ts 것을 쓴다. 여기 사본이 따로 있었는데 mock('목(테스트)')이
// 빠져 있어, 목 엔진으로 돌린 측정이 이 화면에서만 'mock'으로 보였다.
function fmtEngines(engines?: string[]): string {
  if (!engines || engines.length === 0) return '-'
  return engines.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')
}
// 로컬 측정 기록(measure:local이 커밋) — 이 앱이 남긴 기록(/api/measure-status completed)과 합쳐 측정 1회로 묶는다.
const localLog = measureLogRaw as LocalRun[]

/** 「비용」 접기 상태 — 이 PC에 기억(처음에는 접힘). */
const COST_OPEN_KEY = 'measureStatus.costOpen'
function readCostOpen(): boolean {
  try {
    return localStorage.getItem(COST_OPEN_KEY) === '1'
  } catch {
    return false // 못 읽으면 접힌 채로
  }
}
function writeCostOpen(open: boolean) {
  try {
    localStorage.setItem(COST_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* 기억 못 해도 지금 화면은 그대로 */
  }
}
const GROUP_PAGE = 10

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
  const navigate = useNavigate()
  const { setTenantId } = useTenant()
  // 이 앱의 로컬 측정(진행 중 · 최근 실패 · 완료 기록) — 사이드바 · 결과 띠와 같은 공용 저장소(lib/measureStatus.ts).
  const status = useMeasureStatus()
  const [runs, setRuns] = useState<MeasureRunInfo[]>([])
  const [enabled, setEnabled] = useState(true)
  // 원격 측정 실행 목록을 한 번이라도 받았는가 — 데스크톱은 받기 전에 원격 칸을 그리지 않는다(토큰 없는 PC에서 칸이 잠깐 보였다 — 1-C 검토).
  const [runsKnown, setRunsKnown] = useState(false)
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
  /*
   * 한 번도 설정하지 않았으면 펼쳐서 시작한다.
   *
   * 접힌 회색 한 줄로 두었더니 처음 쓰는 사람이 못 찾았다 — 평소에 안 보이게 하려던 것이
   * 정작 설정해야 할 때 숨긴 셈이 됐다. 저장한 뒤부터는 접힌다(updatedAt이 생긴다).
   * null로 두는 이유는 단가를 아직 못 읽었을 때 "설정 없음"으로 단정하지 않기 위해서다.
   */
  const [priceOpen, setPriceOpen] = useState<boolean | null>(null)
  const priceExpanded = priceOpen ?? (pricing !== null && !pricing.updatedAt)
  const [priceNote, setPriceNote] = useState<string | null>(null)
  // 아직 아무것도 못 읽었을 때의 바탕값. 편집 중에는 항상 이전 상태를 펼쳐 이어받는다.
  const emptyPricing: EnginePricing = { currency: 'USD', updatedAt: '', engines: {} }
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
  // 경쟁사(비교용 브랜드) — 완료 기록을 측정 1회로 묶을 때 고객 브랜드와 가른다.
  const [competitorIds, setCompetitorIds] = useState<Set<string>>(() => new Set())
  const [cancelling, setCancelling] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  const [groupLimit, setGroupLimit] = useState(GROUP_PAGE)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [costOpen, setCostOpen] = useState(readCostOpen)

  // GitHub Actions 실행 목록(배포 토큰 필요). 로컬 측정 상태는 공용 저장소가 따로 읽는다.
  const load = useCallback(async () => {
    try {
      const data = await loadMeasureRuns()
      setEnabled(data.enabled)
      setRunsKnown(true)
      setRuns(data.runs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다.')
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
        // 범위만 다르게 등록한 같은 이름의 브랜드(군산각 지역형 · 전국형)는 꼬리표로 가른다(상용화 UI 3차 U7).
        const brands = list.filter((t): t is VariantBrand & { brandName: string } => Boolean(t?.tenantId && Array.isArray(t.ownedDomains)))
        const map: Record<string, string> = {}
        for (const t of list) if (t?.tenantId) map[t.tenantId] = t.brandName || t.tenantId
        for (const t of brands) if (t.brandName) map[t.tenantId] = brandLabel(t, brands)
        setNameMap(map)
        setCompetitorIds(new Set(list.filter((t: { tenantId?: string; cohortOnly?: boolean }) => t?.tenantId && t.cohortOnly).map((t: { tenantId: string }) => t.tenantId)))
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

  const localActive = status.active
  const localFailed = status.failed
  const active = runs.some((r) => r.status !== 'completed') || localActive.length > 0

  // 로컬 완료 기록: 앱이 방금 돌린 것(API, userData) + 커밋된 CLI 기록(정적). tenantId+at로 중복 제거한 뒤 측정 1회씩 묶는다.
  const groups: RunGroup[] = useMemo(() => {
    const seen = new Set<string>()
    const rows: LocalRun[] = []
    for (const e of [...status.completed, ...localLog]) {
      const key = `${e.tenantId}-${e.at}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(e)
    }
    return groupMeasureRuns(rows, (id) => competitorIds.has(id))
  }, [status.completed, competitorIds])
  const nameOf = (r: { tenantId: string; brandName: string }) => nameMap[r.tenantId] || r.brandName || r.tenantId
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  /** 실패 줄의 「다시 측정」 — 측정 화면에서 그 브랜드를 고른 채 연다(바로 재지 않는다). 경쟁사면 사이드바를 바꾸지 않는다. */
  const remeasure = (tenantId: string) => {
    if (!competitorIds.has(tenantId)) setTenantId(tenantId)
    navigate('/measure-tenant', { state: { pick: tenantId } })
  }

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

  /*
   * 데스크톱 앱에서는 원격 측정(GitHub Actions) 칸을 토큰이 있을 때만 보인다 — 토큰 없는 PC에서 「GH_MEASURE_TOKEN을 넣으세요」 · 「npm
   * run」 같은 개발 안내가 운영자 화면에 남아 있었다(상용화 UI 3차 U4). 웹 · 개발 환경은 예전처럼 늘 보인다.
   */
  const isDesktop = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)
  const showRemote = !isDesktop || (runsKnown && enabled)

  // 접힌 「비용」 줄 — 가장 최근 주차의 비용 한 줄. 단가를 한 번도 넣지 않았으면 그것부터 알린다.
  const latestWeek = usage?.weeks.reduce<UsageStats['weeks'][number] | null>((a, w) => (!a || w.weekOf > a.weekOf ? w : a), null) ?? null
  const latestTotal = latestWeek
    ? costTotalText(mergeCost(sumCost(latestWeek.byEngine, pricing?.engines), sumCost(latestWeek.judgeByEngine, pricing?.engines)), pricing?.currency ?? '')
    : null
  const costSummary =
    pricing !== null && !pricing.updatedAt
      ? '엔진 사용량 · 비용 — 단가를 아직 넣지 않았습니다(펼쳐서 넣으세요)'
      : `엔진 사용량 · 비용${latestWeek ? ` — ${weekLabel(latestWeek.weekOf)} ${latestTotal ?? '비용 기록 없음'}` : ''}`

  return (
    <>
      <p className="brand">측정</p>
      <h1>측정 상태</h1>
      <p className="lead">
        {isDesktop
          ? `진행 중인 측정과 최근 결과입니다. 측정이 끝나면 바로 화면에 반영됩니다.${showRemote ? ' 원격 측정(GitHub Actions) 기록은 맨 아래에 있습니다.' : ''}`
          : '이 앱에서 직접 실행한 측정을 먼저 보여주고, 그 아래에 GitHub Actions 측정 실행을 둡니다. 완료·배포 후 새로고침하면 결과가 반영됩니다.'}
      </p>

      <div className="filters no-print" style={{ alignItems: 'center' }}>
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        {showRemote && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            원격 측정 자동 새로고침(8초)
          </label>
        )}
        {updatedAt && <span className="hint">마지막 갱신 {updatedAt.toLocaleTimeString()}</span>}
        {active && <span className="status-pill st-warn">진행 중인 측정 있음</span>}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {/* 이 PC(앱 서버)에서 돈 측정 — 서버가 측정 상태를 주지 않는 곳(웹 배포)에서는 원격 측정 칸만 본다. */}
      {status.ok && (
        <section className="ms-section" aria-labelledby="ms-active">
          <h3 id="ms-active">진행 중</h3>
          {localActive.length > 0 ? (
            <MeasureProgress active={localActive} nameOf={(a) => nameMap[a.tenantId] || a.brandName} />
          ) : (
            <p className="muted">
              이 PC에서 진행 중인 측정이 없습니다 · <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>
            </p>
          )}
        </section>
      )}

      {localFailed.length > 0 && (
        <section className="ms-section" aria-labelledby="ms-failed">
          <h3 id="ms-failed">최근 실패</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            보고서를 보내기 전에 다시 측정하세요. 같은 브랜드를 다시 재서 성공하면 이 줄은 사라집니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="cell-text">브랜드</th>
                  <th className="cell-text">이유</th>
                  <th>언제</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {localFailed.map((f) => (
                  <tr key={`failed-${f.tenantId}-${f.at}`}>
                    <td className="cell-text">
                      {nameOf(f)}
                      {competitorIds.has(f.tenantId) && <span className="bsw-tag">경쟁사</span>}
                    </td>
                    {/* 끊긴 엔진(「Gemini 지출 한도 초과」)이 있으면 그 이름, 없으면 오류 첫 문장 — 전체 문구는 제목 풍선에. */}
                    <td className="cell-text" title={f.error}>
                      {failureReason(f)}
                    </td>
                    <td>{timeAgo(f.at)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button type="button" className="ghost" onClick={() => remeasure(f.tenantId)}>
                        {competitorIds.has(f.tenantId) ? '이 경쟁사만 다시 측정' : '다시 측정'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {groups.length > 0 && (
        <section className="ms-section" aria-labelledby="ms-done">
          <h3 id="ms-done">최근 완료</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            측정 1회가 1줄입니다 — 경쟁사를 함께 잰 측정은 브랜드 칸을 눌러 펼칩니다. 걸린 시간은 처음 시작부터 마지막 경쟁사가 끝날 때까지입니다.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상태</th>
                  <th className="cell-text">브랜드</th>
                  <th className="cell-text">측정 엔진</th>
                  <th>주차</th>
                  <th>Brand AEO</th>
                  <th>걸린 시간</th>
                  <th>언제</th>
                </tr>
              </thead>
              <tbody>
                {groups.slice(0, groupLimit).flatMap((g) => {
                  const open = openGroups.has(g.key)
                  const pill = (r: LocalRun) =>
                    r.weekCardKept ? (
                      // 엔진이 빠져 그 주 카드를 덮지 않은 회차 — 대시보드 점수와 다른 까닭을 제목 풍선에.
                      <span className="status-pill st-warn" title={`${r.weekCardKept}. 이 점수는 회차 기록에만 남았습니다.`}>
                        카드 유지
                      </span>
                    ) : (
                      <span className="status-pill st-good">완료</span>
                    )
                  const competitorTag = (r: LocalRun) => competitorIds.has(r.tenantId) && <span className="bsw-tag">경쟁사</span>
                  const rows = [
                    <tr key={g.key}>
                      <td>{pill(g.root)}</td>
                      <td className="cell-text">
                        {g.children.length > 0 ? (
                          <button type="button" className="ms-run-toggle" aria-expanded={open} onClick={() => toggleGroup(g.key)}>
                            {nameOf(g.root)} · 경쟁사 {g.children.length}곳 {open ? '▾' : '▸'}
                          </button>
                        ) : (
                          <>
                            {nameOf(g.root)}
                            {competitorTag(g.root)}
                          </>
                        )}
                      </td>
                      <td className="cell-text" style={{ whiteSpace: 'nowrap' }}>
                        {fmtEngines(g.root.engines)}
                      </td>
                      <td>{g.root.weekOf}</td>
                      <td className="num">{g.root.aeoScore}</td>
                      <td className="num">{g.children.length > 0 || g.root.durationSec !== undefined ? durationText(g.durationSec) : '-'}</td>
                      <td>{timeAgo(new Date(g.endedAt).toISOString())}</td>
                    </tr>,
                  ]
                  if (open) {
                    for (const c of g.children) {
                      rows.push(
                        <tr key={`${g.key}|${c.tenantId}|${c.at}`} className="ms-run-child">
                          <td>{pill(c)}</td>
                          <td className="cell-text">
                            {nameOf(c)}
                            {competitorTag(c)}
                          </td>
                          <td className="cell-text" style={{ whiteSpace: 'nowrap' }}>
                            {fmtEngines(c.engines)}
                          </td>
                          <td>{c.weekOf}</td>
                          <td className="num">{c.aeoScore}</td>
                          <td className="num">{c.durationSec !== undefined ? durationText(c.durationSec) : '-'}</td>
                          <td>{timeAgo(c.at)}</td>
                        </tr>,
                      )
                    }
                  }
                  return rows
                })}
              </tbody>
            </table>
          </div>
          {groups.length > groupLimit && (
            <button type="button" className="ghost" onClick={() => setGroupLimit((n) => n + GROUP_PAGE)}>
              {Math.min(GROUP_PAGE, groups.length - groupLimit)}개 더 보기
            </button>
          )}
        </section>
      )}

      {!isDesktop && BRAND_DOCS.length > 0 && (
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
        <details
          className="ms-fold"
          open={costOpen}
          onToggle={(e) => {
            const open = e.currentTarget.open
            setCostOpen(open)
            writeCostOpen(open)
          }}
        >
          <summary>{costSummary}</summary>
          <h3>엔진 사용량</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            모든 브랜드를 합친 값입니다 — API 키를 브랜드마다 따로 쓰지 않으므로 크레딧이 왜 줄었는지는 전체를
            봐야 답이 나옵니다. <b>수집</b>은 엔진에 질문한 호출, <b>판정</b>은 그 답변을 읽고 언급·인용·순위·
            사실성을 가르는 호출입니다(답변 하나마다 2~4회).
          </p>
          <p className="hint">
            <b>비용</b>은 아래 「단가 설정」에 넣은 값으로 계산합니다(코드에 박힌 단가는 없습니다). 엔진이 실제
            청구액을 알려 주면(Perplexity) 그 값을 씁니다. <b>검색 요금</b>은 웹검색을 쓴 호출에만, 그달 무료 한도를
            넘은 몫에만 붙습니다 — 판정 호출은 검색하지 않아 토큰 요금만 듭니다.
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
                          {(() => {
                            const collect = sumCost(w.byEngine, pricing?.engines)
                            const judge = sumCost(w.judgeByEngine, pricing?.engines)
                            const cur = pricing?.currency ?? ''
                            // 계산한 줄이 하나도 없고 까닭도 없으면 줄을 그리지 않는다 — 0으로 보이면 "공짜"가 된다. 「+」 대신 「이상 — 까닭」.
                            const total = costTotalText(mergeCost(collect, judge), cur)
                            if (total === null) return null
                            return (
                              <span className="sentence-meta" style={{ display: 'block' }}>
                                {total}
                                {/* 판정 기록이 없는 주차에 "판정 0"이라 적으면 판정을 공짜로 한 것처럼 읽힌다. */}
                                {` (수집 ${costPartText(collect, cur)} · 판정 ${w.judgeByEngine.length > 0 ? costPartText(judge, cur) : '기록 없음'})`}
                              </span>
                            )
                          })()}
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
                        if ((c.reason === 'ok' || c.reason === 'billed') && c.amount !== null) {
                          return (
                            <td className="num">
                              {formatMoney(c.amount, pricing?.currency ?? '')}
                              {/* 검색 요금이 섞여 있으면 밝힌다 — 토큰만 보면 싸 보이는 엔진이 있다. */}
                              {c.requestPart !== null && c.requestPart > 0 && (
                                <span className="sentence-meta" style={{ display: 'block' }}>
                                  검색료 {formatMoney(c.requestPart, pricing?.currency ?? '')}
                                </span>
                              )}
                              {/* 검색이 있었으면 몇 번이 무료 한도로 빠졌는지 밝힌다 — 검색료가 0인 이유가 보여야 한다. */}
                              {c.searches > 0 && (
                                <span className="sentence-meta" style={{ display: 'block' }}>
                                  검색 {c.searches.toLocaleString()}회
                                  {c.freeSearches > 0 ? ` · 무료 한도 ${c.freeSearches.toLocaleString()}회` : ''}
                                </span>
                              )}
                              {/* 엔진이 청구액을 직접 준 경우 — 단가 추정이 아님을 밝힌다. */}
                              {c.reason === 'billed' && (
                                <span className="sentence-meta" style={{ display: 'block' }}>
                                  엔진이 알려 준 실제 청구액
                                </span>
                              )}
                            </td>
                          )
                        }
                        return (
                          <td className="num muted" title={c.reason === 'noRate' ? '이 엔진의 단가가 설정되지 않았습니다' : '입력·출력이 기록되기 전에 측정한 주차라 계산할 수 없습니다'}>
                            {c.reason === 'noRate' ? '단가 미설정' : '기록 없음'}
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
          <button type="button" className="gap-more-toggle" onClick={() => setPriceOpen(!priceExpanded)}>
            {priceExpanded ? '▾' : '▸'} 단가 설정
            {pricing?.updatedAt ? ` · 마지막 수정 ${pricing.updatedAt}` : ' · 아직 설정하지 않았습니다'}
          </button>
          {priceExpanded && (
            <div className="pricing-editor">
              <p className="hint" style={{ marginTop: 0 }}>
                100만 토큰당 가격을 넣으세요. <b>출력</b>에는 생각 토큰도 들어갑니다(Gemini는 생각 토큰을 출력 단가로 청구합니다). <b>검색 1회당</b>은 토큰과 별개로 웹검색을 쓴 호출마다 붙는 요금이고,
                <b>월 무료 검색</b>은 달마다 그 요금이 붙지 않는 건수입니다(Gemini 검색 그라운딩은 월 5,000건) — 없으면
                비워 두세요. 통화는 표시용 꼬리표일 뿐이며 <b>환율 환산은 하지 않습니다</b>. 넣으신 통화 그대로
                계산합니다.
              </p>
              <label className="field" style={{ maxWidth: 200 }}>
                <span>통화 표기</span>
                <input
                  type="text"
                  value={pricing?.currency ?? 'USD'}
                  onChange={(e) =>
                    // ...p로 이전 상태를 이어받는다. 필드를 일일이 옮겨 적으면 빠뜨린 것이
                    // 조용히 사라진다 — currentModels가 그렇게 지워져 모델 안내가 없어졌다.
                    setPricing((p) => ({ ...emptyPricing, ...p, currency: e.target.value }))
                  }
                />
              </label>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {/*
                        입력 상자가 칸 전체를 채우므로 머리글도 그 상자 가운데에 선다.
                        표 기본 규칙은 칸 위치로 정렬을 정해(오른쪽) 넓은 상자 옆에 머리글만
                        끝으로 밀려 짝이 안 맞아 보였다. 엔진 열만 글자 칸이라 왼쪽 그대로 둔다.
                      */}
                      <th className="cell-text">엔진</th>
                      <th className="cell-mid">모델 메모</th>
                      <th className="cell-mid">입력 / 1M</th>
                      <th className="cell-mid">출력 / 1M</th>
                      <th className="cell-mid">검색 1회당</th>
                      <th className="cell-mid">월 무료 검색</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricedEngines.map((id) => {
                      const rate = pricing?.engines[id] ?? {}
                      const set = (patch: Partial<typeof rate>) =>
                        setPricing((p) => ({
                          ...emptyPricing,
                          ...p,
                          engines: { ...(p?.engines ?? {}), [id]: { ...rate, ...patch } },
                        }))
                      const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
                      return (
                        <tr key={id}>
                          <td className="cell-text">{ENGINE_LABEL[id] ?? id}</td>
                          <td className="cell-text">
                            <input
                              type="text"
                              /* 안내는 **측정에 쓰는 설정값 그대로**다(측정 기록에 남는 값과 같다).
                                 Perplexity는 모델이 아니라 프리셋이라 preset:low로 나온다 — 실제 모델은
                                 Perplexity가 고르고 바뀔 수 있어 우리가 고정할 수 있는 이름이 프리셋이다. */
                              placeholder={pricing?.currentModels?.[id] ?? '모델 이름'}
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
                          <td className="num">
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={rate.freeRequestsPerMonth ?? ''}
                              onChange={(e) => set({ freeRequestsPerMonth: num(e.target.value) })}
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
                    /*
                     * 저장하면 updatedAt이 생겨 자동 펼침 조건이 꺼진다. 그대로 두면 누르는
                     * 순간 패널이 닫혀 "저장했습니다" 확인을 못 본다 — 자동 펼침은 처음 열 때만
                     * 정하는 것이지, 저장에 반응해 닫는 장치가 아니다. 명시적으로 열어 둔다.
                     */
                    setPriceOpen(true)
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
              <p className="hint">
                ※ 검색 요금은 <b>검색한 호출 1회를 1건</b>으로 셉니다. 한 호출이 검색어를 여러 개 쓰면 실제 청구가 더
                클 수 있습니다. 월 무료 한도는 이 앱에 있는 측정만 세므로, 같은 키를 다른 곳에서도 쓰면 한도가 더
                빨리 찹니다. 판정 줄은 수집과 같은 엔진 단가로 계산합니다(판정 모델이 수집 모델과 다르면 맞지 않습니다).
              </p>
              <p className="hint">
                ※ 「모델 메모」의 흐린 글씨는 <b>지금 측정에 쓰는 설정</b>(요청하는 모델 이름)입니다. Gemini 측정
                기록에는 실제로 답한 모델과 생각 수준이 남아 이 이름과 다를 수 있습니다
                (예: gemini-3.7-flash → gemini-3.8-flash (thinking low))
                {pricing?.currentModels &&
                  ` (${pricedEngines
                    .map((id) => `${ENGINE_LABEL[id] ?? id} ${pricing.currentModels?.[id] ?? '?'}`)
                    .join(' · ')})`}
                .
              </p>
              <p className="hint">
                ※ <b>Perplexity는 모델이 아니라 프리셋</b>을 씁니다(<code>preset:low</code>). 2026년 9월 27일
                종료된 <code>sonar-pro</code>의 공식 후속이며, 실제로 어떤 모델을 쓸지는 Perplexity가 고르고
                바뀔 수 있어 우리가 고정할 수 있는 이름이 프리셋입니다. 그래서 기록에도 프리셋으로 남깁니다 —
                Perplexity가 내부 모델을 바꿀 때마다 주차 비교가 막히면 안 되기 때문입니다.
              </p>
              <p className="hint">
                ※ 설정은 이 화면에서 바꿀 수 없고 환경변수로만 바뀝니다. 바꾸면 그 사실이 측정 데이터에
                기록되고, 바뀐 뒤 첫 측정은 직전 측정과 증감을 견주지 않고 모델이 바뀌었다고 적습니다.
              </p>
            </div>
          )}
        </details>
      )}

      {showRemote && (
      <section style={{ marginTop: '24px' }}>
        <h3>원격 측정 실행(GitHub Actions)</h3>
        <p className="hint" style={{ marginTop: 0 }}>
          주차 · AEO는 성공한 실행에 한해 그 브랜드의 <b>최신 스코어카드</b>를 붙인 참고값입니다(실패 · 맞는 기록이 없으면 <code>-</code>).
        </p>
        <CiSyncPanel onSynced={() => window.location.reload()} />
        {!enabled ? (
          <p className="muted">
            배포 환경에서 <code>GH_MEASURE_TOKEN</code>이 설정되어야 실행 상태를 볼 수 있습니다. 아래 로컬 측정 기록은 토큰 없이도 보입니다.
          </p>
        ) : !loading && runs.length === 0 ? (
          <p className="muted">
            최근 원격 측정 실행이 없습니다. <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 시작하세요.
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
      )}
    </>
  )
}
