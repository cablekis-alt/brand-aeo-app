import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { normalizePublishSettings, type PublishSettings } from '../src/lib/publishSettings.js';

/**
 * 브랜드별 발행 설정 — data/<tenant>/publish-settings.json(src/lib/publishSettings.ts 주석).
 *
 * 시장 범위(tenantScopeStore.ts)처럼 브랜드 폴더에 따로 둔다. 테넌트 설정(오버레이)은 베이스가 이기고 전환 · 재등록
 * 때 바뀌지만, 이 값은 사람이 발행 화면에서 적는 것이라 측정 설정과 따로 산다.
 */
function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'publish-settings.json');
}

/** 파일이 없으면 null. 깨졌으면 알리고 null — 발행은 설정 없이(글 끝에 공식 사이트 링크만) 이어진다. */
export async function readPublishSettings(tenantId: string): Promise<PublishSettings | null> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const settings = normalizePublishSettings(raw);
    return typeof raw.updatedAt === 'string' ? { ...settings, updatedAt: raw.updatedAt } : settings;
  } catch (err) {
    console.error(`[publishSettings] ${tenantId} publish-settings.json을 읽지 못했습니다 — 설정 없이 씁니다:`, err);
    return null;
  }
}

export async function writePublishSettings(tenantId: string, settings: PublishSettings): Promise<PublishSettings> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const saved: PublishSettings = { ...normalizePublishSettings(settings), updatedAt: new Date().toISOString() };
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(saved, null, 2), 'utf-8');
  await rename(tmp, target);
  return saved;
}
