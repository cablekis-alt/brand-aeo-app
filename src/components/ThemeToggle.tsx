import { useEffect, useState } from 'react'
import { directionParticle } from '../lib/korean'

// 라이트/다크/시스템 3-상태 테마 토글. 'system'이면 data-theme를 지워 OS(prefers-color-scheme)를 따른다.
type Theme = 'light' | 'dark' | 'system'
const KEY = 'brand-aeo-theme'

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
  { value: 'system', label: '시스템' },
]
const CYCLE: Theme[] = ['system', 'light', 'dark']

function readStored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* 접근 불가(프라이빗 창 등) — 기본값 */
  }
  return 'system'
}

function apply(theme: Theme): void {
  const el = document.documentElement
  if (theme === 'system') delete el.dataset.theme
  else el.dataset.theme = theme
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => readStored())

  useEffect(() => {
    apply(theme)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* 저장 실패는 무시 — 이번 세션에만 적용 */
    }
  }, [theme])

  // 낮은 창(높이 800px 이하)에서는 세 칸 대신 단추 하나로 돌린다 — 시스템 → 라이트 → 다크(App.css 조밀 모드가 둘 중 하나만 보인다).
  const labelOf = (t: Theme) => OPTIONS.find((o) => o.value === t)!.label
  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length]!
  const cycleLabel = `테마: ${labelOf(theme)} — 눌러서 ${directionParticle(labelOf(next))}`

  return (
    <>
      <div className="theme-toggle" role="group" aria-label="테마 선택">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={theme === o.value ? 'on' : undefined}
            aria-pressed={theme === o.value}
            onClick={() => setTheme(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <button type="button" className="theme-cycle" aria-label={cycleLabel} title={cycleLabel} onClick={() => setTheme(next)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      </button>
    </>
  )
}
