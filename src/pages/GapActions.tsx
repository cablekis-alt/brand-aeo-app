import { Link } from 'react-router-dom'
import WeekPicker from '../components/WeekPicker'
import { useTenant } from '../context/useTenant'
import type { ActionStatus } from '../lib/api'
import { isOpenAction, type GapAction } from '../lib/gapActions'
import { useGapActionPlan } from '../lib/useGapActionPlan'

// 배지 문구는 항목이 정한다(출처마다 하는 일이 다르다). 화면은 색만 정한다.
const KIND_CLASS: Record<GapAction['kind'], string> = { listing: 'st-warn', content: 'st-info' }

/**
 * 집행 상태 버튼 — '완료'가 아니라 '집행함'이다.
 *
 * 사람이 충족(satisfied)을 직접 켤 수는 없다. 그건 데이터가 정한다. 여기서 고르는 건
 * "내가 그 일을 했는가"뿐이고, 그래서 집행했는데 아직 인용이 안 잡힌 항목이 드러난다.
 */
const STATUS_CHOICES: { value: ActionStatus; label: string; title: string }[] = [
  { value: 'todo', label: '안 함', title: '아직 손대지 않음' },
  { value: 'doing', label: '진행 중', title: '작업하고 있음' },
  { value: 'done', label: '집행함', title: '올렸음 — 인용이 잡히면 자동으로 충족이 된다' },
  { value: 'skip', label: '보류', title: '하지 않기로 함 — 목록 아래로 내린다' },
]

/** 항목 하나. 근거와 완료 조건을 항상 함께 보여준다 — 지시만 있고 근거가 없으면 안 하게 된다. */
function ActionCard({
  action,
  canSaveStatus,
  onStatus,
}: {
  action: GapAction
  canSaveStatus: boolean
  onStatus: (id: string, status: ActionStatus) => void
}) {
  // 집행했다고 적었는데 데이터가 아직 확인하지 못한 상태 — 가장 먼저 봐야 할 줄이다.
  const awaiting = action.status === 'done' && !action.satisfied
  return (
    <article className="gap-card">
      <div className="gap-card-head">
        <span className="gap-name">{action.title}</span>
        <span className={`status-pill ${action.satisfied ? 'st-good' : KIND_CLASS[action.kind]}`}>
          {action.satisfied ? '충족' : action.badge}
        </span>
        <span className="gap-rate">
          영향 <b>{action.reach}</b>
        </span>
      </div>
      <p className="gap-tally" style={{ color: 'var(--ink)' }}>
        {action.evidence}
      </p>
      {action.questionTexts.length > 0 && (
        <ul className="gap-worst">
          {action.questionTexts.map((q) => (
            <li key={q}>
              <span className="gap-q">{q}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="gap-tally">완료 조건 · {action.doneSignal}</p>
      {awaiting && (
        // 종류마다 확인 방법이 다르다. 등재형은 인용 데이터가 자동으로 충족을 켜지만,
        // 콘텐츠형은 자동 충족이 없다 — 우리 사이트 글은 인용 갭이 아니라 '패가 줄어드는 것'으로
        // 나타난다. 같은 문구를 쓰면 콘텐츠 카드가 "인용에서 못 찾았다·등재 방식을 보라"는
        // 해당 없는 말을 하게 된다(실제로 그렇게 떴다).
        <p className="gap-tally" style={{ color: 'var(--accent)' }}>
          {action.kind === 'listing' ? (
            <>
              집행했다고 표시했지만 아직 인용에서 우리를 못 찾았습니다
              {action.markedWeek && ` (${action.markedWeek}에 표시)`}. AI가 새 페이지를 읽어 들이는 데
              보통 몇 주가 걸립니다. 다음 측정에서도 그대로면 등재된 페이지에 브랜드명이 실제로 있는지,
              크롤러가 읽을 수 있는 정적 페이지인지 확인하세요.
            </>
          ) : (
            <>
              집행했다고 표시했습니다{action.markedWeek && ` (${action.markedWeek})`}. 콘텐츠는 인용이
              아니라 <b>이 질문들의 패 판정이 줄어드는 것</b>으로 확인됩니다 — 다음 측정을 보세요.
              자동으로 충족되지 않으므로, 효과가 보이면 직접 판단해 상태를 정리하세요.
            </>
          )}
        </p>
      )}
      {canSaveStatus && (
        <div className="action-status" role="group" aria-label={`${action.title} 집행 상태`}>
          {STATUS_CHOICES.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.title}
              className={action.status === c.value ? 'on' : undefined}
              aria-pressed={action.status === c.value}
              onClick={() => onStatus(action.id, c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}

export default function GapActions() {
  const { tenant } = useTenant()
  const { plan, weeks, weekOf, setWeekOf, loading, neverMeasured, canSaveStatus, setStatus, saveError } =
    useGapActionPlan(tenant?.tenantId ?? '')

  const open = plan.actions.filter(isOpenAction)
  const satisfied = plan.actions.filter((a) => a.satisfied && a.status !== 'skip')
  const skipped = plan.actions.filter((a) => a.status === 'skip')
  const ready = !loading && plan.actions.length > 0

  if (!tenant) return null

  return (
    <>
      <p className="brand">그래서 뭘 하나</p>
      <h1>실행 항목</h1>
      <p className="lead">
        <Link to="/gap-analysis">가시성 격차 분석</Link>이 "어디가 비어 있나"를 말한다면, 여기는{' '}
        <b>그래서 뭘 하나</b>입니다. 저장된 측정만으로 계산하며 새 API 호출은 없습니다.
      </p>

      <div className="filters">
        <WeekPicker weeks={weeks} value={weekOf} onChange={setWeekOf} />
      </div>

      {saveError && (
        <p className="error" role="alert">
          {saveError}
        </p>
      )}

      {loading && <p className="muted">불러오는 중…</p>}

      {!loading && plan.actions.length === 0 && (
        <p className="muted">
          {neverMeasured
            ? '이 브랜드는 아직 측정된 적이 없습니다. '
            : '이 주차에 분석 데이터가 없습니다. '}
          <Link to="/measure-tenant">브랜드·경쟁사 측정</Link>에서 측정하면 항목이 채워집니다.
        </p>
      )}

      {ready && (
        <>
          <section className="hero-card">
            <p className="eyebrow">이번 주차</p>
            <ul className="gap-summary">
              <li>
                남은 항목 <b>{open.length}건</b>
                {satisfied.length > 0 && <> · 데이터가 충족을 확인한 항목 {satisfied.length}건</>}
                {plan.skippedCount > 0 && <> · 보류 {plan.skippedCount}건</>}
              </li>
              {plan.awaitingCount > 0 && (
                <li>
                  <b>집행 확인 대기 {plan.awaitingCount}건</b> — 했다고 표시했지만 데이터가 아직 확인하지
                  못한 항목입니다(등재형은 인용, 콘텐츠형은 패 판정으로 확인). 맨 위에 모아 뒀습니다.
                </li>
              )}
              <li className="muted">
                완료는 사람이 체크하지 않고 <b>데이터에서 읽습니다.</b> 등재가 실제로 되면 그 도메인의
                인용이 우리 언급을 뒷받침하기 시작하고, 그때 자동으로 충족으로 넘어갑니다.
              </li>
            </ul>
          </section>

          <section>
            <h3>할 일</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              영향 숫자는 등재형이면 그 도메인의 인용 수, 콘텐츠형이면 밀린 질문 수입니다. 큰 것부터
              하시면 됩니다.
            </p>
            {open.length === 0 ? (
              <p className="muted">남은 항목이 없습니다.</p>
            ) : (
              <div className="gap-grid">
                {open.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} />
                ))}
              </div>
            )}
          </section>

          {satisfied.length > 0 && (
            <section>
              <h3>이미 되어 있는 것</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                이 출처들은 이미 우리 언급을 뒷받침합니다. 새로 할 일은 없지만, 다음 주차에 사라지면
                여기서 먼저 보입니다.
              </p>
              <div className="gap-grid">
                {satisfied.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} />
                ))}
              </div>
            </section>
          )}

          {skipped.length > 0 && (
            <section>
              <h3>보류</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                하지 않기로 한 항목입니다. 지운 게 아니라 내려 둔 것이라, 생각이 바뀌면 여기서 되돌릴
                수 있습니다.
              </p>
              <div className="gap-grid">
                {skipped.map((a) => (
                  <ActionCard key={a.id} action={a} canSaveStatus={canSaveStatus} onStatus={setStatus} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3>목록에서 뺀 것</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              인용된 도메인이라고 다 등재 대상은 아닙니다. 왜 빠졌는지 밝혀 둡니다 — 목록이 짧은 것이
              데이터가 없어서가 아니라는 뜻입니다.
            </p>
            <ul className="gap-summary">
              <li>
                경쟁사 소유 <b>{plan.competitorDomainCount}개</b> — 경쟁사 사이트에는 우리가 실릴 수
                없습니다.
              </li>
              <li>
                분류가 <code>other</code>라 보류 <b>{plan.excludedLowConfidence}개</b> — 알려진 호스트
                목록에 없는 도메인입니다. 대부분 같은 업종의 다른 업체 홈페이지라 등재할 수 없습니다.
                업체 자체 블로그 서브도메인이 섞이는 <code>blog</code>도 함께 뺐습니다.
              </li>
              <li className="muted">
                공공기관(<code>.go.kr</code>) 출처도 뺐습니다. 분류는 정확하지만 보건복지부나 PubMed에
                병원이 등재할 방법은 없습니다 — AI가 공공 지침을 참고한다는 사실은{' '}
                <Link to="/citation-gap">인용 갭 분석</Link>에서 보세요.
              </li>
            </ul>
          </section>
        </>
      )}
    </>
  )
}
