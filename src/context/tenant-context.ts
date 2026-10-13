import { createContext } from 'react'
import type { TenantSummary } from '../lib/api'

export interface TenantContextValue {
  /** 고객 브랜드 목록(경쟁사 제외). */
  tenants: TenantSummary[]
  /** 화면이 보는 브랜드의 id — 경쟁사 보기 중이면 그 경쟁사. */
  tenantId: string
  /** 고객 브랜드를 고른다. 경쟁사 보기는 풀린다. */
  setTenantId: (id: string) => void
  /** 화면이 보는 브랜드 — 경쟁사 보기 중이면 그 경쟁사, 아니면 고른 고객 브랜드. */
  tenant: TenantSummary | undefined
  /** 고른 고객 브랜드. 경쟁사 보기 중에도 그대로다(돌아갈 곳). */
  customer: TenantSummary | undefined
  /** 보고 있는 경쟁사(읽기 전용). 없으면 null. */
  viewing: TenantSummary | null
  /** 경쟁사를 읽기 전용으로 연다. 고객 브랜드 id면 그 브랜드를 고른다. */
  viewCompetitor: (id: string) => Promise<void>
  /** 경쟁사 보기를 끝내고 고른 고객 브랜드로 돌아간다. */
  exitCompetitorView: () => void
  loading: boolean
  error: string | null
  reloadTenants: () => Promise<TenantSummary[]>
}

export const TenantContext = createContext<TenantContextValue | null>(null)
