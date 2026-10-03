import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BrandText } from '../components/AnswerCard'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { highlightAnswer, type MarkKind } from '../lib/answerHighlight'
import {
  answersCsv,
  buildAnswerQuestions,
  engineOrder,
  type AnswerOutcome,
  type AnswerQuestion,
  type AnswerResponse,
  type CitationChip,
} from '../lib/answerInsights'
import { loadQuestionAnalyses, loadQuestionBank, loadRawAnswers, type RawAnswer } from '../lib/api'
import { resolveBankVersion } from '../lib/bankVersion'
import { ENGINE_LABEL, weekLabel } from '../lib/format'
import { downloadCsv, safeFileName } from '../lib/markdownFile'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'

type Scope = 'unnamed' | 'named' | 'all'
type ResultFilter = 'all' | 'hit' | 'miss' | 'split'

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'unnamed', label: '이름 없는 질문' },
  { id: 'named', label: '이름 넣은 질문' },
  { id: 'all', label: '전체' },
]
const RESULTS: { id: ResultFilter; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'hit', label: '불림' },
  { id: 'miss', label: '안 불림' },
  { id: 'split', label: '엔진마다 다름' },
]
const OWNER_LABEL: Record<CitationChip['ownerType'], string> = {
  'brand-owned': '자사',
  'competitor-owned': '경쟁사',
  'third-party-authority': '제3자',
  'third-party-ugc': '이용자 글',
  unknown: '알 수 없음',
}
const OWNER_TONE: Record<CitationChip['ownerType'], string> = {
  'brand-owned': 'good',
  'competitor-owned': 'bad',
  'third-party-authority': 'info',
  'third-party-ugc': '',
  unknown: '',
}

function outcomeChip(r: AnswerResponse): { text: string; cls: string } {
  if (r.outcome === 'ask') return { text: '되물음', cls: 'warn' }
  if (r.outcome === 'miss') return { text: '안 불림', cls: 'bad' }
  if (r.rank === 1) return { text: '1순위 추천', cls: 'good' }
  if (r.rank) return { text: `${r.rank}순위`, cls: 'info' }
  return { text: '불림 · 순서 없음', cls: 'good' }
}

/** 이 응답들이 결과 거르개를 통과하나 — 엔진을 골랐으면 그 엔진 응답만 본다. */
function passes(q: AnswerQuestion, engine: string, result: ResultFilter): boolean {
  if (result === 'all') return true
  if (result === 'split') return q.divergence !== null
  const rs = q.responses.filter((r) => (!engine || r.engine === engine) && r.outcome !== 'ask')
  if (rs.length === 0) return false
  const anyHit = rs.some((r) => r.outcome === 'hit')
  return result === 'hit' ? anyHit : !anyHit
}

/**
 * AI 답변 — 질문 하나를 엔진들이 각각 어떻게 답했는지 나란히 본다(상용화 UI 2차 8단계).
 *
 * 다른 화면은 응답을 비율·순위로 접어서 보여 준다. 고객이 가장 먼저 묻는 것은 "그래서 AI가 실제로 뭐라고
 * 했나"라서, 여기서는 접지 않는다 — 언급 문장, 순위, 1순위로 꼽은 곳, 붙인 출처를 엔진별 칸에 그대로 둔다.
 * 값은 전부 저장된 판정 기록이고 새로 판단하지 않는다. 원문은 데스크톱 앱의 원문 API로 질문 하나씩만 읽는다
 * (웹 배포에는 그 API가 없어 판정 문장만 보인다).
 */
export default function Answers() {
  const { tenant } = useTenant()
  const [params, setParams] = useSearchParams()
  const { history, weeks, weekOf, setWeekOf, data: analyses, loading } = useWeeklyPage<QuestionRepeatAnalysis[]>(
    loadQuestionAnalyses,
    tenant?.tenantId ?? '',
    [],
    params.get('week') ?? '',
  )

  // 질문별 승패와 같은 이유로 이 주차를 잰 은행 버전으로 부른다(lib/bankVersion.ts).
  const bankVersion = resolveBankVersion(history, weekOf, analyses)
  const [bank, setBank] = useState<{ key: string; questions: QuestionSpec[] }>({ key: '', questions: [] })
  const bankKey = `${tenant?.tenantId ?? ''}|${bankVersion ?? ''}`
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    const key = `${tenant.tenantId}|${bankVersion ?? ''}`
    void loadQuestionBank(tenant.tenantId, bankVersion).then((b) => {
      if (alive) setBank({ key, questions: b?.questions ?? [] })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, bankVersion])
  const brandName = tenant?.brandName ?? ''
  const all = useMemo(
    () => buildAnswerQuestions(analyses, bank.key === bankKey ? bank.questions : [], brandName),
    [analyses, bank, bankKey, brandName],
  )
  const engines = useMemo((): string[] => [...new Set(analyses.map((a) => a.engine))].sort(engineOrder), [analyses])

  // 고른 질문은 주소(?q=)에 둔다 — 개요의 답변 카드·놓친 질문이 이 화면의 그 질문으로 바로 연다.
  const asked = params.get('q') ?? ''
  const picked = all.find((q) => q.questionId === asked)
  // 종류를 아직 안 골랐으면 이름 없는 질문(점수 기준)을 보인다. 주소로 연 질문이 이름 넣은 질문이면 전체를 보여
  // 목록에서도 그 질문이 보이게 한다.
  const [scopePick, setScope] = useState<Scope | null>(null)
  const scope: Scope = scopePick ?? (picked?.named ? 'all' : 'unnamed')
  // 주제는 지금 종류(이름 없는/넣은 질문)에 있는 것만 — 이름 넣은 질문은 질문마다 주제가 따로라 목록이 길어진다.
  const topics = useMemo(
    () => [
      ...new Set(
        all
          .filter((q) => scope === 'all' || (scope === 'named') === q.named)
          .map((q) => q.topic)
          .filter((t): t is string => Boolean(t)),
      ),
    ],
    [all, scope],
  )
  const [engine, setEngine] = useState('')
  const [result, setResult] = useState<ResultFilter>('all')
  const [topic, setTopic] = useState('')
  const activeEngine = engines.includes(engine) ? engine : ''
  const activeTopic = topics.includes(topic) ? topic : ''

  const shown = useMemo(
    () =>
      all.filter(
        (q) =>
          (scope === 'all' || (scope === 'named') === q.named) &&
          (!activeTopic || q.topic === activeTopic) &&
          passes(q, activeEngine, result),
      ),
    [all, scope, activeTopic, activeEngine, result],
  )

  const selected = picked ?? shown[0] ?? null
  const pick = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('q', id)
    setParams(next, { replace: true })
  }
  const tally = useMemo(() => {
    let hit = 0
    let answered = 0
    for (const q of shown) {
      for (const r of q.responses) {
        if (activeEngine && r.engine !== activeEngine) continue
        if (r.outcome === 'ask') continue
        answered += 1
        if (r.outcome === 'hit') hit += 1
      }
    }
    return { hit, answered }
  }, [shown, activeEngine])

  const exportCsv = () => {
    if (!tenant) return
    const name = safeFileName(`${tenant.brandName}-AI답변-${weekOf}${activeEngine ? `-${ENGINE_LABEL[activeEngine] ?? activeEngine}` : ''}.csv`)
    downloadCsv(name, answersCsv(shown, activeEngine))
  }

  if (!tenant) return null

  return (
    <>
      <header className="page-head">
        <div className="page-title">
          <p className="page-eyebrow">
            {tenant.brandName}
            {weekOf ? ` · ${weekLabel(weekOf)}` : ''}
          </p>
          <h1>AI 답변</h1>
        </div>
        <div className="page-actions">
          <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
          <button type="button" className="btn" onClick={exportCsv} disabled={shown.length === 0}>
            CSV 내보내기
          </button>
        </div>
      </header>
      <p className="page-lead">
        질문 하나를 엔진들이 각각 어떻게 답했는지 나란히 봅니다. 문장·순위·출처는 저장된 판정 그대로이며, 점수의
        언급률은 <b>이름 없는 질문</b>만 셉니다.
      </p>

      {loading && <p className="muted">불러오는 중…</p>}
      {!loading && all.length === 0 && <p className="muted">이 주차에 저장된 판정 기록이 없습니다.</p>}

      {!loading && all.length > 0 && (
        <>
          <div className="ans-filters">
            <div className="seg" role="group" aria-label="질문 종류">
              {SCOPES.map((s) => (
                <button key={s.id} type="button" className={scope === s.id ? 'on' : undefined} onClick={() => setScope(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="결과">
              {RESULTS.map((s) => (
                <button key={s.id} type="button" className={result === s.id ? 'on' : undefined} onClick={() => setResult(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <label className="field-inline">
              <span>엔진</span>
              <select value={activeEngine} onChange={(e) => setEngine(e.target.value)}>
                <option value="">모든 엔진</option>
                {engines.map((e) => (
                  <option key={e} value={e}>
                    {ENGINE_LABEL[e] ?? e}
                  </option>
                ))}
              </select>
            </label>
            {topics.length > 0 && (
              <label className="field-inline">
                <span>주제</span>
                <select value={activeTopic} onChange={(e) => setTopic(e.target.value)}>
                  <option value="">모든 주제</option>
                  {topics.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="dash-sub">
              질문 {shown.length}개 · 응답 {tally.answered}건 중 {tally.hit}건 불림
            </span>
          </div>

          <div className="ans-layout">
            <nav className="ans-list" aria-label="질문 목록">
              <p className="ans-legend dash-caption">
                점 순서 {engines.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')} · 숫자 = 추천 순위
              </p>
              {shown.length === 0 && <p className="dash-caption">거르개에 맞는 질문이 없습니다.</p>}
              {shown.map((q) => (
                <button
                  key={q.questionId}
                  type="button"
                  className={`ans-item${selected?.questionId === q.questionId ? ' on' : ''}`}
                  onClick={() => pick(q.questionId)}
                  aria-current={selected?.questionId === q.questionId ? 'true' : undefined}
                >
                  <span className="ans-item-text">{q.text}</span>
                  <span className="ans-item-meta">
                    <span className="ans-dots">
                      {engines.map((e) => {
                        const r = q.responses.find((x) => x.engine === e)
                        return <OutcomeDot key={e} engine={e} response={r} />
                      })}
                    </span>
                    {q.topic && <span className="dash-sub">{q.topic}</span>}
                    {q.divergence && <span className="chip warn">엔진마다 다름</span>}
                  </span>
                </button>
              ))}
            </nav>

            {selected ? (
              <QuestionDetail key={`${weekOf}|${selected.questionId}`} q={selected} brandName={brandName} tenantId={tenant.tenantId} weekOf={weekOf} />
            ) : (
              <p className="dash-caption">왼쪽에서 질문을 고르세요.</p>
            )}
          </div>
        </>
      )}
    </>
  )
}

/** 엔진 칸에 보이는 출처 도메인 수 — 자사·뒷받침이 앞에 오도록 정렬돼 있다(citationChips). */
const CITES_SHOWN = 6

const OUTCOME_WORD: Record<AnswerOutcome, string> = { hit: '불림', miss: '안 불림', ask: '되물음' }

function OutcomeDot({ engine, response }: { engine: string; response: AnswerResponse | undefined }) {
  const label = ENGINE_LABEL[engine] ?? engine
  if (!response) {
    return <span className="adot none" title={`${label} 응답 없음`} aria-label={`${label} 응답 없음`} />
  }
  const word = response.outcome === 'hit' && response.rank ? `${response.rank}순위` : OUTCOME_WORD[response.outcome]
  return (
    <span className={`adot ${response.outcome}`} title={`${label} ${word}`} aria-label={`${label} ${word}`}>
      {response.outcome === 'hit' && response.rank ? response.rank : ''}
    </span>
  )
}

function QuestionDetail({ q, brandName, tenantId, weekOf }: { q: AnswerQuestion; brandName: string; tenantId: string; weekOf: string }) {
  return (
    <section className="ans-detail" aria-label="엔진별 답변">
      <div className="ans-detail-head">
        <h2>“{q.text}”</h2>
        <p className="ans-tags">
          <span className="chip">{q.named ? '이름 넣은 질문' : '이름 없는 질문 · 점수 기준'}</span>
          {q.topic && <span className="chip">{q.topic}</span>}
          <span className="dash-sub mono">{q.questionId}</span>
          <span className="dash-sub">
            응답 {q.answered}건 중 {q.hit}건 불림
          </span>
        </p>
        {q.divergence && <p className="ans-divergence">{q.divergence}</p>}
      </div>

      <div className="ans-engines">
        {q.responses.map((r) => (
          <EngineAnswer key={`${r.engine}-${r.callIndex}`} r={r} brandName={brandName} repeated={q.responses.filter((x) => x.engine === r.engine).length > 1} />
        ))}
      </div>

      <RawAnswers q={q} tenantId={tenantId} weekOf={weekOf} />
    </section>
  )
}

function EngineAnswer({ r, brandName, repeated }: { r: AnswerResponse; brandName: string; repeated: boolean }) {
  const chip = outcomeChip(r)
  return (
    <article className="ans-engine">
      <div className="answer-tags">
        <span className="engine-chip">
          <span className="engine-dot" data-engine={r.engine} aria-hidden="true" />
          {r.engineLabel}
          {repeated && ` ${r.callIndex}회차`}
        </span>
        <span className={`chip ${chip.cls}`}>{chip.text}</span>
      </div>
      {r.topOther && <p className="ans-line">1순위로 꼽은 곳 · <b>{r.topOther}</b></p>}
      {r.outcome === 'ask' ? (
        <p className="dash-caption">답 대신 사용자에게 되물었습니다 — 언급률 분모에서 빠집니다.</p>
      ) : r.sentences.length > 0 ? (
        <blockquote className="answer-quote">
          {r.sentences.slice(0, 4).map((s, i) => (
            <span key={i}>
              {i > 0 && ' … '}
              <BrandText text={s} brandName={brandName} />
            </span>
          ))}
        </blockquote>
      ) : (
        <p className="dash-caption">{r.outcome === 'miss' ? `이 답변에는 ${brandName} 언급이 없습니다.` : '판정 기록에 언급 문장이 없습니다.'}</p>
      )}
      {r.competitors.length > 0 && <p className="ans-line">함께 불린 경쟁사 · {r.competitors.join(' · ')}</p>}
      {r.citationCount > 0 ? (
        <ul className="ans-cites" aria-label={`출처 ${r.citationCount}건`}>
          {r.citations.slice(0, CITES_SHOWN).map((c) => (
            <li key={c.domain}>
              <span className="ans-cite-domain">{c.domain}</span>
              <span className={`cite-chip ${OWNER_TONE[c.ownerType]}`}>{OWNER_LABEL[c.ownerType]}</span>
              {c.supports && <span className="cite-chip good">뒷받침</span>}
              {c.count > 1 && <span className="dash-sub">×{c.count}</span>}
            </li>
          ))}
          {r.citations.length > CITES_SHOWN && (
            <li className="dash-sub">외 {r.citations.length - CITES_SHOWN}곳 · 전체는 CSV·원문에서</li>
          )}
        </ul>
      ) : (
        <p className="dash-caption">붙인 출처 없음</p>
      )}
    </article>
  )
}

/**
 * 원문 — 펼칠 때만 그 질문의 원문을 읽는다. 칠하는 구간은 판정 기록의 문장뿐이다(lib/answerHighlight.ts:
 * 원문에서 못 찾은 문장은 칠하지 않고 개수를 밝힌다). 웹 배포에는 원문 API가 없어 null이 온다.
 */
function RawAnswers({ q, tenantId, weekOf }: { q: AnswerQuestion; tenantId: string; weekOf: string }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState<RawAnswer[] | null | undefined>(undefined)
  const [tab, setTab] = useState('')
  useEffect(() => {
    if (!open || raw !== undefined) return
    let alive = true
    loadRawAnswers(tenantId, weekOf, q.questionId).then(
      (v) => alive && setRaw(v),
      (err: unknown) => {
        console.error('[Answers] 원문을 읽지 못했습니다', err)
        if (alive) setRaw(null)
      },
    )
    return () => {
      alive = false
    }
  }, [open, raw, tenantId, weekOf, q.questionId])

  const list = useMemo(() => (raw ?? []).slice().sort((a, b) => engineOrder(a.engine, b.engine) || a.callIndex - b.callIndex), [raw])
  const keyOf = (a: RawAnswer) => `${a.engine}-${a.callIndex}`
  const shown = list.find((a) => keyOf(a) === tab) ?? list[0] ?? null
  const marked = useMemo(() => {
    if (!shown) return null
    const judged = q.responses.find((r) => r.engine === shown.engine && r.callIndex === shown.callIndex)?.judged
    const needles: { text: string; kind: MarkKind }[] = []
    if (judged) {
      for (const m of judged.mentionSentences) needles.push({ text: m.sentence, kind: 'mention' })
      for (const c of judged.competitorMentions) for (const m of c.sentences) needles.push({ text: m.sentence, kind: 'competitor' })
    }
    return highlightAnswer(shown.rawText, needles)
  }, [shown, q.responses])

  return (
    <details className="ans-raw" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>답변 원문 보기</summary>
      {raw === undefined && <p className="dash-caption">원문을 불러오는 중…</p>}
      {raw !== undefined && list.length === 0 && (
        <p className="dash-caption">저장된 원문이 없습니다 — 원문은 데스크톱 앱에서만 읽습니다(웹에서는 판정 문장만 보입니다).</p>
      )}
      {list.length > 0 && shown && (
        <>
          <div className="axis-tabs" role="tablist" aria-label="엔진">
            {list.map((a) => (
              <button
                type="button"
                key={keyOf(a)}
                role="tab"
                aria-selected={shown === a}
                className={`axis-tab${shown === a ? ' is-on' : ''}`}
                onClick={() => setTab(keyOf(a))}
              >
                {ENGINE_LABEL[a.engine] ?? a.engine}
                {list.filter((x) => x.engine === a.engine).length > 1 && ` ${a.callIndex}회차`}
              </button>
            ))}
          </div>
          <p className="legend">
            <span className="hl hl-mention">브랜드 언급</span>
            <span className="hl hl-competitor">경쟁사 언급</span>
            {marked && marked.missed > 0 && <span className="muted">· 판정 문장 {marked.missed}건은 원문에서 찾지 못해 칠하지 않았습니다</span>}
          </p>
          <pre className="raw-answer">
            {marked?.segments.map((seg, i) =>
              seg.kind ? (
                <mark key={i} className={`hl hl-${seg.kind}`}>
                  {seg.text}
                </mark>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </pre>
        </>
      )}
    </details>
  )
}
