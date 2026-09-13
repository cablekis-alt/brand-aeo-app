import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildContentDraftPrompt,
  type ContentDraft,
  type ContentDraftRequest,
  type DraftBlock,
  type DraftSection,
} from '../src/prompts/b9c-content-draft.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import type { EngineClient } from './engines/types.js';
import { createFactGuard } from './factGuard.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 초안은 브리프와 같은 방식으로 테넌트 파일 하나(drafts.json)에 actionId별로 저장한다.
 * 실행 항목 id가 주차에 묶이지 않으므로 다음 주에도 같은 초안을 다시 쓴다.
 */
export interface StoredDraft {
  actionId: string;
  generatedAt: string;
  draft: ContentDraft;
  /**
   * 사람이 고친 마크다운. 있으면 화면·내보내기가 이것을 쓴다.
   *
   * 구조화된 draft는 그대로 둔다 — 되돌릴 수 있어야 하고, 다시 만들기를 누르면 새 draft가
   * 오면서 이 필드가 지워진다(화면이 먼저 경고한다).
   */
  editedMarkdown?: string;
  editedAt?: string;
  /**
   * 고친 글에 대한 사실 가드 경고. **막지 않는다** — 사람이 확인한 사실일 수 있다.
   * 다만 출처 없는 숫자가 들어왔다는 사실은 알려야 한다. 우리가 판정 엔진에 요구하는 기준을
   * 사람에게만 면제하면 그 기준이 무의미해진다.
   */
  editWarnings?: string[];
}
type DraftMap = Record<string, StoredDraft>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'drafts.json');
}

export async function readDrafts(tenantId: string): Promise<DraftMap> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as DraftMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDrafts(tenantId: string, map: DraftMap): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await rename(tmp, target);
}

/** 문장 단위로 자른다. 가드는 문장 하나씩 보고, 걸린 문장만 버린다(문단 통째로 버리지 않는다). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。]|다\.|요\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 판정이 쓴 초안을 사실 가드에 통과시킨다. 브리프와 **같은 모듈**을 쓴다.
 *
 * 문단에서 가드에 걸린 문장만 빼고, 남는 문장이 없으면 그 문단을 gap으로 바꾼다 —
 * 문단을 조용히 없애면 글이 왜 짧아졌는지 알 수 없다. gap이면 화면이 "여기를 채우면 완성"으로
 * 보여 주고, guardNotes에 이유가 남는다.
 */
function normalize(
  raw: unknown,
  facts: ContentDraftRequest['factGraph'],
  questionTexts: string[],
): ContentDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { canonicalFacts, guardSentence, notes } = createFactGuard(facts, questionTexts);

  // 팩트 그래프의 **항목 이름**이 문장에 그대로 박힌 경우를 찾는다.
  //
  // 값을 글자 그대로 쓰라는 규칙을 판정이 과하게 적용해 "마취과 전담 원장 수: 3명이 상주하며"처럼
  // 쓴다(실측). 문장을 버리지는 않는다 — 내용은 맞고 어투만 어색하며, 여기서 이름을 기계적으로
  // 지우면 "3명이 상주하며"가 되어 뜻을 잃는다. 대신 기록에 남겨 사람이 다듬을 곳을 알려 준다.
  const noteLabelLeak = (sentence: string): void => {
    for (const f of facts) {
      if (!f.claim) continue;
      if (sentence.includes(`${f.claim}: ${f.value}`) || sentence.includes(`${f.claim}:${f.value}`)) {
        notes.push(`"${sentence.slice(0, 60)}…" — 사실 항목 이름 "${f.claim}"이 문장에 그대로 들어갔습니다. 우리말로 풀어 쓰세요.`);
      }
    }
  };

  const cleanBlocks = (input: unknown): DraftBlock[] => {
    if (!Array.isArray(input)) return [];
    const out: DraftBlock[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (o.kind === 'gap') {
        const need = String(o.need ?? '').trim();
        if (need) out.push({ kind: 'gap', need });
        continue;
      }
      const body = String(o.body ?? '').trim();
      if (!body) continue;
      const kept = splitSentences(body).filter(guardSentence);
      for (const s of kept) noteLabelLeak(s);
      if (kept.length === 0) {
        out.push({ kind: 'gap', need: '이 문단의 문장이 모두 사실 확인에 걸렸습니다 — 아래 검증 기록 참고' });
        continue;
      }
      out.push({ kind: 'text', body: kept.join(' ') });
    }
    return out;
  };

  const sections: DraftSection[] = Array.isArray(r.sections)
    ? (r.sections as unknown[])
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x) => ({
          heading: String(x.heading ?? '').trim(),
          answers: String(x.answers ?? '').trim(),
          blocks: cleanBlocks(x.blocks),
        }))
        .filter((s) => s.heading)
    : [];

  const leadRaw = typeof r.lead === 'string' ? r.lead.trim() : '';
  const lead = splitSentences(leadRaw).filter(guardSentence).join(' ');

  // 초안이 실제로 쓴 사실 — 본문에 값이 그대로 들어간 것만 센다(정본 형태로).
  const blob = [lead, ...sections.flatMap((s) => s.blocks.map((b) => b.body ?? ''))].join('\n');
  const usedFacts = canonicalFacts(facts.filter((f) => blob.includes(f.value)).map((f) => `${f.claim}: ${f.value}`));

  const gapCount = sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'gap').length, 0);

  return {
    title: typeof r.title === 'string' ? r.title.trim() : '',
    lead,
    sections,
    gapCount,
    usedFacts,
    ...(notes.length ? { guardNotes: notes } : {}),
  };
}

export async function generateDraft(
  tenantId: string,
  actionId: string,
  req: ContentDraftRequest,
  judge: EngineClient,
): Promise<StoredDraft> {
  const result = await judge.call(buildContentDraftPrompt(req));
  const draft = normalize(parseJsonLoose<unknown>(result.text), req.factGraph, req.questionTexts);
  if (!draft) throw new Error('초안 응답을 해석할 수 없습니다(JSON 아님). 다시 시도하세요.');
  if (draft.sections.length === 0) throw new Error('초안에 본문 절이 없습니다. 브리프를 먼저 확인하세요.');
  const stored: StoredDraft = { actionId, generatedAt: new Date().toISOString(), draft };
  const map = await readDrafts(tenantId);
  map[actionId] = stored;
  await writeDrafts(tenantId, map);
  return stored;
}

/**
 * 사람이 고친 초안을 저장한다. 가드는 경고만 남기고 저장 자체는 막지 않는다.
 * 문장 단위로 보되 마크다운 표식(제목·목록·인용)은 검사 전에 걷어낸다.
 */
export async function saveEditedDraft(
  tenantId: string,
  actionId: string,
  markdown: string,
  facts: ContentDraftRequest['factGraph'],
  questionTexts: string[],
): Promise<StoredDraft> {
  const map = await readDrafts(tenantId);
  const current = map[actionId];
  if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');

  const { guardSentence, notes } = createFactGuard(facts, questionTexts, 'warn');
  for (const line of markdown.split(/\r?\n/)) {
    const plain = line.replace(/^[#>\-*\s]+/, '').trim();
    if (!plain) continue;
    for (const sentence of splitSentences(plain)) guardSentence(sentence);
  }

  const stored: StoredDraft = {
    ...current,
    editedMarkdown: markdown,
    editedAt: new Date().toISOString(),
    ...(notes.length ? { editWarnings: notes } : {}),
  };
  if (!notes.length) delete stored.editWarnings;
  map[actionId] = stored;
  await writeDrafts(tenantId, map);
  return stored;
}
