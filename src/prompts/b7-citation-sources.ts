/**
 * B7 — AI 인용출처 분석.
 * B5-B가 인용의 소유권(자사/경쟁사/제3자)을 나누면, 이 단계는 그 URL이
 * 어떤 종류의 출처인지(뉴스·공공·위키·후기·포럼 등)와 엔진별 치우침을 집계한다.
 * 분류는 도메인 규칙 + B5-B ownerType으로 결정적이며 LLM을 쓰지 않는다.
 */

export type CitationSourceKind =
  | 'brand-official'
  | 'competitor'
  | 'news'
  | 'gov'
  | 'wiki'
  | 'review'
  | 'forum'
  | 'social'
  | 'blog'
  | 'other';

export interface CitationSourceMixRow {
  kind: CitationSourceKind;
  count: number;
  share: number;
}

export interface CitationSourceUrlRow {
  raw: string;
  domain: string;
  kind: CitationSourceKind;
  ownerType: string;
  citationCount: number;
  engines: string[];
  supportingBrandMentionCount: number;
}

export interface CitationSourceEngineRow {
  engine: string;
  total: number;
  mix: CitationSourceMixRow[];
}

export interface CitationSourceConsensusRow {
  domain: string;
  kind: CitationSourceKind;
  engineCount: number;
  citationCount: number;
}

export interface CitationSourceAnalysis {
  totalCitations: number;
  uniqueUrls: number;
  uniqueDomains: number;
  qualityRate: number;
  mix: CitationSourceMixRow[];
  byEngine: CitationSourceEngineRow[];
  urls: CitationSourceUrlRow[];
  consensusDomains: CitationSourceConsensusRow[];
}
