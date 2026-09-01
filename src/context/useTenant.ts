import { useContext } from 'react'
import { TenantContext, type TenantContextValue } from './tenant-context'

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant는 TenantProvider 내부에서만 사용할 수 있습니다.')
  return ctx
}
