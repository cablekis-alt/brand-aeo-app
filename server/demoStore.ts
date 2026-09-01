import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import { demoCohortScorecards, demoQuestionAnalyses, demoScorecardHistory, type DemoTenant } from './demoData.js';
import type { QuestionRepeatAnalysis } from './types.js';

/**
 * 파이프라인이 쓴 data/ 디렉터리가 없는 배포 환경(서버리스)에서 쓰는 읽기 전용 스토어.
 * ResultStore의 읽기 메서드와 시그니처가 같아 queries.ts의 집계 함수를 그대로 재사용할 수 있다.
 */
export class DemoResultStore {
  private readonly tenants: DemoTenant[];

  constructor(tenants: DemoTenant[]) {
    this.tenants = tenants;
  }

  private tenantOf(tenantId: string): DemoTenant | undefined {
    return this.tenants.find((tenant) => tenant.tenantId === tenantId);
  }

  async getQuestionAnalyses(tenantId: string, weekOf: string): Promise<QuestionRepeatAnalysis[]> {
    const tenant = this.tenantOf(tenantId);
    if (!tenant) return [];
    return demoQuestionAnalyses(tenant, weekOf);
  }

  async getScorecardHistory(tenantId: string, weeksBack: number): Promise<WeeklyScorecard[]> {
    return demoScorecardHistory(tenantId).slice(-weeksBack);
  }

  async getCohortScorecards(industry: string, region: string, weekOf: string): Promise<WeeklyScorecard[]> {
    return demoCohortScorecards(industry, region, weekOf);
  }
}
