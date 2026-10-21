import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isSharedPlatformHost } from '../src/lib/sharedHosts.js';
import type { CohortExclusion } from './cohortExclusionStore.js';
import type { CompetitorContext } from '../src/prompts/types.js';
import type { TenantConfig } from './types.js';

/**
 * 고객 브랜드의 경쟁사 목록을 앱에서 고친 값 — data/<tenant>/competitors.json(경쟁사 편집 서랍, 상용화 UI 11차).
 *
 * 왜 별도 파일인가 — 시장 범위(tenantScopeStore.ts)·수집 엔진과 같은 이유다. 테넌트 병합은 베이스가 이기므로
 * (loadRuntimeTenants) repo config에 박힌 브랜드(스테이,머뭄 등)는 오버레이를 고쳐도 무시된다. 지난번
 * 경쟁사 교체(라엘펜션 → 군산여행의 모든것)는 그래서 릴리스가 필요했다.
 *
 * 저장할 때 베이스 값의 지문(base)을 함께 적는다. 나중에 릴리스로 베이스의 경쟁사·질문지가 바뀌면 지문이
 * 어긋나고, 그때는 이 파일을 쓰지 않는다 — 앱에서 고친 옛 목록이 새 베이스를 영영 가리지 않게. 서랍은
 * 그 사실을 알리고, 다시 저장하면 새 베이스 위에 지문을 새로 적는다.
 *
 * 이 파일은 데스크톱 사용자 폴더에만 있다. GitHub Actions 측정·Vercel 웹은 보지 못한다(저장소 설정을 따른다).
 */
export interface CompetitorOverride {
  competitors: CompetitorContext[];
  /** 저장할 때의 베이스 지문(baseFingerprint). */
  base: string;
  /**
   * 경쟁사를 바꾸며 고쳐 만든 질문지(4단계 「바뀐 경쟁사 질문만 고치기」) — 있으면 베이스의 questionBankVersion ·
   * questionBankSize 대신 쓴다. 없으면 베이스 질문지다. 지문(base)은 베이스 값으로만 계산하므로 이 값과 무관하다.
   * regenerate는 5단계 「브랜드 질문 모두 새로 쓰기」 — 저장할 때 은행 파일을 쓰지 않고, 다음 측정이 그 버전을 새로 만든다.
   * from은 그 전 버전, base는 저장할 때의 저장소 지문이다(측정이 만든 은행에 표식으로 옮겨 적는다 — pipeline.ts).
   */
  questionBank?: { version: string; size: number; regenerate?: { from: string; base: string } };
}

export interface CompetitorOverrideFile {
  /** 지금 쓰는 목록. null이면 베이스(저장소 설정)를 쓴다. */
  current: CompetitorOverride | null;
  /**
   * 마지막 저장 — 되돌리기용. 그 목록으로 이미 쟀으면 되돌릴 수 없다(competitorEditor.ts). exclusions는 그 저장이 코호트 제외
   * 목록(cohortExclusionStore.ts)에 더한 · 지운 항목 — 되돌리면 반대로 한다.
   */
  lastSave: {
    savedAt: string;
    before: CompetitorOverride | null;
    summary: string;
    exclusions?: { added: CohortExclusion[]; removed: CohortExclusion[] };
    /** 목록은 그대로 두고 지난 기록만 바꾼 저장. */
    listUnchanged?: true;
    /** listUnchanged일 때, 그 전 목록 저장의 시각 · 요약(「다음 측정 대기」가 보인다). */
    list?: { savedAt: string; summary: string };
  } | null;
  /**
   * 이 브랜드 자신의 측정(코호트 없이 재는 autoCohort false 고객도 · 다른 고객의 경쟁사로 잰 측정은 빼고)이 마지막으로 쓴
   * 목록(listHash)과 시작 시각. 목록은 런타임 설정이 준 목록이다 — 비어 있어 측정이 경쟁사를 추론해 채웠어도 빈 목록을 적는다
   * (추론한 목록은 저장하지 않아 다음 측정도 빈 목록에서 시작한다). 「다음 측정 대기」와 되돌리기가 이 값으로 판단한다 — 측정 완료 로그(measure-runs.json)는 50건에서 잘리고, 다른 고객의 경쟁사로 잰 측정도
   * 섞여 있어 쓰지 않는다. 처음 저장할 때는 그 직전 목록(마지막 측정이 쓴 목록)으로 채운다(at = null).
   * bankVersion은 그 측정이 쓴 질문지 버전 — 목록은 그대로 두고 질문지만 새로 쓴 저장도 「다음 측정 대기」로 보이게 한다.
   */
  /**
   * 마지막 측정이 쓴 목록 · 질문지. repoBase는 그때의 저장소 설정 지문(baseFingerprint) — 질문지 버전이 달라진 것이 저장소 설정 때문인지
   * 경쟁사 편집 때문인지 가른다(「다음 측정 대기」).
   */
  measured: { at: string | null; listHash: string; bankVersion?: string; repoBase?: string } | null;
  updatedAt: string;
}

const MAX_COMPETITORS = 20;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'competitors.json');
}

/** 경쟁사 목록의 지문 — 측정한 목록과 지금 목록이 같은지 볼 때 쓴다. */
export function listHash(competitors: CompetitorContext[]): string {
  const payload = JSON.stringify(competitors.map((c) => [c.name, c.aliases, c.domains]));
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** 베이스(저장소 설정·오버레이) 값의 지문 — 경쟁사 목록과 질문지 설정이 바뀌면 달라진다. */
export function baseFingerprint(tenant: TenantConfig): string {
  const payload = JSON.stringify({
    competitors: tenant.competitors.map((c) => ({ name: c.name, aliases: c.aliases, domains: c.domains })),
    questionBankVersion: tenant.questionBankVersion,
    questionBankSize: tenant.questionBankSize,
    cohortQuestionBank: tenant.cohortQuestionBank ?? null,
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** 첫 마디가 업체 이름이 아닌 주소 — 'blog.x.com'·'shop.x.co.kr'은 id가 'blog'·'shop'이 되어 다른 업체와 겹친다. */
const GENERIC_LABELS = new Set(['blog', 'shop', 'store', 'mall', 'home', 'web', 'site', 'booking', 'book', 'reserve', 'smartstore', 'cafe', 'post', 'brand', 'official']);

/** 여럿이 함께 쓰는 주소(lib/sharedHosts.ts)이거나 첫 마디가 업체 이름이 아닌 주소 — 홈페이지로 쓰지 않고 이름으로 잰다. */
export function isSharedHost(host: string): boolean {
  return (
    isSharedPlatformHost(host) ||
    // cohortPlan.ts slugFromDomain과 같은 첫 마디(그 모듈은 tenantRegistry를 거쳐 이 파일을 가져와 순환이 된다).
    GENERIC_LABELS.has(host.split('.')[0] ?? '')
  );
}

/**
 * 입력 칸에 들어온 홈페이지(주소 전체일 수도 있다)를 도메인으로 바꾼다. 'https://www.x.com/path' → 'x.com'.
 * 알아볼 수 없으면 null.
 */
export function hostFromInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    // www.·m.(모바일) 접두를 벗긴다 — 'm.x.co.kr'을 그대로 두면 id가 'm'이 되어 다른 업체와 겹친다.
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * 저장할 경쟁사 목록을 정리한다. 잘못된 입력이면 throw한다(라우트가 400으로 돌려준다).
 * 새로 넣은 공용 주소는 버리고(위 SHARED_HOSTS), 고객 자신의 도메인과 같은 경쟁사는 거절한다.
 * 지금 목록(previous)에 같은 이름·같은 주소로 이미 있던 줄은 그대로 둔다 — 주소를 떼면 id가 바뀌어 기록이 끊긴다.
 */
export function normalizeCompetitorList(
  input: unknown,
  owner: TenantConfig,
  previous: CompetitorContext[] = [],
): { competitors: CompetitorContext[]; droppedHosts: string[] } {
  if (!Array.isArray(input)) throw new Error('경쟁사 목록이 배열이 아닙니다.');
  if (input.length === 0) {
    throw new Error('경쟁사를 한 곳 이상 남겨 주세요 — 모두 빼면 측정할 때마다 AI가 경쟁사를 새로 골라요.');
  }
  if (input.length > MAX_COMPETITORS) throw new Error(`경쟁사는 ${MAX_COMPETITORS}곳까지 둘 수 있습니다.`);
  const owned = new Set(owner.ownedDomains.map((d) => d.toLowerCase().replace(/^www\./, '')));
  const droppedHosts: string[] = [];
  const names = new Set<string>();
  const competitors = input.map((item, i): CompetitorContext => {
    const raw = (item ?? {}) as { name?: unknown; aliases?: unknown; domains?: unknown };
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    if (!name) throw new Error(`${i + 1}번째 경쟁사의 이름이 비어 있습니다.`);
    const key = name.replace(/\s+/g, '');
    if (names.has(key)) throw new Error(`같은 경쟁사가 두 번 들어 있습니다: ${name}`);
    names.add(key);
    const domains: string[] = [];
    for (const d of Array.isArray(raw.domains) ? raw.domains : []) {
      if (typeof d !== 'string' || !d.trim()) continue;
      const host = hostFromInput(d);
      if (!host) throw new Error(`${name}의 홈페이지 주소를 알아볼 수 없습니다: ${d}`);
      if (owned.has(host)) throw new Error(`${name}의 홈페이지가 ${owner.brandName} 자신의 도메인과 같습니다: ${host}`);
      const kept = previous.some((p) => p.name === name && p.domains.some((pd) => pd.toLowerCase() === host));
      if (isSharedHost(host) && !kept) {
        droppedHosts.push(host);
        continue;
      }
      if (!domains.includes(host)) domains.push(host);
    }
    const aliases = Array.isArray(raw.aliases)
      ? [...new Set(raw.aliases.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean))]
      : [];
    return { name, aliases: aliases.length ? aliases : [name], domains };
  });
  return { competitors, droppedHosts };
}

function validQuestionBank(x: unknown): x is NonNullable<CompetitorOverride['questionBank']> {
  const v = x as { version?: unknown; size?: unknown; regenerate?: unknown } | null;
  const r = v?.regenerate as { from?: unknown; base?: unknown } | undefined;
  return Boolean(
    v &&
      typeof v.version === 'string' &&
      v.version &&
      typeof v.size === 'number' &&
      Number.isInteger(v.size) &&
      v.size > 0 &&
      (r === undefined || (r && typeof r.from === 'string' && r.from && typeof r.base === 'string' && r.base)),
  );
}

/** 파일이 없거나 깨졌으면 null(= 베이스 값). */
export async function readCompetitorOverride(tenantId: string): Promise<CompetitorOverrideFile | null> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<CompetitorOverrideFile>;
    let current = parsed.current && Array.isArray(parsed.current.competitors) && typeof parsed.current.base === 'string' ? parsed.current : null;
    // 질문지 값이 깨졌으면 목록도 쓰지 않는다 — 목록만 쓰면 그 목록과 맞지 않는 베이스 질문지로 잰다.
    if (current?.questionBank !== undefined && !validQuestionBank(current.questionBank)) {
      console.error(`[tenantCompetitors] ${tenantId} competitors.json의 질문지 값이 올바르지 않습니다 — 저장소 설정의 경쟁사를 씁니다:`, current.questionBank);
      current = null;
    }
    const measured = parsed.measured && typeof parsed.measured.listHash === 'string' ? parsed.measured : null;
    return { current, lastSave: parsed.lastSave ?? null, measured, updatedAt: parsed.updatedAt ?? '' };
  } catch (err) {
    console.error(`[tenantCompetitors] ${tenantId} competitors.json을 읽지 못했습니다 — 저장소 설정의 경쟁사를 씁니다:`, err);
    return null;
  }
}

export async function writeCompetitorOverride(tenantId: string, file: Omit<CompetitorOverrideFile, 'updatedAt'>): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...file, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  await rename(tmp, target);
}

// 이 파일을 읽고 쓰는 일(편집 저장·되돌리기, 측정 기록)은 프로세스 안에서 한 줄로 — 서로의 쓰기를 덮지 않게.
let fileChain: Promise<unknown> = Promise.resolve();
export function serializeCompetitorFile<T>(task: () => Promise<T>): Promise<T> {
  const run = fileChain.then(task, task);
  fileChain = run.catch(() => undefined);
  return run;
}

/**
 * 고객 브랜드 자신의 측정을 적는다(measureAndBake — cohortOnly 측정 · 다른 고객의 경쟁사로 잰 측정은 적지 않는다).
 * competitors는 측정이 시작할 때 런타임 설정에서 읽은 목록이다(비어 있으면 추론으로 채우기 전의 빈 목록). 앱에서 경쟁사를 고친 적이
 * 없는 브랜드(파일 없음)는 적을 것이 없다. 시작 시각(at)을 적는다 — 측정이 읽은 목록은 시작할 때의 목록이다.
 */
export function recordCompetitorMeasurement(
  tenantId: string,
  competitors: CompetitorContext[],
  at: string,
  bankVersion?: string,
  repoBase?: string,
): Promise<void> {
  return serializeCompetitorFile(async () => {
    const file = await readCompetitorOverride(tenantId);
    if (!file) return;
    await writeCompetitorOverride(tenantId, {
      current: file.current,
      lastSave: file.lastSave,
      measured: { at, listHash: listHash(competitors), ...(bankVersion ? { bankVersion } : {}), ...(repoBase ? { repoBase } : {}) },
    });
  });
}

/** 앱에서 고친 목록이 지금 베이스 위에 저장된 것인가. 아니면(베이스가 그 뒤에 바뀌었으면) 쓰지 않는다. */
export function overrideApplies(override: CompetitorOverride | null, base: TenantConfig): override is CompetitorOverride {
  return Boolean(override && override.base === baseFingerprint(base));
}
