import { mapWithConcurrency } from './concurrency.js';
import { parseJsonLoose } from './jsonParse.js';
import { checkRewrite, type HandoffItem } from './questionHandoff.js';
import { buildCompetitorRewritePrompt } from '../src/prompts/b1d-competitor-rewrite.js';
import type { QuestionRewriteContext } from './competitorEditor.js';
import type { EngineClient } from './engines/types.js';

/**
 * 경쟁사 편집 4단계 — 넘겨받은 비교 질문을 판정 엔진으로 고쳐 쓴다(서랍의 미리보기). 저장은 여기서 만든 문장을 화면이 그대로
 * 보내고 서버가 같은 검사(checkRewrite)를 다시 한다 — 저장할 때는 판정 엔진을 부르지 않는다(미리 본 것 = 저장되는 것).
 *
 * 한 문항마다 최대 3번 시도한다(질문지 생성과 같다). 검사에 걸리면 직전 안과 이유를 알려 다시 쓰게 한다. 시간 초과 · 오류는
 * 다시 시도하지 않는다 — 화면이 기다리는 동안 같은 실패를 세 번 기다리게 하지 않는다.
 */

export interface RewriteDraftResult {
  fromId: string;
  toId: string;
  text: string;
  topic?: string;
  attempts: number;
}

export interface RewriteResult {
  key: string;
  drafts: RewriteDraftResult[];
  failed: { fromId: string; reasons: string[] }[];
  ms: number;
}

const MAX_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 90_000;
const CONCURRENCY = 4;
const CACHE_MAX = 20;

// 같은 계획(key)을 다시 열면 판정 엔진을 다시 부르지 않는다. 「다시 쓰기」(fresh)만 새로 쓴다.
const cache = new Map<string, Promise<RewriteResult>>();
const settled = new Map<string, RewriteResult>();

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value!);
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`판정 엔진이 ${ms / 1000}초 안에 답하지 않았어요`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rewriteOne(
  ctx: QuestionRewriteContext,
  item: HandoffItem,
  judge: EngineClient,
  avoidText: string | undefined,
): Promise<RewriteDraftResult | { fromId: string; reasons: string[] }> {
  const bankTexts = (ctx.bank?.questions ?? []).filter((q) => q.questionId !== item.fromId).map((q) => q.text);
  let retryNote: string | undefined;
  let reasons: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const prompt = buildCompetitorRewritePrompt({
      industry: ctx.industry,
      region: ctx.region,
      brandName: ctx.brandName,
      brandAliases: ctx.brandNames.slice(1),
      language: ctx.language,
      source: item.source,
      swaps: item.swaps.map((s) => ({ from: s.from, to: s.to! })),
      keep: item.keep,
      topicNeedsRewrite: item.topicNeedsRewrite,
      retryNote,
      avoidText,
    });
    let text: string;
    try {
      text = (await withTimeout(judge.call(prompt), CALL_TIMEOUT_MS)).text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[competitorRewrite] ${item.fromId} 고쳐 쓰기 실패: ${message}`);
      return { fromId: item.fromId, reasons: [message] };
    }
    // Gemini 판정은 실패를 빈 문자열로 돌려준다(이유를 남기지 않는다) — 여기서 남긴다.
    if (!text.trim()) {
      console.warn(`[competitorRewrite] ${item.fromId} 판정 엔진이 빈 응답 (${attempt}/${MAX_ATTEMPTS})`);
      reasons = ['판정 엔진이 빈 응답을 돌려줬어요'];
      continue;
    }
    const parsed = parseJsonLoose<{ text?: unknown; topic?: unknown }>(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reasons = ['응답을 읽을 수 없어요(JSON 객체가 아님)'];
      retryNote = '직전 응답은 JSON 객체 하나가 아니었다. 설명 없이 {"text": "..."} 형태로만 답하라.';
      continue;
    }
    const checked = checkRewrite(parsed.text, parsed.topic, {
      item,
      brandNames: ctx.brandNames,
      language: ctx.language,
      next: ctx.next,
      gone: ctx.gone,
      otherTexts: bankTexts,
    });
    if (!checked.reasons.length) {
      return { fromId: item.fromId, toId: item.toId!, text: checked.text, ...(checked.topic ? { topic: checked.topic } : {}), attempts: attempt };
    }
    reasons = checked.reasons;
    retryNote = `직전 안: ${checked.text || '(빈 문장)'}\n이 안은 쓸 수 없었다 — ${checked.reasons.join(' · ')}. 규칙을 지켜 다시 써라.`;
    console.warn(`[competitorRewrite] ${item.fromId} 검사 실패 (${attempt}/${MAX_ATTEMPTS}): ${checked.reasons.join(' · ')}`);
  }
  return { fromId: item.fromId, reasons };
}

async function run(ctx: QuestionRewriteContext, judge: EngineClient, avoid: Map<string, string>): Promise<RewriteResult> {
  const started = Date.now();
  const items = ctx.plan.items.filter((i) => i.action === 'rewrite');
  const results = await mapWithConcurrency(items, CONCURRENCY, (item) => rewriteOne(ctx, item, judge, avoid.get(item.fromId)));
  const drafts: RewriteDraftResult[] = [];
  const failed: RewriteResult['failed'] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!('text' in r)) {
      failed.push(r);
      continue;
    }
    // 같은 묶음의 두 질문이 같은 문장이 되면 뒤 것을 실패로 둔다(저장 검사도 같은 문장을 거절한다).
    const k = r.text.replace(/\s+/g, '').toLowerCase();
    if (seen.has(k)) {
      failed.push({ fromId: r.fromId, reasons: ['다른 고친 질문과 같아요'] });
      continue;
    }
    seen.add(k);
    drafts.push(r);
  }
  return { key: ctx.plan.key, drafts, failed, ms: Date.now() - started };
}

/**
 * 넘겨받은 질문을 고쳐 쓴다. fresh(「다시 쓰기」)면 저장해 둔 결과를 쓰지 않고, 직전 문장과 다른 표현으로 쓰게 한다 —
 * Gemini 판정은 temperature 0이라 같은 프롬프트에는 같은 답을 준다.
 */
export function draftCompetitorRewrites(ctx: QuestionRewriteContext, judge: EngineClient, opts: { fresh?: boolean } = {}): Promise<RewriteResult> {
  // Vercel 리전에서는 한국 로컬 이름을 다루는 판정이 엉뚱한 답을 낸다 — 이 기능은 데스크톱(Express)에서만 돈다.
  if (process.env.VERCEL) throw new Error('경쟁사 질문 고쳐 쓰기는 데스크톱 앱에서만 할 수 있어요.');
  const key = ctx.plan.key;
  if (!ctx.plan.items.some((i) => i.action === 'rewrite')) return Promise.resolve({ key, drafts: [], failed: [], ms: 0 });
  const cached = cache.get(key);
  if (cached && !opts.fresh) return cached;
  const avoid = new Map((opts.fresh ? (settled.get(key)?.drafts ?? []) : []).map((d) => [d.fromId, d.text]));
  const task = run(ctx, judge, avoid);
  remember(cache, key, task);
  // 그사이 「다시 쓰기」가 같은 key에 새 작업을 넣었으면 그 작업은 지우지 않는다.
  const forget = () => {
    if (cache.get(key) === task) cache.delete(key);
  };
  task.then(
    (result) => {
      // 실패가 섞인 결과는 남기지 않는다 — 다시 열면 다시 쓴다.
      if (result.failed.length) forget();
      remember(settled, key, result);
    },
    (err: unknown) => {
      console.warn(`[competitorRewrite] ${key} 고쳐 쓰기 중단:`, err);
      forget();
    },
  );
  return task;
}
