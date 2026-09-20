import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import ChangeAlerts from '../components/ChangeAlerts'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, judgeLabel, weekLabel } from '../lib/format'
import { loadRanking, loadSiteScores, type SiteScoreRecord } from '../lib/api'
import type { PromptedSplit } from '../lib/types'
import { useScorecards } from '../lib/useScorecards'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

export default function Dashboard() {
  const { tenant } = useTenant()
  // Site AEO Score의 주차 기록은 로컬 서버에만 있다(Vercel에는 이 라우트가 없다).
  // 웹에서 "진단하면 쌓입니다"라고 안내하면 지키지 못할 약속이 된다.
  const isElectron = typeof window !== 'undefined' && Boolean(window.electron?.isElectron)
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const card = history.at(-1) ?? null

  /*
   * 「이름을 대면 / 안 대면」 대비 — 스코어카드에 없는 값이라 랭킹 API를 한 번 더 부른다.
   *
   * 스코어카드에 넣어 저장할 수도 있지만 그러면 **다시 측정해야** 값이 생긴다. 이 계산은 이미
   * 저장된 판정 레코드와 질문 은행만 쓰므로 지난 주차도 바로 채워진다.
   * 실패하면 조용히 감춘다 — 대시보드 본문(AEO Score)을 막을 이유가 없다.
   */
  const [split, setSplit] = useState<{ key: string; value: PromptedSplit | null }>({ key: '', value: null })
  const splitKey = card ? `${card.tenantId}|${card.weekOf}` : ''
  useEffect(() => {
    if (!card) return
    let alive = true
    void loadRanking(card.tenantId, card.weekOf)
      .then((view) => {
        if (alive) setSplit({ key: `${card.tenantId}|${card.weekOf}`, value: view?.promptedSplit ?? null })
      })
      .catch(() => {
        if (alive) setSplit({ key: `${card.tenantId}|${card.weekOf}`, value: null })
      })
    return () => {
      alive = false
    }
  }, [card])
  /*
   * Site AEO Score — 페이지 자체의 준비도. Brand AEO Score와 **다른 것을 잰다**.
   *
   * Brand 쪽은 "엔진이 우리를 말하는가", Site 쪽은 "그 페이지가 인용될 만한가"다. 둘을 나란히
   * 두는 이유는 차이 자체가 진단이기 때문이다 — Site가 높은데 Brand가 낮으면 페이지는 됐고
   * 권위·인용이 부족한 것이고, 반대면 페이지부터 고쳐야 한다.
   *
   * 주차가 스코어카드와 어긋날 수 있다(사이트 진단은 아무 때나 돌린다). 맞추려고 값을
   * 끌어다 쓰지 않고, 가장 최근 기록을 그 주차와 함께 보여 준다.
   */
  const [siteScores, setSiteScores] = useState<{ key: string; value: Record<string, SiteScoreRecord> }>({
    key: '',
    value: {},
  })
  useEffect(() => {
    const id = tenant?.tenantId
    if (!id) return
    let alive = true
    void loadSiteScores(id).then((v) => {
      if (alive) setSiteScores({ key: id, value: v ?? {} })
    })
    return () => {
      alive = false
    }
  }, [tenant?.tenantId])
  const siteWeeks = siteScores.key === (tenant?.tenantId ?? '') ? Object.keys(siteScores.value).sort() : []
  const siteNow = siteWeeks.length > 0 ? (siteScores.value[siteWeeks[siteWeeks.length - 1]!] ?? null) : null
  const sitePrev = siteWeeks.length > 1 ? (siteScores.value[siteWeeks[siteWeeks.length - 2]!] ?? null) : null
  const siteDelta = siteNow && sitePrev ? siteNow.score - sitePrev.score : null

  /*
   * 두 점수의 관계를 한 줄로 — 숫자만 주고 해석을 사람에게 맡기지 않는다.
   *
   * 다만 둘은 서로 다른 것을 재므로 "78-38=40점 차"처럼 뺄셈을 결론으로 내세우지 않는다.
   * 둘 다 0~100으로 정규화돼 있어 **어느 쪽이 발목을 잡는지**를 읽는 데만 쓴다.
   * 경계를 20점으로 크게 잡은 것도 같은 이유다 — 근소한 차는 방향을 말해 주지 않는다.
   */
  const scoreReading = (() => {
    if (!card || !siteNow) return null
    const gap = siteNow.score - card.aeoScore.current
    if (gap >= 20) {
      return '페이지는 인용될 준비가 됐는데 답변에는 그만큼 나오지 않습니다 — 지금 막는 것은 페이지가 아니라 권위·인용일 가능성이 큽니다.'
    }
    if (gap <= -20) {
      return '답변 노출에 비해 페이지 준비가 뒤처집니다 — 페이지를 먼저 고치면 지금의 노출이 더 단단해집니다.'
    }
    return '두 축이 비슷한 수준입니다 — 한쪽만 손봐서는 크게 달라지지 않습니다.'
  })()

  // 브랜드·주차가 바뀌는 순간 옛 값이 새 카드에 붙지 않게 키를 맞춘다.
  const promptedSplit = split.key === splitKey ? split.value : null
  // 전주는 저장된 previousWeek가 아니라 히스토리에서 읽는다. 저장값은 측정 시점에 박제되어,
  // 지난 주를 다시 재면 어긋난다(실측: W37 카드 33 vs 알림 42 — 같은 화면이 +2와 -7을 동시에
  // 말했다). 알림도 히스토리를 쓰므로 이제 두 자리가 같은 값을 본다.
  const prevCard = history.length > 1 ? history[history.length - 2]! : null
  const prevScore = prevCard?.aeoScore.current ?? null
  // 엔진 구성이 다르면 증감을 숫자로 내세우지 않는다. 헤드라인이 빨간 -7인데 바로 아래 알림이
  // "그렇게 읽지 말라"고 하면 화면이 자기모순이다. 판단 규칙은 alerts.ts의 sameEngines와 같다.
  const engineSets = [prevCard, card].map((c) => [...(c?.enginesUsed ?? [])].sort().join(','))
  // 판정 엔진도 본다 — 같은 원문이라도 판정이 바뀌면 언급·순위·사실성이 달라진다.
  // 판단 규칙은 alerts.ts의 sameEngines·sameJudge와 같다.
  const judges = [prevCard?.judgeEngine, card?.judgeEngine]
  const sameJudge = !judges[0] || !judges[1] || judges[0] === judges[1]
  const comparable =
    !prevCard || !card || ((!engineSets[0] || !engineSets[1] || engineSets[0] === engineSets[1]) && sameJudge)
  const delta = card && prevScore !== null && comparable ? formatDelta(card.aeoScore.current, prevScore) : null

  // 안내문·카드는 실제로 수집에 성공한 엔진에서 파생한다. 스코어카드에 기록된 enginesUsed가 진실이며
  // (키가 설정돼도 크레딧 소진 등으로 실패하면 빠진다), 구버전 스코어카드는 tenant.engines로 폴백한다.
  const ALL_ENGINES = ['openai', 'gemini', 'claude', 'perplexity'] as const
  const usedEngines: string[] = card?.enginesUsed?.length ? card.enginesUsed : (tenant?.engines ?? [])
  const usedLabels = usedEngines.map((e) => ENGINE_LABEL[e] ?? e)
  const excludedLabels = ALL_ENGINES.filter((e) => !usedEngines.includes(e)).map((e) => ENGINE_LABEL[e] ?? e)
  // 실행 항목 남은 건수 — 사이드바 배지·실행 항목 화면과 같은 훅, 같은 정의(isOpenAction).
  const { plan: actionPlan, loading: actionsLoading } = useGapActionPlan(tenant?.tenantId ?? '')
  const openActions = !actionsLoading && tenant ? actionPlan.actions.filter(isOpenAction).length : null

  return (
    <>
      <p className="brand">개요</p>
      <h1>답변 엔진에서 이 브랜드는 얼마나 보이는가</h1>
      <p className="lead">
        ChatGPT, Gemini, Claude, Perplexity에 같은 질문을 반복 호출해 주간 가시성을 측정합니다. 점수는 인용·노출을
        예측하지 않고, 그 주에 실제로 관측된 값입니다.
      </p>

      <Link to="/brand-onboarding" className="pipeline-add">
        <span className="pipeline-add-mark" aria-hidden="true">＋</span>
        <span>
          <strong>브랜드 추가</strong>
          <em>새 테넌트를 등록하고 측정 파이프라인에 넣습니다</em>
        </span>
      </Link>

      {/*
        사이드바와 같은 순서·같은 말로 묶는다 — 측정 → 어디가 비어 있나 → 그래서 뭘 하나 → 보고.
        예전에는 여기 "Visibility 측정 파이프라인 B1–B9 / STAGE 1~4" 카드가 있었다. 사이드바에서
        지운 바로 그 언어가 첫 화면에 남아 있으면 두 곳이 다른 지도를 보여 주는 셈이다.
        카드마다 그 단계의 현재 값을 하나씩 얹어, 읽는 게 아니라 훑어서 상태를 알게 한다.
      */}
      <section className="pipeline" aria-label="이 브랜드를 보는 순서">
        <p className="pipeline-kicker">이 브랜드를 보는 순서</p>
        <p className="pipeline-flow">측정 → 어디가 비어 있나 → 그래서 뭘 하나 → 보고</p>
        <div className="pipeline-grid">
          <article>
            <p className="pipeline-stage">측정</p>
            <h2>같은 질문을 엔진마다 묻는다</h2>
            <p>
              {card
                ? `${weekLabel(card.weekOf)} · ${usedLabels.join(' · ') || '엔진 기록 없음'}`
                : '아직 측정한 주차가 없습니다'}
            </p>
            <Link to="/measure-tenant">브랜드·경쟁사 측정 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">어디가 비어 있나</p>
            <h2>밀리는 질문 유형·엔진·경쟁사</h2>
            <p>{card ? `카테고리 무관 언급률 ${formatPct(card.mentionRate)}` : '측정 후 채워집니다'}</p>
            <Link to="/gap-analysis">가시성 격차 분석 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">그래서 뭘 하나</p>
            <h2>격차를 할 일로</h2>
            <p>
              {openActions === null
                ? '측정 후 채워집니다'
                : openActions === 0
                  ? '남은 실행 항목 없음'
                  : `남은 실행 항목 ${openActions}건`}
            </p>
            <Link to="/gap-actions">콘텐츠 생성 →</Link>
          </article>
          <article>
            <p className="pipeline-stage">보고</p>
            <h2>점수와 코호트 순위</h2>
            <p>
              {card
                ? `AEO Score ${card.aeoScore.current} · 코호트 ${(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}${card.cohortRank.position}/${card.cohortRank.totalTenants}`
                : '측정 후 채워집니다'}
            </p>
            <Link to="/report">정기진단 보고서 →</Link>
          </article>
        </div>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !card && <p className="muted">불러오는 중…</p>}

      {tenant && history.length > 0 && <ChangeAlerts history={history} />}

      {tenant && card && (
        <>
          <section className="hero-card">
            <p className="eyebrow">
              {card.brandName} · {weekLabel(card.weekOf)} · {card.industry} · {card.region}
            </p>
            {/*
              두 스코어는 **다른 것을 잰다**. 그래서 나란히 두되 같은 크기로 둔다.
              앞선 판(한 줄에 꼬리표를 줄줄이 이어 붙인 형태)에서는 78이 38보다 커 보여
              "38 < 78이니 나쁘다"로 읽혔다 — 비교 대상이 아닌 두 축인데도 그랬다.
              칸을 나누고 각 칸에 "무엇을 재는가"를 한 줄씩 붙여 축이 다름을 먼저 보이게 한다.
            */}
            <div className="score-pair">
              <article>
                <p className="score-label">Brand AEO Score</p>
                <p className="score-value">
                  {card.aeoScore.current}
                  {delta && <span className={`delta ${delta.tone}`}>{delta.text}</span>}
                </p>
                <p className="score-caption">답변에 얼마나 나오는가</p>
              </article>
              <article>
                <p className="score-label">Site AEO Score</p>
                {siteNow ? (
                  <>
                    <p className="score-value">
                      {siteNow.score}
                      {siteDelta !== null && (
                        <span className={`delta ${siteDelta > 0 ? 'up' : siteDelta < 0 ? 'down' : 'flat'}`}>
                          {siteDelta > 0 ? '+' : ''}
                          {siteDelta}
                        </span>
                      )}
                    </p>
                    <p className="score-caption">
                      페이지가 인용될 준비가 됐는가
                      {siteNow.weekOf !== card.weekOf && ` · ${weekLabel(siteNow.weekOf)} 진단`}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="score-value none">—</p>
                    <p className="score-caption">
                      {isElectron ? (
                        <>
                          <Link to="/site-diagnosis">Site AEO Checker</Link>에서 진단하면 채워집니다
                        </>
                      ) : (
                        '데스크톱 앱에서 진단·기록합니다'
                      )}
                    </p>
                  </>
                )}
              </article>
            </div>
            {scoreReading && <p className="score-reading">{scoreReading}</p>}
            {/*
              측정 1주차에는 전주·4주 이동평균·신뢰구간을 감춘다.
              셋 다 "아직 비교할 게 없다"는 같은 말을 세 번 하는 자리다 — 전주는 "—",
              이동평균은 이번 주 점수 그 자체, 신뢰구간은 표본이 하나라 넓다. 게다가 위
              변화 알림 배너가 이미 「기준선 형성 중(측정 1주차)」이라고 말하고 있다.
              2주차부터 저절로 다시 나타난다(prevCard가 생긴다).
            */}
            <dl className="meta">
              {prevCard && (
                <>
                  <div>
                    <dt>전주</dt>
                    <dd>
                      {prevScore ?? '—'}
                      {!comparable && (
                        <span className="muted"> · {sameJudge ? '수집' : '판정'} 엔진 달라 비교 불가</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>4주 이동평균</dt>
                    <dd>{card.aeoScore.ma4}</dd>
                  </div>
                  <div>
                    <dt>95% 신뢰구간</dt>
                    <dd>
                      {card.aeoScore.ciLow} – {card.aeoScore.ciHigh}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>업종·지역 코호트</dt>
                <dd>
                  {(card.cohortRank.tiedCount ?? 1) > 1 ? '공동 ' : ''}
                  {card.cohortRank.position} / {card.cohortRank.totalTenants}
                </dd>
              </div>
            </dl>
          </section>

          <section className="metrics">
            <article>
              <h2>카테고리 무관 언급률</h2>
              <p>{formatPct(card.mentionRate)}</p>
              <span>브랜드명을 넣지 않은 질문에서 언급된 비율</span>
            </article>
            <article>
              <h2>Share of Mention</h2>
              <p>{formatPct(card.shareOfMention)}</p>
              <span>
                {card.shareOfMention === null
                  ? '경쟁사 미설정 또는 해당 질문에 언급 없음 — 측정 불가'
                  : '같은 질문(브랜드명 미포함)에서 경쟁 브랜드 대비 언급 점유'}
              </span>
            </article>
            <article>
              <h2>평균 추천 순위</h2>
              <p>{formatRank(card.avgRecommendationRank)}</p>
              <span>1이 최상위. 추천 문맥이 없으면 판정 불가</span>
            </article>
            <article>
              <h2>사실성</h2>
              <p>{formatPct(card.factualityScore)}</p>
              <span>Fact Graph와 모순되지 않은 주장 비율</span>
            </article>
            <article>
              <h2>브랜드 소유 출처</h2>
              <p>{formatPct(card.brandOwnedCitationRate)}</p>
              <span>인용이 자사 도메인으로 연결된 비율</span>
            </article>
            <article>
              <h2>수집 엔진</h2>
              <p className="engines">
                {usedEngines.map((engine) => (
                  <span key={engine}>{ENGINE_LABEL[engine] ?? engine}</span>
                ))}
              </p>
              <span>
                질문 {tenant.questionBankSize}개
                {card.questionBankVersion ? ` · 은행 ${card.questionBankVersion}` : ''} · 판단 {judgeLabel(card.judgeEngine)}
              </span>
            </article>
          </section>

          {promptedSplit && promptedSplit.named.answered > 0 && (
            <section>
              <h3>이름을 대면 / 안 대면</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                브랜드명을 넣은 질문에서 나오는 것은 성과가 아닙니다 — 엔진은 이름을 받으면 거의 항상 답합니다.
                위 점수가 쓰는 값은 <b>이름을 안 댔을 때</b>이고, 두 값의 차이가 곧 <b>아직 우리를 모르는 고객이
                우리를 만나지 못하는 폭</b>입니다. 되물은 응답은 분모에서 빠집니다.
              </p>
              <div className="funnel">
                <div className="funnel-step" title="브랜드명이 들어간 질문(브랜드 직접·비교 등)에서 언급된 비율">
                  <span className="funnel-label">이름을 대고 물으면</span>
                  <span className="funnel-rate">{formatPct(promptedSplit.named.rate)}</span>
                  <span className="funnel-bar">
                    <span style={{ width: `${Math.round(promptedSplit.named.rate * 100)}%` }} />
                  </span>
                  <span className="funnel-meta">응답 {promptedSplit.named.answered}건</span>
                </div>
                <div className="funnel-step is-on" title="브랜드명이 없는 질문(카테고리 무관)에서 언급된 비율 — 점수가 쓰는 값">
                  <span className="funnel-label">이름 없이 물으면 · 점수 기준</span>
                  <span className="funnel-rate">{formatPct(promptedSplit.unnamed.rate)}</span>
                  <span className="funnel-bar">
                    <span style={{ width: `${Math.round(promptedSplit.unnamed.rate * 100)}%` }} />
                  </span>
                  <span className="funnel-meta">응답 {promptedSplit.unnamed.answered}건</span>
                </div>
              </div>
              <p className="muted">
                어느 질문에서 밀리는지는 <Link to="/gap-analysis">가시성 격차 분석</Link>, 어느 여정 단계에서
                안 보이는지는 <Link to="/diagnosis">브랜드 종합 진단</Link>에서 봅니다.
              </p>
            </section>
          )}

          {card.hallucinationFlags.length > 0 && (
            <section className="panel warn">
              <h3>사실성 리스크</h3>
              <ul>
                {card.hallucinationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <p className="disclaimer">
        현재 점수는 {usedLabels.join(' · ') || '설정된 엔진'} 엔진으로 {card ? weekLabel(card.weekOf) : '해당 주'}에 측정한
        값입니다. 질문 {tenant?.questionBankSize ?? '—'}개
        {card?.questionBankVersion ? ` · 질문 은행 ${card.questionBankVersion}` : ''} 기준입니다.
        {excludedLabels.length > 0 && ` ${excludedLabels.join('·')}는 포함하지 않았습니다.`} 실제 인용·노출을 보장하지 않습니다.
      </p>
    </>
  )
}
