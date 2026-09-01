import { useState, type FormEvent } from 'react'
import SiteReportView from '../components/SiteReportView'
import { evaluateAeo, unevaluableReport } from '../lib/aeo/scoreAeo'
import { extractPage } from '../lib/aeo/extractPage'
import { fetchPage } from '../lib/aeo/fetchPage'
import { parsePublicHttpUrl } from '../lib/aeo/netGuard'
import type { AeoReport, AuditContext } from '../lib/aeo/types'

export default function SiteDiagnosis() {
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<AeoReport | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setReport(null)

    const parsed = parsePublicHttpUrl(url)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }

    setBusy(true)
    try {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : '진단 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="brand">S-03 · 브랜드 진단 및 분석</p>
      <h1>사이트 종합 진단</h1>
      <p className="lead">
        단일 페이지 URL의 AI 검색 대응 준비도를 6개 영역, 100점 만점으로 진단합니다. 브랜드 가시성(주간 파이프라인)과
        달리, 지금 이 페이지의 HTML을 직접 수집해 즉시 채점합니다. 실제 인용·노출·순위를 예측하지 않습니다.
      </p>

      <form className="site-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>분석 URL</span>
          <input
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://www.viewclinic.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <span className="hint">공개 HTTPS 페이지만 수집합니다. 사설 IP·로그인 페이지는 진단할 수 없습니다.</span>
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
      {report && <SiteReportView report={report} />}
    </>
  )
}
