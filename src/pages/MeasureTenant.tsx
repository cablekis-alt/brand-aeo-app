import { useEffect, useMemo, useRef, useState } from 'react'
import MeasureProgress, { type ActiveMeasure } from '../components/MeasureProgress'
import { Link } from 'react-router-dom'
import ApiKeySettings from '../components/ApiKeySettings'
import BrandPickerPanel, { type PickerRow } from '../components/BrandPickerPanel'
import NavIcon from '../components/NavIcon'
import { useTenant } from '../context/useTenant'
import { loadPortfolio, measureTenantAll, type PortfolioCohort, type PortfolioRow } from '../lib/api'

interface MeasureTenantOption {
  tenantId: string
  brandName: string
  industry: string
  region: string
  cohortOnly?: boolean
}

type MeasureVia = 'local' | 'github' | 'none'

export default function MeasureTenant() {
  const { tenantId: currentTenantId } = useTenant()
  const [canMeasure, setCanMeasure] = useState(false)
  const [measureVia, setMeasureVia] = useState<MeasureVia>('none')
  const [healthReady, setHealthReady] = useState(false)
  const [tenants, setTenants] = useState<MeasureTenantOption[]>([])
  const [pickedTenant, setPickedTenant] = useState('')
  const [measuring, setMeasuring] = useState(false)
  // 이번 주 카드가 이미 있는 경쟁사를 다시 재지 않는다. 주차 카드는 주차당 하나라 같은 주에
  // 다시 재면 앞선 측정을 덮어쓴다 — 데이터가 늘지 않고 표본만 바뀐다. 기본은 끔(현재 동작 유지).
  const [reuseCohort, setReuseCohort] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // 서버에서 실제로 진행 중인 측정(페이지를 벗어났다 와도 상태 유지). measureVia=local 전용.
  const [serverActive, setServerActive] = useState<ActiveMeasure[]>([])

  /*
   * 측정 대상 고르기 — 사이드바 브랜드 바꾸기와 같은 업종별 패널(BrandPickerPanel). 기본 select에 160곳
   * (고객 브랜드 + 경쟁사)이 한 줄로 늘어서 찾기 어려웠다. 여기서는 **지금 설정**의 업종·지역으로 묶는다 —
   * 측정하면 들어갈 코호트가 그것이라, 설정을 바꾼 직후에도 어디로 재게 될지가 보인다(사이드바는 마지막
   * 측정 기준). 경쟁사도 함께 두고 「경쟁사」 표시를 단다(경쟁사 하나만 측정하는 기능을 위해).
   */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerAnchor, setPickerAnchor] = useState({ top: 0, left: 0 })
  const [portfolio, setPortfolio] = useState<{ loaded: boolean; rows: PortfolioRow[] | null; cohorts: PortfolioCohort[] }>({
    loaded: false,
    rows: null,
    cohorts: [],
  })
  const pickerRef = useRef<HTMLButtonElement>(null)
  const openPicker = () => {
    const rect = pickerRef.current?.getBoundingClientRect()
    if (rect) setPickerAnchor({ top: rect.bottom + 6, left: rect.left })
    setPickerOpen(true)
    loadPortfolio().then(
      (value) => setPortfolio({ loaded: true, rows: value?.rows ?? null, cohorts: value?.cohorts ?? [] }),
      (err: unknown) => {
        console.error('[MeasureTenant] 브랜드 현황을 읽지 못했습니다', err)
        setPortfolio((p) => ({ ...p, loaded: true }))
      },
    )
  }
  const closePicker = () => {
    setPickerOpen(false)
    pickerRef.current?.focus()
  }
  const pickerRows = useMemo((): PickerRow[] => {
    const byId = new Map((portfolio.rows ?? []).map((r) => [r.tenantId, r]))
    // 경쟁사 점수 — 고객 브랜드의 코호트 리더보드에 든 마지막 측정(브랜드 현황과 같은 값).
    const compScore = new Map<string, { score: number; week: string }>()
    for (const c of portfolio.cohorts) {
      for (const m of c.members) {
        const prev = compScore.get(m.tenantId)
        if (m.competitor && (!prev || prev.week < c.weekOf)) compScore.set(m.tenantId, { score: m.score, week: c.weekOf })
      }
    }
    return tenants.map((t) => {
      const p = byId.get(t.tenantId) ?? null
      const comp = t.cohortOnly ? compScore.get(t.tenantId) : undefined
      return {
        tenantId: t.tenantId,
        brandName: t.brandName,
        industry: t.industry,
        region: t.region,
        score: p?.score ?? comp?.score ?? null,
        p,
        competitor: Boolean(t.cohortOnly),
        week: comp?.week ?? null,
      }
    })
  }, [tenants, portfolio.rows, portfolio.cohorts])

  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        const via = d.measureVia === 'local' || d.measureVia === 'github' ? (d.measureVia as MeasureVia) : 'none'
        setMeasureVia(via)
        setCanMeasure(Boolean(d.canMeasure) || via !== 'none')
        setHealthReady(true)
      })
      .catch(() => {
        if (alive) {
          setCanMeasure(false)
          setMeasureVia('none')
          setHealthReady(true)
        }
      })
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive) return
        const next = (Array.isArray(list) ? list : []) as MeasureTenantOption[]
        setTenants(next)
        setPickedTenant((current) => current || currentTenantId || next[0]?.tenantId || '')
      })
      .catch(() => {
        if (alive) setTenants([])
      })
    return () => {
      alive = false
    }
  }, [currentTenantId])

  // 서버의 진행 중 측정을 폴링 — 다른 페이지 갔다 와도 "측정 중"이 유지된다.
  useEffect(() => {
    let alive = true
    const poll = () => {
      fetch('/api/measure-status')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d) setServerActive(Array.isArray(d.active) ? d.active : [])
        })
        .catch(() => {})
    }
    poll()
    const t = window.setInterval(poll, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  async function measureOne() {
    if (!pickedTenant || !canMeasure) return
    setMeasuring(true)
    setMessage(
      measureVia === 'github'
        ? `${pickedTenant} GitHub Actions 측정 요청 중…`
        : `${pickedTenant} 측정 중… 이 탭을 열어 두세요. 경과·남은 시간은 아래 진행 표시에 나옵니다.`,
    )
    try {
      if (measureVia === 'github') {
        const res = await fetch('/api/measure-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run', tenantId: pickedTenant }),
        })
        const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string }
        if (!res.ok) throw new Error(body.error || `측정 요청 실패 (HTTP ${res.status})`)
        setMessage(
          `✓ GitHub Actions가 시작됐습니다. 수 분~수십 분 뒤 이 사이트에 점수가 반영됩니다.` +
            (body.htmlUrl ? ` 진행 상황: ${body.htmlUrl}` : ''),
        )
        return
      }
      const d = await measureTenantAll(pickedTenant, reuseCohort)
      setMessage(
        `✓ ${d.brandName} 측정·baking 완료 (Brand AEO Score ${d.aeoScore ?? '?'}). git commit + npx vercel --prod 로 배포하세요.`,
      )
    } catch (err) {
      setMessage(`✗ ${err instanceof Error ? err.message : '측정 실패'}`)
    } finally {
      setMeasuring(false)
    }
  }

  const picked = tenants.find((t) => t.tenantId === pickedTenant)
  const locked = healthReady && !canMeasure
  // 로컬 측정은 앱 전체에서 한 번에 하나씩 순차 실행되므로, 서버에 진행 중이 있으면 측정 중으로 본다.
  const isMeasuring = measuring || (measureVia === 'local' && serverActive.length > 0)

  return (
    <>
      <p className="brand">측정</p>
      <h1>브랜드·경쟁사 측정</h1>
      <p className="lead">
        측정할 대상을 골라 실행합니다. <b>본 브랜드</b>를 고르면 <b>경쟁사·코호트까지 함께</b> 측정하고(경쟁 순위의 "이 브랜드
        측정"과 동일), <b>경쟁사</b>를 고르면 그 경쟁사 <b>하나만</b> 측정합니다(특정 경쟁사 스코어카드만 갱신). 배포에서는
        GitHub Actions가, 로컬에서는 이 탭에서 바로 측정합니다.
      </p>

      <ApiKeySettings />

      <section className={`panel${locked ? ' measure-local-only' : ''}`}>
        <h3>측정할 대상 선택</h3>
        <p className="muted">
          목록에는 내 브랜드와 경쟁사(「경쟁사」 표시)가 모두 있고, 측정하면 들어갈 코호트(지금 설정의 업종 · 지역)로 묶입니다.{' '}
          {!healthReady
            ? '환경을 확인하는 중…'
            : measureVia === 'local'
              ? '로컬 백엔드가 감지됐습니다. 선택 후 측정하면 baking까지 이어서 실행합니다.'
              : measureVia === 'github'
                ? '배포 환경입니다. 버튼은 GitHub Actions 측정을 시작하고, 완료·배포 후 새로고침하면 결과가 반영됩니다.'
                : '로컬에서만 측정 가능 — 배포에서 켜려면 Vercel에 GH_MEASURE_TOKEN을 넣으세요.'}
        </p>
        <div className="measure-pick">
          <button
            ref={pickerRef}
            type="button"
            className={`measure-target${pickerOpen ? ' is-open' : ''}`}
            onClick={() => (pickerOpen ? closePicker() : openPicker())}
            disabled={locked || isMeasuring}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-label={`측정할 대상 고르기 — 지금 ${picked?.brandName ?? '선택 안 함'}`}
          >
            <span className="measure-target-text">
              <span className="measure-target-name">
                {picked ? picked.brandName : '측정할 대상 고르기…'}
                {picked?.cohortOnly && <span className="bsw-tag">경쟁사</span>}
              </span>
              {picked && (
                <span className="measure-target-meta">
                  {picked.industry} · {picked.region} · {picked.tenantId}
                </span>
              )}
            </span>
            <NavIcon name="updown" size={16} />
          </button>
          {pickerOpen && (
            <BrandPickerPanel
              rows={pickerRows}
              currentId={pickedTenant || null}
              known={portfolio.rows !== null}
              loading={!portfolio.loaded}
              anchor={pickerAnchor}
              label="측정할 대상 고르기"
              verb="고르기"
              cohortSize="listed"
              onPick={(id) => {
                setPickedTenant(id)
                closePicker()
              }}
              onClose={closePicker}
            />
          )}
          <button
            type="button"
            className="primary"
            onClick={() => void measureOne()}
            disabled={locked || !pickedTenant || isMeasuring}
          >
            {isMeasuring
              ? '측정 중…'
              : !canMeasure
                ? '로컬에서만 측정 가능'
                : picked?.cohortOnly
                  ? '이 경쟁사만 측정'
                  : '브랜드 전체 측정 (경쟁사·코호트 포함)'}
          </button>
        </div>
        {!picked?.cohortOnly && (
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '0.9em' }}
          >
            <input
              type="checkbox"
              checked={reuseCohort}
              onChange={(e) => setReuseCohort(e.target.checked)}
              disabled={locked || isMeasuring}
            />
            <span>
              이번 주에 이미 측정한 경쟁사는 건너뛰기
              <span className="hint" style={{ marginLeft: '6px' }}>
                (수집·판단 엔진이 그때와 같을 때만 재사용합니다. 경쟁사 하나당 2분 가까이 걸립니다.)
              </span>
            </span>
          </label>
        )}
        {isMeasuring && serverActive.length > 0 && (
          // 이름만 나열하면 "돌고 있다"까지만 말한다. 단계·건수가 있으면 어디쯤인지가 보인다.
          <div style={{ marginTop: '10px' }} role="status">
            <MeasureProgress active={serverActive} />
            <p className="hint" style={{ marginTop: 6 }}>
              <Link to="/measure-status">측정 상태에서 전체 보기</Link>
            </p>
          </div>
        )}
        {picked && (
          <p className="hint" style={{ marginTop: '10px' }}>
            {picked.cohortOnly ? (
              <>
                <b>{picked.brandName}</b> 경쟁사 하나만 측정합니다.
              </>
            ) : (
              <>
                <b>{picked.brandName}</b> + 경쟁사(도메인 없어도 이름 기준으로 코호트 측정)까지 함께 측정 → 코호트 순위 1/N이
                채워집니다.
              </>
            )}{' '}
            로컬 CLI: <code>npm run measure:local -- {picked.tenantId}</code>
          </p>
        )}
        {message && (
          <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '10px', fontWeight: 500 }}>
            {message}
          </p>
        )}
        {measureVia === 'github' && (
          <p className="hint" style={{ marginTop: '10px' }}>
            진행 상태는 <Link to="/measure-status">측정 상태</Link>에서 실시간으로 볼 수 있습니다.
          </p>
        )}
      </section>
    </>
  )
}
