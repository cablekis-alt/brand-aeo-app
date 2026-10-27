import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { hostKey } from '../src/lib/brandVariant.js';

/**
 * 더한 자사 주소 — data/<tenant>/owned-domains.json.
 *
 * 등록할 때 넣은 홈페이지(ownedDomains[0])는 경쟁사 id · 사이트 주소에 쓰이므로 그대로 두고, 그 뒤에 붙일 주소만 여기에 둔다
 * (2026-10-27 군산각: 옛 이름 사이트 all-about-gunsan.vercel.app). 브랜드 페이지 주소와 같은 이유로 별도 파일이다 — 테넌트 병합은
 * 베이스가 이기므로 저장소 설정 브랜드는 오버레이에 써도 무시된다. 이 파일이 있으면 런타임 ownedDomains 뒤에 합친다(tenantRegistry).
 */
export interface OwnedDomainsFile {
  extra: string[];
  updatedAt: string;
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'owned-domains.json');
}

/** 파일이 없으면 null. 열지 못하거나 깨진 파일은 로그를 남기고 null — 브랜드 목록 전체가 멈추지 않게 더한 주소 없이 간다. */
export async function readExtraOwnedDomains(tenantId: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.error(`[ownedDomainsStore] ${tenantId}/owned-domains.json을 열지 못해 더한 주소 없이 갑니다:`, err);
    return null;
  }
  try {
    const extra = (JSON.parse(text) as Partial<OwnedDomainsFile>).extra;
    return Array.isArray(extra) ? extra.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(hostKey) : [];
  } catch (err) {
    console.error(`[ownedDomainsStore] ${tenantId}/owned-domains.json을 읽지 못해 더한 주소 없이 갑니다:`, err);
    return null;
  }
}

export async function writeExtraOwnedDomains(tenantId: string, extra: string[]): Promise<void> {
  const body: OwnedDomainsFile = { extra, updatedAt: new Date().toISOString().slice(0, 10) };
  await writeJsonAtomic(filePathFor(tenantId), body);
}

/** 기존 목록 뒤에 더한 주소를 붙인다 — 같은 호스트는 한 번만, 앞 순서는 그대로(판정 맥락 지문이 순서째 해시한다). */
export function mergeOwnedDomains(base: string[], extra: string[] | null): string[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base.map(hostKey));
  const out = [...base];
  for (const d of extra) {
    const key = hostKey(d);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
