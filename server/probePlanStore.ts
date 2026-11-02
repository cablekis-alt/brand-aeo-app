import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { isExtraArticleId } from '../src/lib/extraArticles.js';
import { todayKst } from '../src/lib/publishedUrl.js';
import { parseProbePlan, topicGuard, type ProbePlan } from '../src/lib/probePlan.js';

/**
 * 실증 배정 — data/<tenant>/probe-plan.json(src/lib/probePlan.ts 주석). scripts/write-probe-plan.ts만 쓰고 앱은 요청마다 읽기만 한다 —
 * 그래서 쓰기 줄(tenantWriteQueue.ts)에 서지 않고, 파일을 바꿔도 앱을 껐다 켤 필요가 없다.
 *
 * 파일이 없으면 plan null(지금과 같다). 있는데 JSON이 깨졌거나, 검사(parseProbePlan)를 통과하지 못하거나, 다른 브랜드의 배정이면 로그를
 * 남기고 corrupt — 잠금이 조용히 풀리지 않게 글 만들기를 막는다(fail closed).
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「배정 없음」으로 읽는다.
 */
export const PROBE_PLAN_FILE = 'probe-plan.json';

export interface ProbePlanState {
  plan: ProbePlan | null;
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
    const parsed = parseProbePlan(JSON.parse(text) as unknown);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    if (parsed.plan.tenantId !== tenantId) throw new Error(`다른 브랜드(${parsed.plan.tenantId})의 배정입니다`);
    return { plan: parsed.plan, corrupt: false };
  } catch (err) {
    console.error(`[probePlan] ${tenantId} probe-plan.json을 읽지 못했습니다 — 실증 기간의 글 만들기를 막습니다:`, err);
    return { plan: null, corrupt: true };
  }
}

/**
 * 이 글(topicId)을 만들거나 되살리거나 브리프 · 초안을 써도 되는지 — 되면 null, 아니면 이유(라우트는 400). 추가 글 저장소와
 * POST /api/content-brief · content-draft가 함께 부른다. bankVersion은 그 글의 질문 id가 뜻하는 판 — 브리프 · 초안 요청에 판이
 * 없으면 배정 판으로 본다(질문 은행 입구는 지금 판의 질문이다). 'topic:'이 아닌 글이면 파일을 읽지 않는다.
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
