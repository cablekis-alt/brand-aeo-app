import { useTenant } from '../context/useTenant'
import { ENGINE_LABEL, formatDelta, formatPct, formatRank, weekLabel } from '../lib/format'
import { useScorecards } from '../lib/useScorecards'

export default function Dashboard() {
  const { tenant } = useTenant()
  const { history, loading, error } = useScorecards(tenant?.tenantId ?? '')
  const card = history.at(-1) ?? null
  const delta = card ? formatDelta(card.aeoScore.current, card.aeoScore.previousWeek) : null

  return (
    <>
      <p className="brand">Brand AEO</p>
      <h1>답변 엔진에서 이 브랜드는 얼마나 보이는가</h1>
      <p className="lead">
        ChatGPT, Gemini, Claude, Perplexity에 같은 질문을 반복 호출해 주간 가시성을 측정합니다. 점수는 인용·노출을
        예측하지 않고, 그 주에 실제로 관측된 값입니다.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading && !card && <p className="muted">불러오는 중…</p>}

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
              <span>경쟁 브랜드 대비 언급 점유</span>
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
                {tenant.engines.map((engine) => (
                  <span key={engine}>{ENGINE_LABEL[engine] ?? engine}</span>
                ))}
              </p>
              <span>질문 {tenant.questionBankSize}개 · 엔진당 3회 반복</span>
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
        현재 점수는 ChatGPT(gpt-4o, 웹 검색 사용)로 {card ? weekLabel(card.weekOf) : '해당 주'}에 측정한 값입니다.
        질문 12개 × 3회 반복이며, Gemini·Claude·Perplexity는 포함하지 않았습니다. 실제 인용·노출을 보장하지 않습니다.
      </p>
    </>
  )
}
