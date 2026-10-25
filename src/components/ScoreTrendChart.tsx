import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryWeek, PublishedPost } from '../lib/api'
import { compareConditions, diffText } from '../lib/comparability'
import { executionMarks, pinLegend, postingLegend, type ExecutionPin } from '../lib/publishTracking'
import type { WeeklyScorecard } from '../prompts/b8-report'
import { previousIsoWeek } from '../prompts/isoWeek'

interface Slot {
  weekOf: string
  card: WeeklyScorecard | null
}

interface Break {
  /** 조건이 바뀐 뒤 첫 주차의 칸 번호. 선은 이 칸 앞에서 끊긴다. */
  at: number
  weekOf: string
  detail: string
}

const MAX_WEEKS = 12
/*
 * 크기 — 가로는 카드 폭을 그대로 쓰고(늘려도 글자는 커지지 않는다) 세로는 고정한다. 예전에는 640×230 그림을
 * 카드 폭까지 통째로 키워, 넓은 화면에서 높이가 400px을 넘었다. 좁은 화면에서는 주차 글자가 겹치지 않는
 * 최소 폭(MIN_W)을 지키고 가로로 넘긴다.
 */
const MIN_W = 520
const H = 190
const PAD = { left: 44, right: 40, top: 22, bottom: 50 }
/** 집행 핀 줄 — 핀이 있을 때만 위쪽을 이만큼 늘려 따로 둔다(점 · 값 · 조건 변경 표시와 겹치지 않게). */
const PIN_ROW = 18
const PIN_Y = 12
/** 양 끝 틈 핀을 그림 안쪽 끝에서 띄우는 거리 — 핀 원 지름(14) + 선 두께보다 넓게. */
const PIN_EDGE = 16
/** 범례에 이름을 적는 핀 수 — 나머지는 「외 n편」. */
const PIN_LEGEND = 4

/** 끝 주차에서 거슬러 최대 12주 — 측정 기록이 시작된 주보다 앞은 자른다. 측정하지 않은 주는 빈칸으로 둔다. */
function slotsOf(history: WeeklyScorecard[], endWeek: string): Slot[] {
  const byWeek = new Map(history.map((h) => [h.weekOf, h]))
  const first = history[0]?.weekOf ?? endWeek
  const out: Slot[] = []
  let w: string | null = endWeek
  while (w && out.length < MAX_WEEKS) {
    out.unshift({ weekOf: w, card: byWeek.get(w) ?? null })
    if (w <= first) break
    w = previousIsoWeek(w)
  }
  return out
}

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

/**
 * 주차별 Brand AEO Score 추이 — 정기진단 보고서.
 *
 * 같은 조건(질문지·수집 엔진·판정 엔진·모델·반복 횟수)으로 잰 주끼리만 선으로 잇는다. 조건이 바뀐 곳에서
 * 선을 끊고 표시를 단다 — 이어 그리면 질문지가 바뀌어 생긴 차이(실측: 스테이,머뭄 W39 22 → W40 8, 질문지
 * v3→v4)가 성과 하락으로 읽힌다. 판정 규칙은 대시보드의 전주 대비 칩과 같다(lib/comparability).
 * 측정하지 않은 주도 빈칸으로 남겨 건너뛰어 잇지 않는다. 띠는 각 주 카드의 95% 신뢰구간이다(한 번 잰 값의
 * 흔들림을 숫자와 함께 보인다).
 *
 * executions를 주면 올린 글을 번호 핀으로 단다(언급률 2번 P4) — 핀 오른쪽 점이 올린 뒤 측정이다. 점수가 오른 까닭을 핀으로
 * 설명하지 않는다(범례도 날짜 · 올린 곳 · 제목만). 핀이 없으면 전과 똑같이 그린다.
 */
export default function ScoreTrendChart({
  history,
  endWeek,
  executions,
}: {
  history: WeeklyScorecard[]
  endWeek: string
  executions?: { posts: PublishedPost[]; weeks: Pick<HistoryWeek, 'weekOf' | 'window'>[] }
}) {
  // 좁은 화면에서 그래프가 가로로 넘칠 때 처음부터 최근 주(오른쪽 끝)가 보이게 한다.
  // 상자는 콜백 ref로 받는다 — 측정이 1주인 브랜드에서 넘어오면 상자가 나중에 생기므로 그때 관찰을 건다.
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
  }, [box, endWeek, boxW])
  const W = Math.max(MIN_W, boxW)
  const sorted = history.filter((h) => h.weekOf <= endWeek).sort((a, b) => a.weekOf.localeCompare(b.weekOf))
  const slots = slotsOf(sorted, endWeek)
  const measured = slots.filter((s) => s.card)
  if (measured.length < 2) {
    return <p className="hint">측정 1주차라 추이는 다음 측정부터 그려집니다.</p>
  }

  // 조건 변경 — 직전에 측정한 주와 비교한다(사이에 빈 주가 있어도 그 앞 측정과 견준다). 앱 전체 규칙(comparability)을 쓴다 —
  // 한쪽에만 기록이 있는 조건(확인 불가)도 끊는다. 그래프 첫 칸도 창 밖의 앞 측정과 견준다.
  const breaks: Break[] = []
  let prev: WeeklyScorecard | null = [...sorted].reverse().find((h) => h.weekOf < (slots[0]?.weekOf ?? '')) ?? null
  for (const [i, s] of slots.entries()) {
    if (!s.card) continue
    if (prev) {
      const diffs = compareConditions(prev, s.card)
      if (diffs.length > 0) breaks.push({ at: i, weekOf: s.weekOf, detail: diffs.map(diffText).join(' · ') })
    }
    prev = s.card
  }

  // 선 조각 — 빈 주나 조건 변경에서 끊는다.
  const segments: number[][] = []
  let run: number[] = []
  for (const [i, s] of slots.entries()) {
    const broken = !s.card || breaks.some((b) => b.at === i)
    if (broken && run.length) {
      segments.push(run)
      run = []
    }
    if (s.card) run.push(i)
  }
  if (run.length) segments.push(run)

  const marks = executions
    ? executionMarks(
        executions.posts,
        slots.map((s) => ({ weekOf: s.weekOf, measured: s.card !== null })),
        executions.weeks,
        endWeek,
      )
    : null
  const pins = marks?.pins ?? []
  const padTop = PAD.top + (pins.length > 0 ? PIN_ROW : 0)
  const height = H + (pins.length > 0 ? PIN_ROW : 0)

  const top = Math.max(20, Math.ceil(Math.max(...measured.map((s) => Math.max(s.card!.aeoScore.ciHigh, s.card!.aeoScore.current))) / 10) * 10)
  const innerW = W - PAD.left - PAD.right
  const innerH = height - padTop - PAD.bottom
  const step = slots.length > 1 ? innerW / (slots.length - 1) : 0
  const x = (i: number) => PAD.left + (slots.length > 1 ? i * step : innerW / 2)
  const y = (v: number) => padTop + innerH - (Math.max(0, Math.min(top, v)) / top) * innerH
  const ticks = [0, top / 2, top]
  // 조건 변경 선과 같은 틈이면 4px 비켜 둘 다 보이게 한다. 양 끝 틈은 그림 안으로 당긴다.
  // 양 끝 틈 핀은 끝 칸 위 핀과 원이 겹치지 않게 PIN_EDGE만큼 띄우고, 왼쪽 끝 핀이 있으면 세로축 눈금을 그만큼 왼쪽으로 옮긴다.
  const pinX = (p: ExecutionPin) =>
    Math.min(W - PAD.right + PIN_EDGE, Math.max(PAD.left - PIN_EDGE, x(p.x) + (breaks.some((b) => b.at - 0.5 === p.x) ? 4 : 0)))
  const leftEdgePin = pins.some((p) => p.x < 0)
  // 속 빈 핀은 그 칸 점 위에 서므로 선을 점수 글자 위에서 멈춘다(글자를 긋지 않게).
  const pinLineEnd = (p: ExecutionPin) => {
    const card = p.hollow ? slots[p.x]?.card : null
    return card ? Math.max(PIN_Y + 7, y(card.aeoScore.current) - 24) : padTop + innerH
  }
  const pinPosts = pins.reduce((n, p) => n + p.posts.length, 0)
  const legendRest = pins.slice(PIN_LEGEND).reduce((n, p) => n + p.posts.length, 0)

  const summary = measured
    .map((s) => `${shortWeek(s.weekOf)} ${s.card!.aeoScore.current}점`)
    .join(', ')

  return (
    <figure className="score-trend">
      <div className="score-trend-scroll" ref={attach}>
        <svg
          width={W}
          height={height}
          viewBox={`0 0 ${W} ${height}`}
          role="img"
          aria-label={`주차별 Brand AEO Score — ${summary}${pinPosts > 0 ? ` · 올린 글 ${pinPosts}편 표시` : ''}`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="st-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="st-axis" x={PAD.left - (leftEdgePin ? PIN_EDGE + 4 : 8)} y={y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}

          {segments.map((seg) =>
            seg.length > 1 ? (
              <polygon
                key={`band-${seg[0]}`}
                className="st-band"
                points={[
                  ...seg.map((i) => `${x(i)},${y(slots[i]!.card!.aeoScore.ciHigh)}`),
                  ...[...seg].reverse().map((i) => `${x(i)},${y(slots[i]!.card!.aeoScore.ciLow)}`),
                ].join(' ')}
              />
            ) : (
              <rect
                key={`band-${seg[0]}`}
                className="st-band"
                x={x(seg[0]!) - 5}
                width={10}
                y={y(slots[seg[0]!]!.card!.aeoScore.ciHigh)}
                height={Math.max(1, y(slots[seg[0]!]!.card!.aeoScore.ciLow) - y(slots[seg[0]!]!.card!.aeoScore.ciHigh))}
                rx={3}
              />
            ),
          )}

          {breaks.map((b) => {
            // 첫 칸의 조건 변경(창 밖 앞 측정과 견줌)은 칸 사이가 없어 그림 왼쪽 끝에 붙인다 — 세로축 눈금 위나 그림 밖에 그리지 않는다.
            const bx = Math.max(PAD.left + 4, x(b.at) - step / 2)
            return (
              <g key={`brk-${b.at}`}>
                <line className="st-break" x1={bx} x2={bx} y1={padTop - 6} y2={padTop + innerH} />
                <rect className="st-break-mark" x={bx - 4} y={padTop - 10} width={8} height={8} transform={`rotate(45 ${bx} ${padTop - 6})`} />
              </g>
            )
          })}

          {pins.map((p) => {
            const px = pinX(p)
            return (
              <g key={`exec-${p.n}`} className={`st-exec-pin${p.hollow ? ' hollow' : ''}`}>
                <title>{p.posts.map((q) => postingLegend(q, endWeek)).join('\n')}</title>
                <line className="st-exec" x1={px} x2={px} y1={PIN_Y + 7} y2={pinLineEnd(p)} />
                <circle className="st-exec-dot" cx={px} cy={PIN_Y} r={7} />
                <text className="st-exec-num" x={px} y={PIN_Y + 3.5} textAnchor="middle">
                  {p.n}
                </text>
              </g>
            )
          })}

          {segments
            .filter((seg) => seg.length > 1)
            .map((seg) => (
              <polyline
                key={`line-${seg[0]}`}
                className="st-line"
                points={seg.map((i) => `${x(i)},${y(slots[i]!.card!.aeoScore.current)}`).join(' ')}
              />
            ))}

          {slots.map((s, i) => {
            const cx = x(i)
            const current = s.weekOf === endWeek
            const rank = s.card?.cohortRank
            return (
              <g key={s.weekOf}>
                {s.card && (
                  <>
                    <circle className={`st-dot${current ? ' current' : ''}`} cx={cx} cy={y(s.card.aeoScore.current)} r={current ? 5.5 : 4} />
                    <text className={`st-value${current ? ' current' : ''}`} x={cx} y={y(s.card.aeoScore.current) - 10} textAnchor="middle">
                      {s.card.aeoScore.current}
                    </text>
                  </>
                )}
                <text className={`st-week${s.card ? '' : ' none'}`} x={cx} y={height - PAD.bottom + 20} textAnchor="middle">
                  {shortWeek(s.weekOf)}
                </text>
                <text className="st-rank" x={cx} y={height - PAD.bottom + 36} textAnchor="middle">
                  {s.card ? (rank ? `${(rank.tiedCount ?? 1) > 1 ? '공동 ' : ''}${rank.position}/${rank.totalTenants}` : '') : '미측정'}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <figcaption className="score-trend-legend">
        <span>
          <span className="st-key band" aria-hidden="true" /> 95% 신뢰구간
        </span>
        <span>세로축 0–{top}점 · 아래 숫자는 코호트 순위</span>
        {breaks.map((b) => (
          <span key={b.at} className="st-key-break">
            <span className="st-key diamond" aria-hidden="true" /> {shortWeek(b.weekOf)} {b.detail} — 앞뒤를 잇지 않음
          </span>
        ))}
        {pins.length > 0 && <span>번호 핀은 올린 글 — 핀 오른쪽 점이 올린 뒤 측정(내린 글은 내린 날까지)</span>}
        {pins.slice(0, PIN_LEGEND).map((p) => (
          <span key={`exec-${p.n}`} className="st-key-exec">
            <span className={`st-key exec${p.hollow ? ' hollow' : ''}`} aria-hidden="true">
              {p.n}
            </span>{' '}
            {pinLegend(p, endWeek)}
            {p.hollow && ' · 측정하던 주에 올려 전후 불명'}
          </span>
        ))}
        {legendRest > 0 && <span className="st-key-exec">외 {legendRest}편</span>}
        {(marks?.outOfRange ?? 0) > 0 && <span className="st-key-exec">그래프 범위 밖 {marks!.outOfRange}편</span>}
        {(marks?.undated ?? 0) > 0 && <span className="st-key-exec">올린 날 모름 {marks!.undated}편 — 핀 없음</span>}
      </figcaption>
    </figure>
  )
}
