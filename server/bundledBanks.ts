import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_BANK_DIR } from './appPaths.js';
import type { QuestionBank } from './store.js';

/**
 * 설치본에 동봉한 브랜드 질문지(v0.4.49 브랜드 통일) — src/data/question-banks/<tenantId>/<판>.json.
 *
 * 왜 필요한가. 저장소 설정(server/tenants.config.json)의 판을 올리면 PC마다 그 판 파일이 없어 측정이 질문지를 AI로 새로 만든다 —
 * 같은 「v6」인데 PC마다 브랜드 질문이 다르고, 실증에서 올린 질문(promote-probe-questions)은 사라진다. 그래서 운영 PC의 질문지를
 * 저장소에 담고(scripts/promote-probe-questions.ts --bundle-out), 측정이 그 판을 처음 읽을 때 userData로 가져온다
 * (store.ts getQuestionBank). 이미 있는 파일은 덮지 않는다 — 내용이 다르면 측정을 멈춘다(pipeline.ts assertBundledBank).
 *
 * 경쟁사(cohortOnly) 질문지는 담지 않는다. 웹(Vercel)은 BUNDLED_BANK_DIR이 null이라 아무것도 하지 않는다.
 */

/** 경로 한 마디로 쓸 수 있는 이름인가 — 폴더를 벗어나거나(.. · 구분자) 숨은 이름이면 아니다. */
const safeSegment = (name: string) => /^[^\\/]+$/.test(name) && !name.startsWith('.');

/** 그 브랜드의 동봉 폴더. 동봉 폴더가 없으면(웹) · 이름이 경로를 벗어나면 null. */
function bundledTenantDir(tenantId: string): string | null {
  return BUNDLED_BANK_DIR && safeSegment(tenantId) ? path.join(BUNDLED_BANK_DIR, tenantId) : null;
}

/** 동봉본을 읽는다. 없으면 null. 깨진 동봉본은 던진다 — 조용히 넘어가면 측정이 질문지를 새로 만든다. */
export async function readBundledBank(tenantId: string, version: string): Promise<QuestionBank | null> {
  const dir = bundledTenantDir(tenantId);
  if (!dir || !safeSegment(version)) return null;
  const file = path.join(dir, `${version}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as QuestionBank;
  } catch (err) {
    throw new Error(`동봉한 질문지를 읽지 못했습니다: ${file} — ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** 그 브랜드의 동봉한 판 이름들. 동봉하지 않으면 빈 배열. */
export async function listBundledVersions(tenantId: string): Promise<string[]> {
  const dir = bundledTenantDir(tenantId);
  if (!dir) return [];
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

/** 이 브랜드의 질문지를 설치본에 담아 배포하는가(동봉 폴더에 그 브랜드의 판 파일이 하나라도 있다). */
export async function hasBundledBanks(tenantId: string): Promise<boolean> {
  return (await listBundledVersions(tenantId)).length > 0;
}

/**
 * 두 질문지의 질문이 다른가 — 순서대로 질문 id · 문장을 견준다(판 이름 · 만든 시각 · 다른 필드는 보지 않는다). 같으면 null, 다르면
 * 처음 다른 곳을 사람이 읽을 문장으로.
 */
export function bankQuestionsDiffer(local: QuestionBank, bundled: QuestionBank): string | null {
  const a = local.questions ?? [];
  const b = bundled.questions ?? [];
  if (a.length !== b.length) return `문항 ${a.length}개 · 동봉본 ${b.length}개`;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.questionId !== b[i]!.questionId) return `${i + 1}번째 질문 id ${a[i]!.questionId} · 동봉본 ${b[i]!.questionId}`;
    if (a[i]!.text !== b[i]!.text) return `${a[i]!.questionId} 문장이 다릅니다`;
  }
  return null;
}

/**
 * 같은 판 이름으로 문항을 덧붙이는 운영 스크립트(scripts/add-learn-questions.ts · add-probe-questions.ts)가 쓰기 전에 부른다. 그 판을
 * 동봉하면 막을 이유를, 아니면 null을 돌려준다. 동봉한 판에 덧붙이면 그 PC 질문지가 동봉본과 달라져 그 판의 측정이 매번 멈추고
 * (pipeline.ts assertBundledBank), 그 PC 파일을 동봉본에 맞춰 다시 담으면 이미 가져간 다른 PC가 멈춘다 — 같은 판은 모든 PC에서 같은 질문이다.
 */
export async function bundledAppendBlocker(tenantId: string, version: string): Promise<string | null> {
  if (!(await readBundledBank(tenantId, version))) return null;
  return (
    `${tenantId} 질문 은행 ${version}은 설치본에 담아 배포하는 질문지입니다 — 같은 판에 문항을 덧붙이면 이 PC 질문지가 설치본의 것과 ` +
    '달라져 그 판의 측정이 멈춥니다. 문항을 늘리려면 새 판으로 만들어 저장소 설정(server/tenants.config.json)의 판과 동봉본' +
    '(src/data/question-banks)을 함께 올리는 릴리스로 내세요. 아무것도 쓰지 않았습니다.'
  );
}
