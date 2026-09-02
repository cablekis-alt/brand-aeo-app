/**
 * B6 — EEAT 분석.
 * Google EEAT(Experience / Expertise / Authoritativeness / Trustworthiness)를
 * 답변 엔진이 이 브랜드를 어떻게 그리는지로 측정한다.
 *
 * 점수는 심판 LLM이 아니라 B5-A~D 판정(언급 문장·인용 소유권·사실성)에서
 * 결정적으로 계산한다. SoM과 같은 이유: 주간 변동에 분석기 노이즈가 섞이면 안 된다.
 */

export type EeatPillarId = 'experience' | 'expertise' | 'authoritativeness' | 'trustworthiness';

export interface EeatPillar {
  score: number;
  evidence: string[];
}

export interface EeatAnalysis {
  overall: number;
  experience: EeatPillar;
  expertise: EeatPillar;
  authoritativeness: EeatPillar;
  trustworthiness: EeatPillar;
  mentionedCallCount: number;
  totalCallCount: number;
}
