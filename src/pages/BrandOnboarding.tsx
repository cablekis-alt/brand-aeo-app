import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import BrandManageList from '../components/BrandManageList'
import { useTenant } from '../context/useTenant'
import { extractPage } from '../lib/aeo/extractPage'
import { fetchPage } from '../lib/aeo/fetchPage'
import { parsePublicHttpUrl } from '../lib/aeo/netGuard'

// 한국 주소 best-effort 추출 (시/도 + 시/군/구 + 로/길 + 번지). 실패해도 사용자가 직접 수정 가능.
const KR_ADDRESS =
  /((?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청?[남북]?|충[남북]|전라?[남북]?|전[남북]|경상?[남북]?|경[남북]|제주)[가-힣]*(?:특별자치[시도]|특별[시도]|광역시|도)?\s?[가-힣]+(?:시|군|구)\s?[가-힣0-9]+(?:로|길)\s?\d+[-\d]*)/

interface CompetitorDraft {
  name: string
  aliases: string[]
  domains: string[]
}

interface TenantDraft {
  tenantId: string
  brandName: string
  aliases: string[]
  ownedDomains: string[]
  industry: string
  region: string
  engines: string[]
  questionBankSize: number
  questionBankVersion: string
  repeatsPerQuestion: number
  competitors: CompetitorDraft[]
  factGraph: { id: string; type: string; claim: string; value: string; updatedAt: string }[]
}

function hostToDomain(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}

function slugFromDomain(domain: string): string {
  const label = domain.split('.')[0] || 'brand'
  return label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'brand'
}

/** "강남언니, gangnamunni.com" 형식 줄들을 경쟁사 배열로. */
function parseCompetitors(raw: string): CompetitorDraft[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, domain] = line.split(',').map((s) => s.trim())
      return {
        name: name || '',
        aliases: name ? [name] : [],
        domains: domain ? [hostToDomain(domain.includes('://') ? domain : `https://${domain}`)] : [],
      }
    })
    .filter((c) => c.name)
}

type StageStatus = 'current' | 'done' | 'locked' | 'open'

function stageStatus(id: 1 | 2 | 3 | 4, extracted: boolean, ready: boolean): StageStatus {
  if (id === 1) return extracted ? 'done' : 'current'
  if (!extracted) return 'locked'
  if (id === 2) return ready ? 'done' : 'current'
  if (id === 4) return ready ? 'current' : 'open'
  return 'open'
}

function StageShell({
  id,
  code,
  title,
  status,
  children,
}: {
  id: string
  code: string
  title: string
  status: StageStatus
  children: ReactNode
}) {
  const locked = status === 'locked'
  return (
    <section id={id} className={`onboard-stage panel${status === 'current' ? ' is-current' : ''}${locked ? ' is-locked' : ''}`}>
      <header className="onboard-stage-head">
        <span className="onboard-stage-code">{code}</span>
        <h2>{title}</h2>
        {status === 'done' && <span className="onboard-stage-mark">완료</span>}
        {status === 'current' && <span className="onboard-stage-mark on">진행</span>}
      </header>
      {locked ? <p className="onboard-lock">URL에서 자동 채우기를 먼저 실행하세요.</p> : children}
    </section>
  )
}

export default function BrandOnboarding() {
  const { reloadTenants, setTenantId } = useTenant()
  const [url, setUrl] = useState('')
  const [industry, setIndustry] = useState('')
  const [region, setRegion] = useState('')
  const [brandName, setBrandName] = useState('')
  const [domain, setDomain] = useState('')
  const [address, setAddress] = useState('')
  const [competitorsRaw, setCompetitorsRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [extracted, setExtracted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [canRegister, setCanRegister] = useState(false)
  const [canMeasure, setCanMeasure] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerMsg, setRegisterMsg] = useState<string | null>(null)
  const [suggestingComp, setSuggestingComp] = useState(false)
  const [compMsg, setCompMsg] = useState<string | null>(null)
  // 코호트 표기 불일치 방지 — 기존 브랜드의 업종·지역을 자동완성으로 제공한다.
  const [cohortIndustries, setCohortIndustries] = useState<string[]>([])
  const [cohortRegions, setCohortRegions] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    fetch('/api/tenants?all=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: { industry?: string; region?: string }[]) => {
        if (!alive || !Array.isArray(list)) return
        const uniq = (vals: (string | undefined)[]) =>
          [...new Set(vals.filter((v): v is string => Boolean(v && v.trim())))].sort((a, b) => a.localeCompare(b, 'ko'))
        setCohortIndustries(uniq(list.map((t) => t.industry)))
        setCohortRegions(uniq(list.map((t) => t.region)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 배포(Vercel)에서도 /api/health가 canRegister를 알려 준다.
  useEffect(() => {
    let alive = true
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setCanRegister(Boolean(d.canRegister))
        setCanMeasure(d.canMeasure !== false)
      })
      .catch(() => {
        if (alive) {
          setCanRegister(false)
          setCanMeasure(false)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  async function handleExtract(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setExtracted(false)
    const parsed = parsePublicHttpUrl(url)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setBusy(true)
    try {
      const payload = await fetchPage(parsed.href)
      if (payload.fetchError && !payload.html) {
        setError(`페이지를 가져오지 못했습니다: ${payload.fetchError}. 브랜드명·도메인은 직접 입력해 진행할 수 있습니다.`)
        setDomain(hostToDomain(parsed.href))
        setExtracted(true)
        return
      }
      const s = extractPage({
        requestedUrl: parsed.href,
        finalUrl: payload.finalUrl || parsed.href,
        status: payload.status,
        contentType: payload.contentType,
        redirected: payload.redirected,
        html: payload.html,
        robotsTxt: payload.robotsTxt,
        robotsTxtStatus: payload.robotsTxtStatus,
        sitemapFound: payload.sitemapFound,
        llmsTxtFound: payload.llmsTxtFound,
        xRobotsTag: payload.xRobotsTag,
        fetchError: payload.fetchError,
        fetchErrorCode: payload.fetchErrorCode,
        renderMode: payload.renderMode,
        rendered: payload.rendered,
        renderWarning: payload.renderWarning,
      })
      const guessedName =
        s.ogSiteName?.trim() ||
        s.orgCandidates?.[0]?.trim() ||
        (s.title || '').split(/[|\-–—:·]/)[0].trim()
      setDomain(hostToDomain(s.finalUrl || parsed.href))
      setBrandName(guessedName)
      const addr = (s.mainText || '').match(KR_ADDRESS)?.[0] ?? ''
      setAddress(addr)
      setExtracted(true)

      // 업종·지역·주소는 정규식만으로 부족하니, 읽어온 본문을 Gemini로 추론해 비어 있는 칸만 채운다.
      const pageText = (s.mainText || '').trim()
      if (pageText) {
        try {
          const res = await fetch('/api/infer?kind=brand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: pageText, brandName: guessedName }),
          })
          if (res.ok) {
            const inferred = (await res.json()) as { industry?: string; region?: string; address?: string }
            if (inferred.industry) setIndustry((prev) => prev || inferred.industry!)
            if (inferred.region) setRegion((prev) => prev || inferred.region!)
            if (!addr && inferred.address) setAddress((prev) => prev || inferred.address!)
          }
        } catch {
          // 추론 실패는 무시 — 사용자가 직접 입력하면 된다.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '수집 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const tenant: TenantDraft = {
    tenantId: slugFromDomain(domain),
    brandName: brandName.trim(),
    aliases: brandName.trim() ? [brandName.trim()] : [],
    ownedDomains: domain ? [domain] : [],
    industry: industry.trim(),
    region: region.trim(),
    engines: ['openai', 'gemini'],
    questionBankSize: 12,
    questionBankVersion: 'v1',
    repeatsPerQuestion: 3,
    competitors: parseCompetitors(competitorsRaw),
    factGraph: address.trim()
      ? [
          {
            id: 'brand-address',
            type: 'location',
            claim: '주소',
            value: address.trim(),
            updatedAt: new Date().toISOString().slice(0, 10),
          },
        ]
      : [],
  }

  const ready = Boolean(tenant.brandName && tenant.ownedDomains.length && tenant.industry && tenant.region)
  const canSuggestComp = Boolean(brandName.trim() && industry.trim())
  const json = JSON.stringify(tenant, null, 2)

  // 같은 업종·지역 경쟁사를 Gemini로 추천해 경쟁사 칸에 병합한다. 도메인은 백엔드에서 DNS 검증된 것만 온다.
  async function suggestCompetitors() {
    setSuggestingComp(true)
    setCompMsg('경쟁사를 추론하는 중… (웹검색·도메인 확인, 십여 초)')
    try {
      const res = await fetch('/api/infer?kind=competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brandName: brandName.trim(), industry: industry.trim(), region: region.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `추천 실패 (HTTP ${res.status})`)
      }
      const list = (await res.json()) as { name: string; domain: string }[]
      if (!Array.isArray(list) || list.length === 0) {
        setCompMsg('추천 결과가 없습니다 — 직접 입력해 주세요.')
        return
      }
      const existing = new Set(
        competitorsRaw
          .split('\n')
          .map((l) => l.split(',')[0]?.trim())
          .filter(Boolean),
      )
      const added = list.filter((c) => c.name && !existing.has(c.name))
      const lines = added.map((c) => (c.domain ? `${c.name}, ${c.domain}` : c.name))
      setCompetitorsRaw((prev) => [prev.trim(), ...lines].filter(Boolean).join('\n'))
      const noDomain = added.filter((c) => !c.domain).length
      setCompMsg(
        `✓ ${added.length}곳 추가${noDomain ? ` — 도메인 미확인 ${noDomain}곳은 이름만 넣었으니 확인·보완하세요` : ''}. 경쟁사는 직접 검토를 권합니다.`,
      )
    } catch (err) {
      setCompMsg(`✗ ${err instanceof Error ? err.message : '추천 실패'}`)
    } finally {
      setSuggestingComp(false)
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드 복사에 실패했습니다. JSON을 직접 선택해 복사하세요.')
    }
  }

  // 등록 후 드롭다운에 바로 보이게 한다. 측정은 로컬 백엔드가 있을 때만 이어서 돈다.
  async function registerAndMeasure() {
    setRegistering(true)
    setRegisterMsg('브랜드를 등록하는 중…')
    try {
      const reg = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      })
      if (!reg.ok) {
        const body = (await reg.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `등록 실패 (HTTP ${reg.status})`)
      }
      await reloadTenants()
      setTenantId(tenant.tenantId)
      if (!canMeasure) {
        // 배포에선 측정을 못 돌리니 "측정 요청"만 대기열에 쌓는다(로컬 CLI가 처리).
        let queued = false
        try {
          const q = await fetch('/api/measure-requests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json,
          })
          queued = q.ok
        } catch {
          queued = false
        }
        setRegisterMsg(
          `✓ 등록 완료 — ${tenant.brandName} (${tenant.tenantId}). 상단 메뉴에서 선택할 수 있습니다. ` +
            (queued ? '측정 대기열에 추가됐습니다 — ' : '') +
            `측정은 로컬에서 npx tsx scripts/measure-requests.ts 로 대기열을 확인해 실행하세요.`,
        )
        return
      }
      setRegisterMsg(
        `등록 완료 · 측정 시작 (질문 ${tenant.questionBankSize} × ${tenant.repeatsPerQuestion}회, 수 분 소요)… 이 탭을 열어 두세요.`,
      )
      const run = await fetch(`/api/tenants/${encodeURIComponent(tenant.tenantId)}/run`, { method: 'POST' })
      if (!run.ok) {
        const body = (await run.json().catch(() => ({}))) as { error?: string }
        throw new Error(`등록은 됐지만 측정 실패: ${body.error || `HTTP ${run.status}`}. 나중에 CLI로 재시도할 수 있습니다.`)
      }
      const result = (await run.json()) as { aeoScore?: number }
      setRegisterMsg(
        `✓ 완료 — ${tenant.brandName} 등록·측정됨 (AEO Score ${result.aeoScore ?? '?'}). 상단 브랜드 메뉴에서 선택할 수 있습니다.`,
      )
    } catch (err) {
      setRegisterMsg(`✗ ${err instanceof Error ? err.message : '실패했습니다.'}`)
    } finally {
      setRegistering(false)
    }
  }

  const currentStage = !extracted ? 1 : !ready ? 2 : 4
  const s1 = stageStatus(1, extracted, ready)
  const s2 = stageStatus(2, extracted, ready)
  const s3 = stageStatus(3, extracted, ready)
  const s4 = stageStatus(4, extracted, ready)

  function goStage(n: 1 | 2 | 3 | 4) {
    document.getElementById(`stage-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <header className="onboard-masthead">
        <div>
          <p className="brand">시작 · 진입점</p>
          <h1>브랜드 추가</h1>
          <p className="lead">URL을 넣으면 브랜드명·도메인·주소를 채웁니다. 업종·지역·경쟁사만 확인하면 테넌트가 만들어집니다.</p>
        </div>
      </header>

      <nav className="onboard-steps" aria-label="브랜드 추가 단계">
        {(
          [
            [1, '1', 'URL', s1],
            [2, '2', '정보', s2],
            [3, '3', '경쟁사', s3],
            [4, '4', '등록', s4],
          ] as const
        ).map(([n, code, label, status]) => (
          <button
            key={n}
            type="button"
            className={`onboard-step${n === currentStage ? ' is-current' : ''}${status === 'done' ? ' is-done' : ''}${status === 'locked' ? ' is-locked' : ''}`}
            onClick={() => goStage(n)}
          >
            <span className="onboard-step-code">
              {code}
              {status === 'done' ? ' · 완료' : n === currentStage ? ' · 진행' : ''}
            </span>
            <span className="onboard-step-title">{label}</span>
          </button>
        ))}
      </nav>

      <StageShell id="stage-1" code="1" title="URL 수집" status={s1}>
        <form className="site-form" onSubmit={handleExtract}>
          <label className="field">
            <span>브랜드 URL</span>
            <input
              type="text"
              inputMode="url"
              placeholder="https://www.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <span className="hint">
              공개 HTTPS 페이지만 읽습니다. 봇 차단·JS 렌더링 사이트는 자동 추출이 제한될 수 있으니 아래에서 직접 보완하세요.
            </span>
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '페이지를 읽는 중…' : 'URL에서 자동 채우기'}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </StageShell>

      <StageShell id="stage-2" code="2" title="브랜드 정보" status={s2}>
        <div className="onboard-grid">
          <label className="field">
            <span>브랜드명 *</span>
            <input type="text" value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="예: 뷰성형외과" />
          </label>
          <label className="field">
            <span>대표 도메인 *</span>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="예: viewclinic.com" />
          </label>
          <label className="field">
            <span>업종 *</span>
            <input
              type="text"
              list="cohort-industries"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="예: 성형외과"
            />
            <datalist id="cohort-industries">
              {cohortIndustries.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <span className="hint">
              코호트 랭킹은 <b>업종·지역이 정확히 일치</b>해야 같은 그룹입니다. 기존 값이 있으면 목록에서 고르세요.
            </span>
            {industry.trim() && cohortIndustries.length > 0 && !cohortIndustries.includes(industry.trim()) && (
              <span className="hint">⚠ 기존 코호트에 없는 업종입니다 — 새 코호트로 분리됩니다.</span>
            )}
          </label>
          <label className="field">
            <span>지역 *</span>
            <input
              type="text"
              list="cohort-regions"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="예: 서울 강남"
            />
            <datalist id="cohort-regions">
              {cohortRegions.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {region.trim() && cohortRegions.length > 0 && !cohortRegions.includes(region.trim()) && (
              <span className="hint">
                ⚠ 기존 코호트에 없는 지역입니다 — 새 코호트로 분리됩니다. 의도한 것이 아니면 기존 값과 맞추세요.
              </span>
            )}
          </label>
          <label className="field span2">
            <span>주소 (Fact Graph · 선택)</span>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="예: 서울 강남구 봉은사로 107" />
            <span className="hint">사실성 검증에 쓰입니다. 자동 추출이 비었으면 직접 입력하세요.</span>
          </label>
        </div>
      </StageShell>

      <StageShell id="stage-3" code="3" title="경쟁사" status={s3}>
        <div className="field">
          <div className="onboard-comp-label">
            <span>경쟁사 (선택 · 한 줄에 하나: 이름, 도메인)</span>
            {canRegister && (
              <button
                type="button"
                className="ghost"
                onClick={suggestCompetitors}
                disabled={!canSuggestComp || suggestingComp}
                title={canSuggestComp ? '' : '브랜드명·업종을 먼저 채우세요'}
              >
                {suggestingComp ? '추천 중…' : '경쟁사 자동 추천 (Gemini)'}
              </button>
            )}
          </div>
          <textarea
            rows={4}
            value={competitorsRaw}
            onChange={(e) => setCompetitorsRaw(e.target.value)}
            placeholder={'강남언니, gangnamunni.com\n원진성형외과, k-wonjin.co.kr'}
          />
          <span className="hint">
            경쟁사를 넣으면 Share of Mention·순위 비교가 가능합니다. 비우면 SoM은 판정 불가로 표시됩니다. 자동 추천은{' '}
            <b>이름 위주 best-effort</b>이며 도메인은 실재 확인된 것만 채웁니다 — 직접 검토하세요.
          </span>
          {compMsg && (
            <span className={compMsg.startsWith('✗') ? 'error' : 'hint'} role="status">
              {compMsg}
            </span>
          )}
        </div>
      </StageShell>

      <StageShell id="stage-4" code="4" title="등록" status={s4}>
        <div className="onboard-register">
          <p className="onboard-tenant">테넌트 초안 (tenantId: {tenant.tenantId || '—'})</p>
          <div className="onboard-register-actions">
            {canRegister && (
              <button type="button" className="primary" onClick={registerAndMeasure} disabled={!ready || registering}>
                {registering ? '진행 중…' : canMeasure ? '브랜드 등록 & 측정' : '브랜드 등록'}
              </button>
            )}
            <button type="button" className="ghost" onClick={copyJson} disabled={!ready}>
              {copied ? '복사됨 ✓' : 'JSON 복사'}
            </button>
          </div>
        </div>
        {!ready && <p className="hint">* 브랜드명·도메인·업종·지역을 모두 채우면 등록할 수 있습니다.</p>}
        {canRegister ? (
          <p className="hint">
            {canMeasure
              ? '로컬 백엔드가 감지됐습니다 — 등록과 측정을 한 번에 실행합니다.'
              : '프로덕션에 브랜드를 바로 등록합니다. 측정은 테넌트 골라 측정에서 GitHub Actions로 실행하세요.'}
          </p>
        ) : (
          <p className="hint">
            자동 등록을 쓰려면 Vercel 프로젝트에 Blob 스토어를 연결하세요. 지금은 JSON을 복사해{' '}
            <code>tenants.config.json</code>에 추가할 수 있습니다.
          </p>
        )}
        {registerMsg && (
          <p className={registerMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
            {registerMsg}
          </p>
        )}
        <p className="hint onboard-cli">
          측정 CLI: <code>npx tsx scripts/run-pipeline.ts {tenant.tenantId || '<tenantId>'}</code>
          {' · '}
          점수 반영: <code>npx tsx scripts/publish-tenant.ts {tenant.tenantId || '<tenantId>'}</code>
        </p>
      </StageShell>

      <BrandManageList />
    </>
  )
}
