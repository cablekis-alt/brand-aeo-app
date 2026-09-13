import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';

/**
 * 브랜드 페이지 주소 — data/<tenant>/brand-page.json.
 *
 * ownedDomains의 첫 도메인은 "이 브랜드가 소유한 곳"을 가리킬 뿐, **사실이 적힌 페이지**와
 * 같지 않다. 스테이,머뭄이 그 차이를 드러냈다: 소유 도메인은 web4ai.o2osolution.ai인데
 * 루트는 콘솔 껍데기고, 체크인 시각·추가 요금·취소 규정이 적힌 곳은 /s/stay다. 루트를 읽으면
 * 후보가 0건 나와 기능이 고장 난 것처럼 보인다.
 *
 * 왜 오버레이가 아니라 별도 파일인가 — 팩트 그래프와 같은 이유다. 테넌트 병합은 **베이스가
 * 이기므로**(loadRuntimeTenants) repo config에 박힌 브랜드는 오버레이에 써도 무시된다.
 * 사람이 앱에서 고치는 값은 릴리스를 기다리면 안 된다. 그래서 이 파일이 있으면 그것이 이긴다.
 */
function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'brand-page.json');
}

/**
 * http(s)만 받는다. 빈 값은 null — "기본값(소유 도메인)으로 되돌린다"는 뜻이다.
 *
 * 스킴 검사를 **https를 붙이기 전에** 한다. 나중에 보면 늦다 — `ftp://x`에 https를 덧붙이면
 * `https://ftp//x`가 되어 형식상 멀쩡한 URL로 통과해 버린다(실측으로 걸린 구멍).
 */
export function normalizeBrandPageUrl(input: unknown): string | null {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    throw new Error(`http 또는 https 주소만 쓸 수 있습니다: ${s}`);
  }
  const withScheme = scheme ? s : `https://${s.replace(/^\/+/, '')}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`주소 형식이 아닙니다: ${s}`);
  }
  // 점 없는 호스트는 사람이 주소라고 부르는 것이 아니다(localhost만 예외로 둔다 — 개발용).
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.') && host !== 'localhost') {
    throw new Error(`주소 형식이 아닙니다: ${s}`);
  }
  return parsed.toString();
}

/** 파일이 없으면 null(= 소유 도메인을 쓴다). */
export async function readBrandPageUrl(tenantId: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as unknown;
    const url = (parsed as { url?: unknown })?.url;
    return typeof url === 'string' && url.trim() ? url.trim() : null;
  } catch {
    return null;
  }
}

/** null이면 비워 둔 것으로 기록한다 — 파일을 지우지 않고 빈 값을 남겨 "되돌렸다"가 드러나게 한다. */
export async function writeBrandPageUrl(tenantId: string, url: string | null): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const body = { url: url ?? '', updatedAt: new Date().toISOString().slice(0, 10) };
  await writeFile(tmp, JSON.stringify(body, null, 2), 'utf-8');
  await rename(tmp, target);
}
