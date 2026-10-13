import { useEffect, useRef, useState } from 'react'
import { loadCompetitorEditor, type CompetitorEditorState, type EditorCompetitorRow } from '../lib/api'
import { topicParticle, withParticle } from '../lib/korean'

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; value: CompetitorEditorState }

/**
 * 경쟁사 편집 서랍(상용화 UI 11차) — 브랜드 현황 코호트 카드에서 오른쪽에 연다. 화면을 어둡게 깔지 않는다:
 * 리더보드를 보면서 고치라는 서랍이다.
 *
 * 「함께 측정 5/5 · 대기」와 줄 순서는 서버가 측정과 같은 함수로 계산해 준다(server/cohortPlan.ts) — 화면이
 * 경쟁사 수로 세면 칸 안의 이름 겹침 때문에 실제 측정과 어긋난다.
 */
export default function CompetitorEditor({ tenantId, onClose }: { tenantId: string; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [pastOpen, setPastOpen] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let alive = true
    loadCompetitorEditor(tenantId).then(
      (value) => alive && setLoad({ status: 'ok', value }),
      (err: unknown) => {
        console.error('[CompetitorEditor] 경쟁사 목록을 불러오지 못했습니다', err)
        if (alive) setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  // 열면 서랍 제목으로 초점을 옮기고, 닫으면 연 자리로 돌려준다.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    headingRef.current?.focus()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const s = load.status === 'ok' ? load.value : null
  const slotRows = s?.rows.filter((r) => r.takesSlot) ?? []
  const restRows = s?.rows.filter((r) => !r.takesSlot && r.status !== 'unnamed') ?? []
  const top = Math.max(1, s?.baseline?.score ?? 0, ...(s?.rows.map((r) => r.latest?.score ?? 0) ?? []))
  const neverMeasured = s?.rows.find((r) => r.status === 'waiting' && !r.latest)

  return (
    <aside className="ce-drawer" aria-labelledby="ce-title">
      <div className="ce-head">
        <div className="ce-title-row">
          <h2 id="ce-title" ref={headingRef} tabIndex={-1}>
            경쟁사 편집
          </h2>
          {s && (
            <>
              <span
                className={`chip ${s.blockedCount > 0 ? 'warn' : s.measuredCount === s.cap ? 'good' : ''}`}
                title={
                  s.blockedCount > 0
                    ? `${s.blockedCount}곳은 칸을 쓰지만 측정되지 않아요`
                    : s.measuredCount < s.cap
                      ? `빈 칸 ${s.cap - s.measuredCount}개 — 경쟁사를 더 넣을 수 있어요`
                      : undefined
                }
              >
                함께 측정 {s.measuredCount}/{s.cap}
              </span>
              {s.waitingCount > 0 && <span className="chip">대기 {s.waitingCount}</span>}
            </>
          )}
          <button type="button" className="ce-close" onClick={onClose} aria-label="경쟁사 편집 닫기">
            ✕
          </button>
        </div>
        {s && (
          <p className="ce-sub">
            {s.brandName} · {s.industry} · {s.region} · <b>바꾼 내용은 다음 측정부터 적용돼요</b>
          </p>
        )}
        {neverMeasured && (
          <p className="ce-alert warn">
            {topicParticle(neverMeasured.name)} 한 번도 측정되지 않았어요. 경쟁사는 {s?.cap}곳까지만 함께 측정해요.
          </p>
        )}
        {s?.measuring && <p className="ce-alert">측정이 진행 중이에요. 끝난 뒤에 바꿀 수 있어요.</p>}
      </div>

      <div className="ce-body">
        {load.status === 'loading' && <p className="muted">불러오는 중…</p>}
        {load.status === 'error' && (
          <p className="error" role="alert">
            {load.message}
          </p>
        )}
        {s && (
          <>
            <div className="ce-us">
              <b>{s.brandName}</b>
              <span className="ce-us-tag">우리</span>
              <span className="ce-us-meta">
                {s.baseline
                  ? `${s.baseline.score}점 · 코호트 ${s.baseline.tied ? '공동 ' : ''}${s.baseline.rank}위 / ${s.baseline.totalTenants} · ${shortWeek(s.baseline.weekOf)}`
                  : '측정 전'}
              </span>
            </div>

            <div className="ce-cols" aria-hidden="true">
              <span>순서</span>
              <span>경쟁사</span>
              <span>{s.baseline ? `${shortWeek(s.baseline.weekOf)} 점수` : '점수'}</span>
              <span>비교 질문</span>
            </div>
            <ol className="ce-rows">
              {slotRows.map((r, i) => (
                <Row key={r.index} r={r} n={String(i + 1)} top={top} ours={s.baseline?.score ?? null} baselineWeek={s.baseline?.weekOf ?? null} />
              ))}
            </ol>

            <div
              className="ce-cap"
              title={`한 번에 ${s.cap}곳까지만 함께 재요. 그 아래는 대기로 두고 측정하지 않아요. 위에서 빼거나 바꾸면 대기 첫 줄이 올라와요.`}
            >
              <span>여기까지 함께 측정 · {s.cap}곳</span>
            </div>

            {restRows.length > 0 ? (
              <ol className="ce-rows wait">
                {restRows.map((r) => (
                  <Row key={r.index} r={r} n="대기" top={top} ours={s.baseline?.score ?? null} baselineWeek={s.baseline?.weekOf ?? null} />
                ))}
              </ol>
            ) : (
              <p className="ce-empty">대기 중인 경쟁사가 없어요.</p>
            )}

            {s.past.length > 0 && (
              <section className="ce-past">
                <button type="button" className="ce-past-toggle" aria-expanded={pastOpen} onClick={() => setPastOpen(!pastOpen)}>
                  예전 경쟁사 {s.past.length} {pastOpen ? '▾' : '▸'}
                </button>
                {pastOpen && (
                  <ul>
                    {s.past.map((p) => (
                      <li key={p.tenantId}>
                        <b>{p.brandName}</b>
                        <span>
                          지난 기록 {p.weeks}주 · 마지막 {shortWeek(p.lastWeekOf)} {p.lastScore}점
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <p className="ce-bank">
              질문지 {s.questionBank.version}
              {s.questionBank.exists
                ? ` · 공통 ${s.questionBank.sharedCount} · 브랜드 ${s.questionBank.brandCount}`
                : ` · 다음 측정 때 새로 만들어요`}
              <span
                className="ce-hint"
                title={`점수와 순위는 같은 코호트에 똑같이 묻는 공통 질문${s.questionBank.exists ? ` ${s.questionBank.sharedCount}개` : ''}로 매겨요. 비교 질문은 브랜드 질문이에요.`}
              >
                ?
              </span>
            </p>
          </>
        )}
      </div>
    </aside>
  )
}

function Row({
  r,
  n,
  top,
  ours,
  baselineWeek,
}: {
  r: EditorCompetitorRow
  n: string
  top: number
  ours: number | null
  baselineWeek: string | null
}) {
  const chips: { text: string; tone: string; title?: string }[] = []
  if (r.status === 'collision' && r.collidesWith) {
    chips.push({
      text: '이름 겹침 · 측정 안 됨',
      tone: 'bad',
      title: `${withParticle(`${r.collidesWith.brandName}(${r.collidesWith.industry} · ${r.collidesWith.region})`)} id가 같아 함께 재지 않아요`,
    })
  }
  if (r.status === 'duplicate') chips.push({ text: '같은 곳 중복', tone: 'warn', title: '앞 줄과 같은 브랜드로 재요 · 한 번만 측정해요' })
  if (r.status === 'waiting') {
    chips.push(r.latest ? { text: '대기', tone: '', title: '지금은 칸이 차서 재지 않아요' } : { text: '측정 안 됨', tone: 'warn' })
  }
  if (r.otherRegion) chips.push({ text: '다른 지역으로 잼', tone: 'info', title: '다른 지역에 등록된 같은 브랜드로 재요 · 이 순위표에는 나오지 않아요' })
  if (r.existingCustomer) chips.push({ text: '고객 브랜드', tone: 'info', title: '다른 고객 브랜드를 그 브랜드 설정으로 재요' })
  if (r.deleted) chips.push({ text: '지운 브랜드', tone: 'warn', title: '지운 브랜드와 id가 같아요 · 측정하면 지난 기록이 다시 살아나요' })

  const score = r.latest?.score
  const staleWeek = r.latest && baselineWeek && r.latest.weekOf !== baselineWeek ? shortWeek(r.latest.weekOf) : null
  return (
    <li className={`ce-row${r.takesSlot ? '' : ' wait'}`}>
      <span className="ce-n">{n}</span>
      <span className="ce-name">
        <span className="ce-name-line">
          <b>{r.name}</b>
          {chips.map((c) => (
            <span key={c.text} className={`chip ${c.tone}`} title={c.title}>
              {c.text}
            </span>
          ))}
        </span>
        <span className="ce-domain">{r.domains[0] ?? '홈페이지 없음'}</span>
      </span>
      <span className="ce-score" title={r.latest ? `${shortWeek(r.latest.weekOf)} · 1회 측정` : '측정 기록 없음'}>
        <span className="ce-score-num">
          {score ?? '—'}
          {staleWeek && <small> {staleWeek}</small>}
        </span>
        <span className="ce-score-bar" aria-hidden="true">
          <span style={{ width: `${score === undefined ? 0 : Math.max(3, Math.round((score / top) * 100))}%` }} />
          {ours !== null && <i style={{ left: `${Math.min(100, Math.round((ours / top) * 100))}%` }} />}
        </span>
      </span>
      <span className={`ce-q${r.questionIds.length ? '' : ' none'}`}>{r.questionIds.length ? r.questionIds.join(' · ') : '비교 질문 없음'}</span>
    </li>
  )
}
