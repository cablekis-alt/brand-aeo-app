import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

interface QueueTenant {
  tenantId: string
  brandName: string
  industry: string
  region: string
  ownedDomains: string[]
  competitors: { name: string }[]
}
interface MeasureRequest {
  tenant: QueueTenant
  requestedAt: string
}

export default function MeasureQueue() {
  const [items, setItems] = useState<MeasureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [canMeasure, setCanMeasure] = useState(false)
  const [measureVia, setMeasureVia] = useState<'local' | 'github' | 'none'>('none')
  const [processing, setProcessing] = useState(false)
  const [processMsg, setProcessMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/measure-requests')
      if (!res.ok) throw new Error(`대기열을 불러오지 못했습니다 (HTTP ${res.status})`)
      setItems((await res.json()) as MeasureRequest[])
    } catch (err) {
      setError(err instanceof Error ? err.message : '대기열 조회 실패')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const via = d?.measureVia === 'local' || d?.measureVia === 'github' ? d.measureVia : 'none'
        setMeasureVia(via)
        setCanMeasure(Boolean(d?.canMeasure) || via !== 'none')
      })
      .catch(() => {
        setCanMeasure(false)
        setMeasureVia('none')
      })
  }, [load])

  // 배포 환경: 대기열 전체를 GitHub Actions 한 번의 실행으로 순차 측정 → 자동 배포 → 러너가 대기열을 비운다.
  async function processViaGithub() {
    setProcessing(true)
    setProcessMsg(`GitHub Actions에 대기열 ${items.length}건 측정을 요청하는 중…`)
    try {
      const res = await fetch('/api/measure-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-queue' }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; htmlUrl?: string; pending?: number }
      if (!res.ok) throw new Error(body.error || `요청 실패 (HTTP ${res.status})`)
      setProcessMsg(
        `✓ GitHub Actions가 대기열 ${body.pending ?? items.length}건을 순차 측정 중입니다. 완료되면 이 사이트에 자동 반영되고 대기열이 비워집니다 (수 분~수십 분).` +
          (body.htmlUrl ? ` 진행 상황: ${body.htmlUrl}` : ''),
      )
    } catch (err) {
      setProcessMsg(`✗ ${err instanceof Error ? err.message : '요청 실패'}`)
    } finally {
      setProcessing(false)
    }
  }

  // 로컬 백엔드: 대기열 전체를 측정 + publish + 정리한다 (수 분 소요, 이후 수동 배포).
  async function processLocally() {
    setProcessing(true)
    setProcessMsg(`측정 중… 대기 ${items.length}건을 순서대로 처리합니다 (브랜드당 수 분). 이 탭을 열어 두세요.`)
    try {
      const res = await fetch('/api/measure-requests/process', { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `처리 실패 (HTTP ${res.status})`)
      }
      const data = (await res.json()) as {
        processed: number
        results: { brandName: string; aeoScore?: number; ok: boolean; error?: string }[]
      }
      const done = data.results.filter((r) => r.ok)
      const failed = data.results.filter((r) => !r.ok)
      setProcessMsg(
        `✓ ${done.length}건 측정·publish 완료` +
          (done.length ? ` — ${done.map((r) => `${r.brandName}(${r.aeoScore})`).join(', ')}` : '') +
          (failed.length ? ` · 실패 ${failed.length}건` : '') +
          `. 이제 git commit + npx vercel --prod 로 배포하세요.`,
      )
      await load()
    } catch (err) {
      setProcessMsg(`✗ ${err instanceof Error ? err.message : '처리 실패'}`)
    } finally {
      setProcessing(false)
    }
  }

  async function processAll() {
    if (measureVia === 'github') await processViaGithub()
    else await processLocally()
  }

  async function cancel(tenantId: string) {
    setBusyId(tenantId)
    try {
      const res = await fetch(`/api/measure-requests?tenantId=${encodeURIComponent(tenantId)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`취소 실패 (HTTP ${res.status})`)
      setItems((prev) => prev.filter((r) => r.tenant.tenantId !== tenantId))
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 취소 실패')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <p className="brand">STAGE 1</p>
      <h1>측정 대기열</h1>
      <p className="lead">
        배포 사이트에서 등록된 브랜드의 <b>측정 요청</b> 목록입니다. 측정(질문 × 엔진 × 반복, 수 분)은 서버리스
        함수에서 못 돌리므로, 배포 환경에서는 <b>GitHub Actions</b>가, 로컬에서는 <b>로컬 백엔드</b>가 대기열을
        처리합니다. 완료되면 결과가 자동 반영됩니다.
      </p>

      <div style={{ display: 'flex', gap: '10px', margin: '4px 0 12px', flexWrap: 'wrap' }}>
        {canMeasure && (
          <button type="button" className="primary" onClick={() => void processAll()} disabled={processing || items.length === 0}>
            {processing ? '측정 중…' : `측정 실행 (${items.length}건)`}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading || processing}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
        <span className="hint" style={{ alignSelf: 'center' }}>대기 {items.length}건</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {measureVia === 'github'
          ? '배포 환경 — "측정 실행"이 GitHub Actions 한 번의 실행으로 대기열 전체를 순차 측정하고, 끝나면 이 사이트에 자동 반영·대기열 정리까지 합니다.'
          : measureVia === 'local'
            ? '로컬 백엔드 감지됨 — "측정 실행"으로 대기열을 바로 측정·publish합니다 (완료 후 커밋·배포).'
            : '측정을 켜려면 로컬 백엔드를 띄우거나 Vercel에 GH_MEASURE_TOKEN을 넣으세요. 아래 CLI도 사용할 수 있습니다.'}
      </p>

      {processMsg && (
        <p className={processMsg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ fontWeight: 500 }}>
          {processMsg}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!loading && items.length === 0 ? (
        <section className="panel">
          <p className="muted">측정 대기열이 비어 있습니다. 배포 사이트의 S-08에서 브랜드를 등록하면 여기에 쌓입니다.</p>
        </section>
      ) : (
        <section>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>브랜드</th>
                  <th>tenantId</th>
                  <th>업종 · 지역</th>
                  <th>경쟁사</th>
                  <th>요청일</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.tenant.tenantId}>
                    <td>{r.tenant.brandName}</td>
                    <td>
                      <code>{r.tenant.tenantId}</code>
                    </td>
                    <td className="judgment">
                      {r.tenant.industry} · {r.tenant.region}
                    </td>
                    <td>{r.tenant.competitors?.length ?? 0}곳</td>
                    <td>{r.requestedAt.slice(0, 10)}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void cancel(r.tenant.tenantId)}
                        disabled={busyId === r.tenant.tenantId}
                      >
                        {busyId === r.tenant.tenantId ? '취소 중…' : '요청 취소'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" style={{ marginTop: '20px' }}>
        <p className="hint">
          테넌트 하나만 측정하려면 <Link to="/measure-tenant">S-12 테넌트 골라 측정</Link>을 사용하세요. 실행 진행 상태는{' '}
          <Link to="/measure-status">S-14 측정 상태</Link>에서 볼 수 있습니다.
        </p>
      </section>

      <section className="panel" style={{ marginTop: '20px' }}>
        <h3>로컬에서 처리하기</h3>
        <p className="muted">대기열을 확인하고, 측정 + baking + 대기열 정리까지 한 번에:</p>
        <pre className="json-block">{`# 목록만 보기
npx tsx scripts/measure-requests.ts

# 대기 중인 브랜드를 모두 측정 + publish + 대기열 정리
npx tsx scripts/measure-requests.ts --measure

# 이후 공개
git commit -am "data: measure queued brands" && npx vercel --prod`}</pre>
        <p className="hint">
          측정에는 OpenAI/Gemini 키가 필요합니다. 처리가 끝난 요청은 자동으로 이 대기열에서 사라집니다.
        </p>
      </section>
    </>
  )
}
