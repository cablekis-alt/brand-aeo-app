import { useEffect, useState } from 'react'

// 데스크톱 앱의 측정 엔진 설정 패널.
//
//  - API 키: 상태 표시(읽기 전용). 키는 .env(실행파일 옆 또는 userData)나 설치본 동봉에서 자동 인식.
//  - 수집 엔진: 여기서 바꾼다(COLLECT_ENGINES 전역 지정). 키가 없는 엔진은 고를 수 없다 —
//    고를 수는 있는데 측정에서 조용히 빠지면 그게 더 혼란스럽다.
//  - 판단 엔진: 표시만 한다. 판단이 바뀌면 같은 원문에서 다른 판정이 나와 주차 간 비교가 깨지고,
//    스코어카드에 판단 엔진이 기록되지 않아 사후에 설명할 수도 없다. 바꾸려면 .env로 명시한다.
const ENGINES = [
  { id: 'gemini', key: 'GEMINI_API_KEY', label: 'Gemini' },
  { id: 'openai', key: 'OPENAI_API_KEY', label: 'ChatGPT' },
  { id: 'claude', key: 'ANTHROPIC_API_KEY', label: 'Claude' },
  { id: 'perplexity', key: 'PERPLEXITY_API_KEY', label: 'Perplexity' },
] as const

const KEY_LABEL: Record<string, string> = {
  GEMINI_API_KEY: 'GEMINI',
  OPENAI_API_KEY: 'OPENAI (ChatGPT)',
  ANTHROPIC_API_KEY: 'ANTHROPIC (Claude)',
  PERPLEXITY_API_KEY: 'PERPLEXITY',
}
const JUDGE_LABEL: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT' }
const ENGINE_LABEL: Record<string, string> = Object.fromEntries(ENGINES.map((e) => [e.id, e.label]))

type Mode = 'per-tenant' | 'global'

export default function ApiKeySettings() {
  const bridge = typeof window !== 'undefined' ? window.electron : undefined
  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [judge, setJudge] = useState<string | null>(null)
  // 서버에 저장된 값(null = 브랜드별 설정). 초안(draft)과 분리해 "적용" 전에는 건드리지 않는다.
  const [saved, setSaved] = useState<string[] | null>(null)
  const [mode, setMode] = useState<Mode>('per-tenant')
  const [draft, setDraft] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void bridge?.apiKeyStatus().then((r) => {
      setStatus(r.status)
      setJudge(r.judgeEngine ?? null)
      const engines = r.collectEngines ?? null
      setSaved(engines)
      setMode(engines ? 'global' : 'per-tenant')
      setDraft(engines ?? [])
    })
  }, [bridge])

  if (!bridge?.isElectron) return null // 데스크톱 앱에서만

  const isSet = (name: string) => Boolean(status?.[name])
  const availableIds = ENGINES.filter((e) => isSet(e.key)).map((e) => e.id as string)
  const setKeys = ENGINES.filter((e) => isSet(e.key))
  const geminiSet = isSet('GEMINI_API_KEY')

  const toggle = (id: string) => {
    setMessage(null)
    setDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // 전역 지정인데 하나도 안 고르면 저장할 수 없다(수집할 엔진이 없다).
  const invalid = mode === 'global' && draft.length === 0
  const dirty =
    mode === 'per-tenant'
      ? saved !== null
      : saved === null || saved.join(',') !== ENGINES.filter((e) => draft.includes(e.id)).map((e) => e.id).join(',')

  async function apply() {
    setBusy(true)
    setMessage(null)
    try {
      const next = mode === 'per-tenant' ? null : draft
      const r = await bridge!.setCollectEngines(next)
      if (!r.ok) {
        setMessage(`✗ ${r.error ?? '저장 실패'}`)
        return
      }
      setSaved(r.engines ?? null)
      setDraft(r.engines ?? [])
      setMessage(
        r.needsRestart
          ? '✓ 저장했습니다. 앱을 재시작하면 적용됩니다.'
          : '✓ 저장했습니다. 다음 측정부터 적용됩니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  // 수집 엔진 수만큼 수집 호출이 늘고, 판정 호출은 수집 호출당 3~4건이라 전체가 거의 비례해 늘어난다.
  const effective = mode === 'global' ? draft.length : availableIds.length
  const multiplier = effective > 0 ? effective : 1

  return (
    <section className="panel apikey-panel">
      <h3>
        API 키{' '}
        {setKeys.length > 0 ? (
          setKeys.map((e) => (
            <span key={e.key} className="status-pill st-good" style={{ marginLeft: 6 }}>
              {KEY_LABEL[e.key]} 설정됨
            </span>
          ))
        ) : (
          <span className="status-pill st-bad" style={{ marginLeft: 6 }}>
            설정된 키 없음
          </span>
        )}
      </h3>

      <p className="muted" style={{ marginBottom: 6 }}>
        키는 <code>.env</code>(실행파일 옆 또는 사용자 폴더)나 설치본에서 <b>자동 인식</b>됩니다. 위 배지가 이 PC에 현재 설정된
        키이며, 추가·변경은 <code>.env</code>에서 합니다.
        {!geminiSet && <> · <b style={{ color: 'var(--bad)' }}>측정에는 최소 GEMINI 키가 필요합니다.</b></>}
      </p>

      <h4 style={{ margin: '18px 0 6px' }}>수집 엔진</h4>
      <p className="hint" style={{ marginTop: 0 }}>
        질문을 실제로 물어볼 엔진입니다. 여기서 바꾸면 <b>모든 브랜드</b>에 적용됩니다(
        <code>COLLECT_ENGINES</code> 전역 지정).
      </p>

      <div className="engine-pick" role="radiogroup" aria-label="수집 엔진 지정 방식">
        <label>
          <input
            type="radio"
            name="collect-mode"
            checked={mode === 'per-tenant'}
            onChange={() => {
              setMode('per-tenant')
              setMessage(null)
            }}
          />{' '}
          브랜드별 설정 사용 <span className="muted">— 브랜드 추가 시 고른 엔진을 그대로 씁니다</span>
        </label>
        <label>
          <input
            type="radio"
            name="collect-mode"
            checked={mode === 'global'}
            onChange={() => {
              setMode('global')
              setMessage(null)
            }}
          />{' '}
          전역 지정 <span className="muted">— 아래에서 고른 엔진만 씁니다</span>
        </label>
      </div>

      <div className="engine-pick engine-pick-boxes">
        {ENGINES.map((e) => {
          const keyMissing = !isSet(e.key)
          return (
            <label key={e.id} className={keyMissing ? 'disabled' : undefined}>
              <input
                type="checkbox"
                checked={mode === 'global' && draft.includes(e.id)}
                disabled={mode !== 'global' || keyMissing}
                onChange={() => toggle(e.id)}
              />{' '}
              {e.label}
              {keyMissing && <span className="muted"> — 키 없음</span>}
            </label>
          )
        })}
      </div>

      <p className="hint" style={{ marginTop: 8 }}>
        {mode === 'per-tenant' ? (
          <>
            현재 키가 있는 엔진은 <b>{availableIds.map((id) => ENGINE_LABEL[id]).join(' · ') || '없음'}</b>입니다. 브랜드에
            등록된 엔진 중 키가 있는 것만 실제로 수집합니다.
          </>
        ) : draft.length === 0 ? (
          <>수집할 엔진을 하나 이상 고르세요. 엔진이 없으면 측정이 실패합니다.</>
        ) : (
          <>
            선택 <b>{draft.length}개</b> — 엔진 1개 기준 대비 수집·판정 호출이 약 <b>{multiplier}배</b>가 되고, 브랜드당
            측정 시간도 그만큼 늘어납니다.
          </>
        )}
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button type="button" className="primary" onClick={() => void apply()} disabled={busy || invalid || !dirty}>
          {busy ? '저장 중…' : '적용'}
        </button>
        {invalid && <span className="muted">엔진을 하나 이상 고르세요.</span>}
        {!invalid && !dirty && <span className="muted">변경 사항 없음</span>}
        {message && (
          <span className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ margin: 0 }}>
            {message}
          </span>
        )}
      </div>

      {judge && (
        <p className="hint" style={{ marginTop: 16, marginBottom: 0 }}>
          <b>판단 엔진</b>은 현재 <b>{JUDGE_LABEL[judge] ?? judge}</b>입니다. 언급·인용·순위·사실성을 모두 이 엔진이
          판정하므로, 바꾸면 같은 응답에서 다른 결과가 나와 <b>주차 간 비교가 깨집니다</b>. 그래서 앱에서는 바꾸지 않고
          고정합니다(변경이 꼭 필요하면 <code>.env</code>의 <code>JUDGE_ENGINE</code>으로 지정).
        </p>
      )}
    </section>
  )
}
