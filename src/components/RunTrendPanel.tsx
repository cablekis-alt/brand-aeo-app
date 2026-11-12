import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RunHistory, RunPoint } from '../lib/api'
import { ENGINE_LABEL } from '../lib/format'
import { monthDay } from '../lib/publishTracking'
import { buildRunTrend, dayLabel, kstStamp, pct, type RunPin } from '../lib/runTrend'

const MIN_W = 520
const PAD = { left: 44, right: 16 }
const PIN_Y = 10
const GRAPH_TOP = 34
const GRAPH_H = 150
const BOTTOM = 40
/** 올린 날 점 제목에 늘어놓는 글 제목 수 — 하루 수십 편이면 나머지는 「외 n편」. */
const PIN_TITLES = 5

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

/** 회차의 엔진 성공/예정 — 「ChatGPT 26/26 · Gemini 12/26」. 예정 수를 모르는 옛 기록은 쓴 엔진만. */
function engineCounts(p: RunPoint): string {
  if (p.engines) {
    return Object.entries(p.engines)
      .map(([e, v]) => `${ENGINE_LABEL[e] ?? e} ${v.succeeded}/${v.planned}`)
      .join(' · ')
  }
  return p.enginesUsed.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')
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

/** 올린 날 점 제목 — 「10/21 올린 글 2편」과 제목 몇 개. 같은 글을 두 곳에 올리면 제목이 같아 올린 곳을 붙인다. */
function pinTitle(pin: RunPin): string {
  const titles = pin.postings.map((p) => `「${p.post.articleTitle ?? p.post.articleId}」 ${p.places.join(' · ')}`.trim())
  const more = titles.length > PIN_TITLES ? [`외 ${titles.length - PIN_TITLES}편`] : []
  return [`${monthDay(pin.date)} 올린 글 ${titles.length}편`, ...titles.slice(0, PIN_TITLES), ...more].join('\n')
}

/**
 * 측정 회차별 보기 — 성과 화면. 같은 주에 여러 번 잰 회차를 시간순으로 늘어놓고, 이름 없는 질문의 답에서 순위와 함께 불린 응답
 * k/N을 앞세운다. 점수는 보조 한 줄이다(server/runHistory.ts 머리 주석). 회차 사이 대비 칩 · 저장된 신뢰구간 띠 · 코호트 순위는
 * 그리지 않는다.
 *
 * 글별 줄(글 목록 · 회차마다 인용 점 · 날짜별 합계의 글 칸 · 회차 표의 글 열)은 뺐다(2026-11-12 사용자 「뭘 의미하는지 어렵게 되어
 * 있네요」) — 작성자 글이 브랜드마다 80편을 넘자 군산각에서 줄이 85개, 절 높이가 1만 px을 넘어 본론인 회차 점이 맨 아래에 묻혔다.
 * 글마다의 인용은 발행 현황 「AI 인용」 칸과 정기진단 보고서 「집행한 글과 인용」 표가 보인다. 올린 날만 번호 없는 세로선으로 남긴다.
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
  const H = GRAPH_TOP + GRAPH_H + BOTTOM
  const x = (pos: number) => PAD.left + (pos / days) * innerW
  const maxUpper = Math.max(0, ...points.map((p) => p.ranked?.ci?.upper ?? 0))
  const top = Math.max(0.1, Math.ceil(maxUpper * 20) / 20)
  const y = (v: number) => GRAPH_TOP + GRAPH_H - (Math.max(0, Math.min(top, v)) / top) * GRAPH_H
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

  return (
    <div className="run-trend">
      <p className="hint" style={{ marginTop: 0 }}>
        이 브랜드를 잰 회차를 시간순으로 봅니다. 점은 카테고리 무관 질문(점수와 같은 기준 — 브랜드 이름 없이 묻는 일반 질문)의 답
        가운데 우리가 순위와 함께 불린 응답 수입니다.{' '}
        {m.sameDay
          ? `같은 날 같은 조건으로 다시 재도 크게 흔들립니다(이 브랜드 ${dayLabel(m.sameDay.date)} ${m.sameDay.scores.length}회 점수 ${m.sameDay.scores.join('·')}) — 회차 하나의 오르내림으로 판단하지 마세요.`
          : '같은 날 다시 재도 크게 흔들릴 수 있습니다 — 회차 하나의 오르내림으로 판단하지 마세요.'}
      </p>
      {m.rows.length > 0 && (
        <p className="hint" style={{ marginTop: 0 }}>
          올린 글마다 인용됐는지는 <Link to="/publish-status">발행 현황</Link>의 「AI 인용」 칸에서 봅니다.
        </p>
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
            {weekStarts.map(({ d, i }) => (
              <line key={`wk-${d}`} className="st-grid" x1={x(i)} x2={x(i)} y1={GRAPH_TOP - 12} y2={GRAPH_TOP + GRAPH_H} />
            ))}
            {ticks.map((t) => (
              <g key={t}>
                <line className="st-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="st-axis" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {pct(t)}
                </text>
              </g>
            ))}

            {/* 올린 날 — 번호 없는 세로선. 하루에 올린 글이 많아도 선 하나, 편 수와 제목은 점 제목에. */}
            {m.pins.map((pin) => (
              <g key={`pin-${pin.date}`} className="st-exec-pin">
                <title>{pinTitle(pin)}</title>
                <line className="st-exec" x1={x(pin.x)} x2={x(pin.x)} y1={PIN_Y + 4} y2={GRAPH_TOP + GRAPH_H} />
                <circle className="st-exec-dot" cx={x(pin.x)} cy={PIN_Y} r={4} />
              </g>
            ))}

            {m.breaks.map((b, k) => (
              <g key={`brk-${k}`}>
                <title>{`측정 조건: ${b.text} — 앞뒤를 잇지 않음`}</title>
                <line className="st-break" x1={x(b.x)} x2={x(b.x)} y1={GRAPH_TOP - 6} y2={GRAPH_TOP + GRAPH_H} />
                <rect className="st-break-mark" x={x(b.x) - 4} y={GRAPH_TOP - 10} width={8} height={8} transform={`rotate(45 ${x(b.x)} ${GRAPH_TOP - 6})`} />
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
                  <text key={`dot-${d.i}`} className="st-week none" x={cx} y={GRAPH_TOP + GRAPH_H - 4} textAnchor="middle" onClick={select}>
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
                <text key={`day-${d}`} className="st-axis" x={x(i + 0.5)} y={GRAPH_TOP + GRAPH_H + 16} textAnchor="middle">
                  {dayLabel(d)}
                </text>
              ) : null,
            )}
            {[...new Set(points.map((p) => p.weekOf))].map((weekOf) => {
              const idx = points.map((p, k) => (p.weekOf === weekOf ? m.dots[k]!.x : null)).filter((v): v is number => v !== null)
              return (
                <text key={`w-${weekOf}`} className="st-week" x={x((Math.min(...idx) + Math.max(...idx)) / 2)} y={GRAPH_TOP + GRAPH_H + 32} textAnchor="middle">
                  {shortWeek(weekOf)}
                </text>
              )
            })}
          </svg>
        </div>
        <figcaption className="score-trend-legend">
          <span>
            세로 막대 = 그 회차 응답 수로 본 대략의 범위(95%, Clopper–Pearson). {spreadNote}
          </span>
          <span>
            <span className="rt-key partial" aria-hidden="true" /> 엔진이 빠졌거나 일부만 들어온 회차 — 잇지 않음
          </span>
          <span>
            <span className="rt-key base" aria-hidden="true" /> 옛 기록(회차 기록 전 그 주 마지막 측정) — 잇지 않음
          </span>
          {/* b.text는 바뀐 조건(이름 그대로)과 「… 기록 없음」이 섞인다 — 기록이 없는 것을 「바뀜」이라 하지 않는다. */}
          {m.breaks.map((b, k) => (
            <span key={k} className="st-key-break">
              <span className="st-key diamond" aria-hidden="true" /> 측정 조건: {b.text} — 앞뒤를 잇지 않음
            </span>
          ))}
          {m.pins.length > 0 && <span>위 점과 세로선 = 글을 올린 날(점에 마우스를 올리면 편 수 · 제목)</span>}
        </figcaption>
      </figure>

      {m.daily && (
        <section aria-label="날짜별 합계">
          <h4 style={{ margin: '12px 0 4px' }}>날짜별 합계</h4>
          <p className="hint" style={{ marginTop: 0 }}>
            같은 날, 같은 조건으로 끝까지 잰 회차만 합쳤습니다(옛 기록 · 엔진이 빠진 회차는 뺍니다). 같은 질문을 다시 물은 합이라 회차가
            늘어도 흔들림이 그만큼 줄지는 않습니다 — 날짜끼리의 오르내림으로 판단하지 마세요. 점수 칸은 그날 회차 점수를 늘어놓은 것이고
            평균이 아닙니다.
          </p>
          <div className="table-wrap">
            <table className="rt-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>합친 회차</th>
                  <th title="카테고리 무관 질문 응답 가운데 우리 이름이 나온 응답 / 응답 합">언급(카테고리 무관)</th>
                  <th>순위 든 응답</th>
                  <th>점수(참고)</th>
                </tr>
              </thead>
              <tbody>
                {m.daily.map((d) => {
                  const dropped = [
                    ...(d.legacy ? [`옛 기록 ${d.legacy} 뺌`] : []),
                    ...(d.isolated ? [`엔진 빠진 회차 ${d.isolated} 뺌`] : []),
                    ...(d.unknown ? [`질문지 못 찾은 회차 ${d.unknown} 뺌`] : []),
                  ]
                  return (
                    <tr key={d.date}>
                      <td>{dayLabel(d.date)}</td>
                      <td>{d.mixed ? '조건 섞임 — 합치지 않음' : [`${d.runs}회`, ...dropped].join(' · ')}</td>
                      <td>{d.mentioned ? `${d.mentioned.k}/${d.mentioned.n}` : '—'}</td>
                      <td>{d.ranked ? `${d.ranked.k}/${d.ranked.n}` : '—'}</td>
                      <td>{d.scores.length > 0 ? d.scores.join(' · ') : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
                <th>점수</th>
                <th>주 카드</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={`${p.weekOf}-${p.runId ?? 'week'}`}>
                  <td>{p.at ? kstStamp(p.at) : '시각 모름'}</td>
                  <td>{shortWeek(p.weekOf)}</td>
                  <td>{p.kind === 'week-file' ? '옛 기록' : p.preserved ? '옮겨 둔 옛 측정' : p.inCohortRun ? '경쟁사로 측정' : p.selfOnly ? '이 브랜드만' : '함께 측정'}</td>
                  <td>{engineCounts(p)}</td>
                  <td className="num">{p.ranked ? `${p.ranked.k}/${p.ranked.n}` : '확인 불가'}</td>
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
