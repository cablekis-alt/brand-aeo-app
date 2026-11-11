import { cellText, nextStepText, type IndexCell, type ProgressTotals, type StageCell, type WriterProgress } from '../lib/contentProgress'

/**
 * 콘텐츠 생성 화면 맨 위 — 요약 칸 다섯과 작성자 진행판(2026-11-11 개편 시안). 숫자는 src/lib/contentProgress.ts가 계산한다.
 * 작성자 줄의 작성자 단추를 누르면 아래 글 · 올리기 목록이 그 작성자로 걸러진다(한 번 더 누르면 전체). 발행 현황을 읽는 중 · 못 읽었으면
 * 올림 · 색인 칸은 0이 아니라 「확인 불가」이고 그 까닭을 한 줄로 밝힌다.
 */

export type StatusLoad = 'loading' | 'ok' | 'error' | 'none'

const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

function Cell({ c, label }: { c: StageCell; label?: string }) {
  return <span className={`stage-cell st-${c.tone}`}>{label ?? cellText(c)}</span>
}

function indexLabel(c: IndexCell): string {
  if (c.tone === 'na' && c.total === 0 && !c.nextCheck) return cellText(c)
  const base = c.total > 0 ? `${c.done}/${c.total}` : '-'
  if (!c.nextCheck) return base
  return c.due ? `${base} · 자동 확인 차례` : `${base} · ${shortDay(c.nextCheck)} 자동`
}

export default function ContentProgressBoard({
  writers,
  totals,
  status,
  statusError,
  writerKey,
  onPickWriter,
}: {
  writers: WriterProgress[]
  totals: ProgressTotals
  status: StatusLoad
  statusError: string | null
  writerKey: string | null
  onPickWriter: (key: string | null) => void
}) {
  const statusNote =
    status === 'loading'
      ? '발행 현황을 읽는 중이라 올림 · 색인은 잠시 「확인 불가」로 보여요.'
      : status === 'error'
        ? `발행 현황을 읽지 못해 올림 · 색인은 「확인 불가」예요${statusError ? ` — ${statusError}` : ''}.`
        : status === 'none'
          ? '이 환경에는 발행 현황이 없어 올림 · 색인은 「확인 불가」예요.'
          : null
  const postLeft = totals.postLeft.length
    ? `남은 ${totals.posted.total - totals.posted.done}편 · ${totals.postLeft.map((w) => `${w.key} ${w.count}`).join(' · ')}`
    : totals.posted.tone === 'na'
      ? '확인 불가'
      : '모두 올림'
  // 올림 · 색인은 발행 현황을 읽었을 때만 숫자다 — 못 읽었으면 0 · 「0 / 0」이 아니라 확인 불가.
  const known = status === 'ok'
  const tiles = [
    { label: '초안', c: totals.draft, unknown: false, sub: totals.draft.done === totals.draft.total ? '모두 만듦' : `남은 ${totals.draft.total - totals.draft.done}편` },
    { label: '사진 자리', c: totals.photo, unknown: false, sub: totals.photo.total ? `빈자리 ${totals.photo.empty}` : '사진을 쓰지 않거나 자리가 없음' },
    { label: '빈칸 처리', c: totals.gaps, unknown: false, sub: `남은 빈칸 ${totals.gaps.left}곳 — 묶음에서는 빈칸 줄이 빠져요` },
    { label: '올림', c: totals.posted, unknown: !known, sub: postLeft },
    {
      label: '구글 색인',
      c: totals.indexed,
      unknown: !known,
      sub: totals.indexed.nextCheck
        ? totals.indexed.due
          ? '자동 확인 차례 — 발행 현황에서 「구글 자동 확인」'
          : `다음 자동 확인 ${shortDay(totals.indexed.nextCheck)} (올린 지 14일째)`
        : totals.indexed.tone === 'na'
          ? '확인 불가'
          : '볼 글 없음',
    },
  ]
  return (
    <section className="progress-board" aria-label="작성자 진행판">
      <div className="progress-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="progress-tile">
            <span className="progress-tile-label">{t.label}</span>
            <span className="progress-tile-value">
              {t.unknown ? '확인 불가' : t.c.total > 0 ? t.c.done : '-'}
              {!t.unknown && t.c.total > 0 && <span className="progress-tile-of"> / {t.c.total}</span>}
            </span>
            <span className={`progress-tile-bar st-${t.c.tone}`} aria-hidden="true">
              <span style={{ width: `${t.c.total > 0 && t.c.tone !== 'na' ? Math.round((t.c.done / t.c.total) * 100) : 0}%` }} />
            </span>
            <span className="progress-tile-sub">{t.sub}</span>
          </div>
        ))}
      </div>
      <div className="progress-table-wrap">
        <table className="progress-table">
          <caption>
            작성자 진행판 <span className="muted">— 작성자를 누르면 아래 글 · 올리기 목록이 그 작성자로 걸러져요</span>
          </caption>
          <thead>
            <tr>
              <th scope="col">작성자</th>
              <th scope="col">초안</th>
              <th scope="col">사진</th>
              <th scope="col" title="빈칸을 모두 채우거나 뺀 글 — 작성자 묶음에서는 빈칸 줄이 빠져요">빈칸 처리</th>
              <th scope="col">올림</th>
              <th scope="col">구글 색인</th>
              <th scope="col">다음 할 일</th>
            </tr>
          </thead>
          <tbody>
            {writers.map((w) => {
              const on = writerKey === w.key
              return (
                <tr key={w.key} className={on ? 'is-picked' : undefined}>
                  <th scope="row">
                    <button
                      type="button"
                      className="progress-writer"
                      aria-pressed={on}
                      title={on ? '거르기 풀기' : `${w.key} 글만 보기`}
                      onClick={() => onPickWriter(on ? null : w.key)}
                    >
                      {w.key} <span className="muted">{w.name}</span>
                    </button>
                  </th>
                  <td><Cell c={w.draft} /></td>
                  <td><Cell c={w.photo} /></td>
                  <td><Cell c={w.gaps} /></td>
                  <td><Cell c={w.posted} /></td>
                  <td><Cell c={w.indexed} label={known ? indexLabel(w.indexed) : '확인 불가'} /></td>
                  <td className={`progress-next next-${w.next.kind}`}>{nextStepText(w.next)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {statusNote && (
        <p className="hint" role="status">
          {statusNote}
        </p>
      )}
    </section>
  )
}
