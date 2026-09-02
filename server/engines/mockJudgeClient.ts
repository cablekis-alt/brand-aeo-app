import type { PromptMessage } from '../../src/prompts/types.js';
import type { EngineCallResult, EngineClient } from './types.js';

/**
 * 실제 심판 모델 연동 전, B1/B5/B8 프롬프트가 파이프라인에 올바르게 배선됐는지 검증하기 위한 목 클라이언트.
 * 프롬프트 종류는 각 b*.ts의 시스템 프롬프트 고유 문구로 구분한다 — 실제 모델 교체 시 이 파일은 통째로 버린다.
 */
export class MockJudgeClient implements EngineClient {
  async call(prompt: PromptMessage): Promise<EngineCallResult> {
    return { text: this.respond(prompt), citations: [], usedWebSearch: false, tokenUsage: 50, latencyMs: 10 };
  }

  private respond({ system, user }: PromptMessage): string {
    if (system.includes('AEO(Answer Engine Optimization) 리서치 설계자')) {
      return JSON.stringify(this.buildQuestionBank(user));
    }
    if (system.includes('브랜드 언급을 정확히 탐지하는 분석기')) {
      return JSON.stringify(this.buildBrandMention(user));
    }
    if (system.includes('인용/출처를 브랜드 관점에서 분류하는 분석기')) {
      return JSON.stringify({ citations: [] });
    }
    if (system.includes('추천 우선순위')) {
      return JSON.stringify({ hasExplicitRanking: false, ranking: [], topRecommendation: null });
    }
    if (system.includes('사실 주장만을 검증하는 팩트체커')) {
      return JSON.stringify({ claims: [] });
    }
    return '## 요약\n(mock) 이번 주 데이터 기준 리포트입니다.';
  }

  private buildQuestionBank(user: string) {
    const countMatch = user.match(/질문\s*(\d+)개를 생성/);
    const count = countMatch ? Number(countMatch[1]) : 5;
    return Array.from({ length: count }, (_, i) => ({
      questionId: `mock-${String(i + 1).padStart(3, '0')}`,
      text: `이 업종에서 뭘 골라야 할지 추천해줄 수 있어? (mock ${i + 1})`,
      category: i % 3 === 0 ? 'brand-direct' : 'category-agnostic',
      containsBrandName: i % 3 === 0,
    }));
  }

  private buildBrandMention(responseText: string) {
    const mentioned = responseText.includes('뷰성형외과');
    return {
      targetBrand: {
        mentioned,
        mentionCount: mentioned ? 1 : 0,
        mentions: mentioned
          ? [{ mentionOrder: 1, sentence: responseText.slice(0, 40), sentiment: 'positive', matchedAlias: '뷰성형외과' }]
          : [],
      },
      competitorMentions: mentioned
        ? [{ name: '강남성형A', mentionCount: 1, mentions: [{ mentionOrder: 2, sentence: responseText.slice(0, 40), sentiment: 'neutral' }] }]
        : [],
    };
  }
}
