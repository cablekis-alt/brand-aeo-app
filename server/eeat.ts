import type { EeatAnalysis, EeatPillar } from '../src/prompts/b6-eeat.js';
import { classifyCitationSourceKind } from './citationSources.js';
import type { QuestionRepeatAnalysis } from './types.js';

const EXPERIENCE_RE = /후기|리뷰|경험|다녀|방문|상담|시술받|수술받|이용했|묵었|숙박|예약했|다녀왔|직접|실제 이용|stayed|visited|reviewed/i;
const EXPERTISE_RE = /전문|원장|의사|병원|자격|인증|경력|교수|전문의|클리닉|호텔|수상|전문성|기술력|board-certified|expertise/i;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function pillar(score: number, evidence: string[]): EeatPillar {
  return { score: round3(score), evidence: evidence.slice(0, 5) };
}

function uniqueEvidence(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** B6 — 한 주차 판정에서 EEAT 4축을 결정적으로 계산한다. */
export function computeEeatAnalysis(analyses: QuestionRepeatAnalysis[]): EeatAnalysis {
  const totalCallCount = analyses.length;
  const mentioned = analyses.filter((a) => a.mentioned);
  const mentionSentences = mentioned.flatMap((a) => a.mentionSentences);
  const citations = analyses.flatMap((a) => a.citations);
  const claims = analyses.flatMap((a) => a.factualityClaims);

  const experientialMentions = mentionSentences.filter((m) => EXPERIENCE_RE.test(m.sentence));
  const expertiseMentions = mentionSentences.filter((m) => EXPERTISE_RE.test(m.sentence));
  const negativeMentions = mentionSentences.filter((m) => m.sentiment === 'negative');
  const reviewSupport = citations.filter(
    (c) =>
      c.supportsBrandMention &&
      (classifyCitationSourceKind(c) === 'review' || classifyCitationSourceKind(c) === 'blog'),
  );
  const authoritySupport = citations.filter((c) => {
    const kind = classifyCitationSourceKind(c);
    return c.supportsBrandMention && (kind === 'news' || kind === 'gov' || kind === 'wiki' || kind === 'brand-official');
  });
  const officialCitations = citations.filter((c) => classifyCitationSourceKind(c) === 'brand-official');
  const supportedCerts = claims.filter((c) => c.claimType === 'certification' && c.verdict === 'supported');
  const contradicted = claims.filter((c) => c.verdict === 'contradicted');
  const supported = claims.filter((c) => c.verdict === 'supported');
  const topRecs = analyses.filter((a) => a.brandRank === 1);

  const mentionRate = totalCallCount > 0 ? mentioned.length / totalCallCount : 0;
  const experientialRatio =
    mentionSentences.length > 0 ? experientialMentions.length / mentionSentences.length : reviewSupport.length > 0 ? 0.4 : 0;
  const reviewSupportRate = citations.length > 0 ? reviewSupport.length / citations.length : 0;
  const keywordRatio = mentionSentences.length > 0 ? expertiseMentions.length / mentionSentences.length : 0;
  const authorityShare = citations.length > 0 ? authoritySupport.length / citations.length : 0;
  const topRate = totalCallCount > 0 ? topRecs.length / totalCallCount : 0;
  const factuality =
    supported.length + contradicted.length > 0 ? supported.length / (supported.length + contradicted.length) : 1;
  const nonNegativeRate = mentionSentences.length > 0 ? 1 - negativeMentions.length / mentionSentences.length : 1;
  const officialShare = citations.length > 0 ? officialCitations.length / citations.length : 0;

  const experience = pillar(
    mentionRate === 0 && reviewSupport.length === 0
      ? 0
      : 0.45 * mentionRate + 0.35 * experientialRatio + 0.2 * reviewSupportRate,
    uniqueEvidence([
      ...experientialMentions.map((m) => m.sentence),
      ...reviewSupport.slice(0, 3).map((c) => c.domain ?? c.raw),
    ]),
  );

  const expertise = pillar(
    mentionSentences.length === 0 ? 0 : 0.7 * keywordRatio + 0.3 * (supportedCerts.length > 0 ? 1 : 0),
    uniqueEvidence([
      ...expertiseMentions.map((m) => m.sentence),
      ...supportedCerts.map((c) => `${c.claimText} → ${c.responseValue ?? c.factGraphValue ?? 'supported'}`),
    ]),
  );

  const authoritativeness = pillar(
    citations.length === 0 && topRecs.length === 0
      ? 0.2 * mentionRate
      : 0.5 * authorityShare + 0.3 * topRate + 0.2 * mentionRate,
    uniqueEvidence([
      ...authoritySupport.map((c) => c.domain ?? c.raw),
      ...topRecs.slice(0, 3).map((a) => `${a.engine} ${a.questionId} #${a.callIndex}: 1위 추천`),
    ]),
  );

  let trustScore = 0.45 * factuality + 0.3 * nonNegativeRate + 0.25 * officialShare;
  if (contradicted.length > 0) trustScore = Math.min(trustScore, 0.65);
  const trustworthiness = pillar(
    trustScore,
    uniqueEvidence([
      ...contradicted.map((c) => `불일치: ${c.claimText}`),
      ...negativeMentions.map((m) => m.sentence),
      ...officialCitations.slice(0, 3).map((c) => c.domain ?? c.raw),
    ]),
  );

  const overall = round3(
    (experience.score + expertise.score + authoritativeness.score + trustworthiness.score) / 4,
  );

  return {
    overall,
    experience,
    expertise,
    authoritativeness,
    trustworthiness,
    mentionedCallCount: mentioned.length,
    totalCallCount,
  };
}
