import { useEffect, useState, type FormEvent } from 'react'
import EntityMatchPanel from '../components/EntityMatchPanel'
import SiteReportView from '../components/SiteReportView'
import { useTenant } from '../context/useTenant'
import { checkEntityMatch, type EntityMatchReport } from '../lib/aeo/entityMatch'
import { resolveWithoutNetwork, subjectBrand, toHttpsUrl, type ResolvedTarget } from '../lib/aeo/resolveTarget'
import { evaluateAeo, unevaluableReport } from '../lib/aeo/scoreAeo'
import { extractPage } from '../lib/aeo/extractPage'
import { fetchPage } from '../lib/aeo/fetchPage'
import { inferBrandDomain } from '../lib/api'
import { parsePublicHttpUrl } from '../lib/aeo/netGuard'
import type { AeoReport, AuditContext } from '../lib/aeo/types'

/** 선택한 브랜드의 대표 소유 도메인을 진단용 https URL로 만든다. */
function brandSiteUrl(ownedDomains: string[] | undefined): string {
  const domain = ownedDomains?.[0]?.trim()
  if (!domain) return ''
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
}

export default function SiteDiagnosis() {
  const { tenant, tenants } = useTenant()
  // 상호 추론은 데스크톱에서만 — Vercel 리전에서는 한국 사업체 회상이 신뢰할 수 없다.
  const isElectron = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<AeoReport | null>(null)
  // 엔티티 일치는 총점과 분리해 따로 담는다 — scoreAeo를 거치지 않으므로 배점에 영향이 없다.
  const [entity, setEntity] = useState<EntityMatchReport | null>(null)
  // 입력을 무엇으로 해석했는지(URL/등록 브랜드/추론) — 추론 결과를 조용히 진단하지 않기 위해 표시한다.
  const [resolved, setResolved] = useState<ResolvedTarget | null>(null)

  // 브랜드를 바꾸면 그 브랜드의 소유 도메인으로 분석 URL을 채우고, 이전 진단 결과는 비운다.
  useEffect(() => {
    setUrl(brandSiteUrl(tenant?.ownedDomains))
    setReport(null)
    setEntity(null)
    setResolved(null)
    setError(null)
  }, [tenant?.tenantId])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setReport(null)
    setEntity(null)
    setResolved(null)

    setBusy(true)
    try {
      // ①URL → ②등록 브랜드명 → ③추론. 앞의 둘은 호출이 없다.
      let target = resolveWithoutNetwork(url, tenants)
      if (!target) {
        if (!isElectron) {
          setError('URL을 입력하세요. 상호로 도메인을 찾는 기능은 데스크톱 앱에서만 동작합니다(웹에서는 결과를 신뢰할 수 없습니다).')
          return
        }
        const inferred = await inferBrandDomain(url.trim(), tenant?.region ?? '')
        if (!inferred?.domain?.trim()) {
          setError(`「${url.trim()}」의 공식 도메인을 찾지 못했습니다. URL을 직접 입력하세요.`)
          return
        }
        target = { url: toHttpsUrl(inferred.domain), source: 'infer', brandName: inferred.brandName || url.trim() }
      }
      setResolved(target)
      // 해석된 URL을 입력 칸에도 반영한다 — 무엇을 진단했는지 남고, 바로 고쳐 다시 돌릴 수 있다.
      if (target.url !== url) setUrl(target.url)

      const parsed = parsePublicHttpUrl(target.url)
      if (!parsed.ok) {
        setError(parsed.error)
        return
      }
      const context: AuditContext = { topicOrQuery: topic.trim(), audience: '', competitorUrls: [] }
      const payload = await fetchPage(parsed.href)
      if (payload.fetchError && !payload.html) {
        setReport(
          unevaluableReport(parsed.href, {
            status: '수집 실패',
            cause: payload.fetchError,
            technical: '수집 프록시가 HTML을 반환하지 못했습니다.',
            neededFromUser: '본문 HTML, 또는 접근 가능한 공개 URL, 필요 시 스크린샷.',
            howToRetry: '사설 IP가 아닌 공개 HTTPS 페이지인지 확인한 뒤 다시 시도하세요.',
          }),
        )
        return
      }
      const signals = extractPage({
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
      setReport(evaluateAeo(signals, context))
      // 판정 기준은 **진단한 페이지의 주체 브랜드**다. 드롭다운 선택을 그대로 쓰면 상호를 넣거나
      // 남의 URL을 넣었을 때 짝이 어긋난다(뷰성형외과 페이지를 t'order 기준으로 판정하는 일).
      const subject = subjectBrand(target, tenants, tenant)
      setEntity(subject ? checkEntityMatch(signals, subject.brandName, subject.aliases) : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '진단 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="brand">STAGE 1</p>
      <h1>Site AEO Checker</h1>
      <p className="lead">
        단일 페이지 URL의 AI 검색 대응 준비도를 6개 영역, 100점 만점으로 진단합니다. 브랜드 가시성(주간 파이프라인)과
        달리, 지금 이 페이지의 HTML을 직접 수집해 즉시 채점합니다. 실제 인용·노출·순위를 예측하지 않습니다.
      </p>

      <form className="site-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>{isElectron ? '분석 URL 또는 브랜드명' : '분석 URL'}</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder={isElectron ? 'https://example.com 또는 삼성서울병원' : 'https://example.com'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <span className="hint">
            선택한 브랜드의 소유 도메인이 자동 입력됩니다 — 다른 페이지를 진단하려면 URL을 바꾸세요.
            {isElectron && (
              <>
                {' '}
                <b>상호를 넣어도 됩니다</b> — 등록된 브랜드면 그 도메인을 바로 쓰고, 아니면 공식 도메인을 찾습니다(판단
                엔진 호출 1회).
              </>
            )}{' '}
            공개 HTTPS 페이지만 수집하며, 사설 IP·로그인 페이지는 진단할 수 없습니다.
          </span>
        </label>
        <label className="field">
          <span>핵심 주제 / 검색어 (선택)</span>
          <input
            type="text"
            placeholder="비우면 페이지에서 추론"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '페이지를 수집하는 중…' : 'AEO 진단하기'}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {resolved && resolved.source !== 'url' && (
        <p className="hint" role="status" style={{ marginTop: 4 }}>
          {resolved.source === 'tenant'
            ? `등록된 브랜드 「${resolved.brandName}」의 소유 도메인으로 진단했습니다 — ${resolved.url}`
            : `「${resolved.brandName}」의 공식 도메인을 찾아 진단했습니다 — ${resolved.url} (추론값이므로 맞는 사이트인지 확인하세요)`}
        </p>
      )}
      {report && <SiteReportView report={report} />}
      {report && entity && <EntityMatchPanel report={entity} />}
    </>
  )
}
