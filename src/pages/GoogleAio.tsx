import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'
import { useTenant } from '../context/useTenant'
import {
  GoogleAioRequestError,
  cancelGoogleAio,
  loadGoogleAio,
  loadGoogleAioRun,
  loadPricing,
  planGoogleAio,
  rejudgeGoogleAio,
  runGoogleAio,
  saveGoogleAioSettings,
  type EnginePricing,
  type GoogleAioDetailItem,
  type GoogleAioPlan,
  type GoogleAioQuota,
  type GoogleAioRunDetail,
  type GoogleAioStatus,
} from '../lib/api'
import { conditionSummary } from '../lib/comparability'
import { formatMoney } from '../lib/engineCost'
import {
  AIO_CELL,
  AIO_DROP_FROM,
  AIO_REASON_TEXT,
  AIO_STATUS_LABEL,
  judgeCostOf,
  pctText,
  ratioText,
  type AioPostTableRow,
  type AioReason,
  type AioRunRow,
  type AioRunState,
  type AioRunSummary,
  type AioSourceReason,
  type AioTrendPoint,
  type AioView,
} from '../lib/googleAio'
import { kstStamp } from '../lib/runTrend'

/**
 * 구글 AI 개요(시범) — 점수에 세는 이름 없는 질문을 질문 그대로 구글에 검색해(SerpAPI), AI 개요가 떴는지 · 그 안에 이 브랜드가 나오는지 ·
 * 어떤 출처를 댔는지 따로 잰다. 점수 · 정기진단 보고서 · 전주 비교에는 넣지 않는다. 서버: server/googleAio.ts, 규칙: src/lib/googleAio.ts.
 *
 * 돈이 드는 때를 사람이 정한다: 이 PC 스위치(기본 꺼짐 — 「이 PC에서 켜기」 확인창이 같은 계정을 나눠 쓴다고 알린다)가 켜져 있고 시범 브랜드일 때,
 * 「지금 재기」를 누르면 계획을 받고(검색 0 — 서버가 SerpAPI 계정만 무료로 읽는다) 확인창에 질문 수 · 최대 검색 M · 판정 엔진 · 이번 결제 주기
 * 몫(분모는 계정 · 장부 값 그대로) · 계정 바닥 · 시간당 남은 수 · 걸리는 시간 · 지난 회차를 보인 뒤, 확인해야 그 계획 id로 시작한다. 계정은 이때만
 * 읽는다. 도는 동안 2초마다 상태를 묻는다(서버 메모리의 진행 — 회차 · 지표는 그동안 비어 오므로 앞서 받은 것을 둔다). 다시 판정(검색 0)도
 * 확인창을 거친다(판정 최대 n회 · 판정 엔진).
 *
 * 숫자는 늘 분모와 함께, 분모가 0이거나 목록이 없으면 「확인 불가」(0 아님). 요약은 끝난 회차나 질문의 90% 이상을 잰 회차만, 질문 표 · 추이는
 * 최신과 같은 조건인 회차만, 회차끼리는 두 회차 모두 잰 질문만 견준다(규칙 모듈이 셈). 작성자는 키(w1~w8)만, 링크는 http(s)만 그린다.
 *
 * 키보드: 누른 단추가 사라질 때(시작 · 끝 · 켜기 · 끄기) 포커스를 남는 곳(진행 글자 · 지금 재기 · 켜기)으로 옮긴다. 확인창은 Esc로 닫히고 연
 * 단추로 포커스를 돌려준다(components/ConfirmDialog.tsx). 웹(라우트 404)에서는 「데스크톱 앱에서 볼 수 있습니다」만 보인다.
 */

const POLL_MS = 2000
const NO_KEY =
  '이 PC에 SerpAPI 키가 없어요 — 최신 설치본에는 키가 들어 있어요. 따로 쓰려면 %APPDATA%\\brand-aeo-app\\.env에 SERPAPI_API_KEY=… 한 줄을 넣고 앱을 다시 켜 주세요.'
const OFF_TEXT = '이 PC에서는 구글 AI 개요 시범 측정을 켜지 않았어요. 키가 모든 설치본에 들어 있어, 다른 PC가 실수로 검색을 쓰지 않게 PC마다 따로 켭니다.'
const MEASURING_NOTE = '브랜드 측정이 도는 중이라 지금은 재지 않아요 — 측정이 끝난 뒤 「다시 읽기」를 누르고 재 주세요(판정 엔진을 함께 써요).'
const ELSEWHERE_NOTE = '다른 앱 창에서 구글 AI 개요 시범이 도는 중이에요 — 끝나면 여기에도 보여요(멈추려면 그 창에서 「중단」을 눌러 주세요).'
const INTERRUPTED = '앱이 꺼져 멈춘 회차예요 — 받은 검색만 남았어요.'
const PLAN_RENEWED = '계획이 바뀌었어요 — 다시 눌러 주세요(계획을 새로 받아요).'
const STATE_LABEL: Record<AioRunState, string> = { running: '도는 중', done: '끝남', partial: '멈춤', cancelled: '중단', interrupted: '끊김' }
const SOURCE_REASON: Record<AioSourceReason, string> = {
  ok: '',
  'no-overview': 'AI 개요가 뜬 질문이 없어요',
  'no-source-list': '출처 목록과 함께 온 개요가 없어요',
  'no-owned': '자사 주소가 비어 있어요',
  'no-posts': '그때 올라가 있던 글이 없어요',
  'posts-unreadable': '원장 · 앱 밖 글을 읽지 못했어요',
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const n = (v: number) => v.toLocaleString('ko-KR')
/** 결제 주기 이름(갱신일 YYYY-MM-DD) → 「12월 8일」. */
const renewalDay = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일` : day)
const isHttp = (url: string) => /^https?:\/\//i.test(url)
const googleUrl = (query: string) => `https://www.google.co.kr/search?q=${encodeURIComponent(query)}&hl=ko&gl=kr`
const excerpt = (text: string, max = 280) => (text.length > max ? `${text.slice(0, max)}…` : text)
const minutesText = ([lo, hi]: [number, number]) => (lo === hi ? `약 ${lo}분` : `약 ${lo}~${hi}분`)

function quotaLine(q: GoogleAioQuota): string {
  return `이번 결제 주기(${renewalDay(q.planRenewalDate ?? q.cycle)} 갱신까지) 구글 AI 개요 몫 남은 ${n(q.left)}회 / ${n(q.cap)}회 · 계정 남은 검색 ${n(q.accountLeft)}회(바닥 ${n(q.floor)}회 아래로는 쓰지 않아요) · 이번 시간 남은 검색 ${n(q.hourLeft)}회`
}

/** 판정 비용 — 회차의 판정 엔진 단가로(생각 토큰은 출력 단가). 엔진이 섞였거나 단가가 없으면 null(0 아님). */
function judgeCostText(row: AioRunRow, pricing: EnginePricing | null | undefined): string {
  if (row.usage.judgeCalls <= 0) return '판정 0회'
  const engine = row.judgeEngine && !row.judgeEngine.includes('+') ? row.judgeEngine : null
  const cost = engine && pricing ? judgeCostOf(row.usage, pricing.engines[engine]) : null
  return `판정 ${n(row.usage.judgeCalls)}회 · ${cost === null ? '비용 확인 불가' : `약 ${formatMoney(cost, pricing?.currency ?? '')}`}`
}

function mentionText(m: boolean | null | undefined): string {
  return m === true ? '언급 있음' : m === false ? '언급 없음' : '판정 불가'
}

// ── 결과 ─────────────────────────────────────────────────────────────────────

function SummaryTiles({ summary }: { summary: AioRunSummary }) {
  const own = summary.ownSource
  const post = summary.postSource
  const tiles = [
    {
      label: 'AI 개요가 뜬 질문',
      value: pctText(summary.exposure),
      sub:
        summary.exposure.rate === null
          ? '잰 질문(있음 · 없음)이 없어요'
          : `${ratioText(summary.exposure)} · AI 개요 없음 ${summary.absent}${summary.unreadable + summary.failed > 0 ? ` · 못 읽음 ${summary.unreadable} · 오류 ${summary.failed}는 분모에서 뺌` : ''}`,
    },
    {
      label: 'AI 개요 속 언급',
      value: pctText(summary.mention),
      sub: `${summary.mention.rate === null ? '판정된 개요가 없어요' : ratioText(summary.mention)}${summary.judgeUnknown > 0 ? ` · 판정 불가 ${summary.judgeUnknown}` : ''}`,
    },
    {
      label: '자사 사이트 출처',
      value: pctText(own),
      sub: own.rate === null ? SOURCE_REASON[own.reason] : `${ratioText(own)} 개요(출처 목록이 온 개요 중)`,
    },
    {
      label: '올린 글 출처',
      value: pctText(post),
      sub: post.rate === null ? SOURCE_REASON[post.reason] : `${ratioText(post)} 개요 · 그때 올라가 있던 글 ${post.posts}편`,
    },
  ]
  return (
    <section className="gaio-tiles" aria-label="요약">
      {tiles.map((t) => (
        <div key={t.label} className="gaio-tile">
          <span className="gaio-tile-label">{t.label}</span>
          <span className="gaio-tile-value">{t.value}</span>
          <span className="gaio-tile-sub">{t.sub}</span>
        </div>
      ))}
    </section>
  )
}

const TREND_W = 600
const TREND_H = 150
const TREND_PAD = { left: 40, right: 14, top: 12, bottom: 26 }

function Trend({ points }: { points: AioTrendPoint[] }) {
  const span = TREND_W - TREND_PAD.left - TREND_PAD.right
  const x = (i: number) => TREND_PAD.left + (points.length > 1 ? (i * span) / (points.length - 1) : span / 2)
  const y = (rate: number) => TREND_PAD.top + (1 - rate) * (TREND_H - TREND_PAD.top - TREND_PAD.bottom)
  const segs = (pick: (p: AioTrendPoint) => number | null) =>
    points.flatMap((p, i) => {
      const prev = points[i - 1]
      const a = prev ? pick(prev) : null
      const b = pick(p)
      return i > 0 && p.connectToPrev && a !== null && b !== null ? [{ key: p.runId, x1: x(i - 1), y1: y(a), x2: x(i), y2: y(b) }] : []
    })
  return (
    <div className="gaio-trend">
      <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} role="img" aria-label="같은 조건 회차의 AI 개요 노출 · 언급 추이(아래 목록과 같은 숫자)">
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line className="gaio-grid" x1={TREND_PAD.left} x2={TREND_W - TREND_PAD.right} y1={y(r)} y2={y(r)} />
            <text className="gaio-axis" x={TREND_PAD.left - 6} y={y(r) + 4} textAnchor="end">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}
        {segs((p) => p.exposure.rate).map((s) => (
          <line key={`e${s.key}`} className="gaio-seg-exposure" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
        ))}
        {segs((p) => p.mention.rate).map((s) => (
          <line key={`m${s.key}`} className="gaio-seg-mention" x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
        ))}
        {points.map((p, i) => (
          <g key={p.runId}>
            {p.exposure.rate !== null && (
              <circle className={`gaio-dot-exposure${p.dropped ? ' gaio-dot-drop' : ''}`} cx={x(i)} cy={y(p.exposure.rate)} r={4}>
                <title>{`${kstStamp(p.startedAt)} AI 개요 노출 ${pctText(p.exposure)}(${ratioText(p.exposure)})${p.dropped ? ' · 급락' : ''}`}</title>
              </circle>
            )}
            {p.mention.rate !== null && (
              <circle className="gaio-dot-mention" cx={x(i)} cy={y(p.mention.rate)} r={3.5}>
                <title>{`${kstStamp(p.startedAt)} 언급 ${pctText(p.mention)}(${ratioText(p.mention)})`}</title>
              </circle>
            )}
            <text className="gaio-axis" x={x(i)} y={TREND_H - 8} textAnchor="middle">
              {kstStamp(p.startedAt).split(' ')[0]}
            </text>
          </g>
        ))}
      </svg>
      <p className="gaio-legend-line">
        <span className="gaio-key gaio-key-exposure" aria-hidden="true" /> AI 개요 노출 <span className="gaio-key gaio-key-mention" aria-hidden="true" /> 개요 속 언급 — 급락한 회차와는 선을 잇지 않아요.
      </p>
      <ol className="gaio-trend-list">
        {points.map((p) => (
          <li key={p.runId}>
            {kstStamp(p.startedAt)} — 노출 {pctText(p.exposure)}({ratioText(p.exposure)}) · 언급 {pctText(p.mention)}({ratioText(p.mention)}){p.dropped ? ' · 급락' : ''}
          </li>
        ))}
      </ol>
    </div>
  )
}

function QuestionTable({ view }: { view: AioView }) {
  const { runIds, rows, otherConditionRuns } = view.questions
  const startOf = new Map(view.runs.map((r) => [r.runId, r.startedAt]))
  return (
    <section className="gaio-section" aria-labelledby="gaio-q-head">
      <h2 id="gaio-q-head">질문별</h2>
      <p className="gaio-fine">
        최신 회차와 같은 조건인 회차만 묶어요(회차 {runIds.length}개). 노출 k/N의 N은 AI 개요가 있었거나 없었던 회차(못 읽음 · 오류 빼고), 언급 k/N의 N은 판정된
        개요예요.{otherConditionRuns > 0 ? ` 조건이 다른 회차 ${otherConditionRuns}개는 이 표 · 추이에서 뺐어요(회차 목록에는 흐리게 보여요).` : ''}
      </p>
      <ul className="gaio-legend" aria-label="칸 기호">
        {Object.values(AIO_CELL).map((c) => (
          <li key={c.label}>
            <span className="gaio-legend-sym" aria-hidden="true">
              {c.symbol}
            </span>
            {c.label}
          </li>
        ))}
        <li>
          <span className="gaio-legend-sym" aria-hidden="true">
            ·
          </span>
          그 회차에 재지 않음
        </li>
      </ul>
      <div className="table-wrap gaio-table-wrap">
        <table className="gaio-qtable">
          <thead>
            <tr>
              <th scope="col">질문</th>
              {runIds.map((id) => (
                <th key={id} scope="col" className="gaio-cellcol">
                  {kstStamp(startOf.get(id) ?? '').split(' ')[0]}
                </th>
              ))}
              <th scope="col">노출 k/N</th>
              <th scope="col">언급 k/N</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.questionId}>
                <th scope="row" className="gaio-qtext">
                  {row.query || row.questionId}
                </th>
                {row.cells.map((cell, i) => (
                  <td key={runIds[i]} className="gaio-cellcol">
                    {cell ? (
                      <span className={`gaio-cell gaio-cell-${cell.kind}`} role="img" aria-label={cell.label} title={cell.label}>
                        {cell.symbol}
                      </span>
                    ) : (
                      <span className="gaio-cell gaio-cell-none" role="img" aria-label="그 회차에 재지 않음" title="그 회차에 재지 않음">
                        ·
                      </span>
                    )}
                  </td>
                ))}
                <td className={`gaio-k gaio-k-exposure${row.exposure.rate === null ? ' gaio-unknown' : ''}`}>{ratioText(row.exposure)}</td>
                <td className={`gaio-k gaio-k-mention${row.mention.rate === null ? ' gaio-unknown' : ''}`}>{ratioText(row.mention)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PostTable({ posts }: { posts: AioPostTableRow[] | null }) {
  if (posts === null) {
    return (
      <section className="gaio-section gaio-posts" aria-labelledby="gaio-p-head">
        <h2 id="gaio-p-head">올린 글이 출처로 나온 회차</h2>
        <p className="gaio-fine">원장 · 앱 밖 글 파일을 읽지 못해 올린 글 출처는 확인 불가예요(0편이 아니에요).</p>
      </section>
    )
  }
  const measured = posts.filter((p) => p.runs > 0).sort((a, b) => b.cited - a.cited || b.runs - a.runs)
  const waiting = posts.length - measured.length
  return (
    <section className="gaio-section gaio-posts" aria-labelledby="gaio-p-head">
      <h2 id="gaio-p-head">올린 글이 출처로 나온 회차</h2>
      <p className="gaio-fine">
        그 글을 올린 뒤 · 올라가 있던 회차만 N에 넣어요(올리기 전 · 내린 뒤 회차를 「안 나옴」으로 세지 않아요). 출처 목록이 온 개요가 있던 회차만이에요.
        {waiting > 0 ? ` 아직 올린 뒤 잰 회차가 없는 글 ${waiting}편은 표에 넣지 않았어요.` : ''}
      </p>
      {measured.length === 0 ? (
        <p className="muted">올린 뒤 잰 회차가 있는 글이 아직 없어요.</p>
      ) : (
        <div className="table-wrap gaio-table-wrap">
          <table className="gaio-ptable">
            <thead>
              <tr>
                <th scope="col">글</th>
                <th scope="col">작성자</th>
                <th scope="col">출처로 나온 회차</th>
                <th scope="col">처음 나온 날</th>
              </tr>
            </thead>
            <tbody>
              {measured.map((p) => (
                <tr key={p.key}>
                  <td className="gaio-ptitle">
                    {isHttp(p.url) ? (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.title ?? p.url}
                      </a>
                    ) : (
                      (p.title ?? p.url)
                    )}
                    {p.origin === 'external' && <span className="chip gaio-chip">앱 밖</span>}
                    {p.variant > 0 && <span className="gaio-fine"> · 주소 뒤 ?…만 다른 주소로 나온 회차 {p.variant}</span>}
                  </td>
                  <td>{p.writerKey ?? '—'}</td>
                  <td className="gaio-k">{ratioText({ k: p.cited, n: p.runs, rate: p.runs > 0 ? p.cited / p.runs : null })}</td>
                  <td>{p.firstCitedOn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function DetailItem({ item }: { item: GoogleAioDetailItem }) {
  const reason = item.reason ? (AIO_REASON_TEXT[item.reason as AioReason] ?? item.reason) : null
  return (
    <li className="gaio-item">
      <p className="gaio-item-q">
        <b>{item.query}</b>{' '}
        <a href={googleUrl(item.query)} target="_blank" rel="noreferrer" aria-label={`「${item.query}」 구글에서 보기(새 창)`}>
          구글에서 보기
        </a>
      </p>
      <p className="gaio-item-status">
        {AIO_STATUS_LABEL[item.status]}
        {reason ? ` — ${reason}` : ''}
        {item.status === 'shown' ? ` · ${mentionText(item.mentioned)}` : ''}
        {item.sourceOnly === true ? ' · 출처로만 보임(본문엔 이름 없음)' : ''}
        {item.truncated ? ' · 본문이 길어 앞부분만 저장' : ''}
      </p>
      {item.text && <p className="gaio-item-text">{excerpt(item.text)}</p>}
      {item.sources.length > 0 && (
        <ul className="gaio-sources">
          {item.sources.map((s, i) => (
            <li key={`${s.link}|${i}`}>
              {isHttp(s.link) ? (
                <a href={s.link} target="_blank" rel="noreferrer">
                  {s.title ?? s.link}
                </a>
              ) : (
                <span>{s.title ?? s.link}</span>
              )}
              {s.source && <span className="gaio-fine"> · {s.source}</span>}
              {s.kind === 'link' && <span className="gaio-fine"> · 본문 안 링크</span>}
              {s.owned && <span className="chip good gaio-chip">자사</span>}
              {s.post && (
                <span className="chip info gaio-chip">
                  올린 글{s.post.writerKey ? ` ${s.post.writerKey}` : ''}
                  {s.post.origin === 'external' ? ' · 앱 밖' : ''}
                </span>
              )}
              {s.variant && <span className="chip gaio-chip">올린 글 주소 뒤 ?…만 다름</span>}
            </li>
          ))}
        </ul>
      )}
      {(item.competitorMentions?.length ?? 0) > 0 && (
        <p className="gaio-fine">함께 나온 경쟁사: {item.competitorMentions!.map((c) => `${c.name} ${c.count}`).join(' · ')}</p>
      )}
    </li>
  )
}

function RunDetail({ detail, loading, error }: { detail: GoogleAioRunDetail | null; loading: boolean; error: string | null }) {
  const run = detail?.run
  return (
    <section id="gaio-detail" className="gaio-detail" aria-label="회차 자세히">
      {loading && <p className="muted">회차를 읽는 중…</p>}
      {error && (
        <p className="error" role="alert">
          회차를 읽지 못했어요 — {error}
        </p>
      )}
      {run && detail && !loading && (
        <>
          <h3>{kstStamp(run.startedAt)} 회차 자세히</h3>
          {run.stopMessage && <p className="gaio-fine">멈춘 까닭 — {run.stopMessage}</p>}
          <p className="gaio-fine">
            검색 위치 {run.conditions.location ?? '없음(나라 전체)'} · 질문지 {run.conditions.questionBankVersion} · 판정 {run.conditions.judgeEngine ?? '기록 없음'}
            {run.conditions.judgeModel ? `(${run.conditions.judgeModel})` : ''}
          </p>
          <p className="gaio-fine">
            검색 {n(run.usage.searches)}/{n(run.maxSearches)}회(늦게 오는 개요 받기 {n(run.usage.followUps)} · 다시 검색 {n(run.usage.reSearches)}) · 판정 {n(run.usage.judgeCalls)}회 · 판정
            토큰 입력 {n(run.usage.judgeTokens.input)} · 출력 {n(run.usage.judgeTokens.output)} · 생각 {n(run.usage.judgeTokens.thought)}
          </p>
          {detail.postsUnreadable && <p className="gaio-fine">원장 · 앱 밖 글을 읽지 못해 올린 글 표시는 확인 불가예요.</p>}
          <ol className="gaio-items">
            {detail.items.map((item) => (
              <DetailItem key={item.questionId} item={item} />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

interface RunListProps {
  view: AioView
  pricing: EnginePricing | null | undefined
  openRun: string | null
  onToggle: (runId: string) => void
  /** 다시 판정을 물을 수 있으면 그 함수(이 PC 켜짐 · 판정 엔진 준비 · 도는 일 없음일 때만). */
  onRejudge: ((row: AioRunRow) => void) | null
}

function RunList({ view, pricing, openRun, onToggle, onRejudge }: RunListProps) {
  return (
    <section className="gaio-section" aria-labelledby="gaio-r-head">
      <h2 id="gaio-r-head">회차</h2>
      <div className="table-wrap gaio-table-wrap">
        <table className="gaio-runs">
          <thead>
            <tr>
              <th scope="col">회차</th>
              <th scope="col">상태</th>
              <th scope="col">있음 · 없음 · 못 읽음 · 오류</th>
              <th scope="col">노출</th>
              <th scope="col">언급</th>
              <th scope="col">검색</th>
              <th scope="col">판정</th>
              <th scope="col">
                <span className="sr-only">동작</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.runs.map((r) => {
              const s = r.summary
              const open = openRun === r.runId
              return (
                <tr key={r.runId} className={r.sameCondition ? '' : 'gaio-dim'}>
                  <td>{kstStamp(r.startedAt)}</td>
                  <td className="gaio-state-cell">
                    {STATE_LABEL[r.state]}
                    {!r.summaryRun && r.state !== 'running' && <span className="chip warn gaio-chip">일부만 잰 회차</span>}
                    {!r.sameCondition && <span className="gaio-fine gaio-block">조건 다름: {conditionSummary(r.diffs)}</span>}
                  </td>
                  <td>
                    {s.shown} · {s.absent} · {s.unreadable} · {s.failed}
                  </td>
                  <td>
                    {pctText(s.exposure)}
                    <span className="gaio-fine gaio-block">{ratioText(s.exposure)}</span>
                  </td>
                  <td>
                    {pctText(s.mention)}
                    <span className="gaio-fine gaio-block">{ratioText(s.mention)}</span>
                  </td>
                  <td>
                    {n(r.usage.searches)}/{n(r.maxSearches)}회
                  </td>
                  <td className="gaio-cost">{judgeCostText(r, pricing)}</td>
                  <td className="gaio-row-actions">
                    <button type="button" className="ghost" aria-expanded={open} aria-controls="gaio-detail" onClick={() => onToggle(r.runId)}>
                      {open ? '접기' : '자세히'}
                    </button>
                    {onRejudge && s.judgeUnknown > 0 && (
                      <button type="button" className="ghost" onClick={() => onRejudge(r)}>
                        판정 불가 {s.judgeUnknown}개 다시 판정
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="gaio-fine">
        판정 비용은 엔진 단가(측정 상태 화면의 단가)로 어림해요 — 생각 토큰도 출력 단가로 셉니다. SerpAPI 검색은 이미 낸 요금 안이라 따로 셈하지 않아요.
      </p>
    </section>
  )
}

function Results({ view, unreadableRuns, pricing, openRun, onToggle, onRejudge, detail }: RunListProps & { unreadableRuns: number; detail: { data: GoogleAioRunDetail | null; loading: boolean; error: string | null } | null }) {
  const s = view.summary
  const prev = view.previous
  const dropRuns = view.trend.points.filter((p) => p.dropped).map((p) => kstStamp(p.startedAt))
  return (
    <>
      {unreadableRuns > 0 && (
        <p className="error" role="alert">
          읽지 못한 회차 {unreadableRuns}개 — 파일이 깨져 셈에서 뺐어요(지우지 않았어요).
        </p>
      )}
      <p className="gaio-note">{view.note}</p>
      {s ? (
        <>
          <p className="gaio-basis">
            {kstStamp(s.startedAt)} 회차 기준 — 잰 질문 {s.measured}/{s.planned}
            {s.state !== 'done' ? ' · 일부만 잰 회차(90% 이상이라 요약에 씀)' : ''}
          </p>
          <SummaryTiles summary={s} />
          <ul className="gaio-facts">
            {s.noSourceList > 0 && <li>출처 없는 개요 {s.noSourceList} — 출처 목록 없이 온 개요는 출처 지표 분모에서 뺐어요.</li>}
            {s.sourceOnly > 0 && <li>출처로만 보임 {s.sourceOnly} — 본문엔 이름이 없고 출처 제목 · 이름에만 나온 개요예요.</li>}
            {s.variantSource > 0 && <li>올린 글 주소 뒤에 ?…만 다른 주소가 출처인 개요 {s.variantSource} — 올린 글 출처로 세지 않고 따로 보여요.</li>}
            <li>
              함께 나온 경쟁사:{' '}
              {s.competitors === null
                ? '확인 불가(경쟁사 목록이 없거나 판정된 개요가 없어요)'
                : s.competitors.length === 0
                  ? '판정된 개요에는 없었어요'
                  : s.competitors.map((c) => `${c.name} ${c.count}`).join(' · ')}
            </li>
            {prev && (
              <li>
                직전 같은 조건 회차와(두 회차 모두 잰 질문 {prev.common}개): AI 개요 노출 {pctText(prev.exposure[0])} → {pctText(prev.exposure[1])} · 언급(두 회차 모두 판정된{' '}
                {prev.mentionCommon}개) {pctText(prev.mention[0])} → {pctText(prev.mention[1])}
              </li>
            )}
          </ul>
        </>
      ) : (
        <p className="muted">요약할 회차가 아직 없어요 — 끝난 회차나 질문의 90% 이상을 잰 회차만 요약해요.</p>
      )}
      {dropRuns.length > 0 && (
        <p className="gaio-warn">
          AI 개요가 한 번도 안 떴어요({dropRuns.join(' · ')} 회차) — 구글 · SerpAPI 쪽 변화일 수 있어요(앞 회차들은 {Math.round(AIO_DROP_FROM * 100)}%를 넘었어요). 추이 선은 그
          회차에서 잇지 않았어요. 회차 자세히에서 응답을 확인해 주세요.
        </p>
      )}
      {view.trend.points.length >= 2 && (
        <section className="gaio-section" aria-labelledby="gaio-t-head">
          <h2 id="gaio-t-head">추이</h2>
          <Trend points={view.trend.points} />
        </section>
      )}
      {view.questions.rows.length > 0 && <QuestionTable view={view} />}
      <RunList view={view} pricing={pricing} openRun={openRun} onToggle={onToggle} onRejudge={onRejudge} />
      {openRun && detail && <RunDetail detail={detail.data} loading={detail.loading} error={detail.error} />}
      <PostTable posts={view.posts} />
    </>
  )
}

// ── 화면 ─────────────────────────────────────────────────────────────────────

type Note = { text: string; alert: boolean; extra?: string | null }

function GoogleAioScreen({ tenantId, brandName }: { tenantId: string; brandName: string }) {
  // 상태 — null은 아직 읽는 중. status null + error null은 웹(404 — 기능 없음).
  const [res, setRes] = useState<{ status: GoogleAioStatus | null; error: string | null } | null>(null)
  // 앞서 받은 회차 · 지표 — 도는 동안은 서버가 비워 보내므로 이것을 둔다.
  const [kept, setKept] = useState<{ view: AioView | null; unreadableRuns: number } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [note, setNote] = useState<Note | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<GoogleAioPlan | null>(null)
  const [starting, setStarting] = useState(false)
  const [enableAsk, setEnableAsk] = useState(false)
  const [savingSwitch, setSavingSwitch] = useState(false)
  const [rejudgeAsk, setRejudgeAsk] = useState<{ runId: string; startedAt: string; max: number } | null>(null)
  const [rejudgeStarting, setRejudgeStarting] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ runId: string; data: GoogleAioRunDetail | null; error: string | null } | null>(null)
  const [pricing, setPricing] = useState<EnginePricing | null | undefined>(undefined)
  // 다음 상태가 그려진 뒤 포커스를 줄 곳(누른 단추가 사라질 때) · 진행 글자가 있었는지.
  const focusNext = useRef<string | null>(null)
  const hadProgress = useRef(false)

  const apply = useCallback((next: GoogleAioStatus | null) => {
    setRes({ status: next, error: null })
    if (next && !next.running && !next.rejudging && !next.runningElsewhere) setKept({ view: next.view, unreadableRuns: next.unreadableRuns })
  }, [])

  const refresh = useCallback(
    (): Promise<GoogleAioStatus | null> =>
      loadGoogleAio(tenantId).then(
        (next) => {
          apply(next)
          return next
        },
        (err: unknown) => {
          setNote({ text: `상태를 다시 읽지 못했어요 — ${message(err)}`, alert: true })
          return null
        },
      ),
    [tenantId, apply],
  )

  useEffect(() => {
    let alive = true
    loadGoogleAio(tenantId).then(
      (next) => {
        if (alive) apply(next)
      },
      (err: unknown) => {
        if (!alive) return
        const text = err instanceof GoogleAioRequestError && err.status === 404 ? '이 브랜드를 앱 서버에서 찾지 못했어요(경쟁사 · 지운 브랜드는 볼 수 없어요).' : message(err)
        setRes({ status: null, error: text })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId, reloadKey, apply])

  const st = res?.status ?? null
  const live = Boolean(st && (st.running || st.rejudging || st.runningElsewhere))

  // 도는 동안만 2초마다 묻는다(서버 메모리의 진행 — 검색 · 계정 · 원장 읽기 없음).
  useEffect(() => {
    if (!live) return
    let alive = true
    const timer = window.setInterval(() => {
      loadGoogleAio(tenantId).then(
        (next) => {
          if (!alive) return
          setPollError(null)
          apply(next)
        },
        (err: unknown) => {
          if (alive) setPollError(`진행 상태를 읽지 못했어요 — ${message(err)}`)
        },
      )
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [live, tenantId, apply])

  // 누른 단추가 사라졌으면 포커스를 남는 곳으로 — 시작하면 진행 글자, 끝나면 「지금 재기」.
  useEffect(() => {
    const want = focusNext.current
    if (want) {
      const el = document.getElementById(want)
      if (el) {
        el.focus()
        focusNext.current = null
      }
    }
    const had = hadProgress.current
    hadProgress.current = document.getElementById('gaio-progress') !== null
    if (had && !hadProgress.current && (document.activeElement === null || document.activeElement === document.body)) document.getElementById('gaio-now')?.focus()
  }, [st])

  const hasRuns = (kept?.view?.runs.length ?? 0) > 0
  useEffect(() => {
    if (!hasRuns || pricing !== undefined) return
    let alive = true
    loadPricing().then((p) => {
      if (alive) setPricing(p)
    })
    return () => {
      alive = false
    }
  }, [hasRuns, pricing])

  useEffect(() => {
    if (!openRun) return
    let alive = true
    loadGoogleAioRun(tenantId, openRun).then(
      (data) => {
        if (alive) setDetail({ runId: openRun, data, error: null })
      },
      (err: unknown) => {
        if (alive) setDetail({ runId: openRun, data: null, error: message(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId, openRun])

  const askPlan = (resume: string | null) => {
    if (planning || starting) return
    setPlanning(true)
    setNote(null)
    planGoogleAio(tenantId, resume)
      .then(
        (p) => {
          if (p.planId && !p.blocked) setPlan(p)
          else setNote({ text: p.blocked?.message ?? '지금은 시작할 수 없어요.', alert: true, extra: p.quota ? quotaLine(p.quota) : null })
        },
        (err: unknown) => {
          setNote({ text: message(err), alert: true })
          if (err instanceof GoogleAioRequestError && err.status === 409) void refresh()
        },
      )
      .finally(() => setPlanning(false))
  }

  const confirmRun = () => {
    if (!plan?.planId || starting) return
    const planId = plan.planId
    setStarting(true)
    focusNext.current = 'gaio-progress'
    runGoogleAio(tenantId, planId)
      .then(
        async () => {
          setPlan(null)
          setNote(null)
          await refresh()
        },
        async (err: unknown) => {
          setPlan(null)
          if (!(err instanceof GoogleAioRequestError) || err.status !== 409) {
            focusNext.current = null
            setNote({ text: message(err), alert: true })
            return
          }
          // 계획이 바뀌었거나, 그 사이 다른 탭 · 다른 창이 먼저 시작했다 — 상태를 다시 읽어 도는 중이면 진행으로 넘어간다.
          const next = await refresh()
          if (next?.running) return
          focusNext.current = null
          setNote({ text: err.code === 'plan-changed' ? PLAN_RENEWED : err.message, alert: true })
        },
      )
      .finally(() => setStarting(false))
  }

  const cancelRun = (runId: string) => {
    cancelGoogleAio(tenantId, runId).then(
      () => refresh(),
      (err: unknown) => {
        setNote({ text: `중단하지 못했어요 — ${message(err)}`, alert: true })
        void refresh()
      },
    )
  }

  const confirmRejudge = () => {
    if (!rejudgeAsk || rejudgeStarting) return
    const { runId } = rejudgeAsk
    setRejudgeStarting(true)
    focusNext.current = 'gaio-progress'
    rejudgeGoogleAio(tenantId, runId, 'unknown')
      .then(
        async () => {
          setRejudgeAsk(null)
          setNote(null)
          await refresh()
        },
        async (err: unknown) => {
          focusNext.current = null
          setRejudgeAsk(null)
          setNote({ text: `다시 판정을 시작하지 못했어요 — ${message(err)}`, alert: true })
          if (err instanceof GoogleAioRequestError && err.status === 409) await refresh()
        },
      )
      .finally(() => setRejudgeStarting(false))
  }

  const saveSwitch = (enabled: boolean) => {
    if (savingSwitch) return
    setSavingSwitch(true)
    saveGoogleAioSettings(enabled)
      .then(
        async () => {
          setEnableAsk(false)
          focusNext.current = enabled ? 'gaio-now' : 'gaio-enable'
          setNote({ text: enabled ? '이 PC에서 켰어요 — 「지금 재기」를 누르면 먼저 검색 수와 남은 몫을 보여 드려요(검색 0회).' : '이 PC에서 껐어요.', alert: false })
          await refresh()
        },
        (err: unknown) => {
          setEnableAsk(false)
          setNote({ text: `이 PC 설정을 저장하지 못했어요 — ${message(err)}`, alert: true })
        },
      )
      .finally(() => setSavingSwitch(false))
  }

  const toggleRun = (runId: string) => {
    setOpenRun((cur) => (cur === runId ? null : runId))
  }

  const view = kept?.view ?? null
  const latest = view?.runs[0] ?? null
  const latestStopped = !live && latest && (latest.state === 'partial' || latest.state === 'cancelled' || latest.state === 'interrupted') ? latest : null
  const canRejudge = Boolean(st && st.enabled && st.pilot && st.judge.ready && !live && st.configured && !st.configError)
  const detailState = openRun ? { data: detail?.runId === openRun ? detail.data : null, loading: detail?.runId !== openRun, error: detail?.runId === openRun ? detail.error : null } : null

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">{brandName}</p>
          <h1>구글 AI 개요(시범)</h1>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            다시 읽기
          </button>
        </div>
      </header>
      <p className="page-lead">
        구글 검색의 AI 개요에 이 브랜드가 나오는지 따로 재는 시범 측정입니다. 점수에 세는 이름 없는 질문을 질문 그대로 구글에 검색해, AI 개요가 떴는지 · 그
        안에 이 브랜드가 나오는지 · 어떤 출처를 댔는지 봅니다. 점수 · 정기진단 보고서 · 전주 비교에는 넣지 않습니다. 검색 한 번마다 SerpAPI 사용량이 들어,
        「지금 재기」를 누르고 확인해야만 잽니다.
      </p>

      {res === null && <p className="muted">불러오는 중…</p>}
      {res?.error && (
        <p className="error" role="alert">
          구글 AI 개요 시범 상태를 읽지 못했어요 — {res.error}{' '}
          <button type="button" className="ghost" onClick={() => setReloadKey((k) => k + 1)}>
            다시 시도
          </button>
        </p>
      )}
      {res && !res.error && st === null && <p className="muted">구글 AI 개요 시범은 데스크톱 앱에서 볼 수 있습니다(웹에는 이 기능이 없습니다).</p>}

      {st && (
        <section className="gaio-control" aria-label="이 PC · 지금 재기">
          <Control
            st={st}
            planning={planning}
            onEnable={() => setEnableAsk(true)}
            onDisable={() => saveSwitch(false)}
            onPlan={askPlan}
            onCancel={cancelRun}
            savingSwitch={savingSwitch}
          />
          {note &&
            (note.alert ? (
              <div className="error gaio-note-box" role="alert">
                <p>{note.text}</p>
                {note.extra && <p className="gaio-fine">{note.extra}</p>}
              </div>
            ) : (
              <p className="pi-note" role="status">
                {note.text}
              </p>
            ))}
          {pollError && (
            <p className="error" role="alert">
              {pollError}
            </p>
          )}
          {latestStopped && (
            <p className="error" role="alert">
              마지막 회차({kstStamp(latestStopped.startedAt)}) 멈춤 — {latestStopped.stopMessage ?? (latestStopped.state === 'interrupted' ? INTERRUPTED : '까닭이 적혀 있지 않아요.')}
            </p>
          )}
        </section>
      )}

      {st && view && (
        <Results
          view={view}
          unreadableRuns={kept?.unreadableRuns ?? 0}
          pricing={pricing}
          openRun={openRun}
          onToggle={toggleRun}
          onRejudge={canRejudge ? (row) => setRejudgeAsk({ runId: row.runId, startedAt: row.startedAt, max: row.summary.judgeUnknown }) : null}
          detail={detailState}
        />
      )}
      {st && !view && !live && (
        <>
          {(kept?.unreadableRuns ?? 0) > 0 && (
            <p className="error" role="alert">
              읽지 못한 회차 {kept?.unreadableRuns}개 — 파일이 깨져 셈에서 뺐어요(지우지 않았어요).
            </p>
          )}
          {st.pilot && <p className="muted">아직 잰 회차가 없어요.</p>}
        </>
      )}

      {enableAsk && (
        <ConfirmDialog title="이 PC에서 시범 측정을 켤까요?" confirmLabel="이 PC에서 켜기" busy={savingSwitch} onConfirm={() => saveSwitch(true)} onCancel={() => setEnableAsk(false)}>
          <p>검색마다 SerpAPI 사용량이 들어요. 같은 계정을 다른 PC · 다른 프로젝트(구글 색인 자동 확인 등)와 나눠 써요 — 계정에 남은 검색이 바닥 아래로 내려가지 않게 앱이 멈춰요.</p>
          <p>켜도 저절로 재지 않아요 — 「지금 재기」를 누르고 확인창에서 한 번 더 확인해야 검색해요. 이 화면에서 언제든 끌 수 있어요.</p>
        </ConfirmDialog>
      )}
      {plan && <RunConfirm plan={plan} busy={starting} onConfirm={confirmRun} onCancel={() => setPlan(null)} />}
      {rejudgeAsk && st && (
        <ConfirmDialog
          title="다시 판정할까요?"
          confirmLabel={`다시 판정(판정 최대 ${rejudgeAsk.max}회)`}
          busy={rejudgeStarting}
          onConfirm={confirmRejudge}
          onCancel={() => setRejudgeAsk(null)}
        >
          <p>
            {kstStamp(rejudgeAsk.startedAt)} 회차에서 판정 불가로 남은 개요를 저장된 본문으로 다시 판정해요 — <b>판정 최대 {rejudgeAsk.max}회</b>({st.judge.label}) · <b>검색 0회</b>.
          </p>
          <p>SerpAPI 검색은 하지 않아요. 판정 엔진 사용량만 들어요. 다시 판정이 실패해도 앞선 판정은 지우지 않아요.</p>
        </ConfirmDialog>
      )}
    </>
  )
}

function Control({
  st,
  planning,
  savingSwitch,
  onEnable,
  onDisable,
  onPlan,
  onCancel,
}: {
  st: GoogleAioStatus
  planning: boolean
  savingSwitch: boolean
  onEnable: () => void
  onDisable: () => void
  onPlan: (resume: string | null) => void
  onCancel: (runId: string) => void
}) {
  if (st.settingsError) {
    return (
      <p className="error" role="alert">
        {st.settingsError}
      </p>
    )
  }
  // 도는 회차 · 다시 판정은 스위치 · 키 상태보다 먼저 보인다 — 다른 탭에서 끄더라도 다음 질문 전까지는 돌고, 「중단」이 있어야 한다.
  const run = st.running
  if (run) {
    return (
      <>
        <p id="gaio-progress" className="gaio-progress" role="status" tabIndex={-1}>
          {run.cancelling ? '멈추는 중… 지금 받는 검색 하나는 끝까지 받아요. ' : run.resumed ? '이어 재는 중… ' : '재는 중… '}
          {run.done}/{run.planned} · 검색 {n(run.searches)}/{n(run.maxSearches)}회 · 있음 {run.shown} · AI 개요 없음 {run.absent} · 못 읽음 {run.unreadable} · 오류 {run.failed} · 판정 불가{' '}
          {run.judgeUnknown}
        </p>
        <p className="gaio-fine">앱을 켜 두세요 — 끄면 멈추고 받은 검색만 셉니다. 도는 동안 아래 결과는 지난 회차까지예요.</p>
        {!run.cancelling && (
          <div className="gaio-actions">
            <button type="button" className="btn" onClick={() => onCancel(run.runId)}>
              중단
            </button>
          </div>
        )}
      </>
    )
  }
  if (st.rejudging) {
    return (
      <p id="gaio-progress" className="gaio-progress" role="status" tabIndex={-1}>
        다시 판정하는 중… {st.rejudging.done}/{st.rejudging.total} · 검색 0회 — 판정 엔진({st.judge.label}) 사용량만 들어요.
      </p>
    )
  }
  if (!st.pilot) {
    return (
      <p className="gaio-plain">
        {st.pilotMessage ?? '이 브랜드는 시범 대상이 아니에요.'} 시범은 정해진 브랜드에서만 재요 — 점수 · 보고서에는 영향이 없어요.
      </p>
    )
  }
  if (!st.configured) return <p className="gaio-plain">{NO_KEY}</p>
  if (st.configError) return <p className="error">구글 AI 개요 시범: {st.configError}</p>
  if (!st.enabled) {
    return (
      <>
        <p className="gaio-plain">{OFF_TEXT}</p>
        <div className="gaio-actions">
          <button id="gaio-enable" type="button" className="btn" aria-disabled={savingSwitch || undefined} onClick={() => !savingSwitch && onEnable()}>
            이 PC에서 켜기
          </button>
        </div>
      </>
    )
  }
  if (st.runningElsewhere) return <p className="gaio-plain">{ELSEWHERE_NOTE}</p>
  const blocked = st.measuring ? MEASURING_NOTE : !st.judge.ready ? (st.judge.problem ?? '판정 엔진을 쓸 수 없어요.') : st.busy
  return (
    <>
      <p className="gaio-state">
        이 PC: 켜짐 · 판정 엔진 {st.judge.label} · 검색 위치 {st.location ?? '없음(나라 전체)'} · 질문: 점수에 세는 이름 없는 질문{' '}
        <button type="button" className="ghost" aria-disabled={savingSwitch || undefined} onClick={() => !savingSwitch && onDisable()}>
          이 PC에서 끄기
        </button>
      </p>
      {blocked && <p className="gaio-blocked">{blocked}</p>}
      <div className="gaio-actions">
        <button id="gaio-now" type="button" className="btn primary" disabled={Boolean(blocked)} aria-disabled={planning || undefined} onClick={() => !planning && onPlan(null)}>
          지금 재기
        </button>
        {st.resumable && (
          <button type="button" className="btn" disabled={Boolean(blocked)} aria-disabled={planning || undefined} onClick={() => !planning && onPlan(st.resumable!.runId)}>
            이어 재기(남은 {st.resumable.remaining}문항)
          </button>
        )}
      </div>
      {planning ? (
        <p className="muted" role="status">
          계획을 세우는 중… SerpAPI 계정만 읽어요(검색 0회).
        </p>
      ) : (
        <p className="gaio-fine">누르면 먼저 검색 수 · 남은 몫을 보여 드려요(검색 0회) — 확인해야 검색해요. 2주에 한 번 재기를 권해요.</p>
      )}
      {st.rejudged && (
        <p className="pi-note" role="status">
          {kstStamp(st.rejudged.at)} 다시 판정을 마쳤어요 — 판정 {st.rejudged.judged}개 · 못 함 {st.rejudged.failed}개
          {st.rejudged.stopped ? ' · 3번 잇따라 실패해 멈췄어요(판정 엔진을 확인해 주세요)' : ''}
        </p>
      )}
    </>
  )
}

function RunConfirm({ plan, busy, onConfirm, onCancel }: { plan: GoogleAioPlan; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const q = plan.quota
  const M = plan.maxSearches
  const resume = plan.resume
  return (
    <ConfirmDialog
      title={resume ? '멈춘 회차를 이어 잴까요?' : '구글 AI 개요를 지금 잴까요?'}
      confirmLabel={`${resume ? '이어 재기' : '지금 재기'}(검색 최대 ${n(M)}회)`}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul className="gaio-confirm">
        <li>
          {resume
            ? `멈춘 회차의 남은 ${plan.questions}문항만 보내요(질문 ${plan.totalQuestions}개 중 — 이미 받은 질문은 다시 보내지 않아요).`
            : `점수에 세는 이름 없는 질문 ${plan.questions}개${plan.bankLabel ? `(${plan.bankLabel})` : ''}`}
        </li>
        <li>
          <b>검색 최대 {n(M)}회</b> — 늦게 오는 개요는 질문당 2회, 못 읽은 질문 다시 검색 몫까지예요. 보통은 이보다 적어요.
        </li>
        <li>
          판정({plan.judge.label}) 최대 {n(plan.maxJudgeCalls)}회 — AI 개요가 뜬 질문만 판정해요(판정 엔진 사용량이 들어요).
        </li>
        {q && <li>{quotaLine(q)}</li>}
        <li>검색 위치: {plan.location ?? '없음(나라 전체 · gl=kr)'}</li>
        <li>
          걸리는 시간 {minutesText(plan.expectedMinutes)} — 앱을 켜 두세요 — 끄면 멈추고 받은 검색만 셉니다.
        </li>
        <li>
          {plan.perSearchUsd !== null
            ? `요금: 이미 낸 요금 안 · 검색당 환산 약 $${plan.perSearchUsd.toFixed(3)}(최대 약 $${(plan.perSearchUsd * M).toFixed(2)}어치${q?.planName ? ` · ${q.planName}` : ''})`
            : '요금: 이미 낸 요금 안이에요(요금제를 몰라 검색당 환산은 못 해요).'}
        </li>
        <li>
          지난 회차:{' '}
          {plan.lastRunAt
            ? `${kstStamp(plan.lastRunAt)}${plan.daysSinceLastRun === null ? '' : plan.daysSinceLastRun === 0 ? '(오늘)' : `(${plan.daysSinceLastRun}일 전)`}`
            : '없음(첫 회차)'}
        </li>
      </ul>
      {plan.recent && <p className="gaio-warn">지난 회차가 14일이 안 됐어요 — 2주에 한 번 재기를 권해요. 몫을 아끼려면 다음에 재 주세요.</p>}
      <p className="ce-dialog-note">확인하면 하나씩 차례로 검색해요. 「중단」을 누르면 다음 검색 전에 멈춰요(받은 검색은 남겨요).</p>
    </ConfirmDialog>
  )
}

export default function GoogleAio() {
  const { tenant } = useTenant()
  if (!tenant) return null
  // 브랜드를 바꾸면 화면 상태(받은 계획 · 펼친 회차 · 진행)를 모두 새로 시작한다.
  return <GoogleAioScreen key={tenant.tenantId} tenantId={tenant.tenantId} brandName={tenant.brandName} />
}
