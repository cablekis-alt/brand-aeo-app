import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { FactGraphNode } from '../src/prompts/types.js';

/**
 * 팩트 그래프(브랜드 사실)를 테넌트 파일 하나에 둔다 — data/<tenant>/fact-graph.json.
 *
 * 왜 오버레이(tenants.overlay.json)가 아닌 별도 파일인가. 테넌트 병합은 **베이스가 이긴다**
 * (loadRuntimeTenants: 오버레이는 베이스에 없는 id만 추가). 원진성형외과처럼 repo config에 박힌
 * 브랜드는 오버레이에 써도 무시된다. 팩트 그래프만은 사람이 앱에서 고쳐야 하는 값이라, 베이스든
 * 오버레이든 **이 파일이 있으면 그것이 이긴다**로 규칙을 하나 더 둔다. 다른 필드(경쟁사·질문
 * 배분 등)는 여전히 베이스가 이기므로 병합 규칙이 두 갈래로 갈리지 않는다.
 *
 * 쓰는 곳: 사실성 판정(B5-D — 응답의 주장을 이 값과 대조), 콘텐츠 브리프(반드시 넣을 사실).
 * 등록된 사실만 두 곳에 들어간다 — 여기 없는 것은 판정에서는 '검증 불가', 브리프에서는
 * '확인 필요'로 남는다. 그래서 채울수록 두 화면이 정확해진다.
 */
export const FACT_TYPES = ['price', 'spec', 'date', 'certification', 'location', 'other'] as const;
export type FactType = (typeof FACT_TYPES)[number];

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'fact-graph.json');
}

/** 파일이 없으면 null(= 설정값 그대로 쓴다). 있으면 배열(빈 배열도 유효 — 사용자가 비운 것). */
export async function readFactGraphFile(tenantId: string): Promise<FactGraphNode[] | null> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as FactGraphNode[]) : null;
  } catch {
    return null;
  }
}

/**
 * 입력을 검증·정규화한다. claim·value가 비면 버린다(빈 줄 저장 방지). id가 없으면 만들고,
 * updatedAt은 항상 오늘로 찍는다 — 사람이 저장한 시점이 곧 "이 사실이 확인된 시점"이다.
 */
export function normalizeFactGraph(input: unknown): { nodes: FactGraphNode[]; dropped: number } {
  if (!Array.isArray(input)) return { nodes: [], dropped: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const nodes: FactGraphNode[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      dropped += 1;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const claim = typeof r.claim === 'string' ? r.claim.trim() : '';
    const value = typeof r.value === 'string' ? r.value.trim() : '';
    const type = (FACT_TYPES as readonly string[]).includes(String(r.type)) ? (r.type as FactType) : 'other';
    if (!claim || !value) {
      dropped += 1;
      continue;
    }
    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `fact-${type}-${claim.replace(/\s+/g, '-').slice(0, 24)}`;
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const sourceUrl = typeof r.sourceUrl === 'string' && r.sourceUrl.trim() ? r.sourceUrl.trim() : undefined;
    nodes.push({ id, type, claim, value, ...(sourceUrl ? { sourceUrl } : {}), updatedAt: today });
  }
  return { nodes, dropped };
}

export async function writeFactGraphFile(tenantId: string, nodes: FactGraphNode[]): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(nodes, null, 2), 'utf-8');
  await rename(tmp, target);
}
