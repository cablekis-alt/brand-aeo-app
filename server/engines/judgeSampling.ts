/**
 * 판정 호출의 샘플링 온도 — 한 곳에서 정한다.
 *
 * 왜 고정하나. 판정은 "측정 도구"다. 같은 응답을 두 번 판정했을 때 결과가 달라지면 그 차이는
 * 브랜드가 아니라 계측기의 흔들림이다. 실측(scripts/nondeterminism-probe.ts --judge,
 * torder 카테고리 무관 20개 × 3회, 언급률 62%): **판정 노이즈 σ = 12.9%p**, 20셀 중 1셀에서
 * 언급 판정이 뒤집혔다. 온도가 코드에 없어 SDK 기본값(비결정적)을 쓰고 있었기 때문이다.
 *
 * 수집 엔진은 고정하지 않는다. 수집은 "실제 사용자가 물었을 때 무엇이 나오나"를 재는 것이라
 * 엔진이 주는 대로 받아야 한다. 온도를 우리가 바꾸면 그건 더 이상 실제 노출이 아니다.
 *
 * JUDGE_TEMPERATURE로 바꿀 수 있다. 빈 값이나 'none'을 주면 파라미터를 **보내지 않는다** —
 * 온도를 거부하는 모델(아래)로 판정할 때 쓰는 탈출구다.
 */
export function judgeTemperature(): number | undefined {
  const raw = process.env.JUDGE_TEMPERATURE?.trim();
  if (raw === '' || raw?.toLowerCase() === 'none') return undefined;
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[judge] JUDGE_TEMPERATURE 값을 해석할 수 없습니다: ${raw} — 0으로 진행합니다.`);
    return 0;
  }
  return parsed;
}

/**
 * Claude 판정에는 온도를 보내지 않는다 — 보낼 수 없다.
 *
 * 현행 Claude 모델(Opus 5 · 4.8 · 4.7, Sonnet 5, Fable 5 계열)은 temperature·top_p·top_k를
 * **400으로 거부한다**. 기본 JUDGE_MODEL이 claude-opus-5라 온도를 넣으면 판정이 전부 실패한다.
 * 온도 대신 사고 깊이를 output_config.effort로 조절하는 설계로 바뀌었기 때문이다.
 *
 * 즉 판단 엔진을 Claude로 두면 이 프로젝트는 판정 노이즈를 고정할 수 없다. 그래서 기본
 * 판단 엔진은 Gemini로 유지한다(engines/index.ts의 resolveJudgeEngineId 주석 참고).
 * 옛 모델(Opus 4.6 · Sonnet 4.6 · Haiku 4.5)은 온도를 받지만, 그 모델로 내리려고
 * 계측기를 바꾸는 건 본말이 뒤바뀐 선택이다.
 */
export const CLAUDE_JUDGE_REJECTS_TEMPERATURE = true;
