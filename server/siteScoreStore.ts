import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { getIsoWeekString } from './dateUtil.js';

/**
 * Site AEO Score의 주차별 기록 — data/<tenant>/site-scores.json.
 *
 * 왜 저장이 필요한가 — Site AEO Checker는 지금까지 화면 안에서만 살았다(useState). 그래서
 * "이번 주 78점"은 보여도 **지난주 대비**를 말할 수 없었다. 페이지를 고친 효과가 점수로
 * 드러나지 않으면 고객은 고칠 이유를 못 느낀다. 주간 파이프라인의 Brand AEO Score와 나란히
 * 놓으려면 같은 주차 키(ISO week)로 남는 값이 하나는 있어야 한다.
 *
 * 왜 스코어카드에 합치지 않는가 — 성격이 다르다. Brand 쪽은 엔진을 호출해 주 1회 만들어지고
 * 재측정이 비싸다. Site 쪽은 HTML 한 장을 읽어 즉시 나오고 하루에 몇 번이든 다시 돌린다.
 * 같은 파일에 넣으면 값싼 재진단이 비싼 측정 기록을 건드리게 된다. 그래서 파일을 분리하고,
 * 같은 주에 다시 진단하면 그 주 칸만 덮어쓴다(마지막 진단이 그 주의 값이다).
 */
export interface SiteScoreRecord {
  weekOf: string;
  /** 총점. 진단 불가(수집 실패 등)는 아예 저장하지 않으므로 여기서는 항상 숫자다. */
  score: number;
  grade: string | null;
  /** 실제로 채점한 주소. 브랜드 페이지를 바꾸면 추이가 끊기는지 여기서 드러난다. */
  url: string;
  pageTitle: string;
  collectionMode: string;
  categories: { id: string; name: string; score: number | null; maxScore: number }[];
  measuredAt: string;
}

export type SiteScoreMap = Record<string, SiteScoreRecord>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'site-scores.json');
}

/** 파일이 없거나 깨졌으면 빈 기록. 진단 화면을 막을 이유가 없다. */
export async function readSiteScores(tenantId: string): Promise<SiteScoreMap> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SiteScoreMap;
  } catch {
    return {};
  }
}

/**
 * 이번 주 칸에 기록한다. 주차는 **서버가 정한다** — 클라이언트가 보낸 주차를 믿으면
 * 시계가 어긋난 PC가 남의 주차를 덮어쓴다.
 */
export async function writeSiteScore(
  tenantId: string,
  input: Omit<SiteScoreRecord, 'weekOf' | 'measuredAt'>,
): Promise<{ weekOf: string; scores: SiteScoreMap }> {
  const now = new Date();
  const weekOf = getIsoWeekString(now);
  const scores = await readSiteScores(tenantId);
  scores[weekOf] = { ...input, weekOf, measuredAt: now.toISOString() };

  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(scores, null, 2), 'utf-8');
  await rename(tmp, target);
  return { weekOf, scores };
}

/**
 * 이 주소를 이 브랜드의 것으로 인정할지 — 서버 쪽 방어선.
 *
 * 화면도 같은 판정을 하지만(resolveTarget), 여기서 한 번 더 본다. 경쟁사나 남의 페이지를
 * 진단한 값이 우리 점수로 들어가면 추이가 조용히 거짓이 된다 — 인용 소유권에서 겪은 것과
 * 같은 종류의 오염이다. ownedDomains와 brandPageUrl **둘 다** 인정한다(스테이,머뭄처럼
 * 사실이 적힌 페이지가 하위 경로에 있는 경우가 있다).
 */
export function urlBelongsToTenant(
  url: string,
  tenant: { ownedDomains?: string[]; brandPageUrl?: string },
): boolean {
  const hostOf = (raw: string): string | null => {
    const s = raw.trim();
    if (!s) return null;
    try {
      return new URL(/^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`).hostname
        .replace(/^www\./, '')
        .toLowerCase();
    } catch {
      return null;
    }
  };
  const host = hostOf(url);
  if (!host) return false;
  const owned = [...(tenant.ownedDomains ?? []), tenant.brandPageUrl ?? '']
    .map(hostOf)
    .filter((h): h is string => Boolean(h));
  return owned.some((d) => host === d || host.endsWith(`.${d}`));
}
