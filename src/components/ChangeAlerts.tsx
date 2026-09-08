import { useMemo } from 'react'
import { computeAlerts, type AlertLevel } from '../lib/alerts'
import type { WeeklyScorecard } from '../prompts/b8-report'

const LEVEL: Record<AlertLevel, { label: string; cls: string }> = {
  critical: { label: '경고', cls: 'st-bad' },
  warn: { label: '주의', cls: 'st-warn' },
  good: { label: '개선', cls: 'st-good' },
  info: { label: '안내', cls: 'st-info' },
}

// 주간 변화 알림 — 새 수집 없이 스코어카드 히스토리(전주 vs 이번 주)만으로
// "무엇이 나빠졌는지"를 대시보드 상단에 요약한다.
export default function ChangeAlerts({ history }: { history: WeeklyScorecard[] }) {
  const alerts = useMemo(() => computeAlerts(history), [history])
  if (alerts.length === 0) return null

  return (
    <section className="alerts" aria-label="주간 변화 알림">
      <p className="alerts-title">변화 알림 · 전주 대비</p>
      <ul>
        {alerts.map((a, i) => (
          <li key={i} className={`alert-row ${LEVEL[a.level].cls}`}>
            <span className={`status-pill ${LEVEL[a.level].cls}`}>{LEVEL[a.level].label}</span>
            <span className="alert-body">
              <b>{a.title}</b>
              <span className="alert-detail">{a.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
