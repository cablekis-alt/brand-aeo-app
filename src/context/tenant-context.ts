import { createContext } from 'react'
import type { TenantSummary } from '../lib/api'

export interface TenantContextValue {
  tenants: TenantSummary[]
  tenantId: string
  setTenantId: (id: string) => void
  tenant: TenantSummary | undefined
  loading: boolean
  error: string | null
}

export const TenantContext = createContext<TenantContextValue | null>(null)
