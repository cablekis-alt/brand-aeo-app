import { useEffect, useState } from 'react'

// 데스크톱 앱의 API 키 "상태 표시(읽기 전용)" 패널.
// 키는 .env(실행파일 옆 또는 userData) 또는 설치본 동봉에서 자동 인식된다 — 앱에서 입력하지 않는다.
// 이 패널은 현재 설정된 키를 보여주기만 한다(추가·변경은 .env에서).
// 수집(collection)은 키가 있는 엔진 전부(크레딧이 살아 있는 것만 실제 사용).
// 판단(judge)은 키 조합·JUDGE_ENGINE에 따라 달라지므로 고정 문구가 아니라 실제 해석값을 표시한다.
const KEYS = [
  { name: 'GEMINI_API_KEY', label: 'GEMINI', role: '수집' },
  { name: 'OPENAI_API_KEY', label: 'OPENAI (ChatGPT)', role: '수집' },
  { name: 'ANTHROPIC_API_KEY', label: 'ANTHROPIC (Claude)', role: '수집' },
  { name: 'PERPLEXITY_API_KEY', label: 'PERPLEXITY', role: '수집' },
] as const

const JUDGE_LABEL: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', openai: 'ChatGPT' }
const ENGINE_LABEL: Record<string, string> = {
  openai: 'ChatGPT',
  gemini: 'Gemini',
  claude: 'Claude',
  perplexity: 'Perplexity',
}

export default function ApiKeySettings() {
  const bridge = typeof window !== 'undefined' ? window.electron : undefined
  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [judge, setJudge] = useState<string | null>(null)
  const [collect, setCollect] = useState<string[] | null>(null)

  useEffect(() => {
    void bridge?.apiKeyStatus().then((r) => {
      setStatus(r.status)
      setJudge(r.judgeEngine ?? null)
      setCollect(r.collectEngines ?? null)
    })
  }, [bridge])

  if (!bridge?.isElectron) return null // 데스크톱 앱에서만

  const isSet = (n: string) => Boolean(status?.[n])
  const geminiSet = isSet('GEMINI_API_KEY')
  const setKeys = KEYS.filter((k) => isSet(k.name))

  return (
    <section className="panel apikey-panel">
      <h3>
        API 키{' '}
        {setKeys.length > 0 ? (
          setKeys.map((k) => (
            <span key={k.name} className="status-pill st-good" style={{ marginLeft: 6 }}>
              {k.label} 설정됨
            </span>
          ))
        ) : (
          <span className="status-pill st-bad" style={{ marginLeft: 6 }}>
            설정된 키 없음
          </span>
        )}
      </h3>

      <p className="muted" style={{ marginBottom: 6 }}>
        키는 <code>.env</code>(실행파일 옆 또는 사용자 폴더)나 설치본에서 <b>자동 인식</b>됩니다. 위 배지가 이 PC에 현재 설정된 키이며,
        추가·변경은 <code>.env</code>에서 합니다.
      </p>
      <p className="hint" style={{ marginBottom: 0 }}>
        <b>수집</b>은{' '}
        {collect
          ? `${collect.map((e) => ENGINE_LABEL[e] ?? e).join(' · ')} (COLLECT_ENGINES 전역 지정)`
          : '브랜드별로 등록된 엔진'}
        에서 하며, 키가 없거나 크레딧이 소진된 엔진은 자동으로 제외됩니다.
        {judge && (
          <>
            {' '}· <b>판단</b>은 현재 <b>{JUDGE_LABEL[judge] ?? judge}</b>입니다
            {judge !== 'gemini' && <> (고정하려면 <code>JUDGE_ENGINE</code>를 설정하세요)</>}.
          </>
        )}
        {!geminiSet && <> · <b style={{ color: 'var(--bad)' }}>측정에는 최소 GEMINI 키가 필요합니다.</b></>}
      </p>
    </section>
  )
}
