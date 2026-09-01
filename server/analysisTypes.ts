// b5*.ts 프롬프트의 JSON 스키마와 1:1 대응하는 파싱 타입.
// 프롬프트 텍스트가 계약(contract)이므로, 스키마를 바꾸면 이 파일도 함께 바꿔야 한다.

export interface BrandMentionResult {
  targetBrand: {
    mentioned: boolean;
    mentionCount: number;
    mentions: { mentionOrder: number; sentence: string; sentiment: 'positive' | 'neutral' | 'negative'; matchedAlias: string }[];
  };
  competitorMentions: {
    name: string;
    mentionCount: number;
    mentions: { mentionOrder: number; sentence: string; sentiment: 'positive' | 'neutral' | 'negative' }[];
  }[];
}

export interface CitationResult {
  citations: {
    raw: string;
    domain: string | null;
    ownerType: 'brand-owned' | 'competitor-owned' | 'third-party-authority' | 'third-party-ugc' | 'unknown';
    supportsBrandMention: boolean;
  }[];
}

export interface RecommendationOrderResult {
  hasExplicitRanking: boolean;
  ranking: { rank: number; entity: string; basis: string | null }[];
  topRecommendation: string | null;
}

export interface FactCheckResult {
  claims: {
    claimText: string;
    claimType: 'price' | 'spec' | 'date' | 'certification' | 'location' | 'other';
    verdict: 'supported' | 'contradicted' | 'unverifiable';
    factGraphId: string | null;
    responseValue: string | null;
    factGraphValue: string | null;
  }[];
}
