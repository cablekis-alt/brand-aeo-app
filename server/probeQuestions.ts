import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isProbe } from '../src/lib/questionScope.js';
import type { QuestionSpec } from '../src/prompts/types.js';
import { cohortRankingEntities } from './cohortEntities.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import type { TenantConfig } from './types.js';

/**
 * 실증 질문 만들기(scripts/add-probe-questions.ts)의 규칙 — 스크립트에서 떼어 검사할 수 있게 둔다(scripts/verify-probe-questions.ts).
 *
 * 실증 질문은 같은 질문지 판에 probe: true로 **덧붙이기만** 한다. 기존 문항은 한 글자도 바꾸지 않아 점수 모집단 · 「같은 조건」이
 * 그대로다(src/lib/questionScope.ts). 그래서 여기서 지키는 것은 셋이다. 이름이 든 질문은 넣지 않는다(이름 없는 질문이어야 「이름을
 * 대지 않아도 나오는가」를 본다). 질문지 · 코호트 공통 질문지에 이미 있는 문장은 넣지 않는다(같은 질문을 두 번 재면 실증과 점수
 * 질문이 섞인다). id는 판 접두를 그대로 둔 `${version}-p001` 꼴이다 — 판 접두 추정(resolveBankVersion)이 그대로 맞고, 일반 번호
 * 정규식 /-(\d+)$/에 걸리지 않으며 추가 글 id 규칙('+' 없음)도 지킨다.
 *
 * 파일 쓰기(writeProbeBank)만 디스크를 만진다. 나머지는 입력만 보고 답한다.
 */

export type ProbeStage = NonNullable<QuestionSpec['stage']>;
/** 추천형(후보를 고르게 하는 질문)인가, 기준 · 시세 · 절차를 묻는 질문인가. */
export type ProbeKind = 'recommend' | 'info';

/** 판정 엔진이 낸 실증 질문 후보. id는 쓸 때 코드가 매긴다. */
export interface ProbeCandidate {
  text: string;
  stage: ProbeStage;
  topic?: string;
  /** 새로 만든 후보에만 있다 — 바꿔 쓴 후보는 원래 질문의 단계 · 주제를 따른다. */
  kind?: ProbeKind;
  /** 바꿔 쓴 후보(홀드아웃)의 원래 실증 질문 id. */
  paraphraseOf?: string;
}

export interface ProbeRejection {
  text: string;
  reason: string;
}

export const DEFAULT_PROBE_COUNT = 16;
export const DEFAULT_RECOMMEND_MIN = 10;

const STAGES: readonly ProbeStage[] = ['learn', 'consider', 'decide'];
const KINDS: readonly ProbeKind[] = ['recommend', 'info'];

/** 겹침을 볼 때의 문장 열쇠 — 띄어쓰기 · 대소문자만 다른 문장은 같은 문장이다. */
export function textKey(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

/**
 * 질문에 넣으면 안 되는 이름 — 브랜드 · 별칭 · 경쟁사 · 경쟁사 별칭 · 코호트 순위 판정 목록(같은 코호트 구성원과 그들의 경쟁사).
 * 코호트 순위 이름까지 넣는 까닭: 코호트의 다른 브랜드 이름이 든 질문은 그 브랜드를 부르는 질문이라, 우리 글의 효과를 볼 수 없다.
 */
export function bannedNames(tenant: TenantConfig, runtime: TenantConfig[]): string[] {
  const names = new Set<string>();
  const add = (name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed) names.add(trimmed);
  };
  add(tenant.brandName);
  for (const alias of tenant.aliases ?? []) add(alias);
  for (const c of tenant.competitors ?? []) {
    add(c.name);
    for (const alias of c.aliases ?? []) add(alias);
  }
  for (const name of cohortRankingEntities(tenant, runtime)) add(name);
  return [...names].sort((a, b) => a.localeCompare(b, 'ko'));
}

/**
 * 본문에 든 금지 이름(첫 하나). 띄어쓰기 · 대소문자를 무시한다. 한 글자 이름은 보지 않는다 — 흔한 낱말에 걸린다
 * (scripts/add-learn-questions.ts와 같은 기준).
 */
export function nameIn(text: string, names: string[]): string | null {
  const key = textKey(text);
  for (const name of names) {
    const nameKey = textKey(name);
    if (nameKey.length > 1 && key.includes(nameKey)) return name;
  }
  return null;
}

/** 다음 실증 질문 id n개 — 그 판의 `${version}-pNNN` 가운데 가장 큰 번호 다음부터. 다른 판 접두 · 일반 번호는 보지 않는다. */
export function nextProbeIds(bank: { version: string; questions: { questionId: string }[] }, n: number): string[] {
  const prefix = `${bank.version}-p`;
  const max = bank.questions.reduce((m, q) => {
    if (!q.questionId.startsWith(prefix)) return m;
    const digits = /^(\d+)$/.exec(q.questionId.slice(prefix.length));
    return digits ? Math.max(m, Number(digits[1])) : m;
  }, 0);
  return Array.from({ length: Math.max(0, n) }, (_, i) => `${prefix}${String(max + i + 1).padStart(3, '0')}`);
}

/** 추천형으로 세는 후보 — kind recommend이고 단계가 비교(consider)다. 바꿔 쓴 후보는 kind가 없어 세지 않는다. */
export function isRecommendCandidate(c: Pick<ProbeCandidate, 'kind' | 'stage'>): boolean {
  return c.kind === 'recommend' && c.stage === 'consider';
}

export function recommendQuotaMet(candidates: Pick<ProbeCandidate, 'kind' | 'stage'>[], min: number): boolean {
  return candidates.filter(isRecommendCandidate).length >= min;
}

const describe = (row: unknown): string =>
  row && typeof row === 'object' && typeof (row as { text?: unknown }).text === 'string'
    ? ((row as { text: string }).text.trim() || '(빈 문장)')
    : JSON.stringify(row) ?? String(row);

/**
 * 판정 엔진 응답(JSON 배열)을 후보로 읽는다. 형식이 틀린 줄은 이유와 함께 거른다.
 *
 * sources가 있으면 바꿔 쓰기 응답이다 — 줄마다 paraphraseOf · text만 읽고, 단계 · 주제는 원래 질문에서 옮긴다. 같은 원래 질문을
 * 두 번 바꿔 쓴 줄은 첫 줄만 남긴다(원래 질문 하나에 홀드아웃 하나).
 */
export function parseProbeRows(
  rows: unknown,
  sources?: QuestionSpec[],
): { candidates: ProbeCandidate[]; rejected: ProbeRejection[] } {
  const candidates: ProbeCandidate[] = [];
  const rejected: ProbeRejection[] = [];
  if (!Array.isArray(rows)) {
    return { candidates, rejected: [{ text: '(응답 전체)', reason: '형식 오류: JSON 배열이 아님' }] };
  }
  const bySource = new Map((sources ?? []).map((q) => [q.questionId, q]));
  const used = new Set<string>();
  for (const row of rows) {
    const r = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) {
      rejected.push({ text: describe(row), reason: '형식 오류: text 없음' });
      continue;
    }
    if (sources) {
      const sourceId = typeof r.paraphraseOf === 'string' ? r.paraphraseOf.trim() : '';
      const source = bySource.get(sourceId);
      if (!source) {
        rejected.push({ text, reason: `형식 오류: 다시 쓸 질문 목록에 없는 paraphraseOf(${sourceId || '없음'})` });
        continue;
      }
      if (!source.stage) {
        rejected.push({ text, reason: `원래 질문(${sourceId})에 단계가 없음` });
        continue;
      }
      if (used.has(sourceId)) {
        rejected.push({ text, reason: `같은 원래 질문(${sourceId})을 두 번 바꿔 씀` });
        continue;
      }
      used.add(sourceId);
      candidates.push({ text, stage: source.stage, ...(source.topic ? { topic: source.topic } : {}), paraphraseOf: sourceId });
      continue;
    }
    const stage = STAGES.find((s) => s === r.stage);
    const kind = KINDS.find((k) => k === r.kind);
    if (!stage) {
      rejected.push({ text, reason: `형식 오류: stage(${String(r.stage)})` });
      continue;
    }
    if (!kind) {
      rejected.push({ text, reason: `형식 오류: kind(${String(r.kind)})` });
      continue;
    }
    const topic = typeof r.topic === 'string' ? r.topic.trim() : '';
    candidates.push({ text, stage, ...(topic ? { topic } : {}), kind });
  }
  return { candidates, rejected };
}

export interface CandidateFilterContext {
  /** bannedNames의 결과. */
  banned: string[];
  /** 브랜드 질문지의 문장 전부(실증 포함). */
  existingTexts: string[];
  /** 코호트 공통 질문지의 문장(없으면 빈 목록). */
  cohortTexts: string[];
  /** 브랜드 질문지의 실증 질문 id — 바꿔 쓴 후보의 원래 질문은 여기 있어야 한다. */
  probeIds: Set<string>;
  /** 이미 바꿔 쓴 실증(홀드아웃)이 있는 원래 질문 id — 하나에 홀드아웃 하나만 둔다. */
  paraphrased: Set<string>;
}

/** 질문지에서 이미 홀드아웃이 있는 원래 실증 질문 id. */
export function paraphrasedIds(questions: QuestionSpec[]): Set<string> {
  return new Set(questions.filter(isProbe).flatMap((q) => (q.paraphraseOf ? [q.paraphraseOf] : [])));
}

/**
 * 후보를 거른다 — 이름이 든 문장, 질문지 · 코호트 공통 질문지에 이미 있는 문장(띄어쓰기만 다른 것 포함), 후보끼리 같은 문장,
 * 질문지의 실증 질문이 아닌 것이나 이미 홀드아웃이 있는 실증을 바꿔 쓴 후보. 남은 후보의 순서는 그대로다.
 */
export function filterCandidates(
  candidates: ProbeCandidate[],
  ctx: CandidateFilterContext,
): { accepted: ProbeCandidate[]; rejected: ProbeRejection[] } {
  const bank = new Set(ctx.existingTexts.map(textKey));
  const cohort = new Set(ctx.cohortTexts.map(textKey));
  const seen = new Set<string>();
  const accepted: ProbeCandidate[] = [];
  const rejected: ProbeRejection[] = [];
  for (const c of candidates) {
    const key = textKey(c.text);
    const name = nameIn(c.text, ctx.banned);
    const reason = !key
      ? '빈 문장'
      : name
        ? `이름 포함: ${name}`
        : bank.has(key)
          ? '질문지에 같은 문장이 있음'
          : cohort.has(key)
            ? '코호트 공통 질문지에 같은 문장이 있음'
            : seen.has(key)
              ? '후보끼리 같은 문장'
              : c.paraphraseOf !== undefined && !ctx.probeIds.has(c.paraphraseOf)
                ? `질문지의 실증 질문이 아닌 것을 바꿔 씀: ${c.paraphraseOf}`
                : c.paraphraseOf !== undefined && ctx.paraphrased.has(c.paraphraseOf)
                  ? `이미 바꿔 쓴 실증이 있는 질문: ${c.paraphraseOf}`
                  : null;
    if (reason) {
      rejected.push({ text: c.text, reason });
      continue;
    }
    seen.add(key);
    accepted.push(c);
  }
  return { accepted, rejected };
}

/** 후보를 질문지 문항으로 — 이름 없는 질문 · 실증 표시. 코호트 공통 문항이 아니다(cohortShared 없음). */
export function toProbeSpec(
  candidate: ProbeCandidate,
  questionId: string,
  ctx: { industry: string; region: string; version: string },
): QuestionSpec {
  return {
    questionId,
    text: candidate.text,
    category: 'category-agnostic',
    stage: candidate.stage,
    ...(candidate.topic ? { topic: candidate.topic } : {}),
    industry: ctx.industry,
    region: ctx.region,
    containsBrandName: false,
    version: ctx.version,
    probe: true,
    ...(candidate.paraphraseOf ? { paraphraseOf: candidate.paraphraseOf } : {}),
  };
}

/** 이 셸의 AppData 가상화 사본처럼 보이는 경로인가(Packages\Claude_…\LocalCache). 그 사본을 고치면 실제 앱 데이터는 그대로다. */
export function looksVirtualized(p: string): boolean {
  return /packages[\\/]claude_/i.test(p);
}

/** 실증을 덧붙일 질문지 경로가 맞는지 — 그 브랜드의 question-bank 폴더 안이어야 하고, 코호트 공통 질문지 · 가상화 사본은 안 된다. */
export function bankPathProblem(bankPath: string, dataDir: string, tenantId: string): string | null {
  const resolved = path.resolve(bankPath);
  const expectedDir = path.resolve(dataDir, tenantId, 'question-bank');
  if (resolved.split(/[\\/]/).some((seg) => seg.toLowerCase() === 'cohort-banks')) {
    return `코호트 공통 질문지(cohort-banks)에는 쓰지 않습니다: ${resolved}`;
  }
  if (path.dirname(resolved) !== expectedDir) return `브랜드 질문지 폴더(${expectedDir}) 밖의 파일입니다: ${resolved}`;
  if (looksVirtualized(resolved)) return `이 셸의 가상화 사본 경로로 보입니다: ${resolved}`;
  return null;
}

/** dry-run이 남기고 --write가 읽는 후보 파일. 사람이 candidates에서 뺄 후보를 지운 뒤 쓴다. */
export interface ProbeCandidatesFile {
  /** 다른 JSON을 --from으로 잘못 주면 멈추게 하는 표시. */
  format: 'probe-candidates/1';
  tenantId: string;
  bankVersion: string;
  /** 후보를 만들 때 읽은 질문지(절대 경로)와 문항 수 — 쓸 때 문항 수가 다르면 멈춘다. */
  bankPath: string;
  bankQuestionCount: number;
  mode: 'new' | 'paraphrase';
  generatedAt: string;
  judgeEngine: string;
  judgeModel?: string;
  recommendMin: number;
  /** 검토한 뒤 남긴 후보 — --write는 이것만 덧붙인다. */
  candidates: ProbeCandidate[];
  /** 거른 후보와 이유 — 검토용이다. 쓰지 않는다. */
  rejected: ProbeRejection[];
}

/** 후보 파일을 읽는다. 형식이 틀리면 이유를 돌려준다. */
export function readCandidatesFile(raw: unknown): { ok: true; file: ProbeCandidatesFile } | { ok: false; error: string } {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProbeCandidatesFile>;
  if (f.format !== 'probe-candidates/1') return { ok: false, error: '실증 후보 파일이 아닙니다(format이 probe-candidates/1이 아님).' };
  if (typeof f.tenantId !== 'string' || typeof f.bankVersion !== 'string' || typeof f.bankQuestionCount !== 'number') {
    return { ok: false, error: 'tenantId · bankVersion · bankQuestionCount가 없습니다.' };
  }
  if (f.mode !== 'new' && f.mode !== 'paraphrase') return { ok: false, error: `mode가 new · paraphrase가 아닙니다: ${String(f.mode)}` };
  if (!Array.isArray(f.candidates)) return { ok: false, error: 'candidates가 배열이 아닙니다.' };
  for (const [i, c] of f.candidates.entries()) {
    const ok =
      c &&
      typeof c.text === 'string' &&
      STAGES.includes(c.stage) &&
      (c.topic === undefined || typeof c.topic === 'string') &&
      (c.kind === undefined || KINDS.includes(c.kind)) &&
      (c.paraphraseOf === undefined || typeof c.paraphraseOf === 'string');
    if (!ok) return { ok: false, error: `candidates[${i}] 형식이 틀렸습니다: ${JSON.stringify(c)}` };
    if ((f.mode === 'paraphrase') !== (c.paraphraseOf !== undefined)) {
      return { ok: false, error: `candidates[${i}]: ${f.mode === 'paraphrase' ? '바꿔 쓰기 파일인데 paraphraseOf가 없습니다' : '새 후보 파일인데 paraphraseOf가 있습니다'}.` };
    }
  }
  return { ok: true, file: f as ProbeCandidatesFile };
}

export interface ProbeWritePlanInput {
  file: ProbeCandidatesFile;
  tenantId: string;
  /** 설정이 지금 쓰는 판(tenant.questionBankVersion). */
  version: string;
  /** 지금 읽은 그 판의 질문지. */
  bank: { version: string; questions: QuestionSpec[] };
  industry: string;
  region: string;
  banned: string[];
  cohortTexts: string[];
  /** 사람이 기대하는 지금 문항 수(--expect-count). 없으면 후보 파일의 문항 수만 본다. */
  expectCount?: number;
}

/**
 * --write가 덧붙일 문항을 정한다. 후보를 만든 뒤 질문지가 바뀌었거나(문항 수 · 판), 다른 브랜드의 후보 파일이거나, 후보가 지금
 * 질문지 기준으로 걸리면(이름 · 중복) 아무것도 쓰지 않는다. 기존 문항은 그대로 두고 뒤에 덧붙인 배열을 돌려준다.
 */
export function planProbeWrite(
  input: ProbeWritePlanInput,
): { ok: true; added: QuestionSpec[]; questions: QuestionSpec[] } | { ok: false; errors: string[] } {
  const { file, bank } = input;
  const errors: string[] = [];
  if (file.tenantId !== input.tenantId) errors.push(`다른 브랜드의 후보 파일입니다: ${file.tenantId} (지금 ${input.tenantId})`);
  if (bank.version !== input.version) errors.push(`질문지 파일의 판(${bank.version})이 설정의 판(${input.version})과 다릅니다.`);
  if (file.bankVersion !== input.version) {
    errors.push(`후보를 만든 판(${file.bankVersion})과 지금 판(${input.version})이 다릅니다 — 판이 바뀌었으면 후보를 다시 만드세요.`);
  }
  if (bank.questions.length !== file.bankQuestionCount) {
    errors.push(`지금 문항 수(${bank.questions.length})가 후보를 만들 때(${file.bankQuestionCount})와 다릅니다 — 다른 폴더를 보고 있거나 그 사이 질문지가 바뀌었습니다.`);
  }
  if (input.expectCount !== undefined && bank.questions.length !== input.expectCount) {
    errors.push(`지금 문항 수(${bank.questions.length})가 기대한 수(--expect-count ${input.expectCount})와 다릅니다.`);
  }
  if (file.candidates.length === 0) errors.push('덧붙일 후보가 없습니다.');
  const { rejected } = filterCandidates(file.candidates, {
    banned: input.banned,
    existingTexts: bank.questions.map((q) => q.text),
    cohortTexts: input.cohortTexts,
    probeIds: new Set(bank.questions.filter(isProbe).map((q) => q.questionId)),
    paraphrased: paraphrasedIds(bank.questions),
  });
  for (const r of rejected) errors.push(`후보가 걸립니다(${r.reason}): ${r.text}`);
  if (errors.length > 0) return { ok: false, errors };

  const ids = nextProbeIds(bank, file.candidates.length);
  const ctx = { industry: input.industry, region: input.region, version: input.version };
  const added = file.candidates.map((c, i) => toProbeSpec(c, ids[i]!, ctx));
  return { ok: true, added, questions: [...bank.questions, ...added] };
}

/** 백업 폴더 이름 — 다른 편집의 백업(before-profile-… · before-owned-domains-…)과 같은 꼴. */
export function backupDirName(now: Date): string {
  return `before-probe-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * 파일 쓰기 — 질문지와 오버레이를 <tenantDir>/before-probe-<시각>/에 복사한 뒤, 질문지를 원자적으로 바꿔 쓴다.
 * 계획을 세울 때 읽은 원문(before)과 지금 파일이 다르면 아무것도 쓰지 않고 던진다(그 사이 앱 · 다른 실행이 고쳤다).
 * 오버레이는 고치지 않는다(questionBankSize 그대로) — 되돌릴 때 함께 볼 수 있게 남길 뿐이다.
 */
export async function writeProbeBank(input: {
  bankPath: string;
  overlayPath: string;
  tenantDir: string;
  /** 계획을 세울 때 읽은 질문지 원문. */
  before: string;
  /** 덧붙인 질문지(문항 외 필드는 그대로). */
  next: { version: string; questions: QuestionSpec[] };
  now: Date;
}): Promise<{ backupDir: string; copied: string[] }> {
  const current = await readFile(input.bankPath, 'utf-8');
  if (current !== input.before) throw new Error(`질문지가 그 사이 바뀌었습니다 — 다시 실행하세요: ${input.bankPath}`);
  const backupDir = path.join(input.tenantDir, backupDirName(input.now));
  await mkdir(backupDir, { recursive: true });
  const copied: string[] = [];
  const bankCopy = path.join(backupDir, path.basename(input.bankPath));
  await copyFile(input.bankPath, bankCopy);
  copied.push(bankCopy);
  const overlayExists = await access(input.overlayPath).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );
  if (overlayExists) {
    const overlayCopy = path.join(backupDir, path.basename(input.overlayPath));
    await copyFile(input.overlayPath, overlayCopy);
    copied.push(overlayCopy);
  }
  await writeJsonAtomic(input.bankPath, input.next);
  return { backupDir, copied };
}
