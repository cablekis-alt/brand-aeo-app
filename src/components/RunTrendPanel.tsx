import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunHistory, RunPoint, RunPostCell } from '../lib/api'
import { ENGINE_LABEL } from '../lib/format'
import { engineName, INDEXING_GRACE_DAYS, monthDay } from '../lib/publishTracking'
import { buildRunTrend, dayLabel, kstStamp, pct, type RunMark } from '../lib/runTrend'

const MIN_W = 520
const PAD = { left: 44, right: 16 }
const PIN_Y = 12
const ROWS_TOP = 28
const ROW_H = 16
const GRAPH_H = 150
const BOTTOM = 40

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

const MARK_TEXT: Record<RunMark, string> = {
  cited: '인용됨',
  none: '인용 없음',
  grace: `인용 없음 · 올린 지 ${INDEXING_GRACE_DAYS}일 안(색인 대기)`,
  unsure: '전후 불명(측정하던 날 올림)',
  weak: '인용 없음 · 엔진이 빠진 회차(근거 약함)',
  skip: '',
  unknown: '판정 기록 없음',
}

/** 회차의 엔진 성공/예정 — 「ChatGPT 26/26 · Gemini 12/26」. 예정 수를 모르는 옛 기록은 쓴 엔진만. */
function engineCounts(p: RunPoint): string {
  if (p.engines) {
    return Object.entries(p.engines)
      .map(([e, v]) => `${ENGINE_LABEL[e] ?? e} ${v.succeeded}/${v.planned}`)
      .join(' · ')
  }
  return p.enginesUsed.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')
}

function markTitle(p: RunPoint, c: RunPostCell | null, mark: RunMark): string {
  const parts = [p.at ? kstStamp(p.at) : shortWeek(p.weekOf)]
  if (c?.daysAfterPublish !== null && c?.daysAfterPublish !== undefined) parts.push(`D+${c.daysAfterPublish}`)
  parts.push(MARK_TEXT[mark])
  if (c && c.cited > 0) {
    const engines = Object.entries(c.byEngine)
      .map(([e, n]) => `${ENGINE_LABEL[e] ?? e} ${n}`)
      .join(' · ')
    parts.push(`인용 응답 ${c.cited}${engines ? `(${engines})` : ''}${c.unnamedCited !== null ? ` · 이름 없는 질문 ${c.unnamedCited}` : ''}`)
  }
  if (p.partialEngines.length || p.missingEngines.length) parts.push(`엔진: ${engineCounts(p)}`)
  return parts.join(' · ')
}

/** 점 제목 — 측정 시각 · 순위 응답 · 엔진 · 주 카드 여부. */
function dotTitle(p: RunPoint): string {
  const lines = [`${p.at ? kstStamp(p.at) : '시각 모름'} · ${shortWeek(p.weekOf)}`]
  lines.push(p.ranked ? `순위와 함께 불린 응답 ${p.ranked.k}/${p.ranked.n}` : '질문 은행을 못 찾아 셀 수 없음')
  lines.push(`엔진 ${engineCounts(p)}`)
  if (p.engineIssues.length) lines.push(p.engineIssues.join(' · '))
  if (p.kind === 'week-file') lines.push(`${shortWeek(p.weekOf)} 주 대표(옛 기록) — 그 주 마지막 측정 하나`)
  if (p.preserved) lines.push('회차 기록 전 측정을 옮겨 둔 것 — 예정 호출 수 · 판정 맥락 모름')
  if (p.isWeekCard) lines.push('지금 그 주 카드(막대 · 보고서 점수)')
  else if (p.weekCard === 'kept') lines.push(`주 카드 유지 — ${p.weekCardKeptReason ?? '엔진이 빠짐'}`)
  if (p.score !== null) lines.push(`점수(참고) ${p.score}`)
  return lines.join('\n')
}

function MarkShape({ mark, cx, cy, title }: { mark: RunMark; cx: number; cy: number; title: string }) {
  if (mark === 'skip') return null
  const t = <title>{title}</title>
  if (mark === 'unknown' || mark === 'weak') {
    return (
      <text className={`rt-mark-text ${mark}`} x={cx} y={cy + 4} textAnchor="middle">
        {t}
        {mark === 'unknown' ? '?' : '–'}
      </text>
    )
  }
  if (mark === 'unsure') {
    return (
      <g className="rt-mark unsure">
        {t}
        <circle cx={cx} cy={cy} r={4.5} />
        <path d={`M ${cx} ${cy - 4.5} A 4.5 4.5 0 0 0 ${cx} ${cy + 4.5} Z`} />
      </g>
    )
  }
  return (
    <circle className={`rt-mark ${mark}`} cx={cx} cy={cy} r={4.5}>
      {t}
    </circle>
  )
}

/**
 * 측정 회차별 보기 — 성과 화면. 같은 주에 여러 번 잰 회차를 시간순으로 늘어놓고, 올린 글이 회차마다 인용됐는지와 이름 없는
 * 질문의 답에서 순위와 함께 불린 응답 k/N을 앞세운다. 점수는 보조 한 줄이다(server/runHistory.ts 머리 주석). 회차 사이 대비 칩 ·
 * 저장된 신뢰구간 띠 · 코호트 순위는 그리지 않는다.
 */
export default function RunTrendPanel({
  history,
  selectedWeek,
  onSelectWeek,
}: {
  history: RunHistory
  selectedWeek?: string
  onSelectWeek?: (weekOf: string) => void
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const attach = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el
    setBox(el)
  }, [])
  const [boxW, setBoxW] = useState(0)
  useEffect(() => {
    if (!box) return
    const ro = new ResizeObserver(() => setBoxW(box.clientWidth))
    ro.observe(box)
    return () => ro.disconnect()
  }, [box])
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [box, boxW])

  const m = buildRunTrend(history)
  const points = history.points
  const days = Math.max(1, m.days.length)
  const dayW = Math.max(24, (Math.max(MIN_W, boxW) - PAD.left - PAD.right) / days)
  const W = PAD.left + PAD.right + dayW * days
  const innerW = dayW * days
  const graphTop = ROWS_TOP + m.rows.length * ROW_H + 18
  const H = graphTop + GRAPH_H + BOTTOM
  const x = (pos: number) => PAD.left + (pos / days) * innerW
  const maxUpper = Math.max(0, ...points.map((p) => p.ranked?.ci?.upper ?? 0))
  const top = Math.max(0.1, Math.ceil(maxUpper * 20) / 20)
  const y = (v: number) => graphTop + GRAPH_H - (Math.max(0, Math.min(top, v)) / top) * GRAPH_H
  const ticks = [0, top / 2, top]
  const weekStarts = m.days.map((d, i) => ({ d, i })).filter(({ d }) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1)
  const dailyTicks = dayW >= 36
  const selectedDays = selectedWeek
    ? m.days.map((d, i) => ({ d, i })).filter(({ i }) => points.some((p, k) => p.weekOf === selectedWeek && Math.floor(m.dots[k]!.x) === i))
    : []

  // 점 위 「k/N」 글자 — 붙은 점끼리 겹치지 않게 앞 글자와 30px 넘게 떨어진 점에만 단다(값은 점 제목 · 회차 표에 다 있다).
  const labeled = new Set<number>()
  {
    let lastX = -Infinity
    for (const d of [...m.dots].sort((a, b) => a.x - b.x)) {
      if (d.unknown || !points[d.i]!.ranked) continue
      if (x(d.x) - lastX >= 30) {
        labeled.add(d.i)
        lastX = x(d.x)
      }
    }
  }

  const latest = points.at(-1)
  const engineCount = latest?.enginesUsed.length ?? 0
  const spreadNote =
    latest?.agnosticQuestions && engineCount > 0
      ? `같은 ${latest.agnosticQuestions}문항을 엔진 ${engineCount}곳에${(latest.repeatsPerQuestion ?? 1) > 1 ? ` ${latest.repeatsPerQuestion}번씩` : ''} 물어 응답끼리 함께 움직이므로 실제 흔들림은 이 범위보다 큽니다.`
      : '응답끼리 함께 움직이므로 실제 흔들림은 이 범위보다 큽니다.'

  const latestDays = (cells: (RunPostCell | null)[]) =>
    cells.reduce<number | null>((n, c) => (c && c.timing === 'after' && !c.afterRemoval && c.daysAfterPublish !== null ? Math.max(n ?? 0, c.daysAfterPublish) : n), null)

  return (
    <div className="run-trend">
      <p className="hint" style={{ marginTop: 0 }}>
        이 브랜드를 잰 회차를 시간순으로 봅니다. 위 줄은 올린 글이 회차마다 인용됐는지, 아래 점은 카테고리 무관 질문(점수와 같은 기준 —
        브랜드 이름 없이 묻는 일반 질문)의 답 가운데 우리가 순위와 함께 불린 응답 수입니다.{' '}
        {m.sameDay
          ? `같은 날 같은 조건으로 다시 재도 크게 흔들립니다(이 브랜드 ${dayLabel(m.sameDay.date)} ${m.sameDay.scores.length}회 점수 ${m.sameDay.scores.join('·')}) — 회차 하나의 오르내림으로 판단하지 마세요.`
          : '같은 날 다시 재도 크게 흔들릴 수 있습니다 — 회차 하나의 오르내림으로 판단하지 마세요.'}
      </p>

      {m.rows.length === 0 ? (
        <p className="muted">올린 글 기록이 없어 회차별 인용은 없습니다.</p>
      ) : (
        <ul className="rt-post-list">
          {m.rows.map(({ posting, pin, label, sinceEdit }) => {
            const r = posting.item
            const d = latestDays(r.cells)
            const extras = [
              ...(r.weakRuns > 0 ? [`엔진 빠진 회차 ${r.weakRuns}${r.weakEngines.length ? `(${r.weakEngines.map(engineName).join(' · ')})` : ''}`] : []),
              ...(r.unsureRuns > 0 ? [`전후 불명 ${r.unsureRuns}회`] : []),
            ]
            let line: string
            if (r.measuredRuns === 0) line = '올린 뒤 회차 없음 — 다음 측정부터'
            else if (r.firstCited) {
              line =
                `첫 인용 확인 D+${r.firstCited.daysAfterPublish}` +
                (r.lastUncitedDaysBefore !== null ? `(직전 인용 없음 D+${r.lastUncitedDaysBefore})` : '') +
                ` · 인용된 회차 ${r.citedRuns}/${r.measuredRuns}` +
                (r.afterGrace.measured > 0 ? ` · 올린 지 ${INDEXING_GRACE_DAYS}일 지난 회차 ${r.afterGrace.cited}/${r.afterGrace.measured}` : '')
            } else {
              line =
                `아직 인용 없음 · 회차 0/${r.measuredRuns}` +
                (d !== null ? ` · 올린 지 ${d}일` : '') +
                (d !== null && d < INDEXING_GRACE_DAYS ? ` · 색인 대기(${INDEXING_GRACE_DAYS}일) 중` : '')
            }
            return (
              <li key={r.post.id} className="rt-post-line">
                {pin !== null && (
                  <span className="st-key exec rt-label" aria-hidden="true">
                    {label}
                  </span>
                )}
                <b>{r.post.articleTitle ?? r.post.articleId}</b>
                {posting.places.map((place) => (
                  <span key={place} className="st st-info">
                    {place}
                  </span>
                ))}
                <span className="muted">
                  {r.post.publishedOn ? `${monthDay(r.post.publishedOn)} 올림` : '올린 날 모름'}
                  {r.post.edits && r.post.edits.length > 0 && ` · ${r.post.edits.map((e) => monthDay(e.editedOn)).join(' · ')} 고침`}
                </span>
                <div className="doc-meta">
                  {line}
                  {extras.length > 0 && ` · ${extras.join(' · ')}`}
                </div>
                {/* 고친 글 — 고친 글을 본 회차만 따로 센다(옛 글 · 새 글을 가르려고). */}
                {sinceEdit && (
                  <div className="doc-meta">
                    {sinceEdit.measured === 0
                      ? `${monthDay(sinceEdit.editedOn)} 고친 뒤 회차 없음 — 다음 측정부터`
                      : `${monthDay(sinceEdit.editedOn)} 고친 뒤 인용된 회차 ${sinceEdit.cited}/${sinceEdit.measured}` +
                        (sinceEdit.firstCitedDays !== null ? ` · 고친 뒤 첫 인용 D+${sinceEdit.firstCitedDays}` : '')}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <figure className="score-trend">
        <div className="score-trend-scroll" ref={attach}>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`측정 회차 ${points.length}번 — ${points
              .map((p) => `${p.at ? kstStamp(p.at) : shortWeek(p.weekOf)} 순위 응답 ${p.ranked ? `${p.ranked.k}/${p.ranked.n}` : '확인 불가'}`)
              .join(', ')}`}
          >
            {selectedDays.map(({ i }) => (
              <rect key={`sel-${i}`} className="rt-week-on" x={x(i)} width={dayW} y={0} height={H - BOTTOM + 4} />
            ))}
            {m.pins.map((pin) => (
              <rect key={`grace-${pin.n}`} className="rt-grace" x={x(pin.x)} width={Math.max(0, x(pin.graceEndX) - x(pin.x))} y={0} height={H - BOTTOM + 4}>
                <title>{`올린 뒤 ${INDEXING_GRACE_DAYS}일 — 색인 대기`}</title>
              </rect>
            ))}
            {weekStarts.map(({ d, i }) => (
              <line key={`wk-${d}`} className="st-grid" x1={x(i)} x2={x(i)} y1={ROWS_TOP - 6} y2={graphTop + GRAPH_H} />
            ))}
            {ticks.map((t) => (
              <g key={t}>
                <line className="st-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="st-axis" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {pct(t)}
                </text>
              </g>
            ))}

            {m.pins.map((pin) => (
              <g key={`pin-${pin.n}`} className="st-exec-pin">
                <title>{pin.postings.map((p) => `${monthDay(pin.date)} 「${p.post.articleTitle ?? p.post.articleId}」 ${p.places.join(' · ')}`).join('\n')}</title>
                <line className="st-exec" x1={x(pin.x)} x2={x(pin.x)} y1={PIN_Y + 7} y2={graphTop + GRAPH_H} />
                <circle className="st-exec-dot" cx={x(pin.x)} cy={PIN_Y} r={7} />
                <text className="st-exec-num" x={x(pin.x)} y={PIN_Y + 3.5} textAnchor="middle">
                  {pin.n}
                </text>
              </g>
            ))}

            {m.rows.map((row, r) => {
              const cy = ROWS_TOP + r * ROW_H + ROW_H / 2
              return (
                <g key={`row-${row.posting.item.post.id}`}>
                  <text className="st-axis" x={PAD.left - 6} y={cy + 4} textAnchor="end">
                    {`글${row.label}`}
                  </text>
                  {/* 고친 날 — 그 줄에 짧은 점선. 이 선 뒤 회차가 고친 글을 본 측정이다. */}
                  {row.edits
                    .filter((e) => e.x !== null)
                    .map((e) => (
                      <line key={`edit-${e.date}`} className="rt-edit" x1={x(e.x!)} x2={x(e.x!)} y1={cy - ROW_H / 2 + 2} y2={cy + ROW_H / 2 - 2}>
                        <title>{`글${row.label} ${monthDay(e.date)} 고침 — 이 뒤 회차가 고친 글을 본 측정`}</title>
                      </line>
                    ))}
                  {row.marks.map((mark, k) => (
                    <MarkShape
                      key={k}
                      mark={mark}
                      cx={x(m.dots[k]!.x)}
                      cy={cy}
                      title={`글${row.label} ${row.posting.places.join(' · ')} · ${markTitle(points[k]!, row.posting.item.cells[k] ?? null, mark)}`}
                    />
                  ))}
                </g>
              )
            })}

            {m.breaks.map((b, k) => (
              <g key={`brk-${k}`}>
                <title>{`${b.text} — 앞뒤를 잇지 않음`}</title>
                <line className="st-break" x1={x(b.x)} x2={x(b.x)} y1={graphTop - 6} y2={graphTop + GRAPH_H} />
                <rect className="st-break-mark" x={x(b.x) - 4} y={graphTop - 10} width={8} height={8} transform={`rotate(45 ${x(b.x)} ${graphTop - 6})`} />
              </g>
            ))}

            {m.segments
              .filter((seg) => seg.length > 1)
              .map((seg) => (
                <polyline
                  key={`line-${seg[0]}`}
                  className="st-line"
                  points={seg.map((i) => `${x(m.dots[i]!.x)},${y(points[i]!.ranked!.k / Math.max(1, points[i]!.ranked!.n))}`).join(' ')}
                />
              ))}

            {m.dots.map((d) => {
              const p = points[d.i]!
              const cx = x(d.x)
              const current = p.weekOf === selectedWeek
              const select = onSelectWeek ? () => onSelectWeek(p.weekOf) : undefined
              if (d.unknown || !p.ranked) {
                return (
                  <text key={`dot-${d.i}`} className="st-week none" x={cx} y={graphTop + GRAPH_H - 4} textAnchor="middle" onClick={select}>
                    <title>{dotTitle(p)}</title>?
                  </text>
                )
              }
              const v = p.ranked.k / Math.max(1, p.ranked.n)
              const ci = p.ranked.ci
              return (
                <g key={`dot-${d.i}`} onClick={select} style={select ? { cursor: 'pointer' } : undefined}>
                  <title>{dotTitle(p)}</title>
                  {ci && (
                    <g className="rt-ci">
                      <line x1={cx} x2={cx} y1={y(ci.upper)} y2={y(ci.lower)} />
                      <line x1={cx - 3} x2={cx + 3} y1={y(ci.upper)} y2={y(ci.upper)} />
                      <line x1={cx - 3} x2={cx + 3} y1={y(ci.lower)} y2={y(ci.lower)} />
                    </g>
                  )}
                  {d.legacy ? (
                    <rect className="rt-base" x={cx - 3.5} y={y(v) - 3.5} width={7} height={7} />
                  ) : (
                    <circle className={d.isolated ? 'rt-dot-partial' : `st-dot${current ? ' current' : ''}`} cx={cx} cy={y(v)} r={current ? 5 : 4} />
                  )}
                  {labeled.has(d.i) && (
                    <text className="st-value" x={cx} y={y(v) - 9} textAnchor="middle">
                      {`${p.ranked.k}/${p.ranked.n}`}
                    </text>
                  )}
                </g>
              )
            })}

            {m.days.map((d, i) =>
              dailyTicks || new Date(`${d}T00:00:00Z`).getUTCDay() === 1 ? (
                <text key={`day-${d}`} className="st-axis" x={x(i + 0.5)} y={graphTop + GRAPH_H + 16} textAnchor="middle">
                  {dayLabel(d)}
                </text>
              ) : null,
            )}
            {[...new Set(points.map((p) => p.weekOf))].map((weekOf) => {
              const idx = points.map((p, k) => (p.weekOf === weekOf ? m.dots[k]!.x : null)).filter((v): v is number => v !== null)
              return (
                <text key={`w-${weekOf}`} className="st-week" x={x((Math.min(...idx) + Math.max(...idx)) / 2)} y={graphTop + GRAPH_H + 32} textAnchor="middle">
                  {shortWeek(weekOf)}
                </text>
              )
            })}
          </svg>
        </div>
        <figcaption className="score-trend-legend">
          <span>
            <span className="rt-key cited" aria-hidden="true" /> 인용된 회차
          </span>
          <span>
            <span className="rt-key none" aria-hidden="true" /> 인용 없음
          </span>
          <span>
            <span className="rt-key grace" aria-hidden="true" /> 올린 지 {INDEXING_GRACE_DAYS}일 안 인용 없음(색인 대기)
          </span>
          <span>◐ 전후 불명 · – 엔진이 빠진 회차의 인용 없음(근거 약함)</span>
          <span>
            세로 막대 = 그 회차 응답 수로 본 대략의 범위(95%, Clopper–Pearson). {spreadNote}
          </span>
          <span>
            <span className="rt-key partial" aria-hidden="true" /> 엔진이 빠졌거나 일부만 들어온 회차 — 잇지 않음
          </span>
          <span>
            <span className="rt-key base" aria-hidden="true" /> 옛 기록(회차 기록 전 그 주 마지막 측정) — 잇지 않음
          </span>
          {m.breaks.map((b, k) => (
            <span key={k} className="st-key-break">
              <span className="st-key diamond" aria-hidden="true" /> {b.text} 바뀜 — 앞뒤를 잇지 않음
            </span>
          ))}
          {m.pins.length > 0 && <span>번호 핀 = 올린 날 · 옅은 띠 = 올린 뒤 {INDEXING_GRACE_DAYS}일</span>}
        </figcaption>
      </figure>

      <p className="hint">
        점수(참고 · 같은 조건 회차의 평균):{' '}
        {m.scoreLine
          .map((w) =>
            w.scores.length === 0
              ? w.isolated + w.unknown === 0
                ? `${shortWeek(w.weekOf)} 옛 기록만${w.bar !== null ? `(막대 ${w.bar}점)` : ''}`
                : `${shortWeek(w.weekOf)} 평균 낼 회차 없음(${[
                    ...(w.legacy ? [`옛 기록 ${w.legacy}`] : []),
                    ...(w.isolated ? [`엔진 빠진 회차 ${w.isolated}`] : []),
                    ...(w.unknown ? [`질문지 못 찾은 회차 ${w.unknown}`] : []),
                  ].join(' · ')})${w.bar !== null ? ` — 막대 ${w.bar}점` : ''}`
              : w.mixed
                ? `${shortWeek(w.weekOf)} 조건 섞임 — 평균 안 냄(${w.scores.join('·')})`
                : `${shortWeek(w.weekOf)} 회차 평균 ${w.mean}(${w.scores.length}회: ${w.scores.join('·')})${w.bar !== null ? ` — 위 막대는 그 주 카드 ${w.bar}점` : ''}`,
          )
          .join(' · ')}
      </p>

      <details>
        <summary>회차 표 ({points.length}회)</summary>
        <div className="table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th>측정 시각</th>
                <th>주차</th>
                <th>방식</th>
                <th>엔진 성공/예정</th>
                <th>순위 든 응답</th>
                {m.rows.map((row) => (
                  <th key={row.posting.item.post.id} title={`${row.posting.item.post.articleTitle ?? ''} · ${row.posting.places.join(' · ')}`}>
                    {`글${row.label}`}
                  </th>
                ))}
                <th>점수</th>
                <th>주 카드</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p, k) => (
                <tr key={`${p.weekOf}-${p.runId ?? 'week'}`}>
                  <td>{p.at ? kstStamp(p.at) : '시각 모름'}</td>
                  <td>{shortWeek(p.weekOf)}</td>
                  <td>{p.kind === 'week-file' ? '옛 기록' : p.preserved ? '옮겨 둔 옛 측정' : p.inCohortRun ? '경쟁사로 측정' : p.selfOnly ? '이 브랜드만' : '함께 측정'}</td>
                  <td>{engineCounts(p)}</td>
                  <td className="num">{p.ranked ? `${p.ranked.k}/${p.ranked.n}` : '확인 불가'}</td>
                  {m.rows.map((row) => {
                    const mark = row.marks[k]!
                    return (
                      <td key={row.posting.item.post.id} title={MARK_TEXT[mark] || undefined}>
                        {{ cited: '●', none: '○', grace: '◌', unsure: '◐', weak: '–', skip: '', unknown: '?' }[mark]}
                      </td>
                    )
                  })}
                  <td className="num">{p.score ?? '?'}</td>
                  <td>{p.isWeekCard ? '지금 주 카드' : p.weekCard === 'kept' ? `유지 — ${p.weekCardKeptReason ?? ''}` : p.kind === 'week-file' ? '—' : '뒤 회차로 바뀜'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {history.issues.length > 0 && <p className="hint">회차 기록 {history.issues.length}개를 읽지 못해 뺐습니다: {history.issues.join(' · ')}</p>}
    </div>
  )
}
