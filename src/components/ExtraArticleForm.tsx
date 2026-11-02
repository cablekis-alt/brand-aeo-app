import { useId, useState } from 'react'
import type { NewExtraArticleInput } from '../lib/api'
import { EXTRA_LIMITS, NAME_AND_ANGLE_LIMIT, questionTextKey } from '../lib/extraArticles'
import { probeQuestionList, type GapAction } from '../lib/gapActions'
import { roleChip, roleOf, topicGuard, type PlannedArticle, type ProbePlan } from '../lib/probePlan'
import { todayKst } from '../lib/publishedUrl'
import { VERDICT_WORD, type WinLossRow } from '../lib/questionWinLoss'
import { probeRoleTone } from '../lib/useProbePlan'

/**
 * 「글 더 만들기」 — 본 글의 이번 주 질문 몇 개를 골라 추가 글 한 편을 만든다(src/lib/extraArticles.ts).
 *
 * 고른 질문은 다음 계산부터 추가 글이 맡고 본 글의 이번 주 질문에서 빠진다. 이미 만든 본 글은 다시 만들지 않는다 — 고친 글 · 빈칸
 * 기록 · 고른 사진이 사라진다. 본 글에는 질문이 하나는 남아야 한다(다 빼면 본 글이 목록에서 사라져 올린 기록이 갈 곳을 잃는다).
 *
 * 실증 질문(src/lib/questionScope.ts)은 본 글에 들지 않아 따로 목록을 둔다(plan.probes에 추가 글이 맡은 응답 없는 실증을 더한
 * probeQuestionList) — 고르면 그 글이 처치군이 되고, 고르지 않은
 * 실증은 대조군으로 남는다. 본 글에서 빼는 질문이 아니라 「본 글에 하나는 남기기」 검사에 세지 않는다. 본 글이 없는 주(일반 질문을 모두
 * 이긴 주)에도 실증만으로 만들 수 있다(main null). 실증과 일반 질문을 한 글에 섞으면 막지 않고 알린다 — 실험 효과를 따로 읽기 어렵다.
 *
 * 질문 은행 판을 모르는 주(예시 은행 포함)에는 만들 수 없다 — 질문 id의 뜻이 판마다 달라, 판 없이 저장하면 다음 주에 엉뚱한 질문을
 * 가리킨다. 이 환경에 기능이 없으면(웹) 부모가 이 칸을 그리지 않는다.
 *
 * 실증 기간(probePlan — src/lib/probePlan.ts)에는 질문을 고르지 않는다 — 「배정표 글」 가운데 하나를 골라 그 정의(이름 · 질문 · 문장)를
 * 그대로 보낸다. 질문 목록에는 역할 칩만 보인다. 배정표 밖 글은 서버도 막는다(server/extraArticles.ts). probePlan이 없으면 지금과 같다.
 */

/** 서버와 같은 정리 — 공백을 하나로 줄이고 앞뒤를 뗀다(src/lib/extraArticles.ts). 글자 수도 이 값으로 센다. */
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()

interface QuestionItem {
  key: string
  /** 본 글의 질문이면 그 id. 다른 추가 글이 맡아 본 글에 없는 질문은 null(고를 수 없다). */
  id: string | null
  text: string
  /** 이 질문을 맡은 추가 글의 이름. */
  takenBy: string | null
}

export default function ExtraArticleForm({
  main,
  probes = [],
  extraActions,
  bankVersion,
  corrupt,
  loadError,
  onCreate,
  probePlan = null,
  locked = false,
}: {
  /** 본 글 항목 — questionIds와 questionTexts가 짝이다. 본 글이 없는 주(실증만 고를 수 있다)는 null. */
  main: GapAction | null
  /** 이번 주 응답이 있는 실증 질문과 판정(plan.probes). 본 글과 따로 고른다. */
  probes?: WinLossRow[]
  /** 이번 주 계산한 추가 글 항목. questionIds(이번 주 id)와 questionTexts(만들 때 고정한 문장)는 짝이 아니다. */
  extraActions: GapAction[]
  /** 이 주를 잰 질문 은행 판. null이면(모름 · 예시 은행) 만들 수 없다. */
  bankVersion: string | null
  /** 저장된 목록이 깨져 서버가 쓰기를 거절한다. */
  corrupt: boolean
  /** 목록을 읽지 못한 이유. */
  loadError: string | null
  /** 성공하면 null, 실패하면 서버가 준 이유. */
  onCreate: (input: Omit<NewExtraArticleInput, 'bankVersion' | 'createdWeek'>) => Promise<string | null>
  /** 잠금 기간 안의 실증 배정(useProbePlan active) — 있으면 「배정표 글」에서만 고른다. null이면 지금과 같다. */
  probePlan?: ProbePlan | null
  /** 실증 일괄 실행 중 — 만들기를 막는다(그 실행이 추가 글 · 브리프 · 초안을 차례로 쓰고 있다). */
  locked?: boolean
}) {
  const radioName = useId()
  const [planPick, setPlanPick] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [angle, setAngle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // 이번 주 id로 맡은 글 — 본 글이 비지 않게 막은 주에는 본 글에도 같은 질문이 남아 있다(gapActions contentActions).
  const takenById = new Map<string, string>()
  for (const x of extraActions) for (const id of x.questionIds) takenById.set(id, x.extra?.name ?? x.title)
  const mainItems: QuestionItem[] = (main?.questionIds ?? []).map((id, i) => ({
    key: id,
    id,
    text: main?.questionTexts[i] ?? id,
    takenBy: takenById.get(id) ?? null,
  }))
  // 추가 글이 맡았는데 이번 주 응답이 없는 실증도 싣는다(plan.probes에 없다) — 판정은 확인 불가로 둔다.
  const probeList = probeQuestionList(probes, extraActions)
  const probeItems: QuestionItem[] = probeList.map((p) => ({ key: p.questionId, id: p.questionId, text: p.text, takenBy: p.takenBy }))
  const verdictById = new Map(probeList.map((p) => [p.questionId, p.verdict]))
  // 본 글에서 빠진 질문 — 다른 글이 맡았다고 흐리게 보인다. 문장은 그 글이 만들 때 고정한 것이고, 이번 주 찾지 못한 질문은 뺀다.
  // 실증은 본 글에서 빠진 질문이 아니라 실증 목록에 「맡음」으로 보인다(응답이 없는 실증까지 — 고정 문장으로 가린다). 본 글이 없는
  // 주에는 본 글 목록째 그리지 않는다.
  const mainKeys = new Set((main?.questionTexts ?? []).map(questionTextKey))
  const probeKeys = new Set([
    ...probes.map((p) => questionTextKey(p.text)),
    ...extraActions.flatMap((x) => (x.extra?.probes ?? []).map((p) => questionTextKey(p.text))),
  ])
  const takenItems: QuestionItem[] = main
    ? extraActions.flatMap((x) => {
        const missing = new Set((x.extra?.missingTexts ?? []).map(questionTextKey))
        return x.questionTexts
          .filter((t) => !missing.has(questionTextKey(t)) && !mainKeys.has(questionTextKey(t)) && !probeKeys.has(questionTextKey(t)))
          .map((t) => ({ key: `${x.id}|${t}`, id: null, text: t, takenBy: x.extra?.name ?? x.title }))
      })
    : []
  const items = [...mainItems, ...takenItems]
  const selectable = mainItems.filter((q) => !q.takenBy)
  // 실증 기간에는 질문을 고르지 않는다 — 배정이 늦게 와 그 전에 고른 체크가 남아도 세지 않는다(경고 · 단추 글자가 고를 수 없는 체크를 말하지 않게).
  const chosenMain = probePlan ? [] : selectable.filter((q) => q.id !== null && selected.has(q.id))
  const chosenProbes = probePlan ? [] : probeItems.filter((q) => !q.takenBy && q.id !== null && selected.has(q.id))
  const chosen = [...chosenMain, ...chosenProbes]
  // 실증과 일반 질문을 한 글에 섞었다 — 막지 않고 알린다.
  const mixed = chosenMain.length > 0 && chosenProbes.length > 0

  const nameText = tidy(name)
  const angleText = tidy(angle)
  const used = nameText.length + angleText.length
  const tooLong = used > NAME_AND_ANGLE_LIMIT
  const nameTooLong = nameText.length > EXTRA_LIMITS.name
  const tooMany = chosen.length > EXTRA_LIMITS.questions
  // 본 글에 하나는 남기기 — 실증은 본 글의 질문이 아니라 세지 않는다.
  const leavesNone = chosenMain.length > 0 && chosenMain.length >= selectable.length

  const blocked = loadError
    ? `추가 글 목록을 읽지 못해 만들 수 없어요: ${loadError}`
    : corrupt
      ? '저장된 추가 글 목록이 깨져 있어 새로 만들 수 없어요(목록을 덮어쓰지 않으려고 막았습니다).'
      : !bankVersion
        ? '이 주를 잰 질문 은행 판을 알 수 없어(예시 질문 은행이거나 옛 측정) 만들 수 없어요. 측정한 주를 골라 주세요.'
        : probePlan
          ? // 판이 배정 판과 다르면 서버와 같은 말로 막는다 — 같은 id라도 다른 질문이다.
            topicGuard(probePlan, false, bankVersion, probePlan.rounds[0].articles[0].id, todayKst())
          : null
  // 실증 기간의 「배정표 글」 — 이미 살아 있는 글은 「만듦」(이번 주 추가 글 항목은 살아 있는 정의마다 하나다).
  const planned: PlannedArticle[] = probePlan
    ? probePlan.rounds.flatMap((r) => r.articles.map((a) => ({ ...a, round: r.round, postDate: r.postDate })))
    : []
  const madeIds = new Set(extraActions.map((x) => x.id))
  const chosenPlan = planned.find((a) => a.id === planPick && !madeIds.has(a.id)) ?? null
  const canSubmit = probePlan
    ? !blocked && !busy && !locked && chosenPlan !== null
    : !blocked && !busy && !locked && chosen.length > 0 && nameText.length > 0 && !nameTooLong && !tooLong && !tooMany && !leavesNone

  const toggle = (id: string) => {
    setMessage(null)
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setMessage(null)
    // 실증 기간에는 배정 글의 정의를 그대로 보낸다 — 이름 · 질문 · 문장을 고치지 않는다(서버가 배정표와 맞춰 본다).
    const input = chosenPlan
      ? { name: chosenPlan.name, questionIds: [...chosenPlan.questionIds], questionTexts: [...chosenPlan.questionTexts] }
      : {
          name: nameText,
          ...(angleText ? { angle: angleText } : {}),
          questionIds: chosen.map((q) => q.id!),
          questionTexts: chosen.map((q) => q.text),
        }
    try {
      const error = await onCreate(input)
      if (error) {
        setMessage({ ok: false, text: error })
        return
      }
      // 본 글이 없는 주에는 이 칸이 실증 칸 안(글 카드 아래쪽)에 있다 — 새 글 카드는 위 「① 글 확인」에 생긴다.
      setMessage({ ok: true, text: `「${input.name}」 글을 만들었어요. ${main ? '아래 카드' : '위 「① 글 확인」'}에서 초안을 만드세요.` })
      setPlanPick(null)
      setSelected(new Set())
      setName('')
      setAngle('')
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  /** 실증 기간에 질문 옆에 붙는 역할 칩 — 이 주의 판이 배정 판일 때만(roleOf). */
  const roleBadge = (id: string | null) => {
    const role = probePlan && id !== null ? roleOf(probePlan, bankVersion, id) : null
    return role ? (
      <>
        {' '}
        <span className={`status-pill ${probeRoleTone(role)}`}>{roleChip(role)}</span>
      </>
    ) : null
  }

  const itemText = (q: QuestionItem, probe: boolean) => (
    <span>
      {q.text}
      {/* 이번 주 판정은 처치 · 대조를 고를 때 참고로만 보인다. */}
      {probe && q.id !== null && verdictById.has(q.id) && (
        <span className="muted"> · 이번 주 {verdictById.get(q.id) ? VERDICT_WORD[verdictById.get(q.id)!] : '응답 없음(확인 불가)'}</span>
      )}
      {q.takenBy && <span className="muted"> · 「{q.takenBy}」 글이 맡음</span>}
      {roleBadge(q.id)}
    </span>
  )

  const itemRow = (q: QuestionItem, probe = false) => (
    <li key={q.key} className={q.takenBy ? 'muted' : undefined}>
      {probePlan ? (
        // 실증 기간에는 질문을 고르지 않는다 — 역할만 보인다.
        itemText(q, probe)
      ) : (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <input
            type="checkbox"
            style={{ width: 'auto', marginTop: 3 }}
            disabled={q.takenBy !== null || q.id === null}
            checked={q.id !== null && !q.takenBy && selected.has(q.id)}
            onChange={() => q.id !== null && toggle(q.id)}
          />
          {itemText(q, probe)}
        </label>
      )}
    </li>
  )

  return (
    <details className="publish-settings" style={{ gridColumn: '1 / -1', margin: 0 }}>
      <summary>
        글 더 만들기{' '}
        <span className="muted">
          {probePlan
            ? `실증 기간(~${probePlan.activeUntil.slice(5)})에는 배정표 글만 만듭니다`
            : !main
              ? '실증 질문을 골라 한 편 더 씁니다'
              : probeItems.length > 0
                ? '본 글의 질문이나 실증 질문 몇 개를 골라 한 편 더 씁니다'
                : '본 글의 질문 몇 개를 떼어 한 편 더 씁니다'}
        </span>
      </summary>
      <div className="publish-settings-body">
        {main && (
          <p className="hint" style={{ margin: 0 }}>
            고른 질문은 새 글이 맡고, 본 글의 이번 주 질문에서 빠집니다. 이미 만든 본 글은 그대로 둡니다(다시 만들 필요 없음).
          </p>
        )}
        {blocked && <p className="hint warn">{blocked}</p>}
        <fieldset disabled={Boolean(blocked) || busy} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 10, minWidth: 0 }}>
          {probePlan && (
            <div style={{ display: 'grid', gap: 4 }}>
              <p className="hint" style={{ margin: 0 }}>
                <b>배정표 글</b> — 실증 기간(~{probePlan.activeUntil.slice(5)})에는 이 글만 만들 수 있어요. 이름과 질문은 배정표 그대로
                씁니다. 이미 만든 글은 「만듦」입니다.
              </p>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }} aria-label="배정표 글">
                {planned.map((a) => {
                  const made = madeIds.has(a.id)
                  return (
                    <li key={a.id} className={made ? 'muted' : undefined}>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <input
                          type="radio"
                          name={radioName}
                          style={{ width: 'auto', marginTop: 3 }}
                          disabled={made}
                          checked={!made && planPick === a.id}
                          onChange={() => {
                            setPlanPick(a.id)
                            setMessage(null)
                          }}
                        />
                        <span>
                          <b>{a.round}차</b> · {a.name}{' '}
                          <span className="muted">
                            · {a.channel} · {a.postDate.slice(5)} 게시{made && ' · 만듦'}
                          </span>
                          <ul className="muted" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                            {a.questionTexts.map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {main && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }} aria-label="본 글의 이번 주 질문">
              {items.map((q) => itemRow(q))}
            </ul>
          )}
          {probeItems.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              {probePlan ? (
                <p className="hint" style={{ margin: 0 }}>
                  <b>실증 질문</b> <span className="status-pill st-info">실증 · 점수 제외</span> — 실증 기간에는 질문을 고르지 않아요. 처치 ·
                  대조 · 홀드아웃은 배정표가 정했습니다.
                </p>
              ) : (
                <p className="hint" style={{ margin: 0 }}>
                  <b>실증 질문</b> <span className="status-pill st-info">실증 · 점수 제외</span> — 점수에 들지 않고 본 글에도 넣지 않는 질문입니다.
                  고른 실증 질문은 이 글이 맡아(처치) 우리 글이 그 답에 인용되는지 보고, 고르지 않은 실증 질문은 견줄 대상(대조)으로 남습니다.
                  효과는 한 번의 측정으로 판단하지 말고 두 번 이상 같은 방향일 때만 읽으세요.
                </p>
              )}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }} aria-label="실증 질문">
                {probeItems.map((q) => itemRow(q, true))}
              </ul>
            </div>
          )}
          {leavesNone && <p className="hint warn">본 글에 질문을 하나 이상 남겨 두세요.</p>}
          {mixed && <p className="hint warn">실증과 일반 질문을 섞으면 실험 효과를 따로 읽기 어려워요. 실증 질문만 고른 글을 따로 만드는 편이 좋아요.</p>}
          {tooMany && <p className="hint warn">한 글에는 질문을 {EXTRA_LIMITS.questions}개까지 고를 수 있어요(지금 {chosen.length}개).</p>}
          {!probePlan && (
            <>
              <label>
                주제 이름 <span className="muted">(꼭 적기 · 카드 제목이 됩니다)</span>
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    setMessage(null)
                  }}
                  placeholder="예: 아이 · 부모님과 함께하는 코스"
                />
              </label>
              <label>
                다룰 각도 <span className="muted">(선택 · 이 글만의 관점)</span>
                <textarea
                  rows={2}
                  value={angle}
                  onChange={(e) => {
                    setAngle(e.target.value)
                    setMessage(null)
                  }}
                  placeholder="예: 걷는 거리가 짧고 쉬어 갈 곳이 많은 순서로"
                />
              </label>
              <p className={tooLong || nameTooLong ? 'hint warn' : 'hint'} style={{ margin: 0 }}>
                주제 이름 + 다룰 각도 {used}/{NAME_AND_ANGLE_LIMIT}자
                {nameTooLong && ` — 주제 이름은 ${EXTRA_LIMITS.name}자까지예요.`}
                {tooLong && ' — 각도를 줄여 주세요.'}
              </p>
            </>
          )}
        </fieldset>
        <div className="brief-bar">
          <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy
              ? '만드는 중…'
              : probePlan
                ? `배정표 글 만들기${chosenPlan ? ` · 「${chosenPlan.name}」` : ''}`
                : `이 질문으로 글 한 편 더 만들기${chosen.length > 0 ? ` · 질문 ${chosen.length}개` : ''}`}
          </button>
          {locked && <span className="doc-meta">일괄 실행이 끝난 뒤에 만들 수 있어요.</span>}
          {message && (
            <span className={message.ok ? 'hint' : 'error'} role={message.ok ? 'status' : 'alert'}>
              {message.text}
            </span>
          )}
        </div>
      </div>
    </details>
  )
}
