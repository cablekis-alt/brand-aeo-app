import { createHash } from 'node:crypto';
import { linkCompetitorQuestions } from './competitorQuestions.js';
import { isBrandTopic, normalizeTopic } from '../src/prompts/b1c-question-topic.js';
import type { CompetitorContext, QuestionLanguage, QuestionSpec } from '../src/prompts/types.js';
import type { QuestionBank } from './store.js';

/**
 * 경쟁사 편집 4단계 「바뀐 경쟁사 질문만 고치기」 — 질문 넘겨받기를 AI 없이 계산한다(순수 함수).
 *
 * 측정에서 빠지는 경쟁사(outgoing)를 짚은 브랜드 질문은 새로 측정에 드는 경쟁사(incoming)가 넘겨받는다. 넘겨받은 질문만
 * 고쳐 쓰고(문장은 판정 엔진이 쓴다 — competitorRewrite.ts) 나머지 문항은 id · 문장 · 순서까지 그대로 둔 채 다음 버전
 * 은행(v5 → v6)으로 저장한다. 넘겨받을 곳이 없으면 그 질문은 뺀다(42 → 41).
 *
 * 누가 나가고 들어오는지는 측정 id가 아니라 이름(공백 제거)으로 정한다 — 홈페이지만 바꿔도 측정 id는 바뀐다.
 * 서버는 바꾼 목록만 받으므로 누가 누구를 대신했는지는 화면이 힌트로 보낸다(바꿈 · 측정에 넣기).
 */

/** 질문지를 어떻게 하는가 — derive만 새 은행을 만든다. */
export type HandoffMode = 'same' | 'derive' | 'repo' | 'fresh';

/** 화면이 보내는 힌트 — from 자리를 to가 대신했다(이름). */
export interface HandoffHint {
  from: string;
  to: string;
}

export interface HandoffSwap {
  from: CompetitorContext;
  /** 넘겨받는 곳. null이면 받을 곳이 없다(그 질문은 빠진다). */
  to: CompetitorContext | null;
  /** hint: 바꿈 · 측정에 넣기 힌트 · promoted: 새로 측정에 든 곳 · existing: 이미 재는데 비교 질문이 없던 곳. */
  via: 'hint' | 'promoted' | 'existing' | null;
}

export interface HandoffItem {
  fromId: string;
  /** 고쳐 쓴 질문의 새 id(`${toVersion}-${번호}`). 빼면 null. */
  toId: string | null;
  action: 'rewrite' | 'remove';
  source: Pick<QuestionSpec, 'text' | 'topic' | 'category' | 'stage'>;
  /** 이 질문이 짚은 나가는 경쟁사마다 받는 곳. */
  swaps: HandoffSwap[];
  /** 이 질문이 함께 짚은, 계속 목록에 남는 경쟁사 — 고쳐 쓴 문장에도 그대로 있어야 한다. */
  keep: CompetitorContext[];
  /** 고쳐 쓴 문장이 이어져야 할 바꾼 목록의 위치(받는 곳 ∪ keep). */
  expectedIndexes: number[];
  /** 주제에 나가는 경쟁사 이름(또는 그 일부)이 들어 있어 주제도 새로 받는다. */
  topicNeedsRewrite: boolean;
  reason: 'hint' | 'promoted' | 'existing' | 'noReceiver';
}

export interface QuestionPlan {
  mode: HandoffMode;
  fromVersion: string;
  toVersion: string;
  sizeBefore: number;
  sizeAfter: number;
  items: HandoffItem[];
  /** 넘겨받는 곳 → 받은 새 질문 id. */
  receivers: { name: string; ids: string[] }[];
  /** 넘겨받을 곳이 없어 질문이 빠지는 나가는 경쟁사. receiverHasOwn이면 들어온 곳이 이미 자기 질문을 가졌다. */
  unreceived: {
    name: string;
    questionIds: string[];
    reason: 'noReceiver' | 'receiverHasOwn' | 'otherIndustry';
    own?: { name: string; questionIds: string[] };
    /** otherIndustry — 받을 수 있었지만 「업종 다름」으로 표시된 곳. */
    other?: string[];
  }[];
  key: string;
}

export interface HandoffInput {
  /** 지금 질문지(런타임 버전 파일). 없으면 다음 측정이 새 목록으로 만든다. */
  bank: QuestionBank | null;
  /** 지금 런타임 질문지 버전(설정값). */
  version: string;
  brandNames: string[];
  /** 바꾼 목록이 저장소 목록과 같다 — 저장하면 앱 질문지를 버리고 저장소 질문지로 돌아간다. */
  backToRepo: boolean;
  repoVersion: string;
  now: { competitors: CompetitorContext[]; measured: boolean[] };
  next: { competitors: CompetitorContext[]; measured: boolean[] };
  hints: HandoffHint[];
  /** 「업종 다름」으로 표시된 경쟁사 이름 — 비교 질문을 넘겨받지 않는다(competitorIndustry.ts). */
  otherIndustry?: string[];
  /**
   * 이미 재는데 비교 질문이 없는 곳도 받는가(기본 true, 결정 E8). 고친 문장을 확인할 화면이 없는 곳(고객 전환의 「목록에서
   * 빼기」)은 false로 부른다 — 그때는 새로 든 곳만 받고, 받을 곳이 없으면 뺀다.
   */
  existingReceivers?: boolean;
  /** 이미 쓰인 버전 이름(은행 파일 · 카드 · 저장소) — 새 버전은 이 이름을 피한다. */
  taken: Iterable<string>;
}

/** 주제 칸 길이 — 주제 화면 · 집계가 쓰는 normalizeTopic과 같다(넘으면 자르지 않고 비운다). */
const TOPIC_MAX_LENGTH = 24;

/** 글자 비교용 — 띄어쓰기와 대소문자를 무시한다(linkCompetitorQuestions와 같다). */
const fold = (s: string) => s.replace(/\s+/g, '').toLowerCase();
/** 같은 경쟁사인가 — 이름을 같은 규칙으로 접는다(대소문자만 바꾼 「KT → kt」는 같은 곳이다). */
const keyOf = (c: CompetitorContext) => fold(c.name);
const namesOf = (c: CompetitorContext) => [c.name, ...(c.aliases ?? [])].filter(Boolean);

/**
 * 바꾼 목록으로 질문을 다시 잇는다 — 빠지는 이름(나가는 곳 · 목록에서 지운 줄)도 함께 놓고 긴 이름부터 읽는다. 그래야 나간
 * 이름이 남는 곳 · 받는 곳 이름 안에 들어 있어도(초원 / 초원고택) 남는 이름으로 읽고, 지운 긴 이름 안의 짧은 이름을 나간 곳으로
 * 잘못 읽지 않는다. 넘겨받기 계산 · 고쳐 쓴 문장 검사(R4 · R5) · 저장 검사가 모두 이 함수를 쓴다(미리 본 것 = 저장되는 것).
 *
 * nextIndexes: 이어진 바꾼 목록 위치(나가는 곳이 대기로 남아 있으면 그 위치는 빼고 outgoingHit로 센다).
 */
export function linkAfterEdit(
  questions: QuestionSpec[],
  next: CompetitorContext[],
  gone: CompetitorContext[],
  outgoing: CompetitorContext[],
  brandNames: string[],
): { questionId: string; nextIndexes: number[]; outgoingHit: boolean }[] {
  const nextKeys = new Set(next.map(keyOf));
  const outKeys = new Set(outgoing.map(keyOf));
  const combined = [...next, ...gone.filter((c) => !nextKeys.has(keyOf(c)))];
  return linkCompetitorQuestions(questions, combined, brandNames).questions.map((l) => ({
    questionId: l.questionId,
    nextIndexes: l.competitorIndexes.filter((i) => i < next.length && !outKeys.has(keyOf(combined[i]!))),
    outgoingHit: l.competitorIndexes.some((i) => outKeys.has(keyOf(combined[i]!))),
  }));
}

/**
 * 다음 질문지 버전 — 접두는 두고 끝 숫자만 올린다(v5 → v6, en1 → en2, v9 → v10). 쓰인 이름이면 계속 올린다
 * (되돌린 저장이 남긴 v6 파일이 있으면 v7 — 아무도 가리키지 않는 파일이라도 덮어쓰지 않는다).
 */
export function nextBankVersion(from: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const m = /^(.*?)(\d+)$/.exec(from);
  const prefix = m ? m[1]! : from;
  const width = m ? m[2]!.length : 1;
  let n = m ? Number(m[2]) : 1;
  for (;;) {
    n += 1;
    const candidate = `${prefix}${String(n).padStart(width, '0')}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * 주제에 나가는 경쟁사 이름이 들어 있는가 — 이름 전체, 또는 이름의 낱말(2글자 이상)이 들어 있으면 그렇다
 * ('스테이 골목집'의 주제 '골목집과의 비교'). 고객 이름이나 남는 경쟁사 이름에도 있는 낱말('스테이')은 보지 않는다.
 */
export function topicMentions(topic: string | undefined, outgoing: CompetitorContext[], otherNames: string[]): boolean {
  if (!topic) return false;
  const hay = fold(topic);
  const others = otherNames.map(fold).filter(Boolean);
  for (const c of outgoing) {
    for (const name of namesOf(c)) {
      if (hay.includes(fold(name))) return true;
      for (const word of name.split(/[\s,·/()]+/)) {
        const w = fold(word);
        if (w.length < 2 || others.some((o) => o.includes(w))) continue;
        if (hay.includes(w)) return true;
      }
    }
  }
  return false;
}

export function planQuestionHandoff(input: HandoffInput): QuestionPlan {
  const { bank, brandNames } = input;
  const empty = (mode: HandoffMode, toVersion: string): QuestionPlan => {
    const size = bank?.questions.length ?? 0;
    const plan = { mode, fromVersion: input.version, toVersion, sizeBefore: size, sizeAfter: size, items: [], receivers: [], unreceived: [] };
    return { ...plan, key: handoffKey(plan, input) };
  };
  // 저장소 목록으로 돌아가면 저장이 앱 수정본을 지운다(current = null) — 질문지도 저장소 버전으로 돌아가 고칠 것이 없다.
  if (input.backToRepo) return empty(input.version !== input.repoVersion ? 'repo' : 'same', input.repoVersion);
  if (!bank) return empty('fresh', input.version);

  const now = input.now.competitors;
  const next = input.next.competitors;
  const nowMeasured = new Set(now.filter((_, i) => input.now.measured[i]).map(keyOf));
  const nextMeasured = new Set(next.filter((_, i) => input.next.measured[i]).map(keyOf));
  const outgoing = now.filter((c, i) => input.now.measured[i] && !nextMeasured.has(keyOf(c)));
  const incoming = next.filter((c, i) => input.next.measured[i] && !nowMeasured.has(keyOf(c)));
  const outgoingKeys = new Set(outgoing.map(keyOf));
  const nextIndex = new Map(next.map((c, i) => [keyOf(c), i]));
  const gone = now.filter((c) => !nextIndex.has(keyOf(c)));
  const linksNow = linkCompetitorQuestions(bank.questions, now, brandNames);
  const questionsOf = (c: CompetitorContext) => linksNow.byCompetitor[now.indexOf(c)] ?? [];
  // 넘겨줄 질문 — 나가는 곳을 짚은 질문이다. 들어온 곳의 「자기 질문」으로 세지 않는다(옛 이름을 별칭으로 둔 이름 바꾸기 ·
  // 옛 이름의 일부로 바꾸기에서는 넘겨줄 질문이 들어온 곳에도 이어진다).
  const handedOff = new Set(outgoing.flatMap(questionsOf));
  const after = new Map(linkAfterEdit(bank.questions, next, gone, outgoing, brandNames).map((l) => [l.questionId, l.nextIndexes]));
  const named = (questionId: string, c: CompetitorContext) => (after.get(questionId) ?? []).includes(nextIndex.get(keyOf(c)) ?? -1);
  const ownIds = (c: CompetitorContext) => bank.questions.filter((q) => !handedOff.has(q.questionId) && named(q.questionId, c)).map((q) => q.questionId);
  // 고객 이름을 품은 이름은 질문에서 이어지지 않는다(잇기가 고객 이름을 먼저 지운다) — 받아도 고쳐 쓴 질문이 검사를 통과할 수 없다.
  const brandFolds = brandNames.map(fold).filter(Boolean);
  const linkable = (c: CompetitorContext) => namesOf(c).some((n) => !brandFolds.some((b) => fold(n).includes(b)));

  // 받는 곳은 경쟁사 단위로 정한다 — 한 경쟁사의 질문은 모두 같은 곳이 받고, 받는 곳 하나는 나가는 곳 하나만 받는다.
  // 자기 질문이 이미 있는 들어온 곳은 받지 않는다(경쟁사마다 비교 질문 하나). 나가는 곳의 질문이 이미 짚은 곳도 받지 않는다
  // (그 질문이 자기 자신과 견주게 된다).
  const receiver = new Map<CompetitorContext, { to: CompetitorContext; via: 'hint' | 'promoted' | 'existing' }>();
  const taken = new Set<string>();
  // 「이미 짚은 곳」은 지금 목록으로 본다 — 지금 목록에 따로 있던 곳(대기 줄)을 그 질문이 함께 짚었다. 새로 든 곳이 옛 이름을
  // 별칭으로 가져 바꾼 목록에서 이어지는 것(이름 바꾸기)은 넘겨받는다.
  const nowIndex = new Map(now.map((c, i) => [keyOf(c), i]));
  const linkedNow = new Map(linksNow.questions.map((l) => [l.questionId, l.competitorIndexes]));
  const alreadyIn = (o: CompetitorContext, c: CompetitorContext) =>
    nowIndex.has(keyOf(c)) && questionsOf(o).some((id) => (linkedNow.get(id) ?? []).includes(nowIndex.get(keyOf(c))!));
  // 「업종 다름」으로 표시된 곳은 받지 않는다 — 다른 업종 곳과 견주는 질문은 고객 업종 질문이 아니다.
  const otherIndustry = new Set((input.otherIndustry ?? []).map(fold));
  const sameIndustry = (c: CompetitorContext) => !otherIndustry.has(keyOf(c));
  const eligible = (c: CompetitorContext, o: CompetitorContext) =>
    linkable(c) && sameIndustry(c) && !ownIds(c).length && !taken.has(keyOf(c)) && !alreadyIn(o, c);
  // 이미 재는데 비교 질문이 없던 곳(바꾼 목록에서도 잰다) — 새로 든 곳이 없을 때 받는다(결정 E8).
  const staying = next.filter((c, i) => input.next.measured[i] && nowMeasured.has(keyOf(c)));
  const withQuestions = outgoing.filter((o) => questionsOf(o).length > 0);
  // 1) 화면 힌트(바꿈 · 측정에 넣기) — 지금 목록 순서로. 한 자리에 힌트가 여럿이면 나중 것부터 본다.
  for (const o of withQuestions) {
    for (const hint of input.hints.filter((h) => fold(h.from) === keyOf(o)).reverse()) {
      const to = incoming.find((c) => keyOf(c) === fold(hint.to));
      if (!to || !eligible(to, o)) continue;
      receiver.set(o, { to, via: 'hint' });
      taken.add(keyOf(to));
      break;
    }
  }
  // 2) 남은 나가는 곳 — 빼기로 대기 첫 줄이 올라왔거나 추가한 곳이 측정에 들었다. 바꾼 목록 순서로 첫 곳이 받는다.
  for (const o of withQuestions) {
    if (receiver.has(o)) continue;
    const to = incoming.find((c) => eligible(c, o));
    if (!to) continue;
    receiver.set(o, { to, via: 'promoted' });
    taken.add(keyOf(to));
  }
  // 3) 그래도 남은 나가는 곳 — 이미 재는데 비교 질문이 없는 곳이 받는다(바꾼 목록 순서). 그래야 질문지가 덜 줄어든다.
  for (const o of input.existingReceivers === false ? [] : withQuestions) {
    if (receiver.has(o)) continue;
    const to = staying.find((c) => eligible(c, o));
    if (!to) continue;
    receiver.set(o, { to, via: 'existing' });
    taken.add(keyOf(to));
  }

  const toVersion = nextBankVersion(input.version, [...input.taken, input.version]);
  const items: HandoffItem[] = [];
  for (const linked of linksNow.questions) {
    const outs = linked.competitorIndexes.map((i) => now[i]!).filter((c) => outgoingKeys.has(keyOf(c)));
    if (!outs.length) continue;
    const q = bank.questions.find((x) => x.questionId === linked.questionId)!;
    const swaps: HandoffSwap[] = outs.map((from) => {
      const r = receiver.get(from);
      return { from, to: r?.to ?? null, via: r?.via ?? null };
    });
    const keep = linked.competitorIndexes.map((i) => now[i]!).filter((c) => !outgoingKeys.has(keyOf(c)) && nextIndex.has(keyOf(c)));
    // 짚은 경쟁사 가운데 한 곳이라도 받을 곳이 없으면 질문을 통째로 뺀다(결정 D1) — 이름만 빼면 다른 질문이 된다.
    const rewrite = swaps.every((s) => s.to);
    const seq = /-(\d+)$/.exec(q.questionId)?.[1];
    const stay = [...keep, ...swaps.flatMap((s) => (s.to ? [s.to] : []))];
    items.push({
      fromId: q.questionId,
      toId: rewrite ? `${toVersion}-${seq ?? q.questionId}` : null,
      action: rewrite ? 'rewrite' : 'remove',
      source: { text: q.text, ...(q.topic ? { topic: q.topic } : {}), category: q.category, ...(q.stage ? { stage: q.stage } : {}) },
      swaps,
      keep,
      expectedIndexes: rewrite ? stay.map((c) => nextIndex.get(keyOf(c))!).sort((a, b) => a - b) : [],
      topicNeedsRewrite: rewrite && topicMentions(q.topic, outs, [...brandNames, ...stay.flatMap(namesOf)]),
      reason: !rewrite ? 'noReceiver' : swaps.some((s) => s.via === 'existing') ? 'existing' : swaps.some((s) => s.via === 'promoted') ? 'promoted' : 'hint',
    });
  }
  if (!items.length) return empty('same', input.version);

  const receivers = new Map<string, string[]>();
  for (const item of items) {
    if (item.action !== 'rewrite') continue;
    for (const s of item.swaps) receivers.set(s.to!.name, [...(receivers.get(s.to!.name) ?? []), item.toId!]);
  }
  const unreceived: QuestionPlan['unreceived'] = [];
  for (const o of withQuestions) {
    if (receiver.has(o)) continue;
    const own = incoming.find((c) => ownIds(c).length > 0);
    // 업종 다름만 아니었으면 받을 수 있던 곳 — 표시를 풀면 넘겨받는다(화면이 그 이유를 보인다).
    const other = [...incoming, ...staying].filter(
      (c) => !sameIndustry(c) && linkable(c) && !ownIds(c).length && !taken.has(keyOf(c)) && !alreadyIn(o, c),
    );
    unreceived.push({
      name: o.name,
      questionIds: questionsOf(o),
      reason: own ? 'receiverHasOwn' : other.length ? 'otherIndustry' : 'noReceiver',
      ...(own ? { own: { name: own.name, questionIds: ownIds(own) } } : {}),
      ...(!own && other.length ? { other: other.map((c) => c.name) } : {}),
    });
  }
  const removed = items.filter((i) => i.action === 'remove').length;
  const plan = {
    mode: 'derive' as const,
    fromVersion: input.version,
    toVersion,
    sizeBefore: bank.questions.length,
    sizeAfter: bank.questions.length - removed,
    items,
    receivers: [...receivers.entries()].map(([name, ids]) => ({ name, ids })),
    unreceived,
  };
  return { ...plan, key: handoffKey(plan, input) };
}

/**
 * 넘겨받기 계획의 지문 — 미리 본 초안과 저장할 때 다시 계산한 계획이 같은지 본다(3단계 previewKey와 같은 방식).
 * 원문 · 주제 · 받는 곳의 이름과 별칭 · 바꾼 목록 이름이 바뀌면 달라진다.
 */
export function handoffKey(
  plan: Pick<QuestionPlan, 'mode' | 'fromVersion' | 'toVersion' | 'items'>,
  input: Pick<HandoffInput, 'brandNames' | 'next' | 'now'>,
): string {
  const ctx = (c: CompetitorContext) => [c.name, c.aliases ?? []];
  const payload = {
    mode: plan.mode,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    items: plan.items.map((i) => [
      i.fromId,
      i.toId,
      i.action,
      i.source.text,
      i.source.topic ?? null,
      i.source.stage ?? null,
      i.swaps.map((s) => [ctx(s.from), s.to ? ctx(s.to) : null]),
      i.keep.map((c) => c.name),
      i.expectedIndexes,
      i.topicNeedsRewrite,
    ]),
    brand: input.brandNames,
    names: input.next.competitors.map(ctx),
    // 지금 목록도 넣는다 — 빠지는 이름(지운 대기 줄 포함)이 고쳐 쓴 문장 검사에 쓰인다(linkAfterEdit).
    before: input.now.competitors.map(ctx),
  };
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export interface RewriteDraft {
  text: string;
  topic?: string;
}

/** 넘겨받기에서 질문지가 어디서 왔는지 — 저장 뒤에도 무엇을 고쳤는지 알 수 있게 은행에 남긴다. */
export interface DerivedFrom {
  version: string;
  by: 'competitor-edit';
  /** 저장할 때의 저장소 지문(baseFingerprint). */
  base: string;
  replaced: { from: string; to: string }[];
  removed: string[];
}

/**
 * 새 은행을 만든다 — 고쳐 쓴 질문만 새 id · 버전을 달고, 나머지 문항은 객체 그대로 같은 순서에 둔다(번호를 다시 매기지 않는다).
 * cohortBank는 그대로 둔다 — 측정이 그 은행을 그대로 쓰는 조건이다(cohortQuestionBank.ts ensureComposedQuestionBank).
 */
export function deriveQuestionBank(
  base: QuestionBank,
  plan: QuestionPlan,
  drafts: Map<string, RewriteDraft>,
  meta: { now: string; base: string },
): QuestionBank & { derivedFrom: DerivedFrom } {
  if (plan.mode !== 'derive') throw new Error(`질문지를 새로 만들 계획이 아닙니다(${plan.mode}).`);
  const byId = new Map(plan.items.map((i) => [i.fromId, i]));
  const questions: QuestionSpec[] = [];
  for (const q of base.questions) {
    const item = byId.get(q.questionId);
    if (!item) {
      questions.push(q);
      continue;
    }
    if (item.action === 'remove') continue;
    const draft = drafts.get(item.fromId);
    if (!draft) throw new Error(`${item.fromId}의 고쳐 쓴 문장이 없습니다.`);
    const rewritten: QuestionSpec = { ...q, questionId: item.toId!, text: draft.text, version: plan.toVersion };
    const topic = item.topicNeedsRewrite ? draft.topic : q.topic;
    if (topic) rewritten.topic = topic;
    else delete rewritten.topic;
    questions.push(rewritten);
  }
  return {
    version: plan.toVersion,
    generatedAt: meta.now,
    questions,
    ...(base.cohortBank ? { cohortBank: base.cohortBank } : {}),
    derivedFrom: {
      version: base.version,
      by: 'competitor-edit',
      base: meta.base,
      replaced: plan.items.filter((i) => i.action === 'rewrite').map((i) => ({ from: i.fromId, to: i.toId! })),
      removed: plan.items.filter((i) => i.action === 'remove').map((i) => i.fromId),
    },
  };
}

/** 이름을 긴 것부터 빈칸으로 지운다 — 짧은 이름이 긴 이름 안에서 다시 잡히지 않게(초원 / 초원고택). */
function blankNames(text: string, names: string[]): string {
  let hay = fold(text);
  for (const n of [...new Set(names.map(fold).filter(Boolean))].sort((a, b) => b.length - a.length)) hay = hay.split(n).join('\u0000');
  return hay;
}

export interface RewriteCheckContext {
  item: HandoffItem;
  brandNames: string[];
  language: QuestionLanguage;
  /** 바꾼 목록(측정 순서) — expectedIndexes의 기준. */
  next: CompetitorContext[];
  /** 지금 목록에 있다가 바꾼 목록에서 빠지는 곳(나가는 곳 · 지운 대기 줄) — linkAfterEdit가 긴 이름부터 읽는 데 쓴다. */
  gone: CompetitorContext[];
  /** 은행의 다른 문장(공통 포함)과 같은 묶음의 다른 고친 문장 — 같으면 안 된다. */
  otherTexts: string[];
}

/**
 * 고쳐 쓴 질문을 검사한다(R0~R9). 문장은 여기서 정리한다(앞뒤 공백 · 공백 하나) — 미리 본 문장과 저장되는 문장이 같게.
 * 주제(R9)는 실패해도 문장을 거절하지 않는다 — 쓸 수 없는 주제면 비운다(「미분류」, 결정 D5).
 */
export function checkRewrite(raw: unknown, rawTopic: unknown, ctx: RewriteCheckContext): { text: string; topic?: string; reasons: string[] } {
  const { item } = ctx;
  const original = typeof raw === 'string' ? raw.trim() : '';
  const text = original.replace(/\s+/g, ' ');
  if (!text) return { text, reasons: ['빈 문장이에요'] };
  const reasons: string[] = [];
  // R0 · R8: 한 줄짜리 질문이어야 한다 — 줄바꿈 · 코드 블록 · 목록 기호 · 측정 구분용 꼬리표가 섞이면 엔진에 그대로 들어간다.
  if (/[\r\n]|```/.test(original) || /^(?:[-*#>•]|\d+[.)]\s)/.test(text)) reasons.push('한 줄 질문이 아니에요');
  if (text.includes('(영어 질문)')) reasons.push('측정 구분 꼬리표 「(영어 질문)」이 들어 있어요');
  // R2
  if (fold(text) === fold(item.source.text)) reasons.push('원래 질문과 같아요');
  else if (ctx.otherTexts.some((t) => fold(t) === fold(text))) reasons.push('다른 질문과 같아요');
  // R3: 원래 질문에 고객 이름이 있었으면 새 문장에도 있어야 한다(결정 D10 — 이름 없는 질문지도 있다).
  const hasBrand = (t: string) => ctx.brandNames.some((n) => n && fold(t).includes(fold(n)));
  if (hasBrand(item.source.text) && !hasBrand(text)) reasons.push('고객 브랜드 이름이 빠졌어요');
  // R4 · R5: 바꾼 목록과 빠지는 이름을 함께 놓고 긴 이름부터 잇는다(저장 검사와 같은 함수). 이어지는 곳이 정확히 받는 곳 ∪ 남는
  // 경쟁사여야 하고(받는 곳 이름이 있고, 남는 곳을 지우지 않았고, 다른 경쟁사를 넣지 않았다), 나가는 곳에는 이어지지 않아야 한다
  // (초원 → 초원고택처럼 새 이름이 옛 이름을 품어도 새 이름으로 읽는다).
  const outgoing = item.swaps.map((s) => s.from);
  const linked = linkAfterEdit([{ ...(item.source as QuestionSpec), questionId: item.fromId, text }], ctx.next, ctx.gone, outgoing, ctx.brandNames)[0];
  const got = linked?.nextIndexes ?? [];
  if (got.join() !== item.expectedIndexes.join()) {
    const want = item.expectedIndexes.map((i) => ctx.next[i]?.name).join(', ');
    const seen = got.map((i) => ctx.next[i]?.name).join(', ') || '없음';
    reasons.push(`짚은 경쟁사가 달라요(필요: ${want} · 문장: ${seen})`);
  }
  if (linked?.outgoingHit) reasons.push('나간 경쟁사 이름이 남았어요');
  const outKeys = new Set(outgoing.map(keyOf));
  const keepNames = [...ctx.brandNames, ...ctx.next.filter((c) => !outKeys.has(keyOf(c))).flatMap(namesOf)];
  const rest = blankNames(text, [...keepNames, ...ctx.gone.flatMap(namesOf), ...outgoing.flatMap(namesOf)]);
  // R6: 길이 — 원래 질문과 비슷한 길이여야 한다.
  const max = ctx.language === 'en' ? 250 : 150;
  const was = item.source.text.length;
  if (text.length < 10 || text.length > max || text.length < was * 0.5 || text.length > was * 2 + 20) {
    reasons.push(`길이가 맞지 않아요(${text.length}자 · 원래 ${was}자)`);
  }
  // R7: 언어 — 이름을 지운 나머지 글자로 본다.
  const residue = rest.split('\u0000').join('');
  const hangul = (residue.match(/[가-힣]/g) ?? []).length;
  const letters = (residue.match(/[A-Za-z가-힣]/g) ?? []).length;
  if (ctx.language === 'en' && hangul > 0) reasons.push('영어 질문에 한글이 섞였어요');
  if (ctx.language !== 'en' && (letters === 0 || hangul / letters < 0.5)) reasons.push('한국어 질문이 아니에요');
  // R9: 주제 — 나가는 이름이 든 주제만 새로 받는다. 비었거나 「미분류」이거나 길거나(주제 칸 24자), 나간 이름이 남거나, 업체
  // 이름이 주제가 됐으면(주제 매기기의 isBrandTopic과 같은 기준 — 프롬프트만으로는 막지 못한다) 비운다.
  let topic: string | undefined = item.source.topic;
  if (item.topicNeedsRewrite) {
    const t = typeof rawTopic === 'string' ? rawTopic.replace(/\s+/g, ' ').replace(/^["'`]|["'`]$/g, '').trim() : '';
    const clean = t.length <= TOPIC_MAX_LENGTH ? normalizeTopic(t) : undefined;
    const names = [...keepNames, ...ctx.gone.flatMap(namesOf), ...outgoing.flatMap(namesOf)];
    topic = clean && !topicMentions(clean, outgoing, keepNames) && !isBrandTopic(clean, names) ? clean : undefined;
  }
  return { text, ...(topic ? { topic } : {}), reasons };
}
