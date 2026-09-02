import { useState, type FormEvent } from 'react'
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

export default function BrandOnboarding() {
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
    engines: ['openai'],
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
  const json = JSON.stringify(tenant, null, 2)

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('클립보드 복사에 실패했습니다. JSON을 직접 선택해 복사하세요.')
    }
  }

  return (
    <>
      <p className="brand">S-08 · 브랜드 관리</p>
      <h1>브랜드 추가</h1>
      <p className="lead">
        브랜드 URL을 넣으면 페이지를 읽어 <b>브랜드명·도메인·주소</b>를 자동으로 채웁니다. 업종·지역·경쟁사만 확인하면
        측정용 테넌트 초안(JSON)이 만들어집니다. 실제 측정은 이 초안을 등록한 뒤 백엔드 파이프라인으로 실행합니다.
      </p>

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
          <span className="hint">공개 HTTPS 페이지만 읽습니다. 봇 차단·JS 렌더링 사이트는 자동 추출이 제한될 수 있으니 아래에서 직접 보완하세요.</span>
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

      {extracted && (
        <section className="panel" style={{ marginTop: '20px' }}>
          <h3>브랜드 정보 확인·보완</h3>
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
              <input type="text" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="예: 성형외과" />
            </label>
            <label className="field">
              <span>지역 *</span>
              <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="예: 서울 강남" />
            </label>
            <label className="field span2">
              <span>주소 (Fact Graph · 선택)</span>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="예: 서울 강남구 봉은사로 107" />
              <span className="hint">사실성 검증에 쓰입니다. 자동 추출이 비었으면 직접 입력하세요.</span>
            </label>
            <label className="field span2">
              <span>경쟁사 (선택 · 한 줄에 하나: 이름, 도메인)</span>
              <textarea
                rows={4}
                value={competitorsRaw}
                onChange={(e) => setCompetitorsRaw(e.target.value)}
                placeholder={'강남언니, gangnamunni.com\n원진성형외과, k-wonjin.co.kr'}
              />
              <span className="hint">경쟁사를 넣으면 Share of Mention·순위 비교가 가능합니다. 비우면 SoM은 판정 불가로 표시됩니다.</span>
            </label>
          </div>
        </section>
      )}

      {extracted && (
        <section className="panel" style={{ marginTop: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <h3 style={{ margin: 0 }}>테넌트 초안 (tenantId: {tenant.tenantId})</h3>
            <button type="button" className="primary" onClick={copyJson} disabled={!ready}>
              {copied ? '복사됨 ✓' : 'JSON 복사'}
            </button>
          </div>
          {!ready && <p className="hint" style={{ marginTop: '8px' }}>* 브랜드명·도메인·업종·지역을 모두 채우면 등록할 수 있습니다.</p>}
          <pre className="json-block">{json}</pre>
          <h4>등록·측정 방법</h4>
          <ol className="muted" style={{ lineHeight: 1.8 }}>
            <li>위 JSON을 <code>server/tenants.config.json</code> 배열에 추가합니다.</li>
            <li>측정 실행: <code>npx tsx scripts/run-pipeline.ts {tenant.tenantId}</code></li>
            <li>대시보드에 반영: 브랜드 분석을 <code>src/data/</code>로 baking 후 재배포 (기존 재측정 절차와 동일).</li>
            <li>경쟁사까지 코호트로 비교하려면 각 경쟁사도 테넌트로 추가해 <code>run-cohort</code>를 실행합니다.</li>
          </ol>
        </section>
      )}
    </>
  )
}
