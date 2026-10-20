/**
 * 실행 항목의 「충족」과 인용 갭의 질문 유형 필터가 **브랜드 이름 없는 질문**(containsBrandName=false)으로 세는지 확인한다.
 *
 * 왜: 2026-10-19 언급률 조사에서, 등재형 카드의 「충족」이 이름을 댄 질문(「OO 어때?」)의 인용만으로도 켜졌다. 이름을 댄
 * 질문은 AI가 그 이름으로 찾아가 우리를 뒷받침하는 페이지를 인용하기 쉽다 — 그래서 이름을 모르는 사람의 질문에서는 아직
 * 우리가 없는 곳이 할 일 목록에서 빠졌다. 아래는 같은 상황을 가짜 데이터로 만든다. 화면 · AI는 부르지 않는다.
 *
 *   npx tsx scripts/verify-unnamed-citations.ts
 */
import { readFileSync } from 'node:fs';
import bankRoute from '../api/question-bank/[tenantId]';
import type { WeeklyScorecard } from '../src/prompts/b8-report';
import type { DemoTenant } from '../server/demoData';
import { DemoResultStore } from '../server/demoStore';
import { computeGapActions } from '../src/lib/gapActions';
import type { QuestionRepeatAnalysis as ClientAnalysis, QuestionSpec } from '../src/lib/types';
import { analyzeCitationSources } from '../server/citationSources';
import { getCitationSourceAnalysis } from '../server/queries';
import type { QuestionBank } from '../server/store';
import type { QuestionRepeatAnalysis } from '../server/types';

const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

const WEEK = '2026-W42';
const question = (questionId: string, containsBrandName: boolean) =>
  ({ questionId, text: containsBrandName ? '가상브랜드 어때?' : '군산 숙소 추천해 줘', category: containsBrandName ? 'brand-direct' : 'category-agnostic', containsBrandName }) as QuestionSpec;
const questions = [question('v2-001', false), question('v2-002', true)];

const cite = (raw: string, supports: boolean, ownerType: 'third-party-authority' | 'brand-owned' = 'third-party-authority') => ({ raw, domain: null, ownerType, supportsBrandMention: supports });
// mentioned — 그 답에 우리 이름이 나왔는지. 이름 없는 질문의 「뒷받침」은 이름이 나온 답에서만 센다(2026-10-21, 맘맘 오분류).
const analysis = (questionId: string, citations: ReturnType<typeof cite>[], mentioned = false) =>
  ({
    questionId,
    engine: 'gemini',
    callIndex: 0,
    mentioned,
    mentionSentences: [],
    competitorMentions: [],
    shareOfMention: 0,
    citations,
    topRecommendation: null,
    brandRank: null,
    factualityClaims: [],
    factualitySupported: 0,
    factualityContradicted: 0,
    brandOwnedCitation: false,
    clarifying: false,
  }) as unknown as QuestionRepeatAnalysis;

// 위키는 이름을 댄 질문에서만 우리를 뒷받침한다. 이름 없는 질문에서는 인용되지만 뒷받침이 없다.
// 네이버 블로그는 이름 없는 질문에서 3회 중 1회(그 답에 우리 이름이 나왔다), 이름을 댄 질문에서 2회 중 2회 뒷받침한다.
const analyses = [
  analysis(
    'v2-001',
    [
      cite('https://namu.wiki/w/가상', false),
      cite('https://blog.naver.com/a/1', true),
      cite('https://blog.naver.com/b/2', false),
      cite('https://blog.naver.com/c/3', false),
    ],
    true,
  ),
  analysis('v2-002', [cite('https://namu.wiki/w/가상', true), cite('https://blog.naver.com/a/1', true), cite('https://blog.naver.com/d/4', true)]),
];
const plan = (qs: QuestionSpec[], list = analyses) =>
  computeGapActions(list as unknown as ClientAnalysis[], qs, analyzeCitationSources(list), {});
const action = (p: ReturnType<typeof plan>, id: string) => p.actions.find((a) => a.id === id);

// 1) 「충족」 — 이름을 댄 질문의 뒷받침만으로는 켜지지 않는다
const wiki = action(plan(questions), 'listing:namu.wiki');
ok('이름을 댄 질문에서만 뒷받침한 곳은 「충족」이 아니다', wiki?.satisfied === false);
ok('근거 문장이 이름을 댄 질문에서만 뒷받침했다고 밝힌다', /이름을 댄 질문에서만 1회/.test(wiki?.evidence ?? ''));
const unnamedHit = [analysis('v2-001', [cite('https://namu.wiki/w/가상', true)], true)];
ok('이름 없는 질문에서 뒷받침하면 「충족」', action(plan(questions, unnamedHit), 'listing:namu.wiki')?.satisfied === true);

// 1-a) 맘맘 오분류 회귀(web4ai W42) — 이름 없는 질문의 답에 우리 이름이 없는데 판정이 「뒷받침」을 붙였다. 이름 없는 질문의 답은
//      이름을 대야만 우리를 가리킬 수 있으니 「충족」이 아니고, 모든 질문 합계(집행 후 대기 문구)에서도 빼야 한다.
const misjudged = [analysis('v2-001', [cite('https://mom-mom.net/travel/places/1', true), cite('https://mom-mom.net/travel/places/2', false)])];
const mommom = action(plan(questions, misjudged), 'listing:mom-mom.net');
ok('언급 없는 답의 「뒷받침」으로는 「충족」이 되지 않는다(맘맘 회귀)', mommom?.satisfied === false);
ok('언급 없는 답의 「뒷받침」은 모든 질문 합계에서도 빠진다', mommom?.support?.all === 0 && mommom.support.unnamed === 0);
ok('근거 문장이 뒷받침 0건이라고 쓴다', /우리를 뒷받침하는 대목은 0건입니다/.test(mommom?.evidence ?? ''));
// 이름을 댄 질문은 「이 숙소는…」처럼 이름 없이 가리킬 수 있어 언급 판정으로 거르지 않는다(1-b의 reddit도 mentioned:false다).
const namedNoMention = action(plan(questions, [analysis('v2-002', [cite('https://namu.wiki/w/가상', true)])]), 'listing:namu.wiki');
ok('이름을 댄 질문에서는 언급 없는 답의 뒷받침도 그대로 센다', namedNoMention?.support?.all === 1);
// 묶음 합계(서버)와 호스트 합계를 빼도 음수가 되지 않는다 — 같은 호스트가 이름 없는 질문에서만 언급 없이 뒷받침한 경우.
const mixed = action(plan(questions, [...misjudged, analysis('v2-002', [cite('https://mom-mom.net/travel/places/3', true)])]), 'listing:mom-mom.net');
ok('언급 없는 뒷받침을 빼도 합계는 0 이상이고 이름 댄 질문의 뒷받침은 남는다', mixed?.support?.all === 1 && mixed.satisfied === false);
ok('은행을 읽지 못하면 이름 없는 질문인지 몰라 켜지 않는다', action(plan([], unnamedHit), 'listing:namu.wiki')?.satisfied === false);
ok('은행을 읽지 못했다고 근거 문장이 밝힌다', /질문 은행을 읽지 못해/.test(action(plan([], unnamedHit), 'listing:namu.wiki')?.evidence ?? ''));
ok('뒷받침이 아예 없으면 예전 문장 그대로', /우리를 뒷받침하는 대목은 0건입니다\./.test(action(plan(questions, [analysis('v2-001', [cite('https://namu.wiki/w/가상', false)])]), 'listing:namu.wiki')?.evidence ?? ''));

ok('집행 후 대기 문구가 가를 수 있게 뒷받침 수를 싣는다', wiki?.support?.all === 1 && wiki.support.unnamed === 0 && wiki.support.known === true);

// 1-b) 이름 없는 질문에서는 아예 인용되지 않는 곳 — 이름 없는 질문 기준의 갭이 아니므로 끝낼 수 없는 할 일로 열지 않는다
//      (실측: banobagi W40 reddit.com — 10회 인용 전부 이름을 댄 질문, 그중 4회 뒷받침)
const namedOnlyCited = [
  analysis('v2-001', [cite('https://namu.wiki/w/가상', false)]),
  analysis('v2-002', [cite('https://www.reddit.com/r/가상/1', true), cite('https://www.reddit.com/r/가상/2', false)]),
];
const reddit = action(plan(questions, namedOnlyCited), 'listing:reddit.com');
ok('이름을 댄 질문에서만 인용되고 거기서 뒷받침하면 「충족」(이미 실린 곳)', reddit?.satisfied === true && /브랜드 이름 없는 질문에서는 인용되지 않는 곳/.test(reddit.evidence));
const redditUnmet = action(plan(questions, [analysis('v2-002', [cite('https://www.reddit.com/r/가상/2', false)])]), 'listing:reddit.com');
ok('이름을 댄 질문에서만 인용되고 뒷받침이 없으면 할 일로 남기고 그렇게 밝힌다', redditUnmet?.satisfied === false && /이름을 댄 질문에서만 인용되는 곳/.test(redditUnmet.evidence) && !/브랜드 이름 없는 질문에서 .*인용이/.test(redditUnmet.doneSignal));

// 2) 블로그 플랫폼 지분 — 이름 없는 질문의 인용으로 낸다
const naver = action(plan(questions), 'listing:platform:blog.naver.com');
ok('지분은 이름 없는 질문의 인용 3회 중 1회', naver?.progress?.supporting === 1 && naver.progress.total === 3 && naver.progress.unnamed === true);
ok('은행을 읽지 못하면 모든 질문으로 세고 그렇게 표시한다', (() => {
  const p = action(plan([]), 'listing:platform:blog.naver.com')?.progress;
  return p?.supporting === 3 && p.total === 5 && p.unnamed === false;
})());

// 3) 서버 집계의 질문 유형 필터
const banks: Record<string, QuestionBank> = {
  v2: { version: 'v2', questions } as unknown as QuestionBank,
};
const store = (history: Partial<WeeklyScorecard>[], list = analyses) => ({
  getQuestionAnalyses: async () => list,
  getScorecardHistory: async () => history as WeeklyScorecard[],
  getQuestionBank: async (_t: string, v: string) => banks[v] ?? null,
});
const card = [{ weekOf: WEEK, questionBankVersion: 'v2' }];
const supportingOf = (a: Awaited<ReturnType<typeof getCitationSourceAnalysis>>, url: string) =>
  a.urls.find((u) => u.raw === url)?.supportingBrandMentionCount;

const all = await getCitationSourceAnalysis(store(card), 't', WEEK);
const unnamed = await getCitationSourceAnalysis(store(card), 't', WEEK, { questions: 'unnamed' });
const named = await getCitationSourceAnalysis(store(card), 't', WEEK, { questions: 'named' });
ok('필터 없으면 예전 그대로(질문 유형 표시 없음)', all.totalCitations === 7 && all.questionScope === undefined);
ok('이름 없는 질문만 — 위키 뒷받침 0', unnamed.totalCitations === 4 && supportingOf(unnamed, 'https://namu.wiki/w/가상') === 0);
ok('이름 없는 질문만 — 어느 은행으로 갈랐는지 밝힌다', unnamed.questionScope?.scope === 'unnamed' && unnamed.questionScope.bankVersion === 'v2' && unnamed.questionScope.responses === 1 && unnamed.questionScope.unknown === 0);
ok('이름을 댄 질문만', named.totalCitations === 3 && supportingOf(named, 'https://namu.wiki/w/가상') === 1);

const v9 = [analysis('v9-001', [cite('https://namu.wiki/w/가상', true)]), analysis('v9-002', [cite('https://namu.wiki/w/가상', false)])];
const noBank = await getCitationSourceAnalysis(store([{ weekOf: WEEK, questionBankVersion: 'v9' }], v9), 't', WEEK, { questions: 'unnamed' });
ok('어느 후보 은행도 없으면 비우고 나누지 못했다고 밝힌다', noBank.totalCitations === 0 && noBank.questionScope?.bankVersion === null && noBank.questionScope.unknown === 2);
const cardBankMissing = await getCitationSourceAnalysis(store([{ weekOf: WEEK, questionBankVersion: 'v9' }]), 't', WEEK, { questions: 'unnamed' });
ok('카드의 은행이 없으면 질문 id 접두(v2)의 은행으로 나눈다', cardBankMissing.questionScope?.bankVersion === 'v2' && cardBankMissing.totalCitations === 4);
// 배포 환경의 합성 주차 — 카드에는 실측 은행 버전이 적혀 있지만 판정은 예시 은행의 id를 단다. 맞는 은행(지금 설정)을 찾아 쓴다.
banks.v3 = { version: 'v3', questions: [question('v3-001', false)] } as unknown as QuestionBank;
const synthetic = await getCitationSourceAnalysis(store([{ weekOf: WEEK, questionBankVersion: 'v3' }]), 't', WEEK, { questions: 'unnamed', currentBankVersion: 'v2' });
ok('카드의 은행이 판정과 맞지 않으면 다음 후보 중 맞는 은행을 쓴다', synthetic.questionScope?.bankVersion === 'v2' && synthetic.totalCitations === 4);
const prefixOnly = await getCitationSourceAnalysis(store([]), 't', WEEK, { questions: 'unnamed', currentBankVersion: 'v9' });
ok('스코어카드에 버전이 없으면 질문 id 접두(v2)로 은행을 찾는다', prefixOnly.questionScope?.bankVersion === 'v2' && prefixOnly.totalCitations === 4);
const stray = await getCitationSourceAnalysis(store(card, [...analyses, analysis('v1-077', [cite('https://namu.wiki/w/옛', true)])]), 't', WEEK, { questions: 'unnamed' });
ok('은행에 없는 질문은 어느 쪽에도 넣지 않고 수를 센다', stray.questionScope?.unknown === 1 && stray.totalCitations === 4);

const otherBank = await getCitationSourceAnalysis(
  { ...store(card), getQuestionBank: async () => ({ version: 'v4', questions } as unknown as QuestionBank) },
  't',
  WEEK,
  { questions: 'unnamed' },
);
ok('다른 버전의 은행이 오면 나누지 못한 것으로 본다(그 은행 버전을 대지 않는다)', otherBank.questionScope?.bankVersion === null && otherBank.totalCitations === 0);
const noMatch = await getCitationSourceAnalysis(store(card, [analysis('v2-999', [cite('https://namu.wiki/w/가상', true)])]), 't', WEEK, { questions: 'unnamed' });
ok('응답이 있는데 은행에서 하나도 못 찾으면 나누지 못한 것으로 본다', noMatch.questionScope?.bankVersion === null && noMatch.questionScope.unknown === 1);

// 3-b) 이름 없는 질문 보기의 「뒷받침」도 언급 있는 답에서만 센다(실행 항목 「충족」과 같은 기준). 전체 · 이름 댄 질문 보기는 그대로.
const mm = [analysis('v2-001', [cite('https://mom-mom.net/travel/places/1', true)])];
const mmUnnamed = await getCitationSourceAnalysis(store(card, mm), 't', WEEK, { questions: 'unnamed' });
const mmAll = await getCitationSourceAnalysis(store(card, mm), 't', WEEK);
ok('이름 없는 질문 보기 — 언급 없는 답의 뒷받침은 0', supportingOf(mmUnnamed, 'https://mom-mom.net/travel/places/1') === 0);
ok('전체 보기 — 저장된 판정 그대로 1', supportingOf(mmAll, 'https://mom-mom.net/travel/places/1') === 1);

// 3-c) 후기·예약 플랫폼 페이지의 「자사」 판정은 믿지 않는다(맘맘을 머뭄으로) — 출처 종류는 후기 플랫폼, URL 행 소유는 unknown.
//      우리 소유 도메인처럼 카탈로그 밖의 자사 판정은 그대로다.
const owned = analyzeCitationSources([
  analysis('v2-001', [cite('https://mom-mom.net/travel/places/9', false, 'brand-owned'), cite('https://www.vstay.example/s/stay', true, 'brand-owned')]),
]);
const momRow = owned.urls.find((u) => u.raw === 'https://mom-mom.net/travel/places/9');
const ownRow = owned.urls.find((u) => u.raw === 'https://www.vstay.example/s/stay');
ok('후기 플랫폼의 자사 판정은 후기 플랫폼 · 소유 unknown으로 본다', momRow?.kind === 'review' && momRow.ownerType === 'unknown');
ok('카탈로그 밖의 자사 판정은 그대로 자사', ownRow?.kind === 'brand-official' && ownRow.ownerType === 'brand-owned');

// 4) 배포 환경(DemoResultStore · api/question-bank) — 실측 판정은 그때 쓴 은행(v1)의 질문 id를 단다. 설정은 v4라 예전에는
//    예시 은행이 와서 이름 없는 질문 기준 화면이 실측 주차마다 비었다.
const tenants = JSON.parse(readFileSync(new URL('../server/tenants.config.json', import.meta.url), 'utf8')) as DemoTenant[];
const kt = tenants.find((t) => t.tenantId === 'kt');
if (!kt) throw new Error('tenants.config.json에 kt가 없습니다 — 다른 실측 테넌트로 바꾸세요');
const demo = new DemoResultStore([kt]);
const demoAll = await getCitationSourceAnalysis(demo, 'kt', '2026-W37');
const demoUnnamed = await getCitationSourceAnalysis(demo, 'kt', '2026-W37', { questions: 'unnamed', currentBankVersion: kt.questionBankVersion });
const demoNamed = await getCitationSourceAnalysis(demo, 'kt', '2026-W37', { questions: 'named', currentBankVersion: kt.questionBankVersion });
ok(
  '배포 환경에서도 실측 주차를 그때 쓴 은행으로 나눈다(이름 없는 + 이름 댄 = 전체)',
  demoAll.totalCitations > 0 &&
    demoUnnamed.totalCitations > 0 &&
    demoUnnamed.totalCitations + demoNamed.totalCitations === demoAll.totalCitations &&
    demoUnnamed.questionScope?.unknown === 0 &&
    demoUnnamed.questionScope.bankVersion !== kt.questionBankVersion,
);
const served = await new Promise<{ version: string }>((resolve) => {
  let body = '';
  void bankRoute(
    { method: 'GET', query: { tenantId: 'kt', version: demoUnnamed.questionScope?.bankVersion ?? '' } } as never,
    { statusCode: 0, setHeader() {}, end(b?: string) { body = b ?? ''; resolve(JSON.parse(body)); } },
  );
});
ok('배포 환경의 질문 은행 라우트가 ?version을 따른다', served.version !== kt.questionBankVersion && served.version === demoUnnamed.questionScope?.bankVersion);

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n모두 통과 (${checks.length}건)`);
