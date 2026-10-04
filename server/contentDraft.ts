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
import { findOverclaims } from './claimGuard.js';
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
  /**
   * 빈칸을 화면에서 채운 기록 — 키는 `절 번호:블록 번호`(그 초안 안에서만 뜻이 있다).
   *
   * 예전에는 값을 넣으면 사실로 저장하고 **초안을 통째로 다시 썼다**(판정 1~2회, 1~2분). 빈칸은
   * 문단 하나를 비운 자리라 값만으로는 문장이 되지 않아서였다. 이제는 그 자리에 「항목: 값」
   * 한 줄을 넣고 다시 쓰지 않는다(src/lib/draftGaps.ts가 내보내기에 반영). 다시 만들기로 새 초안이
   * 오면 이 기록은 버린다 — 넣은 값은 이미 브랜드 사실에 있어 새 초안이 처음부터 쓴다.
   */
  gapFills?: Record<string, GapFill>;
}

/** 빈칸 하나의 처리 — 확인한 값, 뺌, 또는 페이지에서 찾아 둔 후보(아직 확인 전). */
export interface GapFill {
  value?: string;
  omit?: boolean;
  suggested?: string;
  sourceUrl?: string;
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
export function splitSentences(text: string): string[] {
  // 마침표 뒤가 숫자면 문장 끝이 아니다 — 사이트 원문 그대로인 전화번호 "+82. 2. 522. 6636"이
  // 조각으로 잘려 조각마다 사실 가드에 걸렸다.
  // 칭호·약어(Dr. Mr. St. …) 뒤의 마침표도 문장 끝이 아니다 — "Led by Dr. Choi Soon Woo, …"가
  // "Led by Dr."와 나머지로 잘려, 격상 가드가 뒤쪽만 빼자 "Led by Dr."라는 조각이 원고에 남았다
  // (실측: 뷰 영어 원고). "No."는 넣지 않는다 — 뒤에 숫자가 오면 위 규칙이 이미 막고, 숫자가
  // 아니면 대답 "No."일 수 있다.
  return text
    .split(/(?<=[.!?。]|다\.|요\.)(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Mt|vs)\.)\s+(?!\d)/)
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

/**
 * 격상 가드(claimGuard)에 걸린 문장을 초안에서 뺀다. 사실 가드와 같은 방식이다 — 문단이 비면 gap으로
 * 바꾸고, 쓴 사실 목록과 빈칸 수를 다시 센다.
 */
function dropOverclaims(draft: ContentDraft, overclaimed: Set<string>, facts: ContentDraftRequest['factGraph']): ContentDraft {
  const keep = (text: string) => splitSentences(text).filter((s) => !overclaimed.has(s)).join(' ');
  const sections = draft.sections.map((s) => ({
    ...s,
    blocks: s.blocks.map((b): DraftBlock => {
      if (b.kind !== 'text' || !b.body) return b;
      const body = keep(b.body);
      return body
        ? { kind: 'text', body }
        : { kind: 'gap', need: '이 문단의 문장이 사실보다 크게 말해 빠졌습니다 — 아래 검증 기록 참고' };
    }),
  }));
  const lead = keep(draft.lead);
  const blob = [lead, ...sections.flatMap((s) => s.blocks.map((b) => b.body ?? ''))].join('\n');
  const usedFacts = draft.usedFacts.filter((line) => {
    const fact = facts.find((f) => `${f.claim}: ${f.value}` === line);
    return fact ? blob.includes(fact.value) : true;
  });
  const gapCount = sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'gap').length, 0);
  return { ...draft, lead, sections, usedFacts, gapCount };
}

/** 초안의 문장 전부(첫머리 + 본문). 격상 가드에 넘긴다. */
function draftSentences(draft: ContentDraft): string[] {
  return [
    ...splitSentences(draft.lead),
    ...draft.sections.flatMap((s) =>
      s.blocks.flatMap((b) => (b.kind === 'text' && b.body ? splitSentences(b.body) : [])),
    ),
  ];
}

export async function generateDraft(
  tenantId: string,
  actionId: string,
  req: ContentDraftRequest,
  judge: EngineClient,
): Promise<StoredDraft> {
  const result = await judge.call(buildContentDraftPrompt(req));
  let draft = normalize(parseJsonLoose<unknown>(result.text), req.factGraph, req.questionTexts);
  if (!draft) throw new Error('초안 응답을 해석할 수 없습니다(JSON 아님). 다시 시도하세요.');
  if (draft.sections.length === 0) throw new Error('초안에 본문 절이 없습니다. 브리프를 먼저 확인하세요.');
  // 숫자 가드 다음에 격상 가드 — 숫자 없이 주체·범위가 커진 문장을 뺀다.
  const claims = await findOverclaims(draftSentences(draft), req.factGraph, judge, 'drop');
  if (claims.overclaimed.size) draft = dropOverclaims(draft, claims.overclaimed, req.factGraph);
  if (claims.notes.length) draft = { ...draft, guardNotes: [...(draft.guardNotes ?? []), ...claims.notes] };
  const stored: StoredDraft = { actionId, generatedAt: new Date().toISOString(), draft };
  const map = await readDrafts(tenantId);
  map[actionId] = stored;
  await writeDrafts(tenantId, map);
  return stored;
}

const GAP_KEY = /^\d{1,3}:\d{1,3}$/;
const MAX_FILL = 500;

/** 빈칸 기록을 저장한다. 판정 호출이 없다 — 값은 사람이 확인한 것이고, 화면이 브랜드 사실에도 넣는다. */
export async function saveGapFills(
  tenantId: string,
  actionId: string,
  fills: Record<string, unknown>,
): Promise<StoredDraft> {
  const map = await readDrafts(tenantId);
  const current = map[actionId];
  if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');
  const clean: Record<string, GapFill> = {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FILL) : undefined);
  for (const [key, raw] of Object.entries(fills)) {
    if (!GAP_KEY.test(key) || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const fill: GapFill = {};
    const value = text(r.value);
    const suggested = text(r.suggested);
    const sourceUrl = text(r.sourceUrl);
    if (r.omit === true) fill.omit = true;
    else if (value) fill.value = value;
    if (suggested) fill.suggested = suggested;
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) fill.sourceUrl = sourceUrl;
    if (Object.keys(fill).length) clean[key] = fill;
  }
  const stored: StoredDraft = { ...current, gapFills: clean };
  if (!Object.keys(clean).length) delete stored.gapFills;
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
  judge?: EngineClient,
): Promise<StoredDraft> {
  const map = await readDrafts(tenantId);
  const current = map[actionId];
  if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');

  const { guardSentence, notes } = createFactGuard(facts, questionTexts, 'warn');
  const sentences: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const plain = line.replace(/^[#>\-*\s]+/, '').trim();
    if (!plain) continue;
    for (const sentence of splitSentences(plain)) {
      guardSentence(sentence);
      sentences.push(sentence);
    }
  }
  // 사람이 쓴 글도 격상 검사를 받는다 — 경고만 남기고 막지 않는다(숫자 가드와 같은 원칙).
  if (judge) notes.push(...(await findOverclaims(sentences, facts, judge, 'warn')).notes);

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
