// scripts/ci-measure.ts와 공유하는, "대기열 전체 측정" 신호.
export const QUEUE_SENTINEL = '__queue__';

export function canTriggerRemoteMeasure(): boolean {
  return Boolean(process.env.GH_MEASURE_TOKEN);
}

function repoParts(): { owner: string; repo: string; ref: string } {
  const owner = process.env.GITHUB_MEASURE_OWNER || process.env.VERCEL_GIT_REPO_OWNER || '';
  const repo = process.env.GITHUB_MEASURE_REPO || process.env.VERCEL_GIT_REPO_SLUG || '';
  const ref = process.env.GITHUB_MEASURE_REF || process.env.VERCEL_GIT_COMMIT_REF || 'master';
  if (!owner || !repo) {
    throw new Error('GitHub 저장소 정보가 없습니다. GITHUB_MEASURE_OWNER / GITHUB_MEASURE_REPO 를 넣거나 Vercel Git 연동을 확인하세요.');
  }
  return { owner, repo, ref };
}

/** 지정 워크플로우를 workflow_dispatch로 트리거한다. */
async function dispatchWorkflow(workflow: string, inputs: Record<string, string>): Promise<{ htmlUrl: string }> {
  const token = process.env.GH_MEASURE_TOKEN;
  if (!token) {
    throw new Error('배포에서 측정·삭제하려면 Vercel에 GH_MEASURE_TOKEN(GitHub PAT, Actions 쓰기)을 넣어야 합니다.');
  }
  const { owner, repo, ref } = repoParts();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`GitHub Actions 트리거 실패 (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  return { htmlUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflow}` };
}

export async function triggerGithubMeasure(tenantId: string): Promise<{ htmlUrl: string }> {
  return dispatchWorkflow('measure.yml', { tenantId });
}

/** 측정 대기열 전체를 GitHub Actions 한 번의 실행으로 순차 측정하도록 트리거한다. */
export async function triggerGithubQueueMeasure(): Promise<{ htmlUrl: string }> {
  return triggerGithubMeasure(QUEUE_SENTINEL);
}

/** 베이크된 브랜드를 GitHub Actions에서 완전 삭제(delete-tenant.ts + 커밋·배포)하도록 트리거한다. */
export async function triggerGithubDelete(tenantId: string): Promise<{ htmlUrl: string }> {
  return dispatchWorkflow('delete.yml', { tenantId });
}

export interface MeasureRunInfo {
  runNumber: number;
  title: string; // "measure <tenantId>" | "measure __queue__" | (구버전) 워크플로우명
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | ...
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/** 측정 상태 — 최근 measure 워크플로우 실행 목록을 반환한다(토큰 필요). */
export async function listMeasureRuns(limit = 15): Promise<{ enabled: boolean; runs: MeasureRunInfo[] }> {
  const token = process.env.GH_MEASURE_TOKEN;
  if (!token) return { enabled: false, runs: [] };
  let parts: { owner: string; repo: string };
  try {
    parts = repoParts();
  } catch {
    return { enabled: false, runs: [] };
  }
  const res = await fetch(
    `https://api.github.com/repos/${parts.owner}/${parts.repo}/actions/workflows/measure.yml/runs?per_page=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) return { enabled: true, runs: [] };
  const data = (await res.json()) as { workflow_runs?: Record<string, unknown>[] };
  const runs: MeasureRunInfo[] = (data.workflow_runs ?? []).map((r) => ({
    runNumber: Number(r.run_number) || 0,
    title: (typeof r.display_title === 'string' && r.display_title) || String(r.name ?? '측정'),
    status: String(r.status ?? ''),
    conclusion: (r.conclusion as string | null) ?? null,
    event: String(r.event ?? ''),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
    htmlUrl: String(r.html_url ?? ''),
  }));
  return { enabled: true, runs };
}
