import { useCallback, useEffect, useRef, useState } from 'react'
import { conditionChanges, type ConditionChange } from '../lib/comparability'
import { ENGINE_LABEL } from '../lib/format'
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

const engines = (c: WeeklyScorecard) => (c.enginesUsed ?? []).map((e) => ENGINE_LABEL[e] ?? e).join('·')

function changeText(change: ConditionChange, prev: WeeklyScorecard, cur: WeeklyScorecard): string {
  if (change === '질문지') return `질문지 ${prev.questionBankVersion}→${cur.questionBankVersion}`
  if (change === '수집 엔진') return `수집 엔진 ${engines(prev)}→${engines(cur)}`
  if (change === '판정 엔진') return '판정 엔진 바뀜'
  if (change === '반복 횟수') return `반복 ${prev.repeatsPerQuestion}→${cur.repeatsPerQuestion}회`
  return '모델 바뀜'
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
 */
export default function ScoreTrendChart({ history, endWeek }: { history: WeeklyScorecard[]; endWeek: string }) {
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

  // 조건 변경 — 직전에 측정한 주와 비교한다(사이에 빈 주가 있어도 그 앞 측정과 견준다).
  const breaks: Break[] = []
  let prev: WeeklyScorecard | null = null
  for (const [i, s] of slots.entries()) {
    if (!s.card) continue
    if (prev) {
      const changes = conditionChanges(prev, s.card)
      if (changes.length > 0) {
        const card = s.card
        const before = prev
        breaks.push({ at: i, weekOf: s.weekOf, detail: changes.map((c) => changeText(c, before, card)).join(' · ') })
      }
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

  const top = Math.max(20, Math.ceil(Math.max(...measured.map((s) => Math.max(s.card!.aeoScore.ciHigh, s.card!.aeoScore.current))) / 10) * 10)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const step = slots.length > 1 ? innerW / (slots.length - 1) : 0
  const x = (i: number) => PAD.left + (slots.length > 1 ? i * step : innerW / 2)
  const y = (v: number) => PAD.top + innerH - (Math.max(0, Math.min(top, v)) / top) * innerH
  const ticks = [0, top / 2, top]

  const summary = measured
    .map((s) => `${shortWeek(s.weekOf)} ${s.card!.aeoScore.current}점`)
    .join(', ')

  return (
    <figure className="score-trend">
      <div className="score-trend-scroll" ref={attach}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`주차별 Brand AEO Score — ${summary}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="st-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="st-axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">
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
            const bx = x(b.at) - step / 2
            return (
              <g key={`brk-${b.at}`}>
                <line className="st-break" x1={bx} x2={bx} y1={PAD.top - 6} y2={PAD.top + innerH} />
                <rect className="st-break-mark" x={bx - 4} y={PAD.top - 10} width={8} height={8} transform={`rotate(45 ${bx} ${PAD.top - 6})`} />
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
                <text className={`st-week${s.card ? '' : ' none'}`} x={cx} y={H - PAD.bottom + 20} textAnchor="middle">
                  {shortWeek(s.weekOf)}
                </text>
                <text className="st-rank" x={cx} y={H - PAD.bottom + 36} textAnchor="middle">
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
      </figcaption>
    </figure>
  )
}
