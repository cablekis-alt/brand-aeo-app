import { reconcileCohortRanks } from './cohortRank.js';
import { repoParts } from './githubMeasure.js';
import type { QuestionBank, ResultStore } from './store.js';
import type { QuestionRepeatAnalysis, TenantConfig } from './types.js';
import type { WeeklyScorecard } from '../src/prompts/b8-report.js';

/**
 * CI(GitHub Actions) 측정 결과를 데스크톱 userData로 끌어온다.
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * measure.yml은 결과를 repo의 src/data에 굽고 커밋한다. 웹(Vercel)은 그걸 번들로 읽지만
 * 데스크톱은 userData를 읽고, asar에 동봉된 src/data는 **설치 시점 사본**이라 첫 실행 시드에만
 * 쓰인다. 그래서 CI에서만 측정한 브랜드(예: torder)는 데스크톱에서 영원히 데모였다.
 * 주간 자동 측정(월 04:00)이 붙은 뒤로는 이 간극이 매주 벌어진다.
 *
 * ── 병합 정책: 없는 것만 채운다 ─────────────────────────────────────────────
 * WeeklyScorecard에는 측정 시각이 없어 "어느 쪽이 새로운가"를 판정할 수 없다. 그래서 (브랜드,
 * 주차)가 **로컬에 없을 때만** 쓴다. 로컬이 3엔진 108건이고 CI가 2엔진 72건인 주차를 CI로 덮는
 * 사고를 막는 쪽을 택했다 — 같은 주차를 두 곳에서 측정했다면 이미 있는 로컬이 이긴다.
 *
 * ── 형식 ────────────────────────────────────────────────────────────────────
 * seedFirstRun과 같은 파일을 같은 규칙으로 읽는다:
 *   demo-scorecards.json                 모든 브랜드의 주차별 스코어카드
 *   live-<id>-question-analyses.json     {tenantId, weekOf, analyses} — 브랜드당 최신 주차 1개
 *   live-<id>-question-bank.json         질문 은행(version 포함)
 * 시드는 폴더에서 읽고 여기는 GitHub Contents API로 읽는다. 비공개 repo라 GH_MEASURE_TOKEN
 * (contents 읽기 권한)이 필요하다 — 없으면 enabled:false를 돌려 화면이 설정 방법을 안내한다.
 *
 * 스코어카드를 새로 넣은 코호트는 순위를 다시 매긴다(reconcileCohortRanks). 순위는 "그 순간까지
 * 저장된 카드"로 계산되므로 카드가 늘면 분모가 바뀐다.
 */

export interface CiSyncSummary {
  enabled: boolean;
  repo: string;
  cardsAdded: number;
  analysesAdded: number;
  banksAdded: number;
  ranksUpdated: number;
  /** 로컬에 이미 있어 건너뛴 (브랜드, 주차) 수 — "왜 안 바뀌었나"에 답한다. */
  skippedExisting: number;
  tenantsTouched: string[];
}

export function ciSyncEnabled(): boolean {
  return Boolean(process.env.GH_MEASURE_TOKEN);
}

export function describeRepo(): string {
  try {
    const { owner, repo, ref } = repoParts();
    return `${owner}/${repo}@${ref}`;
  } catch {
    return '(repo 미설정)';
  }
}

/** repo 안 파일을 원문으로 받는다. 없으면 null. 그 외 실패는 throw — 조용히 빈 결과로 삼키지 않는다. */
async function fetchRepoFile(pathInRepo: string): Promise<string | null> {
  const token = process.env.GH_MEASURE_TOKEN;
  if (!token) throw new Error('GH_MEASURE_TOKEN이 없습니다.');
  const { owner, repo, ref } = repoParts();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${pathInRepo}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} — ${pathInRepo}`);
  return res.text();
}

async function fetchRepoJson<T>(pathInRepo: string): Promise<T | null> {
  const text = await fetchRepoFile(pathInRepo);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

export async function syncFromCi(store: ResultStore, tenants: TenantConfig[]): Promise<CiSyncSummary> {
  const summary: CiSyncSummary = {
    enabled: ciSyncEnabled(),
    repo: describeRepo(),
    cardsAdded: 0,
    analysesAdded: 0,
    banksAdded: 0,
    ranksUpdated: 0,
    skippedExisting: 0,
    tenantsTouched: [],
  };
  if (!summary.enabled) return summary;

  const cards = (await fetchRepoJson<WeeklyScorecard[]>('src/data/demo-scorecards.json')) ?? [];
  const byTenant = new Map<string, WeeklyScorecard[]>();
  for (const c of cards) {
    if (!c?.tenantId || !c.weekOf) continue;
    const list = byTenant.get(c.tenantId) ?? [];
    list.push(c);
    byTenant.set(c.tenantId, list);
  }
  const configOf = new Map(tenants.map((t) => [t.tenantId, t]));
  const touched = new Set<string>();
  // 순위를 다시 매길 코호트 — (업종, 지역, 주차). 카드를 새로 넣은 곳만.
  const cohortsToRank = new Map<string, { industry: string; region: string; weekOf: string }>();

  for (const [tenantId, list] of byTenant) {
    const history = await store.getScorecardHistory(tenantId, 520);
    const have = new Set(history.map((h) => h.weekOf));
    let addedHere = false;

    for (const card of list) {
      if (have.has(card.weekOf)) {
        summary.skippedExisting += 1;
        continue;
      }
      await store.saveScorecard(card);
      summary.cardsAdded += 1;
      addedHere = true;
      const cfg = configOf.get(tenantId);
      if (cfg) {
        const key = `${cfg.industry}|${cfg.region}|${card.weekOf}`;
        cohortsToRank.set(key, { industry: cfg.industry, region: cfg.region, weekOf: card.weekOf });
      }
    }

    // 분석은 브랜드당 최신 주차 1개만 구워진다. 그 주차가 로컬에 없을 때만 내려받는다 — 파일이 커서
    // 무조건 받으면 브랜드 수만큼 큰 요청이 나간다.
    const latest = [...list].sort((a, b) => a.weekOf.localeCompare(b.weekOf)).at(-1)?.weekOf;
    if (latest && (await store.getQuestionAnalyses(tenantId, latest)).length === 0) {
      const rec = await fetchRepoJson<{ tenantId?: string; weekOf?: string; analyses?: QuestionRepeatAnalysis[] }>(
        `src/data/live-${tenantId}-question-analyses.json`,
      );
      if (rec?.weekOf && Array.isArray(rec.analyses) && rec.analyses.length > 0) {
        if ((await store.getQuestionAnalyses(tenantId, rec.weekOf)).length === 0) {
          await store.saveQuestionAnalyses(tenantId, rec.weekOf, rec.analyses);
          summary.analysesAdded += 1;
          addedHere = true;
        }
      }
      // 분석을 새로 넣었으면 그 질문 은행도 있어야 화면이 질문 텍스트를 붙일 수 있다.
      const bank = await fetchRepoJson<QuestionBank>(`src/data/live-${tenantId}-question-bank.json`);
      if (bank?.version && !(await store.getQuestionBank(tenantId, bank.version))) {
        await store.saveQuestionBank(tenantId, bank);
        summary.banksAdded += 1;
        addedHere = true;
      }
    }

    if (addedHere) touched.add(tenantId);
  }

  for (const { industry, region, weekOf } of cohortsToRank.values()) {
    summary.ranksUpdated += await reconcileCohortRanks(store, industry, region, weekOf);
  }
  summary.tenantsTouched = [...touched].sort();
  return summary;
}
