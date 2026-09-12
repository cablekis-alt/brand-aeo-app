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
/**
 * 업종별 입력 예시. 예시가 업종과 어긋나면 사용자가 무엇을 적어야 할지 다시 생각해야 하고,
 * 잘못된 예시를 그대로 따라 적기도 한다(펜션 화면에 "성형외과 전문의 5명 상주"가 떴다).
 *
 * 업종 문자열을 키워드로 묶는다 — 등록 업종은 자유 입력이라 열거로는 못 덮는다. 어느 묶음에도
 * 안 걸리면 GENERIC이 나가는데, 그것도 업종에 중립적이어서 오해를 만들지 않는다.
 */
interface Hint {
  claim: string
  value: string
}
type HintSet = Record<FactNode['type'], Hint>

const GENERIC: HintSet = {
  location: { claim: '주소', value: '서울시 강남구 테헤란로 1' },
  price: { claim: '대표 상품 가격대 (기간 명시)', value: '월 9만 9천원 (2026년 기준)' },
  spec: { claim: '규모·구성', value: '임직원 40명' },
  certification: { claim: '인증·자격', value: 'ISO 9001 인증' },
  date: { claim: '설립 연도', value: '2018년 설립' },
  other: { claim: '위에 안 맞는 검증 가능한 사실', value: '연간 이용 고객 1만 2천 명 (2025년)' },
}

const PROFILES: { match: RegExp; hints: Partial<HintSet> }[] = [
  {
    // 의료 — 병원·의원·클리닉. 인력·시설이 사실의 중심이고 AI가 가장 자주 틀린다.
    match: /성형외과|치과|병원|의원|클리닉|한의원|피부과|안과|정형외과|산부인과|의료/,
    hints: {
      location: { claim: '주소', value: '서울시 서초구 강남대로 419 12층' },
      price: { claim: '대표 시술 가격대 (기간 명시)', value: '눈매교정 180만원~ (2026년 기준)' },
      spec: { claim: '의료진 수', value: '성형외과 전문의 5명 상주' },
      certification: { claim: '전문의 자격·지정 기관', value: '보건복지부 지정 전문병원' },
      date: { claim: '개원 연도', value: '2011년 개원' },
      other: { claim: '위에 안 맞는 검증 가능한 사실', value: '수술실 3실, 회복실 별도 운영' },
    },
  },
  {
    // 숙박 — 펜션·호텔·스테이. 객실·수용 인원·성수기 요금이 예약 직전 질문의 핵심이다.
    match: /펜션|호텔|리조트|스테이|게스트하우스|숙박|민박|캠핑|글램핑/,
    hints: {
      location: { claim: '주소', value: '전북 군산시 절골길 18' },
      price: { claim: '객실 요금대 (비수기·성수기 구분)', value: '비수기 15만원 / 성수기 22만원 (2026년)' },
      spec: { claim: '객실 수·수용 인원', value: '객실 6실, 최대 24인' },
      certification: { claim: '등록 업종·안전 점검', value: '농어촌민박업 신고 완료' },
      date: { claim: '개업·리모델링 연도', value: '2021년 리모델링' },
      other: { claim: '위에 안 맞는 검증 가능한 사실', value: '바비큐장·주차 6대 무료' },
    },
  },
  {
    // B2B 솔루션·SaaS — 도입처 수와 요금제가 비교 질문에서 인용된다.
    match: /오더|솔루션|플랫폼|소프트웨어|SaaS|서비스|결제|커머스|앱/i,
    hints: {
      location: { claim: '본사 주소', value: '서울시 영등포구 여의대로 24' },
      price: { claim: '요금제 (기간 명시)', value: '월 3만 3천원 / 매장 (2026년 기준)' },
      spec: { claim: '도입 규모', value: '도입 매장 1만 2천 곳' },
      certification: { claim: '인증·보안', value: 'ISMS 인증 취득' },
      date: { claim: '서비스 시작 연도', value: '2019년 서비스 시작' },
      other: { claim: '위에 안 맞는 검증 가능한 사실', value: '연동 POS 8종' },
    },
  },
  {
    // 제조·부품 — 생산능력·특허·상장 여부가 확인 가능한 사실이다.
    match: /반도체|제조|장비|부품|소재|전자|기계|화학|바이오|통신|네트워크/,
    hints: {
      location: { claim: '본사·공장 주소', value: '경기도 이천시 부발읍' },
      price: { claim: '해당 없으면 비워 두세요', value: '' },
      spec: { claim: '생산 능력·주요 제품', value: 'DRAM 월 20만 장 생산' },
      certification: { claim: '인증·특허', value: 'ISO 14001 인증, 등록 특허 120건' },
      date: { claim: '설립·상장 연도', value: '1983년 설립, 1996년 상장' },
      other: { claim: '위에 안 맞는 검증 가능한 사실', value: '임직원 3만 1천 명 (2025년 말)' },
    },
  },
  {
    // 연구기관·공공 — 연구 인력과 지정 근거가 사실이다.
    match: /연구|기관|재단|진흥원|대학|학교|공사|공단/,
    hints: {
      location: { claim: '주소', value: '경기도 성남시 분당구' },
      price: { claim: '해당 없으면 비워 두세요', value: '' },
      spec: { claim: '연구 인력·조직', value: '연구원 420명, 5개 연구본부' },
      certification: { claim: '지정 근거', value: '과학기술정보통신부 출연연구기관' },
      date: { claim: '설립 연도', value: '1991년 설립' },
      other: { claim: '위에 안 맞는 검증 가능한 사실', value: '연간 논문 380편 (2025년)' },
    },
  },
]

function hintsFor(industry: string): HintSet {
  const p = PROFILES.find((x) => x.match.test(industry))
  return p ? { ...GENERIC, ...p.hints } : GENERIC
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
  const hints = hintsFor(tenant?.industry ?? '')

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
            <b> 값은 브리프의 인용용 문장에 글자 그대로 들어갑니다</b> — 짧고 정확하게 적으세요.
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
                      등록된 사실이 없습니다. 아래 "사실 추가"로 시작하세요 — {hints.spec.claim}, {hints.date.claim},{' '}
                      {hints.price.claim.replace(' (기간 명시)', '').replace(' (비수기·성수기 구분)', '')}처럼 AI가 자주 틀리는 것부터.
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
                        placeholder={hints[r.type].claim}
                        onChange={(e) => update(i, { claim: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        value={r.value}
                        placeholder={hints[r.type].value ? `예: ${hints[r.type].value}` : ''}
                        onChange={(e) => update(i, { value: e.target.value })}
                      />
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
