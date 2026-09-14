import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../src/prompts/types.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';

/**
 * 브랜드별 수집 엔진 — data/<tenant>/engines.json.
 *
 * 수집 엔진을 고르는 자리는 원래 둘이었는데 하나가 비어 있었다. 전역 지정(COLLECT_ENGINES)은
 * 설정 패널에서 바꿀 수 있었지만, 같은 패널의 "브랜드별 설정 사용"이 가리키는 tenant.engines는
 * 어디서도 정할 수 없었다 — 온보딩이 4개를 하드코딩하고 그 뒤로 고칠 화면도 API도 없었다.
 *
 * 왜 오버레이가 아니라 별도 파일인가 — 팩트 그래프·브랜드 페이지와 같은 이유다. 테넌트 병합은
 * **베이스가 이기므로**(loadRuntimeTenants) repo config에 박힌 브랜드 30곳은 오버레이에 써도
 * 무시된다. 사람이 앱에서 고치는 값이 릴리스를 기다리게 할 수는 없다.
 *
 * 이 값은 전역 지정을 이기지 않는다. 우선순위는 resolveCollectionEngines 한 곳에 있다:
 * COLLECT_ENGINES가 있으면 그것이, 없으면 tenant.engines가 쓰이고, 어느 쪽이든 키가 없는
 * 엔진은 마지막에 걸린다.
 */
const ALL: Engine[] = ['openai', 'gemini', 'claude', 'perplexity'];

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'engines.json');
}

/**
 * 아는 엔진만 남기고 중복을 없앤다. 빈 목록은 거절한다 — 저장을 허용하면 그 브랜드는
 * 측정할 때마다 "측정 가능한 엔진이 없습니다"로 죽는다. 되돌리려면 파일을 지우는 게 아니라
 * 전역 지정을 쓰거나 다시 고르면 된다.
 */
export function normalizeEngineList(input: unknown): Engine[] {
  if (!Array.isArray(input)) throw new Error('engines는 배열이어야 합니다.');
  const seen = new Set<Engine>();
  const unknown: string[] = [];
  for (const item of input) {
    const s = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if ((ALL as string[]).includes(s)) seen.add(s as Engine);
    else if (s) unknown.push(s);
  }
  if (unknown.length) throw new Error(`모르는 엔진입니다: ${unknown.join(', ')}`);
  if (seen.size === 0) throw new Error('수집 엔진을 하나 이상 고르세요.');
  // 저장 순서를 ALL 기준으로 고정한다 — 스코어카드의 enginesUsed 비교가 순서로 갈리지 않게.
  return ALL.filter((e) => seen.has(e));
}

/** 파일이 없으면 null(= 테넌트 설정의 engines를 그대로 쓴다). */
export async function readTenantEngines(tenantId: string): Promise<Engine[] | null> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as unknown;
    const raw = (parsed as { engines?: unknown })?.engines;
    if (!Array.isArray(raw)) return null;
    const picked = ALL.filter((e) => raw.includes(e));
    return picked.length > 0 ? picked : null;
  } catch {
    return null;
  }
}

export async function writeTenantEngines(tenantId: string, engines: Engine[]): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const body = { engines, updatedAt: new Date().toISOString().slice(0, 10) };
  await writeFile(tmp, JSON.stringify(body, null, 2), 'utf-8');
  await rename(tmp, target);
}
