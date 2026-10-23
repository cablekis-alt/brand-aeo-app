import type { HistoryCell, HistoryWeek, PostHistory, PublishedHistory } from '../lib/api'
import {
  distinctPostings,
  freshNoCiteNote,
  runTallyText,
  summarizePost,
  summarizeSinceEdit,
  TIER_LABEL,
  weekEditNote,
  type Posting,
  type PostTier,
} from '../lib/publishTracking'
import { kstDate } from '../lib/publishedUrl'
import { kstStamp } from '../lib/runTrend'
import { weekLabel } from '../lib/format'
import { isoWeekThursday } from '../prompts/isoWeek'
import { UrlLink } from './CitationBits'

const TIER_CLASS: Record<PostTier, string> = {
  waiting: 'st-unknown',
  undated: 'st-unknown',
  removed: 'st-unknown',
  indexing: 'st-unknown',
  none: 'st-unknown',
  once: 'st-info',
  repeated: 'st-good',
}

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

/** "2026-W42" → 그 주 목요일을 7일 단위로 센 값 — 측정 사이 빈 주를 찾는 데만 쓴다(52주 · 53주 해 모두 맞다). */
const weekSerial = (weekOf: string) => {
  const t = isoWeekThursday(weekOf)
  return t ? Math.round(t.getTime() / (7 * 86_400_000)) : 0
}

/**
 * 칸 하나 — 숫자는 정확 일치 인용만, 응답 단위로 센다. 같은 주에 여러 번 잰 주는 회차 단위로 「3회 중 1회」를 앞세우고 응답 합은
 * 아래 줄에 적는다(runTallyText). 0을 지어내지 않는다: 판정 기록이 없는 주는 「확인 불가」, 질문 은행을 못
 * 읽은 주는 질문 유형을 확인 불가로 둔다. 「인용 없음」은 그 주 AI 답변 인용에서 찾지 못했다는 뜻이다.
 */
function cellView(c: HistoryCell | null): { main: string; sub: string[]; cls: string; title: string } {
  if (!c) return { main: '확인 불가', sub: [], cls: 'muted', title: '그 주 판정 기록이 없습니다' }
  if (c.afterRemoval) return { main: '내린 뒤', sub: [], cls: 'muted', title: '글을 내린 뒤에 한 측정이라 세지 않습니다' }
  if (c.timing === 'before') return { main: '—', sub: [], cls: 'muted', title: '올리기 전에 한 측정이라 세지 않습니다' }
  const unsure = c.timing === 'during' || c.timing === 'ambiguous'
  const runs = runTallyText(c)
  const sub: string[] = []
  let main: string
  if (runs) {
    main = runs.main
    sub.push(...runs.sub)
  } else if (!c.tally) {
    main = unsure ? '전후 불명' : '인용 없음'
    // 갓 올린 글의 「인용 없음」은 판단에 넣지 않는다(판단 칸은 「색인 대기」) — 그 까닭을 칸에도 적는다.
    const fresh = freshNoCiteNote(c)
    if (fresh) sub.push(fresh)
  } else if (c.tally.unnamed && c.tally.named) {
    main = `이름 없는 ${c.tally.unnamed.cited} · 이름 댄 ${c.tally.named.cited}`
    sub.push(`뒷받침 ${c.tally.all.supporting}`)
  } else {
    main = `인용 ${c.tally.all.cited}`
    sub.push('질문 유형 확인 불가')
  }
  if (c.tally && unsure) sub.push('전후 불명')
  if (c.citedBeforeRuns) sub.push(`올리기 전 회차 ${c.citedBeforeRuns}번 인용`)
  if (c.variantCited > 0) sub.push(`질의만 다른 주소 ${c.variantCited}`)
  if (c.topicMention !== undefined) {
    sub.push(c.topicMention ? `겨냥한 이름 없는 질문 언급 ${c.topicMention.mentioned}/${c.topicMention.answered}` : '겨냥 질문: 확인 불가')
  }
  const title =
    c.timing === 'during'
      ? '측정하던 날 올렸습니다'
      : c.timing === 'ambiguous'
        ? '같은 주에 올렸는데 측정 시각 기록이 없습니다'
        : c.timing === 'unknown'
          ? '올린 날을 모르는 옛 기록입니다 — 판단에는 넣지 않습니다'
          : ''
  // 올린 뒤로 센 회차만 말한다 — 그 주 전체 회차 수는 주차 머리글(「·3회」)에 있다. 올린 날을 모르는 글은 붙이지 않는다.
  const runTitle =
    c.runs && c.runs.measured + c.runs.unsure > 0
      ? `올린 뒤 회차 ${c.runs.measured}번${c.runs.unsure ? ` · 전후 불명 ${c.runs.unsure}번` : ''} — 한 회차라도 인용되면 그 주는 인용으로 셉니다`
      : ''
  return { main, sub, cls: c.tally ? '' : 'muted', title: [title, runTitle].filter(Boolean).join('\n') }
}

/**
 * 올린 글 인용 추적 — 행은 올린 글(같은 주소 · 같은 올린 날을 여러 줄에 적은 기록은 한 행, distinctPostings — 정기진단 보고서 ·
 * 그래프 핀과 같은 셈), 열은 측정 주차(언급률 2번 P3). 묶인 줄은 올린 곳을 칩으로 함께 보인다. 글 바로 옆 열은 글별 판단이다 —
 * 좁은 화면에서 주차 열을 밀어도 보이게. 「여러 주 인용」은 올린 뒤 서로 다른 2주 이상에서 인용됐을 때만 붙인다 — 같은 주 회차는
 * 한 주로 센다. 측정 조건이 바뀐 주는 ◆, 측정하지 않은 주는 「…」, 여러 번 잰 주는 머리글에 「·3회」.
 */
export default function PublishedHistoryTable({ history, maxWeeks = 8 }: { history: PublishedHistory; maxWeeks?: number }) {
  const start = Math.max(0, history.weeks.length - maxWeeks)
  const weeks = history.weeks.slice(start)
  // 측정 사이 빈 주 — 주차 열 사이에 틈을 둔다.
  const gapBefore = weeks.map((w, i) => (i > 0 ? weekSerial(w.weekOf) - weekSerial(weeks[i - 1]!.weekOf) - 1 : 0))
  const postings = distinctPostings(history.posts, (p) => p.post)
  const runIssues = history.weeks.reduce((n, w) => n + (w.runIssues?.length ?? 0), 0)

  const row = ({ item: p, places }: Posting<PostHistory>) => {
    const removedOn = p.post.removedAt ? kstDate(p.post.removedAt) : null
    const summary = summarizePost(p.cells, history.weeks, removedOn)
    // 고친 글 — 마지막으로 고친 뒤의 결과를 따로 적고, 칸마다 고친 뒤 · 고친 날 측정인지 밝힌다(옛 글 · 새 글을 가르려고).
    const sinceEdit = summarizeSinceEdit(p.post, p.cells, history.weeks)
    const cells = p.cells.slice(start)
    return (
      <tr key={p.post.id}>
        <td className="cell-text history-post">
          <b>{p.post.articleTitle ?? p.post.articleId}</b>
          <div>
            <UrlLink url={p.post.url} max={48} />
          </div>
          <div className="doc-meta">
            {p.post.publishedOn ? `${shortDate(p.post.publishedOn)} 올림` : '올린 날 모름'}
            {p.post.edits && p.post.edits.length > 0 && ` · ${p.post.edits.map((e) => shortDate(e.editedOn)).join(' · ')} 고침`}
            {removedOn && ` · ${shortDate(removedOn)} 내림`}
          </div>
          {places.length > 1 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {places.map((place) => (
                <span key={place} className="st st-info">
                  {place}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="cell-text history-tier">
          <span className={`status-pill ${TIER_CLASS[summary.tier]}`}>{TIER_LABEL[summary.tier]}</span>
          {summary.measuredAfter > 0 && (
            <div className="doc-meta">
              올린 뒤 측정한 주 {summary.measuredAfter} · 인용된 주 {summary.citedWeeks}
              {summary.measuredRuns !== summary.measuredAfter && ` (회차 ${summary.citedRuns}/${summary.measuredRuns})`}
              {summary.unnamedCited === null ? ' · 이름 없는 질문: 확인 불가' : ` · 이름 없는 질문 인용 ${summary.unnamedCited}`}
            </div>
          )}
          {summary.firstCitedDays !== null && <div className="doc-meta">첫 인용 확인 D+{summary.firstCitedDays}</div>}
          {sinceEdit && (
            <div className="doc-meta">
              {sinceEdit.measuredWeeks === 0
                ? // 내린 글에는 다시 오지 않을 측정을 약속하지 않는다.
                  `${shortDate(sinceEdit.editedOn)} 고침 · ${removedOn ? '고친 뒤 측정 없이 내림' : '고친 뒤 측정 없음 — 다음 측정부터'}`
                : `${shortDate(sinceEdit.editedOn)} 고친 뒤 측정한 주 ${sinceEdit.measuredWeeks} · 인용된 주 ${sinceEdit.citedWeeks}` +
                  (sinceEdit.firstCitedDays !== null ? ` · 고친 뒤 첫 인용 D+${sinceEdit.firstCitedDays}` : '')}
            </div>
          )}
          {summary.lapsed && <div className="doc-meta">최근 측정한 주에는 인용 없음</div>}
          {summary.conditionMixed && <div className="doc-meta">◆ 그사이 측정 조건이 바뀜</div>}
          {summary.citedBeforePublish && <div className="doc-meta">올리기 전 측정에서 이미 인용됨 — 올린 날을 확인하세요</div>}
        </td>
        {cells.flatMap((c, i) => {
          const v = cellView(c)
          // 고친 글이면 이 칸이 고친 글을 본 측정인지 — 올린 뒤 · 내리기 전 칸에만 붙인다. 고치기 전 회차가 섞인 주는 고친 뒤 몫을 따로 적는다.
          const editNote = c && !c.afterRemoval && c.timing === 'after' ? weekEditNote(p.post, c, weeks[i]!) : null
          if (editNote) v.sub.push(editNote)
          const out = []
          if (gapBefore[i]! > 0) out.push(<td key={`gap-${i}`} className="history-gap" aria-hidden="true" />)
          out.push(
            <td key={weeks[i]!.weekOf} className={`history-cell ${v.cls}`} title={v.title || undefined}>
              <div>{v.main}</div>
              {v.sub.map((s) => (
                <div key={s} className="doc-meta">
                  {s}
                </div>
              ))}
            </td>,
          )
          return out
        })}
      </tr>
    )
  }

  const header = (w: HistoryWeek, i: number) => {
    const out = []
    if (gapBefore[i]! > 0) {
      out.push(
        <th key={`gap-${w.weekOf}`} className="history-gap" title={`${gapBefore[i]}주 미측정`}>
          …
        </th>,
      )
    }
    out.push(
      <th
        key={w.weekOf}
        title={[
          weekLabel(w.weekOf),
          ...(w.changes.length ? [`바뀐 측정 조건: ${w.changes.join(' · ')}`] : []),
          ...(w.runs ? [`회차 ${w.runs.length}번: ${w.runs.map((r) => (r.at ? kstStamp(r.at) : '시각 모름')).join(' · ')}`] : []),
        ].join('\n')}
      >
        {w.weekOf.slice(5)}
        {w.runs && ` ·${w.runs.length}회`}
        {w.changes.length > 0 && ' ◆'}
      </th>,
    )
    return out
  }

  return (
    <>
      <div className="table-wrap">
        <table className="history-table">
          <thead>
            <tr>
              <th>올린 글</th>
              <th className="cell-text">판단</th>
              {weeks.flatMap(header)}
            </tr>
          </thead>
          <tbody>{postings.map(row)}</tbody>
        </table>
      </div>
      <p className="doc-meta">
        숫자는 그 주소가 정확히 인용된 AI 응답 수입니다(한 응답에 여러 번 나와도 1). 「이름 없는 질문」은 브랜드 이름을 넣지 않은
        질문(containsBrandName=false)으로, 점수가 쓰는 「카테고리 무관 질문」과 정의가 다릅니다(옛 질문지에서는 일부 질문이 두 기준에서 갈립니다). 「인용 없음」은 그 주 분석에서
        찾지 못했다는 뜻입니다. 같은 주에 여러 번 잰 주는 「3회 중 1회」처럼 회차 단위로 적고(한 회차라도 인용되면 그 주는 인용),
        응답 수는 아래 줄에 합으로 적습니다. 「여러 주 인용」은 올린 뒤 서로 다른 2주 이상에서 인용됐을 때만 붙입니다 — 단일 측정은
        흔들립니다. 자주 잴수록 한 주가 인용으로 잡힐 기회가 늘어, 판단 옆에 회차 수를 함께 적습니다.
        같은 주소 · 같은 올린 날을 여러 줄(자사 블로그 · 채널)에 적은 기록은 한 행으로 묶고 올린 곳을 함께 적습니다.
        기존 글을 고쳤다고 남긴 글은 칸에 「고친 뒤」(고친 글을 본 측정) · 「고친 날 측정」(고치기 전후 불명)을 적습니다. 고친 날이 든
        주는 칸 숫자가 그 주 올린 뒤 회차 전체이고, 꼬리에 고친 뒤 회차 몫만 따로 적습니다. 판단 칸에 고친 뒤 결과를 따로 적습니다 —
        판단(여러 주 인용 등)은 올린 날 기준 그대로입니다.
        ◆는 직전 측정과 측정 조건(수집 엔진 · 판정 엔진 · 모델 · 질문지 · 반복 횟수)이 달라진 주입니다 — 엔진이나 반복 횟수가 바뀌면
        응답 수 자체가 달라져 숫자를 그대로 견줄 수 없고, 보정하지 않았습니다. 바뀐 항목은 주차 머리글에 마우스를 올리면 보입니다.
        {history.weeks.length > maxWeeks && ` 최근 ${maxWeeks}주만 보입니다(판단은 ${history.weeks.length}주 기준).`}
        {runIssues > 0 && ` 회차 기록 ${runIssues}개를 읽지 못해 칸에서 뺐습니다.`}
      </p>
    </>
  )
}
