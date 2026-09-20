import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import { loadQuestionAnalyses, loadQuestionBank } from '../lib/api'
import { computeGapAnalysis, type GapGroup, type GapVerdict } from '../lib/gapAnalysis'
import { ENGINE_LABEL } from '../lib/format'
import type { QuestionRepeatAnalysis, QuestionSpec } from '../lib/types'
import { useWeeklyPage } from '../lib/useWeeklyPage'
import { resolveBankVersion } from '../lib/bankVersion'

const VERDICT: Record<GapVerdict, { label: string; cls: string }> = {
  gap: { label: '격차', cls: 'st-bad' },
  mixed: { label: '혼재', cls: 'st-warn' },
  strength: { label: '강점', cls: 'st-good' },
}
const pct = (n: number) => `${Math.round(n * 100)}%`

/** 묶음 하나를 카드로. 카테고리·엔진이 같은 모양을 쓴다. */
/**
 * 묶음 카드 — 기본은 얇게, 밀린 질문은 눌러야 펼친다.
 *
 * 네 축이 모두 이 카드를 쓰기 때문에 한 장이 두꺼우면 화면 전체가 두꺼워진다(원진 W38 실측:
 * 카드 17장 · 약 5화면). 위 요약 표가 "어느 축의 무엇을 볼지"를 이미 정해 주므로, 아래 카드는
 * 눈으로 훑을 수 있을 만큼 얇아야 하고 자세한 근거는 필요한 카드에서만 열면 된다.
 * 인용 갭 분석의 도메인 펼치기와 같은 방식이다.
 */
function GroupCard({ group, nameOf }: { group: GapGroup; nameOf?: (key: string) => string }) {
  const v = VERDICT[group.verdict]
  const [open, setOpen] = useState(false)
  return (
    <article className="gap-card">
      <div className="gap-card-head">
        <span className="gap-name">{nameOf ? nameOf(group.key) : group.label}</span>
        {/*
          배지는 승패로 판정한다(승이 절반을 넘으면 강점). 언급률 옆에 있어서 "강점인데 43%"가
          모순처럼 읽히므로 근거를 붙인다 — 숫자가 아니라 무엇을 센 것인지가 빠져 있었다.
        */}
        <span
          className={`status-pill ${v.cls}`}
          title={`승 ${group.win} · 패 ${group.loss} 기준 (언급률이 아니라 승패로 판정합니다)`}
        >
          {v.label} {group.win}승 {group.loss}패
        </span>
        <span className="gap-rate">
          언급률 <b>{pct(group.mentionRate)}</b>
        </span>
      </div>
      <div className="gap-bar" aria-hidden="true">
        {group.win > 0 && <i className="w" style={{ flexGrow: group.win }} />}
        {group.even > 0 && <i className="e" style={{ flexGrow: group.even }} />}
        {group.loss > 0 && <i className="l" style={{ flexGrow: group.loss }} />}
        {group.unanswered > 0 && <i className="u" style={{ flexGrow: group.unanswered }} />}
      </div>
      {group.worst.length > 0 ? (
        <button
          type="button"
          className="gap-more-toggle"
          onClick={() => setOpen((v2) => !v2)}
          aria-expanded={open}
          title="이 묶음에서 밀린 질문과 누구에게 밀렸는지"
        >
          {open ? '▾' : '▸'} 질문 {group.questions}개 · 승 {group.win} 무 {group.even} 패 {group.loss}
          {group.unanswered > 0 && ` · 무응답 ${group.unanswered}`}
        </button>
      ) : (
        <p className="gap-tally">
          질문 {group.questions}개 · 승 {group.win} · 무 {group.even} · 패 {group.loss}
          {group.unanswered > 0 && ` · 무응답 ${group.unanswered}`}
        </p>
      )}
      {open && group.worst.length > 0 && (
        <ul className="gap-worst">
          {group.worst.map((r) => (
            <li key={r.questionId}>
              <span className="gap-q">{r.text}</span>
              {r.topCompetitor && (
                <span className="gap-who">
                  {r.topCompetitor.name}에 밀림 ({r.topCompetitor.mentions}회)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

export default function GapAnalysis() {
  const { tenant } = useTenant()
  const {
    history,
    weeks,
    weekOf,
    setWeekOf,
    data: analyses,
    loading,
    neverMeasured,
  } = useWeeklyPage<QuestionRepeatAnalysis[]>(loadQuestionAnalyses, tenant?.tenantId ?? '', [])

  // 이 주차를 측정한 은행 버전으로 불러온다 — 현재 버전으로 부르면 옛 주차의 질문 id가
  // 맞지 않아 텍스트·카테고리가 빈 값이 된다(화면에 v1-001 같은 id가 뜬다).
  const bankVersion = resolveBankVersion(history, weekOf, analyses)
  const [questions, setQuestions] = useState<QuestionSpec[]>([])
  useEffect(() => {
    if (!tenant?.tenantId) return
    let alive = true
    void loadQuestionBank(tenant.tenantId, bankVersion).then((bank) => {
      if (alive) setQuestions(bank?.questions ?? [])
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId, bankVersion])

  const gap = useMemo(() => computeGapAnalysis(analyses, questions), [analyses, questions])
  const worstCategory = gap.byCategory.find((g) => g.verdict === 'gap') ?? null
  // 엔진이 하나뿐이면 엔진 격차를 말할 수 없다 — "엔진마다 다르다"는 비교 대상이 있을 때만 참이다.
  const worstEngine = gap.byEngine.length > 1 ? (gap.byEngine.find((g) => g.verdict === 'gap') ?? null) : null
  const topCompetitor = gap.competitors[0] ?? null

  /*
   * 축별로 "가장 많이 밀리는 것" 한 줄씩 — 언급률이 낮고 패 판정이 많은 묶음이다.
   *
   * 아래 본문은 네 축이 전부 같은 모양의 카드 그리드다(원진 W38 실측: 카드 17장·3.9화면).
   * 그러면 어느 줄이 중요한지 화면이 말해 주지 않아, 사람이 17장을 읽어 스스로 찾아야 한다.
   * 여기서 축마다 하나씩만 뽑아 같은 형식으로 세워 둔다 — 아래 카드는 근거를 보러 가는 곳이 된다.
   *
   * 고르는 기준은 아래 정렬과 같다: 카테고리·엔진은 '격차'로 판정된 첫 묶음, 여정·주제는
   * 이미 밀리는 순(byPain)으로 정렬돼 있으므로 맨 앞. 여정은 순서가 여정 순(탐색→비교→결정)이라
   * 따로 언급률 최저를 고른다 — 그 배열의 맨 앞은 '가장 많이 밀리는 것'이 아니다.
   */
  const worstStage = gap.byStage.length > 0
    ? [...gap.byStage].sort((a, b) => a.mentionRate - b.mentionRate)[0]
    : null
  const worstTopic = gap.byTopic.find((g) => g.verdict === 'gap') ?? gap.byTopic[0] ?? null
  const painRows: { axis: string; group: GapGroup; nameOf?: (k: string) => string }[] = [
    worstCategory ? { axis: '질문 유형', group: worstCategory } : null,
    worstStage ? { axis: '구매 여정', group: worstStage } : null,
    worstTopic ? { axis: '주제', group: worstTopic } : null,
    worstEngine ? { axis: '엔진', group: worstEngine, nameOf: (k: string) => ENGINE_LABEL[k] ?? k } : null,
  ].filter((r): r is { axis: string; group: GapGroup; nameOf?: (k: string) => string } => r !== null)
  // 표가 비는 이유는 둘이고 뜻이 정반대다. 밀린 질문이 아예 없으면 좋은 소식이고,
  // 밀렸는데 경쟁사가 안 잡혔다면 그 자리를 아무도 못 가져간 것이다(= 선점 여지).
  const lossQuestions = gap.byCategory.reduce((sum, g) => sum + g.loss, 0)
  const ready = !loading && gap.totalQuestions > 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">어디가 비어 있나</p>
      <h1>가시성 격차 분석</h1>
      <p className="lead">
        어떤 <b>유형의 질문</b>에서, 어떤 <b>엔진</b>에서, <b>누구에게</b> 밀리는지를 봅니다.
        질문 하나하나의 승패는 <Link to="/question-winloss">질문별 승패</Link>에서 보세요 — 여기는 그 위층입니다.
        어떤 <b>출처</b>가 우리를 인용하지 않는지는 <Link to="/citation-gap">인용 갭 분석</Link>이 따로 다룹니다.
        여기서 나온 격차를 할 일로 바꾼 것이 <Link to="/gap-actions">실행 항목</Link>입니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && gap.totalQuestions === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 격차가 채워집니다.
        </p>
      )}

      {ready && (
        <>
          <section className="hero-card">
            <p className="eyebrow">가장 많이 밀리는 곳</p>
            {painRows.length > 0 ? (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>축</th>
                        <th>가장 많이 밀리는 묶음</th>
                        <th>언급률</th>
                        <th>승·패</th>
                      </tr>
                    </thead>
                    <tbody>
                      {painRows.map(({ axis, group, nameOf }) => (
                        <tr key={axis}>
                          <td className="muted">{axis}</td>
                          <td>
                            <b>{nameOf ? nameOf(group.key) : group.label}</b>
                            <span className="muted"> · 질문 {group.questions}개</span>
                          </td>
                          <td>{pct(group.mentionRate)}</td>
                          <td>
                            <span className={`status-pill ${VERDICT[group.verdict].cls}`}>
                              {group.win}승 {group.loss}패
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {topCompetitor && (
                  <p className="muted">
                    <b>{topCompetitor.name}</b>이(가) 질문 {topCompetitor.questionsLost}개에서 우리 자리를 가져갔습니다.
                  </p>
                )}
                <p className="hint">
                  네 축은 서로 다른 질문을 봅니다 — 유형은 질문의 <b>형태</b>, 여정은 고객의 <b>위치</b>, 주제는{' '}
                  <b>내용</b>, 엔진은 <b>어디서</b>입니다. 아래에 축별 전체 묶음과 밀린 질문이 있습니다.
                </p>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                격차로 판정된 묶음이 없습니다 — 이번 주차는 모든 유형·엔진에서 밀리지 않았습니다.
              </p>
            )}
          </section>

          <section>
            <h3>질문 유형별</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              언급률·Share of Mention은 <b>카테고리 무관</b> 질문에서 나옵니다. 브랜드명을 넣은 질문은
              거의 항상 언급되므로 그 줄이 높은 것은 성과가 아닙니다.
            </p>
            <div className="gap-grid">
              {gap.byCategory.map((g) => (
                <GroupCard key={g.key} group={g} />
              ))}
            </div>
          </section>

          {gap.byStage.length > 0 && (
            <section>
              <h3>구매 여정별</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                탐색 → 비교 → 결정 순서입니다. <b>결정</b> 단계에서 밀리면 전환 직전 고객을 놓치는 것이라, 같은
                패라도 먼저 봐야 합니다.
                {gap.stageInferredCount > 0 &&
                  ` 질문 ${gap.stageInferredCount}개는 은행에 단계 기록이 없어 문장으로 추정했습니다 — 질문 프롬프트 빌더에서 "단계 매기기"를 실행하면 판정값으로 바뀝니다.`}
              </p>
              <div className="gap-grid">
                {gap.byStage.map((g) => (
                  <GroupCard key={g.key} group={g} />
                ))}
              </div>
            </section>
          )}

          {(gap.byTopic.length > 0 || gap.topicMissingCount > 0) && (
            <section>
              <h3>주제별</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                카테고리가 질문의 <b>형태</b>, 여정이 고객의 <b>위치</b>라면 주제는 <b>내용</b>입니다. 보강할
                콘텐츠를 정하는 축이라 많이 밀리는 순으로 놓았습니다.
                {gap.topicMissingCount > 0 &&
                  ` 질문 ${gap.topicMissingCount}개는 은행에 주제가 없어 어느 묶음에도 들어가지 않았습니다 — 질문 프롬프트 빌더에서 "주제 매기기"를 실행하세요.`}
              </p>
              {gap.byTopic.length > 0 ? (
                <div className="gap-grid">
                  {gap.byTopic.map((g) => (
                    <GroupCard key={g.key} group={g} />
                  ))}
                </div>
              ) : (
                <p className="muted">아직 주제가 매겨진 질문이 없습니다.</p>
              )}
            </section>
          )}

          {gap.byEngine.length > 1 ? (
            <section>
              <h3>엔진별</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                같은 질문이라도 엔진마다 답이 다릅니다. 한 엔진에서만 빠져 있다면 그 엔진이 참고하는
                출처를 보강하는 것이 빠릅니다.
              </p>
              <div className="gap-grid">
                {gap.byEngine.map((g) => (
                  <GroupCard key={g.key} group={g} nameOf={(k) => ENGINE_LABEL[k] ?? k} />
                ))}
              </div>
            </section>
          ) : (
            <section>
              <h3>엔진별</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                이 주차는 <b>{ENGINE_LABEL[gap.byEngine[0]?.key] ?? gap.byEngine[0]?.key ?? '엔진 1개'}</b>
                로만 측정해 엔진 간 비교가 없습니다. 설정에서 수집 엔진을 늘리면 이 자리가 채워집니다.
              </p>
            </section>
          )}

          <section>
            <h3>우리 자리를 가져간 경쟁사</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              전체 언급량이 아니라 <b>우리가 밀린 질문에서 앞선 횟수</b>입니다. 그 질문들이 곧 보강할
              주제입니다.
            </p>
            {gap.competitors.length === 0 ? (
              <p className="muted">
                {lossQuestions === 0
                  ? '밀린 질문이 없습니다 — 이번 주차는 어떤 질문에서도 경쟁사에 뒤지지 않았습니다.'
                  : `밀린 질문 ${lossQuestions}개에서 추적 중인 경쟁사가 한 곳도 언급되지 않았습니다 — 우리가 진 게 아니라 그 자리를 아직 아무도 가져가지 않았습니다. 먼저 등재되면 선점할 수 있는 질문들입니다.`}
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>경쟁사</th>
                      <th style={{ textAlign: 'right' }}>가져간 질문</th>
                      <th style={{ textAlign: 'right' }}>언급 문장</th>
                      <th>예시 질문</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gap.competitors.map((c) => (
                      <tr key={c.name}>
                        <td>{c.name}</td>
                        <td style={{ textAlign: 'right' }}>{c.questionsLost}</td>
                        <td style={{ textAlign: 'right' }}>{c.mentions}</td>
                        <td className="muted">{c.examples.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}
