import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';

/**
 * 경쟁사 「업종 다름」 판정 — data/<고객>/competitor-industry.json(경쟁사 편집 5단계, 결정 7 · F1).
 *
 * 고객마다 따로 둔다 — 같은 곳이라도 고객 업종에 비춘 판단이라(펜션 고객에게 관광 정보 사이트는 다른 업종이지만 관광 고객에게는
 * 같은 업종이다). competitors.json에 두지 않는다: 그 파일을 쓰는 곳(저장 · 되돌리기 · 저장소로 돌아가기 · 측정 기록)이 모르는
 * 필드를 지우고, 목록이 저장소와 같아지면 수정본 자체가 사라진다. 판정은 목록 편집과 따로 살아남아야 한다.
 *
 * 키는 이름을 접은 값(공백 제거 + 소문자) — 측정 id는 홈페이지를 넣으면 바뀌고, 저장 전의 새 줄에는 id가 없다. 넘겨받기도 이름으로
 * 정한다(questionHandoff.ts keyOf).
 *
 * 이 파일은 데스크톱 사용자 폴더에만 있다. tenantRegistry · store에서 읽지 않는다(Vercel 번들에 들지 않게) — 서랍 계산과 넘겨받기만 쓴다.
 */
export type IndustryVerdict = 'same' | 'different' | 'unsure';

export interface CompetitorIndustryEntry {
  /** 마지막으로 본 표기. */
  name: string;
  /** AI(또는 규칙)가 본 판정 — customerIndustry가 지금 고객 업종과 다르면 낡은 값이다. */
  ai?: {
    verdict: IndustryVerdict;
    looksLike: string | null;
    reason: string | null;
    customerIndustry: string;
    /** 'rule'이면 AI 없이 정했다(업종 접미사 · 등록 고객 브랜드). */
    engine: string;
    at: string;
  };
  /** 사람이 정한 값(「펜션 맞음」 · 「업종 다름으로 표시」) — AI 판정보다 먼저다. */
  person?: { mark: 'same' | 'different'; at: string };
}

interface IndustryFile {
  version: 1;
  entries: Record<string, CompetitorIndustryEntry>;
}

export const industryKey = (name: string) => name.replace(/\s+/g, '').toLowerCase();

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'competitor-industry.json');
}

/** 판정 목록 — 파일이 없으면 빈 목록, 깨졌으면 로그를 남기고 빈 목록(서랍이 멈추지 않게 · 쓰기는 updateCompetitorIndustry가 막는다). */
export async function readCompetitorIndustry(tenantId: string): Promise<Record<string, CompetitorIndustryEntry>> {
  try {
    return parse(await readFile(filePathFor(tenantId), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error(`[competitorIndustry] ${tenantId} competitor-industry.json을 읽지 못했습니다 — 판정 없이 계산합니다:`, err);
    return {};
  }
}

function parse(text: string): Record<string, CompetitorIndustryEntry> {
  const raw = JSON.parse(text) as Partial<IndustryFile>;
  const entries = raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {};
  return entries as Record<string, CompetitorIndustryEntry>;
}

/**
 * 판정을 고쳐 쓴다(고객별 쓰기 줄). 깨진 파일은 덮지 않고 실패한다 — 사람이 정한 표시를 조용히 잃지 않게.
 */
export function updateCompetitorIndustry(
  tenantId: string,
  change: (entries: Record<string, CompetitorIndustryEntry>) => Record<string, CompetitorIndustryEntry>,
): Promise<Record<string, CompetitorIndustryEntry>> {
  if (process.env.VERCEL) throw new Error('경쟁사 업종 판정은 데스크톱 앱에서만 바꿀 수 있어요.');
  return queueTenantWrite(tenantId, async () => {
    let entries: Record<string, CompetitorIndustryEntry> = {};
    try {
      entries = parse(await readFile(filePathFor(tenantId), 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const next = change({ ...entries });
    await writeJsonAtomic(filePathFor(tenantId), { version: 1, entries: next } satisfies IndustryFile);
    return next;
  });
}

/**
 * 지금 쓰는 판정 — 사람이 정한 값이 먼저, 없으면 지금 고객 업종으로 본 AI 판정. 모르면(unsure · 낡음 · 없음) null.
 */
export function effectiveIndustry(
  entry: CompetitorIndustryEntry | undefined,
  customerIndustry: string,
): { verdict: 'same' | 'different'; looksLike: string | null; by: 'ai' | 'person' } | null {
  if (!entry) return null;
  if (entry.person) return { verdict: entry.person.mark, looksLike: entry.ai?.looksLike ?? null, by: 'person' };
  const ai = entry.ai;
  if (!ai || ai.customerIndustry !== customerIndustry || ai.verdict === 'unsure') return null;
  return { verdict: ai.verdict, looksLike: ai.looksLike, by: 'ai' };
}
