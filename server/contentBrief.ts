import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContentBriefPrompt, type ContentBrief, type ContentBriefRequest } from '../src/prompts/b9b-content-brief.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { createFactGuard } from './factGuard.js';
import type { EngineClient } from './engines/types.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 브리프는 테넌트 파일 하나(briefs.json)에 actionId별로 저장한다. 실행 항목 id가 주차에 묶이지
 * 않게 설계된 덕에 같은 항목은 다음 주에도 같은 브리프를 다시 쓴다 — 매번 판정을 부르지 않는다.
 * 다시 만들기(force)를 누르면 덮어쓴다.
 */
export interface StoredBrief {
  actionId: string;
  generatedAt: string;
  brief: ContentBrief;
}
type BriefMap = Record<string, StoredBrief>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'briefs.json');
}

export async function readBriefs(tenantId: string): Promise<BriefMap> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as BriefMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeBriefs(tenantId: string, map: BriefMap): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await rename(tmp, target);
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const FORMATS = ['paragraph', 'faq', 'table', 'list'] as const;

/**
 * 판정 응답을 스키마대로 다듬고, 사실 가드(factGuard)를 통과한 것만 남긴다.
 * 가드 규칙은 초안(contentDraft)과 **같은 모듈**을 쓴다 — 두 벌로 두면 한쪽만 고쳐진다.
 * 빠진 필드는 빈 배열로 둔다. 화면이 "없음"으로 밝힌다.
 */
function normalize(raw: unknown, facts: ContentBriefRequest['factGraph'], questionTexts: string[]): ContentBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { canonicalFacts, guardSentence, notes } = createFactGuard(facts, questionTexts);

  const structure = Array.isArray(r.structure)
    ? (r.structure as unknown[])
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x) => ({
          heading: String(x.heading ?? ''),
          answers: String(x.answers ?? ''),
          format: (FORMATS as readonly string[]).includes(String(x.format))
            ? (x.format as ContentBrief['structure'][number]['format'])
            : ('paragraph' as const),
        }))
        .filter((x) => x.heading)
    : [];
  return {
    titles: isStrArr(r.titles) ? r.titles.slice(0, 3) : [],
    audience: typeof r.audience === 'string' ? r.audience : '',
    questionsToAnswer: isStrArr(r.questionsToAnswer) ? r.questionsToAnswer : [],
    mustIncludeFacts: isStrArr(r.mustIncludeFacts) ? canonicalFacts(r.mustIncludeFacts) : [],
    // 문체 규칙("과장 표현 금지" 등)이 사실 자리에 섞여 오면 걸러낸다 — 프롬프트가 금지하지만 어길 때가 있다.
    doNotClaim: isStrArr(r.doNotClaim) ? r.doNotClaim.filter((x) => !/(표현|문체|어투|톤).*(금지|피하|사용하지)|과장 표현/.test(x)) : [],
    structure,
    citableSentences: isStrArr(r.citableSentences) ? r.citableSentences.filter(guardSentence).slice(0, 5) : [],
    channelNotes: isStrArr(r.channelNotes) ? r.channelNotes : [],
    ...(notes.length ? { guardNotes: notes } : {}),
  };
}

export async function generateBrief(
  tenantId: string,
  actionId: string,
  req: ContentBriefRequest,
  judge: EngineClient,
): Promise<StoredBrief> {
  const result = await judge.call(buildContentBriefPrompt(req));
  const brief = normalize(parseJsonLoose<unknown>(result.text), req.factGraph, req.action.questionTexts);
  if (!brief) throw new Error('브리프 응답을 해석할 수 없습니다(JSON 아님). 다시 시도하세요.');
  const stored: StoredBrief = { actionId, generatedAt: new Date().toISOString(), brief };
  const map = await readBriefs(tenantId);
  map[actionId] = stored;
  await writeBriefs(tenantId, map);
  return stored;
}
