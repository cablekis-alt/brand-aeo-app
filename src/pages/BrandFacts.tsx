import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTenant } from '../context/useTenant'
import { loadFactGraph, saveFactGraph, type FactNode } from '../lib/api'

/**
 * 브랜드 사실(팩트 그래프) 편집.
 *
 * 왜 이 화면이 필요한가. 등록 때 주소 하나가 자동으로 들어가고 그 뒤로 고칠 곳이 없었다. 그런데
 * 이 값은 두 곳의 정확도를 정한다 — 사실성 판정(AI 응답의 주장을 이 값과 대조해 '모순'을 잡는다)과
 * 콘텐츠 브리프("반드시 넣을 사실"은 여기 있는 것만 들어가고, 없는 것은 '확인 필요'로 남는다).
 * 원진성형외과 브리프에 사실이 주소 하나만 들어간 이유가 이것이다.
 *
 * 여기서 저장하면 베이스 테넌트(repo config)든 오버레이든 이 값이 이긴다(server/factGraphStore).
 */
const TYPE_LABEL: Record<FactNode['type'], string> = {
  location: '위치',
  price: '가격',
  spec: '사양·규모',
  certification: '인증·자격',
  date: '날짜·연혁',
  other: '기타',
}
const TYPE_HINT: Record<FactNode['type'], string> = {
  location: '주소, 지점, 층',
  price: '대표 시술·상품 가격대 (원 단위, 기간 명시)',
  spec: '전문의 수, 병상·수술실 수, 장비, 상주 인력',
  certification: '전문의 자격, 인증기관, 수상',
  date: '개원·설립 연도, 이전 시점',
  other: '위에 안 맞는 검증 가능한 사실',
}
const EMPTY: FactNode = { id: '', type: 'spec', claim: '', value: '', sourceUrl: '', updatedAt: '' }

export default function BrandFacts() {
  const { tenant } = useTenant()
  const [rows, setRows] = useState<FactNode[]>([])
  const [source, setSource] = useState<'file' | 'config' | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (!tenant) return
    let alive = true
    setLoading(true)
    setNotice(null)
    setError(null)
    void loadFactGraph(tenant.tenantId).then((r) => {
      if (!alive) return
      if (r) {
        setRows(r.factGraph)
        setSource(r.source)
      } else {
        setSource(null)
      }
      setDirty(false)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [tenant])

  if (!tenant) return null

  const update = (i: number, patch: Partial<FactNode>) => {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
    setDirty(true)
  }
  const remove = (i: number) => {
    setRows((rs) => rs.filter((_, k) => k !== i))
    setDirty(true)
  }
  const add = () => {
    setRows((rs) => [...rs, { ...EMPTY }])
    setDirty(true)
  }
  const save = async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const r = await saveFactGraph(tenant.tenantId, rows)
      setRows(r.factGraph)
      setSource('file')
      setDirty(false)
      setNotice(
        `저장했습니다 — 사실 ${r.factGraph.length}건.` +
          (r.dropped > 0 ? ` 주장이나 값이 비어 있던 ${r.dropped}줄은 저장하지 않았습니다.` : '') +
          ' 다음 측정의 사실성 판정과 새로 만드는 브리프에 바로 반영됩니다.',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <p className="brand">설정</p>
      <h1>브랜드 사실</h1>
      <p className="lead">
        <b>{tenant.brandName}</b>에 대해 검증 가능한 사실만 적습니다. 이 값은 두 곳을 정확하게 만듭니다 —{' '}
        <Link to="/diagnosis">사실성 판정</Link>은 AI 응답의 주장을 여기와 대조해 모순을 잡고,{' '}
        <Link to="/gap-actions">실행 항목의 브리프</Link>는 여기 있는 사실만 "반드시 넣을 사실"에 넣습니다.
        없는 것은 각각 <b>검증 불가</b>·<b>확인 필요</b>로 남습니다.
      </p>

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && source === null && (
        <p className="muted">
          이 환경에서는 브랜드 사실을 저장할 수 없습니다(데스크톱·로컬 전용). 웹에서는 설정 파일의 값이 그대로 쓰입니다.
        </p>
      )}

      {!loading && source !== null && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            {source === 'config'
              ? '아직 여기서 저장한 적이 없어 등록 때 설정된 값을 보여줍니다. 저장하면 그 값을 대신합니다.'
              : '여기서 저장한 값입니다. 설정 파일보다 우선합니다.'}{' '}
            수치·가격은 확인 가능한 것만, 기간이 있으면 기간을 함께 적으세요. 출처 URL은 선택입니다.
          </p>

          <div className="table-wrap">
            <table className="facts">
              <thead>
                <tr>
                  <th style={{ width: '12%' }}>종류</th>
                  <th style={{ width: '26%' }}>주장(무엇에 대한 사실인가)</th>
                  <th>값</th>
                  <th style={{ width: '22%' }}>출처 URL (선택)</th>
                  <th style={{ width: 44 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      등록된 사실이 없습니다. 아래 "사실 추가"로 시작하세요 — 전문의 수, 개원 연도, 대표 시술 가격대처럼
                      AI가 자주 틀리는 것부터.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <select value={r.type} onChange={(e) => update(i, { type: e.target.value as FactNode['type'] })}>
                        {(Object.keys(TYPE_LABEL) as FactNode['type'][]).map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={r.claim}
                        placeholder={TYPE_HINT[r.type]}
                        onChange={(e) => update(i, { claim: e.target.value })}
                      />
                    </td>
                    <td>
                      <input value={r.value} placeholder="예: 성형외과 전문의 5명 상주" onChange={(e) => update(i, { value: e.target.value })} />
                    </td>
                    <td>
                      <input value={r.sourceUrl ?? ''} placeholder="https://…" onChange={(e) => update(i, { sourceUrl: e.target.value })} />
                    </td>
                    <td>
                      <button type="button" className="ghost" onClick={() => remove(i)} aria-label="이 줄 삭제">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="facts-bar">
            <button type="button" className="ghost" onClick={add}>
              ＋ 사실 추가
            </button>
            <button type="button" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? '저장 중…' : dirty ? '저장' : '저장됨'}
            </button>
            {rows.some((r) => r.updatedAt) && (
              <span className="doc-meta">
                마지막 확인 {rows.map((r) => r.updatedAt).filter(Boolean).sort().at(-1)}
              </span>
            )}
          </div>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </>
  )
}
