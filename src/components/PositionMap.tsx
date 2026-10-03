import { formatPct } from '../lib/format'

export interface PositionPeer {
  tenantId: string
  brandName: string
  aeoScore: number
  mentionRate: number
  brandOwnedCitationRate: number
}

interface Spot {
  x: number
  y: number
  self: boolean
  score: number
  names: string[]
}

/** 축 위끝 — 가장 큰 값을 10% 단위로 올린 값(최소 10%). 작은 값끼리 모인 코호트도 퍼져 보이게. */
function axisTop(values: number[]): number {
  const max = Math.max(0, ...values)
  return Math.max(0.1, Math.ceil((max * 100) / 10) / 10 + 0.0001)
}

/**
 * 경쟁 포지션 맵 — 가로 언급률(이름 없는 질문), 세로 자사 인용률, 원 크기는 Brand AEO Score. 코호트 구성원이
 * 같은 판 위에 놓여 "누가 많이 불리고, 누가 근거까지 자기 것으로 가져가나"가 한눈에 보인다.
 * 값은 랭킹 응답(cohort.peers)에 이미 있는 것을 쓴다. 축 범위는 화면에 적는다(0~위끝).
 */
export default function PositionMap({ peers, selfId }: { peers: PositionPeer[]; selfId: string }) {
  if (peers.length === 0) return null
  const xTop = axisTop(peers.map((p) => p.mentionRate))
  const yTop = axisTop(peers.map((p) => p.brandOwnedCitationRate))
  const clamp = (v: number) => Math.min(94, Math.max(5, v))
  const summary = peers
    .map((p) => `${p.brandName} 언급률 ${formatPct(p.mentionRate)} · 자사 인용률 ${formatPct(p.brandOwnedCitationRate)} · ${p.aeoScore}점`)
    .join(', ')
  // 같은 자리(1% 단위)에 놓이는 브랜드는 점 하나로 묶고 이름을 이어 붙인다 — 둘 다 0%인 경쟁사가 겹쳐 읽히지 않게.
  const spots = new Map<string, Spot>()
  for (const p of peers) {
    const x = clamp((p.mentionRate / xTop) * 100)
    const y = clamp((p.brandOwnedCitationRate / yTop) * 100)
    const key = `${Math.round(x)}:${Math.round(y)}`
    const self = p.tenantId === selfId
    const spot = spots.get(key) ?? { x, y, self: false, score: 0, names: [] }
    if (self) spot.names.unshift(p.brandName)
    else spot.names.push(p.brandName)
    spot.self ||= self
    spot.score = Math.max(spot.score, p.aeoScore)
    spots.set(key, spot)
  }
  // 같은 높이 줄에서 왼쪽 이웃의 이름표와 부딪치면 이름표를 점 위로 올린다(이름표 폭은 글자 수로 어림한다).
  const placed: { key: string; spot: Spot; up: boolean }[] = []
  const rowEnd = new Map<number, number>()
  for (const [key, spot] of [...spots.entries()].sort((a, b) => a[1].x - b[1].x)) {
    const row = Math.round(spot.y / 10)
    const up = (rowEnd.get(row) ?? -Infinity) > spot.x
    if (!up) rowEnd.set(row, spot.x + 3 + spot.names.join(' · ').length * 2.2)
    placed.push({ key, spot, up })
  }
  return (
    <div className="pmap">
      <span className="pmap-y">자사 인용률 →</span>
      <div className="pmap-body">
        <div className="pmap-plot" role="img" aria-label={`경쟁 포지션 — ${summary}`}>
          <span className="pmap-mid x" aria-hidden="true" />
          <span className="pmap-mid y" aria-hidden="true" />
          <span className="pmap-corner tr" aria-hidden="true">
            많이 불리고 근거도 자기 것
          </span>
          {placed.map(({ key, spot, up }) => {
            const size = Math.round(10 + spot.score / 2.5)
            // 오른쪽 끝 점은 이름표를 왼쪽에 붙인다 — 긴 이름이 카드 밖으로 나가지 않게.
            return (
              <span
                key={key}
                className={`pmap-dot${spot.self ? ' self' : ''}${up ? ' up' : spot.x > 70 ? ' flip' : ''}`}
                style={{ left: `${spot.x}%`, bottom: `${spot.y}%` }}
                aria-hidden="true"
              >
                <span className="pmap-mark" style={{ width: size, height: size }} />
                <span className="pmap-label">{spot.names.join(' · ')}</span>
              </span>
            )
          })}
        </div>
        <div className="pmap-x">
          <span>0%</span>
          <span>언급률 →</span>
          <span>{Math.round(xTop * 100)}%</span>
        </div>
        <span className="pmap-ytop">세로 0–{Math.round(yTop * 100)}%</span>
      </div>
    </div>
  )
}
