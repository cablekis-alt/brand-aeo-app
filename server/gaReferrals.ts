import { JWT } from 'google-auth-library';
import type { TenantConfig } from './types.js';

/**
 * AI 리퍼럴 트래픽 — GA4 Data API(runReport)로 "AI 답변엔진에서 실제로 유입된 세션"을 집계한다.
 *
 * 측정 파이프라인(B1~B9)이 "AI가 우리를 언급하는가"를 재는 것과 달리, 이쪽은 그 언급이
 * 실제 방문으로 이어졌는가를 자사 GA에서 확인한다. 따라서 GA 접근 권한이 있는 브랜드
 * (보통 자사 사이트)에만 동작하고, 경쟁사 테넌트에는 설정하지 않는다.
 *
 * 인증: 서비스 계정(JSON). GOOGLE_SERVICE_ACCOUNT_JSON(인라인 JSON) 또는
 * GOOGLE_APPLICATION_CREDENTIALS(파일 경로) 중 하나. 해당 서비스 계정 이메일을
 * GA4 속성의 "뷰어"로 추가해야 한다.
 */

const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

// GA4 sessionSource 값 → 답변엔진.
//  hosts:  리퍼러 호스트명으로 들어오는 값 — 정확일치 또는 서브도메인(.host)만 인정.
//  tokens: utm_source로 들어오는 맨 토큰 — 정확일치만 인정.
// 부분 문자열(includes) 매칭은 쓰지 않는다 — 'notchatgpt.com'처럼 무관한 도메인을 오분류한다.
const AI_SOURCE_PATTERNS: { engine: string; label: string; hosts: string[]; tokens: string[] }[] = [
  {
    engine: 'openai',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'],
    tokens: ['openai', 'chatgpt'],
  },
  { engine: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai'], tokens: ['perplexity'] },
  { engine: 'gemini', label: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'], tokens: ['gemini', 'bard'] },
  { engine: 'claude', label: 'Claude', hosts: ['claude.ai', 'anthropic.com'], tokens: ['claude'] },
  {
    engine: 'copilot',
    label: 'Copilot',
    hosts: ['copilot.microsoft.com', 'edgeservices.bing.com'],
    tokens: ['copilot'],
  },
  {
    engine: 'other-ai',
    label: '기타 AI',
    hosts: ['you.com', 'poe.com', 'phind.com', 'deepseek.com', 'grok.com', 'x.ai'],
    tokens: ['deepseek', 'grok'],
  },
];

export function classifyAiSource(source: string): { engine: string; label: string } | null {
  const s = source.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return null;
  const bare = s.replace(/^www\./, '');
  for (const p of AI_SOURCE_PATTERNS) {
    if (p.hosts.some((h) => bare === h || bare.endsWith(`.${h}`))) return { engine: p.engine, label: p.label };
    if (p.tokens.includes(bare)) return { engine: p.engine, label: p.label };
  }
  return null;
}

export interface AiReferralRow {
  engine: string;
  label: string;
  sessions: number;
  activeUsers: number;
  engagedSessions: number;
  share: number; // 전체 세션 대비 비중
  sources: string[]; // 이 엔진으로 분류된 원본 sessionSource 값
}

export interface AiReferralReport {
  configured: boolean; // GA4 속성 ID + 서비스 계정이 모두 있는지
  reason?: string; // 미설정/실패 사유(사용자 안내용)
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  rows: AiReferralRow[];
  totalAiSessions: number;
  totalSessions: number;
  aiShare: number; // AI 유입 세션 / 전체 세션
}

const EMPTY = (reason: string): AiReferralReport => ({
  configured: false,
  reason,
  rows: [],
  totalAiSessions: 0,
  totalSessions: 0,
  aiShare: 0,
});

/** 서비스 계정 자격증명을 읽는다(인라인 JSON 우선, 없으면 파일 경로). */
function loadServiceAccount(): { client_email: string; private_key: string } | null {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    try {
      const parsed = JSON.parse(inline) as { client_email?: string; private_key?: string };
      if (parsed.client_email && parsed.private_key) {
        return { client_email: parsed.client_email, private_key: parsed.private_key };
      }
    } catch {
      return null;
    }
  }
  // GOOGLE_APPLICATION_CREDENTIALS(파일 경로)는 google-auth-library가 직접 읽으므로
  // 여기서는 존재 여부만 신호로 쓴다(아래 getAccessToken에서 ADC 경로 사용).
  return null;
}

async function getAccessToken(): Promise<string | null> {
  const sa = loadServiceAccount();
  if (sa) {
    const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [GA_SCOPE] });
    const { access_token } = await jwt.authorize();
    return access_token ?? null;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // 파일 경로 방식(ADC) — google-auth-library가 파일을 읽어 토큰을 만든다.
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: [GA_SCOPE] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token ?? null;
  }
  return null;
}

/** YYYY-MM-DD */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface RunReportResponse {
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  error?: { message?: string };
}

/**
 * 테넌트의 AI 리퍼럴 트래픽을 조회한다. GA 미설정이면 configured:false로 조용히 반환한다
 * (측정 자체를 막지 않는다 — 이 지표는 보조 지표다).
 */
export async function fetchAiReferrals(tenant: TenantConfig, days = 28): Promise<AiReferralReport> {
  const propertyId = (tenant.ga4PropertyId ?? process.env.GA4_PROPERTY_ID ?? '').trim().replace(/^properties\//, '');
  if (!propertyId) {
    return EMPTY('GA4 속성 ID가 없습니다 — 브랜드 설정의 ga4PropertyId 또는 GA4_PROPERTY_ID를 지정하세요.');
  }

  let token: string | null;
  try {
    token = await getAccessToken();
  } catch (err) {
    return EMPTY(`GA 인증 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!token) {
    return EMPTY(
      'GA 서비스 계정이 없습니다 — GOOGLE_SERVICE_ACCOUNT_JSON(또는 GOOGLE_APPLICATION_CREDENTIALS)을 설정하고, 해당 서비스 계정을 GA4 속성 뷰어로 추가하세요.',
    );
  }

  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const body = {
    dateRanges: [{ startDate: isoDate(start), endDate: isoDate(end) }],
    dimensions: [{ name: 'sessionSource' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagedSessions' }],
    limit: 500,
  };

  let json: RunReportResponse;
  try {
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    json = (await res.json()) as RunReportResponse;
    if (!res.ok) {
      return EMPTY(`GA4 조회 실패 (HTTP ${res.status}): ${json.error?.message ?? '알 수 없는 오류'}`);
    }
  } catch (err) {
    return EMPTY(`GA4 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 엔진별로 합산한다(여러 sessionSource가 한 엔진으로 묶일 수 있다).
  const byEngine = new Map<string, AiReferralRow>();
  let totalSessions = 0;

  for (const row of json.rows ?? []) {
    const source = row.dimensionValues?.[0]?.value ?? '';
    const sessions = Number(row.metricValues?.[0]?.value ?? 0);
    const activeUsers = Number(row.metricValues?.[1]?.value ?? 0);
    const engagedSessions = Number(row.metricValues?.[2]?.value ?? 0);
    totalSessions += sessions;

    const hit = classifyAiSource(source);
    if (!hit) continue;
    const cur =
      byEngine.get(hit.engine) ??
      { engine: hit.engine, label: hit.label, sessions: 0, activeUsers: 0, engagedSessions: 0, share: 0, sources: [] };
    cur.sessions += sessions;
    cur.activeUsers += activeUsers;
    cur.engagedSessions += engagedSessions;
    if (!cur.sources.includes(source)) cur.sources.push(source);
    byEngine.set(hit.engine, cur);
  }

  const rows = [...byEngine.values()].sort((a, b) => b.sessions - a.sessions);
  const totalAiSessions = rows.reduce((s, r) => s + r.sessions, 0);
  for (const r of rows) r.share = totalSessions > 0 ? r.sessions / totalSessions : 0;

  return {
    configured: true,
    propertyId,
    startDate: isoDate(start),
    endDate: isoDate(end),
    rows,
    totalAiSessions,
    totalSessions,
    aiShare: totalSessions > 0 ? totalAiSessions / totalSessions : 0,
  };
}
