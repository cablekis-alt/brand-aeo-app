import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stateFilePath } from './appPaths.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { previousIsoWeek } from '../src/prompts/isoWeek.js';

/**
 * 코호트 순위에서 뺀 경쟁사 — 「지난 기록에서도 빼기」(경쟁사 편집 3단계).
 *
 * 경쟁사를 목록에서 빼도 이미 잰 카드는 지난 주차 순위표에 남는다(측정 기록은 지우지 않는다). 그 카드를 순위
 * 계산에서만 빼고 싶을 때 여기 적는다. 점수 · 카드는 그대로이고, 순위만 다시 센다(cohortRank.ts).
 *
 * 왜 브랜드 삭제(툼스톤)를 다시 쓰지 않는가 — 툼스톤은 브랜드 전체(모든 코호트 · 모든 주차)를 지우고, 그 브랜드를
 * 다시 재면 풀린다. 여기는 코호트(업종 · 지역) 하나와 주차 범위만 뺀다.
 *
 * 키는 카드에 박힌 업종 · 지역 문자열 그대로다(정규화하지 않는다 — getCohortScorecards와 같은 규칙). untilWeek는
 * 포함, fromWeek가 있으면 그 주부터(「W42 기록만 빼기」는 fromWeek = untilWeek).
 *
 * 이 파일은 데스크톱 사용자 폴더에만 있다. GitHub Actions 측정 · Vercel 웹은 보지 못한다(읽으면 파일이 없어 빈 목록).
 */
export interface CohortExclusion {
  /** 되돌리기 · 같은 주 재측정 해제가 항목을 가리키는 값. */
  id: string;
  industry: string;
  region: string;
  tenantId: string;
  untilWeek: string;
  fromWeek?: string;
  brandName: string;
  excludedAt: string;
  /** 뺀 고객 브랜드. */
  excludedBy: string;
}

interface CohortExclusionFile {
  version: 1;
  entries: CohortExclusion[];
}

const FILE_NAME = 'cohort-exclusions.json';
const WEEK = /^\d{4}-W\d{2}$/;

function filePath(): string {
  return stateFilePath(FILE_NAME);
}

function validEntry(e: unknown): e is CohortExclusion {
  const x = (e ?? {}) as Partial<CohortExclusion>;
  return (
    typeof x.id === 'string' &&
    typeof x.industry === 'string' &&
    typeof x.region === 'string' &&
    typeof x.tenantId === 'string' &&
    typeof x.untilWeek === 'string' &&
    WEEK.test(x.untilWeek) &&
    (x.fromWeek === undefined || (typeof x.fromWeek === 'string' && WEEK.test(x.fromWeek)))
  );
}

async function readStrict(): Promise<CohortExclusion[]> {
  let text: string;
  try {
    text = await readFile(filePath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(text) as Partial<CohortExclusionFile>;
  const raw = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entries = raw.filter(validEntry);
  if (entries.length !== raw.length) {
    console.error(`[cohortExclusions] 알아볼 수 없는 항목 ${raw.length - entries.length}개를 건너뜁니다.`);
  }
  return entries;
}

/**
 * 제외 목록. 파일이 없으면 빈 목록. 깨졌으면 로그를 남기고 빈 목록 — 순위 화면이 멈추지 않게(대신 그동안은 뺀 경쟁사도
 * 센다). 쓰기(updateCohortExclusions)는 깨진 파일을 빈 목록으로 덮지 않고 실패한다.
 */
export async function readCohortExclusions(): Promise<CohortExclusion[]> {
  try {
    return await readStrict();
  } catch (err) {
    console.error(`[cohortExclusions] ${FILE_NAME}을 읽지 못했습니다 — 제외 없이 순위를 셉니다:`, err);
    return [];
  }
}

/** 이 카드를 순위 계산에서 빼는가. */
export function isExcluded(
  entries: readonly CohortExclusion[],
  card: { tenantId: string; industry: string; region: string; weekOf: string },
): boolean {
  return entries.some(
    (e) =>
      e.tenantId === card.tenantId &&
      e.industry === card.industry &&
      e.region === card.region &&
      card.weekOf <= e.untilWeek &&
      (!e.fromWeek || card.weekOf >= e.fromWeek),
  );
}

export type NewCohortExclusion = Omit<CohortExclusion, 'id' | 'excludedAt'>;

/** 새 항목에 id · 시각을 붙인다. */
export function stampExclusion(entry: NewCohortExclusion, now = new Date().toISOString()): CohortExclusion {
  return { ...entry, id: randomUUID(), excludedAt: now };
}

/**
 * 바뀐 목록 — 미리보기와 저장이 같이 쓴다(같은 입력이면 같은 목록). removeIds의 항목을 지우고 add를 붙인다.
 */
export function applyExclusionChanges(
  entries: readonly CohortExclusion[],
  change: { add?: readonly CohortExclusion[]; removeIds?: readonly string[] },
): CohortExclusion[] {
  const remove = new Set(change.removeIds ?? []);
  return [...entries.filter((e) => !remove.has(e.id)), ...(change.add ?? [])];
}

/**
 * 같은 주에 다시 넣어 쟀다 — 그 주는 다시 센다. 측정으로 이번 코호트에 카드를 남긴 경쟁사(측정 성공 · 이번 주 카드 재사용)의
 * 키가 항목의 범위에 들면 untilWeek를 그 전 주로 당기고, 범위가 비면 항목을 지운다. 측정에 실패한 경쟁사는 넘기지 않는다.
 */
export function trimRemeasured(
  entries: readonly CohortExclusion[],
  hits: readonly { tenantId: string; industry: string; region: string; weekOf: string }[],
): { entries: CohortExclusion[]; trimmed: { entry: CohortExclusion; weekOf: string; removed: boolean }[] } {
  const trimmed: { entry: CohortExclusion; weekOf: string; removed: boolean }[] = [];
  const out: CohortExclusion[] = [];
  for (const e of entries) {
    const hit = hits.find((h) => isExcluded([e], h));
    if (!hit) {
      out.push(e);
      continue;
    }
    const until = previousIsoWeek(hit.weekOf);
    const removed = !until || (e.fromWeek !== undefined && e.fromWeek > until);
    trimmed.push({ entry: e, weekOf: hit.weekOf, removed });
    if (!removed) out.push({ ...e, untilWeek: until });
  }
  return { entries: out, trimmed };
}

// 읽기 → 고치기 → 쓰기를 프로세스 안에서 한 줄로 — 편집 저장과 측정의 해제가 서로의 쓰기를 덮지 않게.
let chain: Promise<unknown> = Promise.resolve();

/** 제외 목록을 고쳐 쓴다. 깨진 파일은 덮지 않고 실패한다. 웹(Vercel)에서는 쓰지 않는다. */
export function updateCohortExclusions(
  fn: (entries: CohortExclusion[]) => CohortExclusion[],
): Promise<CohortExclusion[]> {
  const run = chain.then(async () => {
    if (process.env.VERCEL) throw new Error('코호트 제외 목록은 데스크톱 앱에서만 바꿀 수 있습니다.');
    const next = fn(await readStrict());
    const file: CohortExclusionFile = { version: 1, entries: next };
    await writeJsonAtomic(filePath(), file);
    return next;
  });
  chain = run.catch(() => undefined);
  return run;
}
