import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildContentBriefPrompt, type ContentBrief, type ContentBriefRequest } from '../src/prompts/b9b-content-brief.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
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

/** 판정 응답을 스키마대로 다듬는다. 빠진 필드는 빈 배열로 — 화면이 "없음"으로 밝힌다. */
/**
 * 판정이 사실을 요약·격상하는 것을 코드로 막는다. 프롬프트가 금지하지만 어길 때가 있다
 * (실측: "30명의 의료진이 직접 집도"를 "전문의 30명"으로 옮겼다 — 의료진과 전문의는 다른 주장이다).
 *
 *   mustIncludeFacts  판정이 쓴 문장을 버리고 팩트 그래프의 "<주장>: <값>" 정본으로 바꾼다.
 *                     어느 사실과도 짝이 안 되는 원소는 새로 만든 사실이므로 버린다.
 *   citableSentences  숫자를 담은 문장은 그 숫자가 어느 사실 값에서 왔는지 찾고, 그 값 문자열을
 *                     **그대로** 포함해야 남긴다. 숫자가 질문 문장에서 온 것이면 통과, 어디에도
 *                     없으면 만들어낸 수치라 버린다. 숫자 없는 문장은 그대로 둔다.
 * 걸러낸 것은 guardNotes에 이유와 함께 적는다 — 조용히 지우지 않는다.
 */
function normalize(raw: unknown, facts: ContentBriefRequest['factGraph'], questionTexts: string[]): ContentBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const notes: string[] = [];
  const questionBlob = questionTexts.join('\n');

  const canonicalFacts = (arr: string[]): string[] => {
    const out: string[] = [];
    for (const item of arr) {
      // 값 원문 포함 → 그 사실. 아니면 주장 이름 포함 → 그 사실. 둘 다 아니면 새로 만든 사실.
      const hit = facts.find((f) => item.includes(f.value)) ?? facts.find((f) => f.claim && item.includes(f.claim));
      if (!hit) {
        notes.push(`"${item}"은(는) 팩트 그래프에 없는 사실이라 넣지 않았습니다.`);
        continue;
      }
      const line = `${hit.claim}: ${hit.value}`;
      if (!out.includes(line)) out.push(line);
    }
    return out;
  };
  const guardSentence = (sentence: string): boolean => {
    const nums = sentence.match(/\d+(?:[.,]\d+)?/g) ?? [];
    for (const n of nums) {
      const fromFact = facts.find((f) => f.value.includes(n));
      if (fromFact) {
        if (!sentence.includes(fromFact.value)) {
          notes.push(`"${sentence}" — 사실 "${fromFact.claim}: ${fromFact.value}"의 값을 그대로 담지 않아 뺐습니다(요약·격상 방지).`);
          return false;
        }
        continue;
      }
      if (questionBlob.includes(n)) continue;
      notes.push(`"${sentence}" — 숫자 ${n}의 출처가 팩트 그래프에 없어 뺐습니다.`);
      return false;
    }
    return true;
  };
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
