import { useEffect, useState } from 'react'

// 데스크톱 앱에서 API 키를 직접 입력·저장한다(userData/.env에 저장, 즉시 적용).
// 측정에는 GEMINI_API_KEY만 있어도 되므로 그것을 중심으로 안내한다.
export default function ApiKeySettings() {
  const bridge = typeof window !== 'undefined' ? window.electron : undefined
  const [status, setStatus] = useState<Record<string, boolean> | null>(null)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const refresh = () => {
    void bridge?.apiKeyStatus().then((r) => setStatus(r.status))
  }
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!bridge?.isElectron) return null // 데스크톱 앱에서만

  // 키가 설정돼 있으면 상태만 보이고, "키 변경"을 눌렀을 때만 입력창을 펼친다. 미설정이면 바로 입력창.
  const geminiSet = Boolean(status?.GEMINI_API_KEY)

  async function save() {
    const v = value.trim()
    if (!v) return
    setSaving(true)
    setMsg(null)
    try {
      const r = await bridge!.setApiKey('GEMINI_API_KEY', v)
      if (r.ok) {
        setValue('')
        setEditing(false)
        setMsg('✓ 저장됐습니다. 이제 측정할 수 있습니다.')
        refresh()
      } else {
        setMsg(`✗ ${r.error ?? '저장 실패'}`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="panel apikey-panel">
      <h3>
        API 키{' '}
        {geminiSet ? (
          <span className="status-pill st-good">GEMINI 설정됨</span>
        ) : (
          <span className="status-pill st-bad">GEMINI 미설정</span>
        )}
      </h3>

      {geminiSet && !editing ? (
        <p className="muted" style={{ marginBottom: 0 }}>
          측정에 사용할 <b>Gemini API 키</b>가 이 PC에 설정돼 있습니다.{' '}
          <button type="button" className="linklike" onClick={() => { setMsg(null); setEditing(true) }}>
            키 변경
          </button>
        </p>
      ) : (
        <>
          <p className="muted">
            측정하려면 <b>Gemini API 키</b>가 필요합니다({' '}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="rec-link">
              발급받기 →
            </a>
            ). 입력하면 이 PC에 안전하게 저장되고 바로 적용됩니다.
          </p>
          <div className="measure-pick">
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={geminiSet ? '새 키로 변경하려면 입력…' : 'GEMINI_API_KEY 붙여넣기 (AIza…)'}
              aria-label="Gemini API 키"
              autoComplete="off"
            />
            <button type="button" className="primary" onClick={() => void save()} disabled={saving || !value.trim()}>
              {saving ? '저장 중…' : '저장'}
            </button>
            {geminiSet && (
              <button type="button" className="ghost" onClick={() => { setValue(''); setEditing(false); setMsg(null) }} disabled={saving}>
                취소
              </button>
            )}
          </div>
        </>
      )}

      {msg && (
        <p className={msg.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ marginTop: '8px', fontWeight: 500 }}>
          {msg}
        </p>
      )}
    </section>
  )
}
