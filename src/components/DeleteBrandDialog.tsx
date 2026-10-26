import { useEffect, useState } from 'react'
import { loadDeletePreview, type TenantDeletePreview } from '../lib/api'
import { objectParticle } from '../lib/korean'
import { runName, useMeasureStatus } from '../lib/measureStatus'
import { useTenant } from '../context/useTenant'
import ConfirmDialog from './ConfirmDialog'

const shortWeek = (weekOf: string) => weekOf.replace(/^\d{4}-/, '')

/**
 * 브랜드 삭제 확인 — 무엇이 남고 무엇이 바뀌는지 알리고, 브랜드 이름을 그대로 입력해야 뺀다(상용화 UI 3차 U15, 결정 S2-2).
 *
 * 예전 확인 창은 「삭제할까요?」 한 줄이라, 같은 비교 그룹의 지난 순위가 다시 매겨져 이미 보낸 보고서와 숫자가 달라진다는 것, 다른
 * 고객의 경쟁사 목록에 들어 있으면 그 고객을 잴 때 다시 잰다는 것을 몰랐다. 열 때 서버에서 미리보기를 받는다. 측정 중이면 잠근다 —
 * 그 측정이 지운 브랜드의 카드 · 순위를 다시 쓴다(서버도 409로 막는다).
 */
export default function DeleteBrandDialog({
  tenantId,
  brandName,
  busy,
  onConfirm,
  onCancel,
}: {
  tenantId: string
  brandName: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { tenants } = useTenant()
  const status = useMeasureStatus()
  const [preview, setPreview] = useState<{ value: TenantDeletePreview | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    loadDeletePreview(tenantId).then(
      (value) => alive && setPreview({ value, error: null }),
      (err: unknown) => {
        console.error('[DeleteBrandDialog] 삭제 미리보기를 읽지 못했습니다', err)
        if (alive) setPreview({ value: null, error: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  const p = preview?.value ?? null
  const root = status.runs?.current[0] ?? null
  const measuring = root !== null || status.active.length > 0 || Boolean(p?.measuring)
  const measuringName = root ? runName(root, tenants) : (status.active[0]?.brandName ?? '')
  const weeks = p ? p.cohorts.reduce((n, c) => n + c.weeks, 0) : 0
  const first = p?.cohorts.map((c) => c.firstWeekOf).sort()[0]
  const last = p?.cohorts.map((c) => c.lastWeekOf).sort().at(-1)
  const disabledReason = measuring
    ? `측정이 끝난 뒤에 뺄 수 있습니다${measuringName ? `(지금 ${measuringName} 측정 중)` : ''}.`
    : preview === null
      ? '무엇이 바뀌는지 확인하는 중…'
      : null

  return (
    <ConfirmDialog
      title={`${objectParticle(brandName)} 브랜드 목록에서 뺄까요?`}
      confirmLabel="목록에서 빼기"
      danger
      busy={busy}
      disabledReason={disabledReason}
      requireText={{ label: `확인하려면 브랜드 이름(${brandName})을 그대로 입력하세요`, expected: brandName }}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {preview?.error && <p className="ce-dialog-note">무엇이 바뀌는지 미리 보지 못했습니다({preview.error}). 빼면 아래와 같이 처리합니다.</p>}
      <p>
        {weeks > 0 && first && last
          ? `측정 기록(${shortWeek(first)}~${shortWeek(last)}, ${weeks}주)은 이 PC에 남습니다. `
          : '측정 기록은 이 PC에 남습니다. '}
        브랜드 관리 아래 「지운 브랜드」에서 설정째 되살릴 수 있고, 같은 홈페이지로 다시 등록해도 기록이 이어집니다.
      </p>
      {p && p.cohorts.length > 0 && (
        <p>
          같은 비교 그룹({p.cohorts.map((c) => `${c.industry} · ${c.region}`).join(', ')})의 지난 순위 {weeks}주치를 이 브랜드를 빼고 다시 매깁니다. 이미
          보낸 보고서의 순위와 달라질 수 있습니다.
        </p>
      )}
      {p && p.competitorOf.length > 0 && (
        <p>
          {p.competitorOf.map((c) => c.brandName).join(', ')}의 경쟁사 목록에 들어 있어,{' '}
          {objectParticle(p.competitorOf.map((c) => c.brandName).join(', '))} 측정하면 경쟁사로 다시 잽니다. 빼려면{' '}
          {p.competitorOf.length > 1 ? '그 브랜드들' : p.competitorOf[0]!.brandName}의 경쟁사 편집에서도 지우세요.
        </p>
      )}
    </ConfirmDialog>
  )
}
