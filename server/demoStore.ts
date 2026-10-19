import type { WeeklyScorecard } from '../src/prompts/b8-report.js';
import {
  demoCohortScorecards,
  demoQuestionAnalyses,
  demoQuestionBank,
  demoScorecardHistory,
  type DemoTenant,
} from './demoData.js';
import type { QuestionBank } from './store.js';
import type { QuestionRepeatAnalysis } from './types.js';

// demoQuestionBank의 weekOf는 generatedAt 표기에만 쓰인다(질문 목록은 주차와 무관).
const LATEST_DEMO_WEEK = '2026-W36';

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

  // 언급률·SoM 모집단(카테고리 무관 질문)을 가려내려면 질문의 category가 필요하다.
  // 합성 판정 레코드는 예시 은행에서, 실측 판정 레코드는 그때 쓴 실측 은행에서 만들었다 — 요청한 버전의 실측 은행이
  // 있으면 그것을 준다(demoQuestionBank 주석). 없으면 예시 은행이 오므로 호출부는 version이 맞는지 본다.
  async getQuestionBank(tenantId: string, version: string): Promise<QuestionBank | null> {
    const tenant = this.tenantOf(tenantId);
    if (!tenant) return null;
    return demoQuestionBank(tenant, LATEST_DEMO_WEEK, version);
  }

  async getScorecardHistory(tenantId: string, weeksBack: number): Promise<WeeklyScorecard[]> {
    return demoScorecardHistory(tenantId).slice(-weeksBack);
  }

  async getCohortScorecards(industry: string, region: string, weekOf: string): Promise<WeeklyScorecard[]> {
    return demoCohortScorecards(industry, region, weekOf);
  }
}
