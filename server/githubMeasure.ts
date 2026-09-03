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

export async function triggerGithubMeasure(tenantId: string): Promise<{ htmlUrl: string }> {
  const token = process.env.GH_MEASURE_TOKEN;
  if (!token) {
    throw new Error('배포에서 측정하려면 Vercel에 GH_MEASURE_TOKEN(GitHub PAT, Actions 쓰기)을 넣어야 합니다.');
  }
  const { owner, repo, ref } = repoParts();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/measure.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs: { tenantId } }),
  });
  if (res.status !== 204) {
    const text = await res.text();
    throw new Error(`GitHub Actions 트리거 실패 (HTTP ${res.status}): ${text.slice(0, 240)}`);
  }
  return { htmlUrl: `https://github.com/${owner}/${repo}/actions/workflows/measure.yml` };
}
