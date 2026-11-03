import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isExtraArticleId, type ExtraArticleRules } from '../src/lib/extraArticles.js';
import { todayKst } from '../src/lib/publishedUrl.js';
import { isActive, parseWriterPlan, topicGuard, writerArticle, writerExtraRules, type WriterPlan } from '../src/lib/probePlan.js';

/**
 * 작성자 배정 — data/<tenant>/probe-plan.json(src/lib/probePlan.ts 주석). scripts/writer-plan.ts만 쓰고 앱은 요청마다 읽기만 한다 —
 * 그래서 쓰기 줄(tenantWriteQueue.ts)에 서지 않고, 파일을 바꿔도 앱을 껐다 켤 필요가 없다.
 *
 * 파일이 없으면 plan null(지금과 같다). 있는데 JSON이 깨졌거나, 검사(parseWriterPlan)를 통과하지 못하거나(실증 때의 probe-plan/1 포함),
 * 다른 브랜드의 배정이면 로그를 남기고 corrupt — 잠금이 조용히 풀리지 않게 글 만들기를 막는다(fail closed).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「배정 없음」으로 읽는다.
 */
export const PROBE_PLAN_FILE = 'probe-plan.json';

export interface ProbePlanState {
  plan: WriterPlan | null;
  /** 파일이 있는데 읽지 못했다 — plan은 null이고 글 만들기는 거절한다. */
  corrupt: boolean;
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, PROBE_PLAN_FILE);
}

/** 배정 파일을 읽는다. 없으면 plan null. 읽기 자체가 실패(권한 등)하면 throw — 라우트는 500, 글 만들기는 막힌다. */
export async function readProbePlan(tenantId: string): Promise<ProbePlanState> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { plan: null, corrupt: false };
    throw err;
  }
  try {
    const parsed = parseWriterPlan(JSON.parse(text) as unknown);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    if (parsed.plan.tenantId !== tenantId) throw new Error(`다른 브랜드(${parsed.plan.tenantId})의 배정입니다`);
    return { plan: parsed.plan, corrupt: false };
  } catch (err) {
    console.error(`[probePlan] ${tenantId} probe-plan.json을 읽지 못했습니다 — 작성자 배정 글 만들기를 막습니다:`, err);
    return { plan: null, corrupt: true };
  }
}

/**
 * 이 글(topicId)을 만들거나 되살리거나 브리프 · 초안을 써도 되는지 — 되면 null, 아니면 이유(라우트는 400). POST /api/content-brief ·
 * content-draft가 부른다. bankVersion은 그 글의 질문 id가 뜻하는 판 — 브리프 · 초안 요청에 판이 없으면 배정 판으로 본다(질문 은행
 * 입구는 지금 판의 질문이다). 'topic:'이 아닌 글이면 파일을 읽지 않는다.
 */
export async function checkProbeTopic(
  tenantId: string,
  topicId: string,
  bankVersion: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!isExtraArticleId(topicId)) return null;
  const { plan, corrupt } = await readProbePlan(tenantId);
  return topicGuard(plan, corrupt, bankVersion ?? plan?.bankVersion, topicId, todayKst(now));
}

/** POST /api/content-brief · content-draft가 부른다 — 요청의 bankVersion은 비지 않은 글자일 때만 쓰고, 아니면 배정 판으로 본다. */
export function checkProbeAction(tenantId: string, actionId: string, requestBankVersion: unknown, now = Date.now()): Promise<string | null> {
  const bankVersion = typeof requestBankVersion === 'string' && requestBankVersion.trim() ? requestBankVersion.trim() : undefined;
  return checkProbeTopic(tenantId, actionId, bankVersion, now);
}

/**
 * 사진 자동 채우기 저장(server/contentDraft.ts saveAutoPhotoPicks)의 작성자 상한 — 운영 기간 안의 배정 글이면 그 작성자 key, 아니면
 * undefined. 화면(GapActions WriterRuns)이 미리보기를 고를 때와 같은 기준이다. 배정 파일이 없거나 깨졌으면 작성자 상한 없이 글 ·
 * 브랜드 상한만. 읽기 자체가 실패하면 throw.
 */
export async function writerGroupOf(tenantId: string, now = Date.now()): Promise<(actionId: string) => string | undefined> {
  const { plan } = await readProbePlan(tenantId);
  const active = isActive(plan, todayKst(now)) ? plan : null;
  return (actionId) => writerArticle(active, actionId)?.writer.key;
}

export interface ExtraArticleGate {
  /** 운영 기간의 편수 · 겹침 규칙(writerExtraRules) — 배정이 없거나 깨졌거나 기간이 지났으면 undefined(지금 규칙 그대로). */
  rules: ExtraArticleRules | undefined;
  /** 이 글을 만들거나 되살려도 되는지 — 되면 null, 아니면 이유(topicGuard). 판은 그 글의 판(만들 때 고정한 값)이다. */
  refuse: (article: { id: string; bankVersion: string }) => string | null;
}

/**
 * 추가 글 저장소(server/extraArticles.ts)가 새로 만들기 · 되살리기 전에 부른다 — 배정 파일을 한 번 읽어 규칙과 잠금을 함께 준다. 읽기
 * 자체가 실패하면 throw(500, 쓰지 않는다).
 */
export async function extraArticleGate(tenantId: string, now = Date.now()): Promise<ExtraArticleGate> {
  const { plan, corrupt } = await readProbePlan(tenantId);
  const today = todayKst(now);
  return {
    rules: writerExtraRules(plan, corrupt, today),
    refuse: (article) => topicGuard(plan, corrupt, article.bankVersion, article.id, today),
  };
}
