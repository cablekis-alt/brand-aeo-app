import { useEffect, useState } from 'react'

// 라이트/다크/시스템 3-상태 테마 토글. 'system'이면 data-theme를 지워 OS(prefers-color-scheme)를 따른다.
type Theme = 'light' | 'dark' | 'system'
const KEY = 'brand-aeo-theme'

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: '라이트' },
  { value: 'dark', label: '다크' },
  { value: 'system', label: '시스템' },
]

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

  return (
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
  )
}
