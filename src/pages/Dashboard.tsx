import { Link } from 'react-router-dom'
import ChangeAlerts from '../components/ChangeAlerts'
import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, judgeLabel, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'
import { isOpenAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

export default function Dashboard() {
  const { tenant } = useTenant()
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const card = history.at(-1) ?? null
  const delta = card ? formatDelta(card.aeoScore.current, card.aeoScore.previousWeek) : null

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
            <Link to="/gap-actions">실행 항목 →</Link>
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
            <p className="total">
              AEO Score <strong>{card.aeoScore.current}</strong>
              <span className={`delta ${delta?.tone}`}>{delta?.text}</span>
            </p>
            <dl className="meta">
              <div>
                <dt>전주</dt>
                <dd>{card.aeoScore.previousWeek}</dd>
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
