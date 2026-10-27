import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { aggregateWeeklyMetrics, ciBounds } from './aggregate.js';
import { packagedDataMode, PIPELINE_DATA_DIR } from './appPaths.js';
import { isReviewHost, urlHost } from './citationSources.js';
import { cohortRankingEntities } from './cohortEntities.js';
import { reconcileCohortRanks } from './cohortRank.js';
import { EditorError } from './competitorEditor.js';
import { readMeasureRequests } from './measureRequests.js';
import { measureInFlight } from './measureTracker.js';
import { mergeOwnedDomains, readExtraOwnedDomains, writeExtraOwnedDomains } from './ownedDomainsStore.js';
import { contextFingerprint } from './pipeline.js';
import { movingAverage4 } from './scoring.js';
import { writeJsonAtomic } from './tenantWriteQueue.js';
import { loadRuntimeTenants } from './tenantRegistry.js';
import { hostKey } from '../src/lib/brandVariant.js';
import { isSharedPlatformHost } from '../src/lib/sharedHosts.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import type { QuestionBank, ResultStore, RunMeta } from './store.js';
import type { QuestionRepeatAnalysis, TenantConfig } from './types.js';

/*
 * 자사 사이트 주소 더하기 · 빼기 — 브랜드 현황 「기본 정보」 서랍의 한 칸(components/OwnedDomainsEditor.tsx).
 *
 * 등록할 때 넣은 홈페이지(ownedDomains[0])는 경쟁사 id · 사이트 주소에 쓰여 그대로 두고, 그 뒤에 붙일 주소를 data/<id>/owned-domains.json에
 * 둔다(ownedDomainsStore). 저장소 설정 브랜드도 고칠 수 있다 — 기본 정보(오버레이 브랜드만)와 다른 점이다.
 *
 * 더할 때 「지난 측정에도 적용」을 고르면 이미 잰 주의 판정 레코드에서 그 주소 인용을 자사로 바꾸고 점수를 다시 센다(2026-10-27 군산각을
 * 손으로 고친 방식). 자사 인용률은 점수의 20 비중이라, 적용하지 않으면 다음 측정의 점수가 등록 때문에 뛴다. 판정 엔진은 새 측정에서
 * 자사 주소 목록을 보고 고르지만, 지난 기록은 호스트(하위 도메인 포함)로 정해서 바꾼다.
 *   - 카드는 고치기 전 판정을 지금 규칙으로 다시 센 값이 저장값과 같을 때만 고친다 — 집계 규칙이 그 뒤 바뀐 주는 건드리지 않고 알린다.
 *   - 한 주 점수가 바뀌면 뒤 주의 전주 · 4주 평균도 이어서 맞춘다(회차 카드 포함).
 *   - 회차의 판정 맥락 지문은 지금 설정의 옛 지문과 같은 회차만 새 지문으로 — 다음 측정이 「판정 맥락 바뀜」으로 끊기지 않게.
 *   - 점수가 바뀐 주는 코호트 순위를 다시 센다(경쟁사 카드도 바뀐다).
 * 빼기는 다음 측정부터다 — 지난 기록의 원래 성격을 모르므로 되돌리지 않는다.
 */

export interface OwnedDomainsState {
  tenantId: string;
  brandName: string;
  /** 등록할 때 넣은 홈페이지 — 바꿀 수 없다. 없으면 null. */
  primary: string | null;
  /** 저장소 설정 · 등록으로 정해진 주소(첫 주소 포함) — 여기서는 바꿀 수 없다. */
  fixed: string[];
  extra: string[];
  editable: boolean;
  reason: string | null;
  measuring: boolean;
}

export interface OwnedDomainsInput {
  extra: string[];
  applyPast: boolean;
}

/** 지난 측정 적용 미리보기의 한 줄 — 주차 카드 하나. */
export interface PastWeekChange {
  weekOf: string;
  promoted: number;
  rateBefore: number;
  rateAfter: number;
  scoreBefore: number;
  scoreAfter: number;
  ma4Before: number;
  ma4After: number;
  /** 같은 주 회차 중 고칠 회차 수. */
  runs: number;
}

export interface OwnedDomainsPlan {
  key: string;
  unchanged: boolean;
  extra: string[];
  added: string[];
  removed: string[];
  errors: string[];
  notes: string[];
  measuring: boolean;
  applyPast: boolean;
  /** 지난 측정 적용 미리보기 — 고르지 않았거나 더한 주소가 없으면 null. */
  past: { weeks: PastWeekChange[]; promoted: number; runs: number; skipped: string[]; cohortWeeks: number } | null;
}

export interface OwnedDomainsSaveResult {
  ok: true;
  tenantId: string;
  extra: string[];
  applied: { weeks: number; runs: number; promoted: number; ranksUpdated: number } | null;
  backupDir: string;
}

const tenantDir = (id: string) => path.join(PIPELINE_DATA_DIR, id);
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

interface Context {
  runtime: TenantConfig[];
  tenant: TenantConfig;
  primary: string | null;
  fixed: string[];
  extra: string[];
  reason: string | null;
}

async function loadContext(tenantId: string): Promise<Context> {
  const runtime = await loadRuntimeTenants();
  const tenant = runtime.find((t) => t.tenantId === tenantId);
  if (!tenant || tenant.cohortOnly) throw new EditorError(404, `고객 브랜드를 찾을 수 없습니다: ${tenantId}`);
  const extra = (await readExtraOwnedDomains(tenantId)) ?? [];
  // 런타임 목록은 더한 주소가 이미 붙어 있다 — 고정 주소는 더한 주소가 아닌 값, 첫 주소는 그 첫 값이다.
  const fixed = (tenant.ownedDomains ?? []).map(hostKey).filter((d) => d && !extra.includes(d));
  const primary = fixed[0] ?? null;
  let reason: string | null = null;
  if (!process.env.VERCEL && !packagedDataMode()) reason = 'dev 체크아웃에서는 저장소 설정(tenants.config.json)을 직접 고치세요.';
  else if (!primary) reason = '등록한 홈페이지가 없어 주소를 더할 수 없어요.';
  return { runtime, tenant, primary, fixed, extra, reason };
}

export async function describeOwnedDomains(tenantId: string): Promise<OwnedDomainsState> {
  const ctx = await loadContext(tenantId);
  return {
    tenantId,
    brandName: ctx.tenant.brandName,
    primary: ctx.primary,
    fixed: ctx.fixed,
    extra: ctx.extra,
    editable: ctx.reason === null,
    reason: ctx.reason,
    measuring: measureInFlight(),
  };
}

export function normalizeOwnedDomainsInput(raw: unknown): OwnedDomainsInput {
  const r = raw as Partial<Record<keyof OwnedDomainsInput, unknown>> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.extra) || r.extra.some((d) => typeof d !== 'string')) {
    throw new EditorError(400, '주소 목록 형식이 아닙니다.');
  }
  const extra: string[] = [];
  for (const d of r.extra as string[]) {
    const key = hostKey(d);
    if (key && !extra.includes(key)) extra.push(key);
  }
  return { extra, applyPast: r.applyPast === true };
}

const ownsHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** 한 주소를 받을 수 있는지 — 안 되면 사람이 읽을 이유. */
function rejectReason(host: string, ctx: Context): string | null {
  if (!HOST_RE.test(host)) return `${host} — 주소 형식이 아니에요(예: example.com).`;
  const inFixed = ctx.fixed.find((d) => ownsHost(host, d));
  if (inFixed) return `${host} — 이미 자사 주소(${inFixed})에 들어 있어요.`;
  if (isSharedPlatformHost(host)) return `${host} — 여럿이 함께 쓰는 플랫폼 주소라 자사 주소로 받지 않아요(남의 글까지 자사로 잡혀요).`;
  if (isReviewHost(host)) return `${host} — 후기 · 예약 플랫폼 주소라 자사 주소로 받지 않아요.`;
  for (const t of ctx.runtime) {
    if (t.tenantId === ctx.tenant.tenantId) continue;
    const domains = (t.ownedDomains ?? []).map(hostKey);
    // 같은 홈페이지를 쓰는 범위 변형(군산각 지역형 · 전국형)은 같은 곳이다.
    if (ctx.primary && domains[0] === ctx.primary) continue;
    if (domains.some((d) => d && (ownsHost(host, d) || ownsHost(d, host)))) return `${host} — ${t.brandName}의 자사 주소예요.`;
  }
  for (const c of ctx.tenant.competitors ?? []) {
    if ((c.domains ?? []).map(hostKey).some((d) => d && (ownsHost(host, d) || ownsHost(d, host)))) return `${host} — 경쟁사 ${c.name}의 주소예요.`;
  }
  return null;
}

/** 그 주 판정 레코드의 문항이 모두 든 은행 — 하나만 맞는 은행으로 세면 모집단이 틀어진다(scripts/rescore-local.ts bankFor). */
async function strictBank(store: ResultStore, tenantId: string, recorded: string | undefined, analyses: QuestionRepeatAnalysis[]): Promise<QuestionBank | null> {
  const ids = new Set(analyses.map((a) => a.questionId));
  const versions = await store.listQuestionBankVersions(tenantId);
  const order = recorded ? [recorded, ...versions.filter((v) => v !== recorded)] : versions;
  for (const v of order) {
    const bank = await store.getQuestionBank(tenantId, v);
    if (!bank) continue;
    const bankIds = new Set(bank.questions.map((q) => q.questionId));
    if ([...ids].every((id) => bankIds.has(id))) return bank;
  }
  return null;
}

/** 그 주에 경쟁사가 있었는가 — 지금 설정이 아니라 그 주 카드로 본다(scripts/rescore-local.ts hadCompetitors). */
const hadCompetitors = (c: WeeklyScorecard) => c.shareOfMention !== null || typeof c.shareOfMentionMentions === 'number';

/** 더한 주소 인용을 자사로 — 고친 사본과 바꾼 수. */
function promote(analyses: QuestionRepeatAnalysis[], added: string[]): { analyses: QuestionRepeatAnalysis[]; promoted: number } {
  const next = structuredClone(analyses);
  let promoted = 0;
  for (const a of next) {
    for (const c of a.citations ?? []) {
      const host = hostKey((c.raw ? urlHost(c.raw) : null) ?? c.domain ?? '');
      if (host && c.ownerType !== 'brand-owned' && added.some((d) => ownsHost(host, d))) {
        c.ownerType = 'brand-owned';
        promoted += 1;
      }
    }
    a.brandOwnedCitation = (a.citations ?? []).some((c) => c.ownerType === 'brand-owned');
  }
  return { analyses: next, promoted };
}

interface CardFix {
  card: WeeklyScorecard;
  /** 점수를 다시 세지 못한 이유 — 있으면 점수 · 인용률은 그대로다. */
  skipped: string | null;
  rateBefore: number;
  rateAfter: number;
}

/** 판정을 바꾼 카드의 점수 · CI · 자사 인용률 — 고치기 전 판정을 지금 규칙으로 센 값이 저장값과 같을 때만. */
async function rescoreCard(
  store: ResultStore,
  card: WeeklyScorecard,
  before: QuestionRepeatAnalysis[],
  after: QuestionRepeatAnalysis[],
  label: string,
): Promise<CardFix> {
  const out = structuredClone(card);
  const same = { card: out, rateBefore: card.brandOwnedCitationRate, rateAfter: card.brandOwnedCitationRate };
  const bank = await strictBank(store, card.tenantId, card.questionBankVersion, before);
  if (!bank) return { ...same, skipped: `${label}: 그 주 질문지를 찾지 못해 점수는 그대로예요.` };
  const tenantLike = { competitors: hadCompetitors(card) ? [{ name: '(그 주 카드 기준)' }] : [] };
  const mb = aggregateWeeklyMetrics(tenantLike, bank.questions, before);
  const ma = aggregateWeeklyMetrics(tenantLike, bank.questions, after);
  const ciB = ciBounds(mb.score, mb.ciMargin);
  const matches =
    mb.score === card.aeoScore.current &&
    Math.abs(mb.brandOwnedCitationRate - card.brandOwnedCitationRate) < 1e-9 &&
    ciB.ciLow === card.aeoScore.ciLow &&
    ciB.ciHigh === card.aeoScore.ciHigh;
  if (!matches) return { ...same, skipped: `${label}: 저장된 점수가 지금 계산 규칙과 달라(측정 뒤 규칙이 바뀐 주) 점수는 그대로예요.` };
  out.aeoScore = { ...out.aeoScore, current: ma.score, ...ciBounds(ma.score, ma.ciMargin) };
  out.brandOwnedCitationRate = ma.brandOwnedCitationRate;
  return { card: out, skipped: null, rateBefore: card.brandOwnedCitationRate, rateAfter: ma.brandOwnedCitationRate };
}

/**
 * 전주 · 4주 평균을 고친 앞 주 점수로 — 저장값이 옛 점수로 낸 값과 같을 때만(pipeline.ts aggregateScorecard와 같은 규칙).
 * 옛 첫 측정 카드는 전주에 이번 주 점수가 들어 있다(2026-10-27 전) — 그 표시는 새 점수로 이어 둔다.
 */
function rechain(card: WeeklyScorecard, oldScore: number, priorOld: number[], priorNew: number[]): void {
  const s = card.aeoScore;
  if (Math.round(movingAverage4([...priorOld, oldScore])) === s.ma4) s.ma4 = Math.round(movingAverage4([...priorNew, s.current]));
  if (s.previousWeek === null) return;
  if (priorOld.length === 0 && s.previousWeek === oldScore) s.previousWeek = s.current;
  else if (priorOld.length > 0 && s.previousWeek === priorOld.at(-1)) s.previousWeek = priorNew.at(-1)!;
}

interface PastWork {
  weeks: PastWeekChange[];
  skipped: string[];
  analyses: { weekOf: string; analyses: QuestionRepeatAnalysis[] }[];
  cards: WeeklyScorecard[];
  runs: { weekOf: string; runId: string; scorecard?: WeeklyScorecard; analyses?: QuestionRepeatAnalysis[]; meta?: RunMeta }[];
  cohortWeeks: { industry: string; region: string; weekOf: string }[];
  promoted: number;
}

async function computePast(ctx: Context, added: string[], finalExtra: string[], store: ResultStore): Promise<PastWork> {
  const tenantId = ctx.tenant.tenantId;
  const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER);
  const oldScores = history.map((h) => h.aeoScore.current);
  const newScores = [...oldScores];
  const work: PastWork = { weeks: [], skipped: [], analyses: [], cards: [], runs: [], cohortWeeks: [], promoted: 0 };

  // 판정 맥락 지문 — 지금 설정(더하기 전)의 지문과 같은 회차만 새 지문으로 바꾼다.
  const entities = cohortRankingEntities(ctx.tenant, ctx.runtime);
  const fpOld = contextFingerprint(ctx.tenant, entities);
  // 저장 뒤 런타임 목록과 같은 값 — 고정 주소 뒤에 최종 더한 주소(tenantRegistry mergeOwnedDomains).
  const fpNew = contextFingerprint({ ...ctx.tenant, ownedDomains: mergeOwnedDomains(ctx.fixed, finalExtra) }, entities);

  for (const [i, card] of history.entries()) {
    const weekOf = card.weekOf;
    const priorOld = oldScores.slice(0, i);
    const priorNew = newScores.slice(0, i);
    const stored = await store.getQuestionAnalyses(tenantId, weekOf);
    const { analyses, promoted } = promote(stored, added);
    let next = structuredClone(card);
    let rateBefore = card.brandOwnedCitationRate;
    let rateAfter = card.brandOwnedCitationRate;
    if (promoted > 0) {
      work.analyses.push({ weekOf, analyses });
      work.promoted += promoted;
      const fix = await rescoreCard(store, card, stored, analyses, weekOf);
      if (fix.skipped) work.skipped.push(fix.skipped);
      next = fix.card;
      rateBefore = fix.rateBefore;
      rateAfter = fix.rateAfter;
    }
    newScores[i] = next.aeoScore.current;
    rechain(next, card.aeoScore.current, priorOld, priorNew);

    let runsChanged = 0;
    const { runs } = await store.listRunSnapshots(tenantId, weekOf);
    for (const run of runs) {
      const p = promote(run.analyses, added);
      let runCard = structuredClone(run.scorecard);
      if (p.promoted > 0) {
        const fix = await rescoreCard(store, run.scorecard, run.analyses, p.analyses, `${weekOf} 회차 ${run.meta.runId}`);
        if (fix.skipped) work.skipped.push(fix.skipped);
        runCard = fix.card;
      }
      rechain(runCard, run.scorecard.aeoScore.current, priorOld, priorNew);
      const metaChanged = run.meta.contextFingerprint === fpOld && fpOld !== fpNew;
      const cardChanged = JSON.stringify(runCard) !== JSON.stringify(run.scorecard);
      if (p.promoted === 0 && !cardChanged && !metaChanged) continue;
      work.runs.push({
        weekOf,
        runId: run.meta.runId,
        ...(p.promoted > 0 ? { analyses: p.analyses } : {}),
        ...(cardChanged ? { scorecard: runCard } : {}),
        ...(metaChanged ? { meta: { ...run.meta, contextFingerprint: fpNew } } : {}),
      });
      runsChanged += 1;
    }

    if (JSON.stringify(next) !== JSON.stringify(card)) {
      work.cards.push(next);
      if (next.aeoScore.current !== card.aeoScore.current) {
        work.cohortWeeks.push({ industry: card.industry, region: card.region, weekOf });
      }
    }
    if (promoted > 0 || runsChanged > 0 || JSON.stringify(next) !== JSON.stringify(card)) {
      work.weeks.push({
        weekOf,
        promoted,
        rateBefore,
        rateAfter,
        scoreBefore: card.aeoScore.current,
        scoreAfter: next.aeoScore.current,
        ma4Before: card.aeoScore.ma4,
        ma4After: next.aeoScore.ma4,
        runs: runsChanged,
      });
    }
  }
  return work;
}

async function computePlan(ctx: Context, input: OwnedDomainsInput, store: ResultStore): Promise<{ plan: OwnedDomainsPlan; work: PastWork | null }> {
  const errors: string[] = [];
  const notes: string[] = [];
  const added = input.extra.filter((d) => !ctx.extra.includes(d));
  const removed = ctx.extra.filter((d) => !input.extra.includes(d));
  const unchanged = added.length === 0 && removed.length === 0;
  if (ctx.reason) errors.push(ctx.reason);
  for (const d of added) {
    const why = rejectReason(d, ctx);
    if (why) errors.push(why);
  }
  if (!unchanged) {
    const queued = (await readMeasureRequests()).some((r) => r.tenant.tenantId === ctx.tenant.tenantId);
    // 대기열은 넣을 때의 설정으로 잰다 — 옛 주소 목록으로 재고, 지난 기록에 적용한 주를 다시 덮을 수 있다.
    if (queued) errors.push('측정 대기열에 이 브랜드가 있어요. 그 측정이 끝난 뒤에 바꿔 주세요.');
  }
  if (removed.length > 0) notes.push(`뺀 주소(${removed.join(', ')})는 다음 측정부터 자사로 보지 않아요. 지난 기록은 그대로예요.`);
  for (const t of ctx.runtime) {
    if (t.tenantId === ctx.tenant.tenantId) continue;
    const hit = (t.competitors ?? []).find((c) => (c.domains ?? []).map(hostKey).some((d) => added.includes(d)));
    if (hit) notes.push(`${t.brandName}의 경쟁사 목록에 이 주소(${hit.name})가 있어요 — 그 브랜드에서는 경쟁사 인용으로 남아요.`);
  }
  const applyPast = input.applyPast && added.length > 0;
  const work = applyPast && errors.length === 0 ? await computePast(ctx, added, input.extra, store) : null;
  if (!applyPast && added.length > 0) notes.push('지난 측정은 그대로라, 다음 측정의 자사 인용률 · 점수가 주소를 더한 만큼 오를 수 있어요.');
  const past = work
    ? { weeks: work.weeks, promoted: work.promoted, runs: work.runs.length, skipped: work.skipped, cohortWeeks: work.cohortWeeks.length }
    : null;
  // 열쇠에 지난 기록 적용 결과까지 넣는다 — 미리보기 뒤 측정이 끼어들면 저장을 막는다.
  const key = createHash('sha1')
    .update(JSON.stringify({ current: ctx.extra, input, past, runs: work?.runs.map((r) => [r.weekOf, r.runId, r.meta?.contextFingerprint ?? '']) }))
    .digest('hex')
    .slice(0, 16);
  return {
    plan: { key, unchanged, extra: input.extra, added, removed, errors, notes, measuring: measureInFlight(), applyPast, past },
    work,
  };
}

export async function planOwnedDomains(tenantId: string, raw: unknown, store: ResultStore): Promise<OwnedDomainsPlan> {
  const ctx = await loadContext(tenantId);
  return (await computePlan(ctx, normalizeOwnedDomainsInput(raw), store)).plan;
}

/** 바꿀 파일을 백업 폴더로 옮겨 적는다(from 기준 상대 경로) — 되돌릴 때 원래 자리로 되쓴다. 없던 파일은 null로 남긴다. */
async function backupFiles(backupRoot: string, from: string, files: string[]): Promise<Map<string, string | null>> {
  const saved = new Map<string, string | null>();
  for (const file of files) {
    if (saved.has(file)) continue;
    const rel = path.relative(from, file);
    const target = path.join(backupRoot, rel);
    try {
      await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        saved.set(file, null);
        continue;
      }
      throw err;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
    saved.set(file, target);
  }
  return saved;
}

async function restoreFiles(saved: Map<string, string | null>): Promise<void> {
  for (const [file, copy] of saved) {
    if (copy) await copyFile(copy, file);
    else await unlink(file).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
}

/**
 * 저장 — 다시 계획해 미리보기 열쇠가 같을 때만. 측정 중이면 409.
 * 백업: data/<id>/before-owned-domains-<시각>/ 아래에 바꿀 파일을 같은 상대 경로로(다른 브랜드 카드는 그 안 _cohort/). 중간에 실패하면 되돌린다.
 */
export async function saveOwnedDomains(tenantId: string, raw: unknown, previewKey: unknown, store: ResultStore): Promise<OwnedDomainsSaveResult> {
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 저장해 주세요.');
  const ctx = await loadContext(tenantId);
  if (ctx.reason) throw new EditorError(409, ctx.reason);
  const { plan, work } = await computePlan(ctx, normalizeOwnedDomainsInput(raw), store);
  if (plan.unchanged) throw new EditorError(400, '바뀐 내용이 없어요.');
  if (plan.errors.length > 0) throw new EditorError(409, plan.errors[0]!);
  if (plan.key !== previewKey) throw new EditorError(409, '미리보기 뒤에 기록이 바뀌었어요. 바뀐 내용을 다시 확인해 주세요.');
  if (measureInFlight()) throw new EditorError(409, '측정이 진행 중이에요. 끝난 뒤에 저장해 주세요.');

  const backupDir = `before-owned-domains-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const root = path.join(tenantDir(tenantId), backupDir);
  const own = (...p: string[]) => path.join(tenantDir(tenantId), ...p);
  const files = [own('owned-domains.json')];
  if (work) {
    for (const a of work.analyses) files.push(own(a.weekOf, 'question-analyses.json'));
    for (const c of work.cards) files.push(own(c.weekOf, 'scorecard.json'));
    if (work.cards.length > 0) files.push(own('scorecard-history.json'));
    for (const r of work.runs) {
      for (const f of ['question-analyses.json', 'scorecard.json', 'run.json']) files.push(own(r.weekOf, 'runs', r.runId, f));
    }
  }
  await mkdir(root, { recursive: true });
  const saved = await backupFiles(root, tenantDir(tenantId), files);
  // 순위를 다시 세면 같은 코호트 다른 브랜드의 카드 · 히스토리도 바뀐다 — 그것도 남긴다.
  const cohortSaved = new Map<string, string | null>();
  for (const k of work?.cohortWeeks ?? []) {
    for (const c of await store.getCohortScorecards(k.industry, k.region, k.weekOf)) {
      if (c.tenantId === tenantId) continue;
      const pairs = await backupFiles(path.join(root, '_cohort'), PIPELINE_DATA_DIR, [
        path.join(tenantDir(c.tenantId), c.weekOf, 'scorecard.json'),
        path.join(tenantDir(c.tenantId), 'scorecard-history.json'),
      ]);
      for (const [f, copy] of pairs) if (!cohortSaved.has(f)) cohortSaved.set(f, copy);
    }
  }

  let ranksUpdated = 0;
  try {
    await writeExtraOwnedDomains(tenantId, plan.extra);
    if (work) {
      for (const a of work.analyses) await writeJsonAtomic(own(a.weekOf, 'question-analyses.json'), a.analyses);
      for (const c of work.cards) await store.saveScorecard(c);
      for (const r of work.runs) {
        await store.rewriteRunSnapshot(tenantId, r.weekOf, r.runId, {
          ...(r.analyses ? { analyses: r.analyses } : {}),
          ...(r.scorecard ? { scorecard: r.scorecard } : {}),
          ...(r.meta ? { meta: r.meta } : {}),
        });
      }
      for (const k of work.cohortWeeks) ranksUpdated += await reconcileCohortRanks(store, k.industry, k.region, k.weekOf);
    }
  } catch (err) {
    console.error(`[ownedDomainsEditor] ${tenantId} 저장 실패 — 되돌립니다:`, err);
    try {
      await restoreFiles(saved);
      await restoreFiles(cohortSaved);
      // 되돌린 회차를 화면이 옛 캐시로 보지 않게 비운다 — 파일은 쓰지 않고 캐시만 비운다.
      for (const r of work?.runs ?? []) await store.rewriteRunSnapshot(tenantId, r.weekOf, r.runId, {});
    } catch (undoErr) {
      console.error(`[ownedDomainsEditor] ${tenantId} 되돌리기도 실패했습니다 — 백업(${backupDir})에서 직접 되돌려 주세요:`, undoErr);
    }
    throw err;
  }
  return {
    ok: true,
    tenantId,
    extra: plan.extra,
    applied: work ? { weeks: work.cards.length, runs: work.runs.length, promoted: work.promoted, ranksUpdated } : null,
    backupDir,
  };
}
