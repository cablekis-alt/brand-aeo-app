import type { AnswerEvidence } from '../src/lib/answerEvidence.js';
import type { PhotoPick } from '../src/lib/articlePhotos.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  articleFormatOf,
  buildContentDraftPrompt,
  DRAFT_ROLES,
  type ContentDraft,
  type ContentDraftRequest,
  type DraftBlock,
  type DraftFormat,
  type DraftImage,
  type DraftRole,
  type DraftSection,
} from '../src/prompts/b9c-content-draft.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { findOverclaims } from './claimGuard.js';
import type { EngineClient } from './engines/types.js';
import { createFactGuard } from './factGuard.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 초안은 브리프와 같은 방식으로 테넌트 파일 하나(drafts.json)에 actionId별로 저장한다.
 * 실행 항목 id가 주차에 묶이지 않으므로 다음 주에도 같은 초안을 다시 쓴다.
 */
export interface StoredDraft {
  /** 이 글을 쓴 모델(대체 모델로 답했으면 그 모델). 예전 기록에는 없다. */
  model?: string;
  actionId: string;
  generatedAt: string;
  draft: ContentDraft;
  /**
   * 사람이 고친 마크다운. 있으면 화면·내보내기가 이것을 쓴다.
   *
   * 구조화된 draft는 그대로 둔다 — 되돌릴 수 있어야 하고, 다시 만들기를 누르면 새 draft가
   * 오면서 이 필드가 지워진다(화면이 먼저 경고한다).
   */
  editedMarkdown?: string;
  editedAt?: string;
  /**
   * 고친 글에 대한 사실 가드 경고. **막지 않는다** — 사람이 확인한 사실일 수 있다.
   * 다만 출처 없는 숫자가 들어왔다는 사실은 알려야 한다. 우리가 판정 엔진에 요구하는 기준을
   * 사람에게만 면제하면 그 기준이 무의미해진다.
   */
  editWarnings?: string[];
  /**
   * 빈칸을 화면에서 채운 기록 — 키는 `절 번호:블록 번호`(그 초안 안에서만 뜻이 있다).
   *
   * 예전에는 값을 넣으면 사실로 저장하고 **초안을 통째로 다시 썼다**(판정 1~2회, 1~2분). 빈칸은
   * 문단 하나를 비운 자리라 값만으로는 문장이 되지 않아서였다. 이제는 그 자리에 「항목: 값」
   * 한 줄을 넣고 다시 쓰지 않는다(src/lib/draftGaps.ts가 내보내기에 반영). 다시 만들기로 새 초안이
   * 오면 이 기록은 버린다 — 넣은 값은 이미 브랜드 사실에 있어 새 초안이 처음부터 쓴다.
   */
  gapFills?: Record<string, GapFill>;
  /**
   * 실측 사례 — 저장된 측정 기록에서 코드가 고른 AI 응답 발췌(src/lib/answerEvidence.ts). 사람이 원문과 대조해
   * 확인해야(confirmedAt) 발행본에 붙는다. 다시 만들기로 새 초안이 와도 남긴다 — 사례는 글이 아니라 측정에서 왔다.
   */
  evidence?: AnswerEvidence;
  /**
   * 사람이 고른 홈페이지 사진(src/lib/articlePhotos.ts) — 본문에 넣지 않고 내보낼 때만 사진 자리에 넣는다(본문 지문 · 사실 가드가
   * 바뀌지 않게). 다시 만들기로 새 초안이 오면 버린다 — 사진 자리가 바뀐다.
   */
  photos?: PhotoPick[];
}

/** 빈칸 하나의 처리 — 확인한 값, 뺌, 또는 페이지에서 찾아 둔 후보(아직 확인 전). */
export interface GapFill {
  value?: string;
  omit?: boolean;
  suggested?: string;
  sourceUrl?: string;
}
type DraftMap = Record<string, StoredDraft>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'drafts.json');
}

export async function readDrafts(tenantId: string): Promise<DraftMap> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as DraftMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * drafts.json 쓰기를 테넌트별로 줄 세운다. 쓰는 길이 다섯(초안 · 빈칸 · 편집 · 실측 사례 · 사진)이라, 줄을 세우지 않으면
 * 판정 호출을 기다리는 사이 다른 길이 쓴 내용을 옛 스냅샷으로 덮는다. 판정 호출은 줄 밖에서 하고, 줄 안에서는
 * 파일을 다시 읽어 그 항목만 바꾼다.
 */
const draftWrites = new Map<string, Promise<unknown>>();
function updateDrafts<T>(tenantId: string, task: (map: DraftMap) => Promise<T> | T): Promise<T> {
  const prev = draftWrites.get(tenantId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const map = await readDrafts(tenantId);
    const result = await task(map);
    await writeDrafts(tenantId, map);
    return result;
  });
  // 앞 작업이 실패해도 다음 작업은 돈다 — 실패는 그 호출자에게만 간다.
  draftWrites.set(
    tenantId,
    run.catch(() => undefined),
  );
  return run;
}

async function writeDrafts(tenantId: string, map: DraftMap): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await rename(tmp, target);
}

/** 문장 단위로 자른다. 가드는 문장 하나씩 보고, 걸린 문장만 버린다(문단 통째로 버리지 않는다). */
export function splitSentences(text: string): string[] {
  // 마침표 뒤가 숫자면 문장 끝이 아니다 — 사이트 원문 그대로인 전화번호 "+82. 2. 522. 6636"이
  // 조각으로 잘려 조각마다 사실 가드에 걸렸다.
  // 칭호·약어(Dr. Mr. St. …) 뒤의 마침표도 문장 끝이 아니다 — "Led by Dr. Choi Soon Woo, …"가
  // "Led by Dr."와 나머지로 잘려, 격상 가드가 뒤쪽만 빼자 "Led by Dr."라는 조각이 원고에 남았다
  // (실측: 뷰 영어 원고). "No."는 넣지 않는다 — 뒤에 숫자가 오면 위 규칙이 이미 막고, 숫자가
  // 아니면 대답 "No."일 수 있다.
  // 굵게 닫는 ** 바로 뒤도 문장 끝이다 — 「**핵심 문장.** 다음 문장」이 한 문장으로 묶이면 뒤 문장이 걸릴 때 핵심 문장까지 빠진다.
  // 다만 약어 예외는 ** 앞의 「Dr.」에도 적용하고(「**Led by Dr.** Choi …」), 「**Q.**」 「**주의!**」 같은 짧은 굵은 꼬리표는
  // 문장이 아니라 다음 문장에 붙인다 — 따로 두면 뒤 문장이 걸릴 때 꼬리표만 남는다.
  const parts = text
    .split(/(?<=[.!?。](?:\*\*)?|다\.|요\.)(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Mt|vs)\.(?:\*\*)?)\s+(?!\d)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && BOLD_LABEL.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * 굵은 꼬리표(「**Q.**」 「**A.**」 「**1.**」 「**주의!**」) — 문장이 아니다. 정해 둔 말만 꼬리표로 본다: 길이로 가르면
 * 「**예약은 필수입니다.**」 같은 짧은 진짜 문장까지 다음 문장에 붙어, 뒤 문장이 걸릴 때 함께 빠진다.
 */
const BOLD_LABEL = /^\*\*(?:Q|A|[QA]?\d{1,2}|주의|참고|팁|TIP|NOTE)[.!?:]?\*\*$/i;

/**
 * 글 속 주소 — 스킴(https://) · www. · 도메인 꼴(gasang-stay.co.kr, linktr.ee/…, booking.naver.com/…). 스킴 · www 뒤와 경로는
 * 공백 · 괄호 · 따옴표 · 굵게 표시 전까지 주소 후보로 잡는다(「https://가상여행.kr」 「…/가상여행」처럼 한글이 섞여도). 뒤에 붙은
 * 조사 · 어미(「…kr입니다」)는 비교할 때 addressKey가 뗀다. 경로 없는 도메인은 흔한 최상위 도메인일 때만, 경로가 붙은 도메인은
 * 파일 확장자가 아닐 때만 주소로 본다(「robots.txt/sitemap.xml」 「Next.js/React」를 주소로 읽지 않게).
 */
const URL_CHARS = `[^\\s()\\[\\]<>"'「」*·（）“”‘’,]`;
const FILE_EXT = '(?:txt|xml|js|mjs|ts|jsx|tsx|html?|json|md|png|jpe?g|gif|svg|webp|pdf|csv|css|php|py|java|go|rb|zip|exe|mp4|mp3|docx?|xlsx?|pptx?)';
const ADDRESS = new RegExp(
  [
    `https?:\\/\\/${URL_CHARS}+`,
    `\\bwww\\.${URL_CHARS}+`,
    `\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)*\\.(?!${FILE_EXT}\\/)[a-z]{2,}\\/${URL_CHARS}*`,
    `\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|co\\.kr|or\\.kr|go\\.kr|kr|io|ai|me|info|biz|shop|site|xyz|app|dev|co|be|ee|ly|gle|tv|to|gg|link|page|store|blog|online|top|us|jp|cc)\\b`,
  ].join('|'),
  'gi',
);
const ADDRESS_TERMS = new Set(['schema.org']);
/** 경로 자리에 온 한글이 조사 · 어미뿐인 경우(「https://kt.com/에서」) — 경로가 아니라 문장이다. */
const ENDING = /^(?:에서|에게|으로|부터|까지|이나|에|로|을|를|이|가|은|는|의|와|과|도|나|만|처럼|입니다|이에요|예요|이며|이고)(?:도|는|만)?[.,;:!?]*$/;

/**
 * 비교용 주소 — 소문자, 스킴 · www.를 걷고, 주소 뒤에 붙은 한글(조사 · 어미 · 문장)을 뗀다. 한글 바로 앞이 / ? = & # 이면 경로
 * (「…/가상여행」)라 두되, 그 한글이 조사뿐이면 뗀다. 호스트가 한글로 시작하면(「가상여행.kr」) 그대로 둔다. 끝 문장부호 · / 도 걷는다.
 * 원문 · 사실 쪽 주소에도 같은 규칙을 써서 「…kr에서」와 「…kr입니다」가 같은 주소로 맞춰진다.
 */
function addressKey(raw: string): string {
  let a = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const hangul = a.search(/[가-힣ㄱ-ㅎㅏ-ㅣ]/);
  if (hangul > 0) {
    const tail = a.slice(hangul);
    if (!/[/?=&#]/.test(a[hangul - 1]!) || ENDING.test(tail)) a = a.slice(0, hangul);
  }
  return a.replace(/[.,;:!?]+$/, '').replace(/\/+$/, '');
}

/**
 * 원문 · 사실에 없는 주소. 주소 단위로 비교한다 — 글자 일부가 겹친다고 같은 주소가 아니다(「gasang.co.kr」 ≠ 「hotel-gasang.co.kr」,
 * 경로를 자른 「…/ro」 ≠ 「…/rooms/deluxe」). 허용: 같은 주소(조사 · 어미가 붙어도), 경로 없이 쓴 같은 사이트(그 호스트 · 상위 도메인).
 */
export function foreignAddresses(text: string, allowed: string): string[] {
  const known = new Set((allowed.match(ADDRESS) ?? []).map(addressKey).filter(Boolean));
  const hosts = [...known].map((k) => k.split('/')[0]!);
  const ok = (key: string): boolean => {
    if (!key || ADDRESS_TERMS.has(key) || known.has(key)) return true;
    return !key.includes('/') && hosts.some((h) => h === key || h.endsWith(`.${key}`));
  };
  return (text.match(ADDRESS) ?? []).filter((a) => !ok(addressKey(a)));
}

/** 블로그 글 형식에서 사진 자리는 이만큼까지 — 사진이 많으면 사람이 다 채우지 못하고 빈 자리가 남는다. */
const MAX_IMAGES = 3;
/** 사진 설명이 이보다 길면 설명이 아니라 문단이다 — 설명은 빼고 자리만 남긴다. */
const MAX_IMAGE_TEXT = 160;

/** key · quote는 한 덩어리다 — 일부 문장만 남기면 뜻이 바뀐다. 걸리면 칸째 뺀다(채울 사실이 아니라 고쳐 쓸 문장이라 빈칸으로 두지 않는다). */
const WHOLE_ROLES = new Set<DraftRole>(['key', 'quote']);
const ROLE_NAME: Record<DraftRole, string> = { key: '핵심 문장', action: '할 일', why: '이유', quote: '그대로 쓸 말', limit: '한계' };

/** 표 줄 — 블로그 글 형식은 표를 넣지 않는다(붙여 넣는 블로그 편집기가 표를 깨뜨린다). */
const TABLE_LINE = /^\s*\|/m;

/**
 * 블로그 글 형식 본문에서 엔진이 넣은 마크다운 기호를 걷는다 — 굵게 · 인용 · 번호는 내보낼 때 코드가 입힌다
 * (src/lib/markdownFile.ts). 남겨 두면 `****`처럼 겹치거나 사진 자리 · 캡션 줄이 깨진다. 링크는 글자만 남긴다.
 * 여러 줄이면 줄마다 목록 기호를 걷어 한 문단으로 잇고, 표 줄은 뺀다(cleanBlocks가 기록을 남긴다).
 */
function plainArticleText(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((line) => !TABLE_LINE.test(line))
    .map((line) =>
      line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|[*`[\]]/g, '')
        .replace(/^\s*(?:#+|>+|[-•]|\d{1,2}[.)])\s+/, '')
        .trim(),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 절 제목 앞 번호(「1.」 「Q2)」 「3 - 」) — 번호는 내보낼 때 코드가 실린 순서대로 붙인다. 번호 뒤에 숫자가 이어지면
 * (「1.5배」 「1:1 상담」 「10-20대」 「3.5km」) 번호가 아니라 사실이라 그대로 둔다 — 절 제목은 사실 가드를 거치지 않는다.
 */
function stripHeadingNumber(h: string): string {
  return h
    .replace(/\*\*/g, '')
    .replace(/^\s*#*\s*(?:Q\s*)?\d{1,2}\s*[.):](?!\d)\s*/i, '')
    .replace(/^\s*#*\s*(?:Q\s*)?\d{1,2}\s+[-–—]\s+(?!\d)/i, '')
    .trim();
}

/**
 * 판정이 쓴 초안을 사실 가드에 통과시킨다. 브리프와 **같은 모듈**을 쓴다.
 *
 * 문단에서 가드에 걸린 문장만 빼고, 남는 문장이 없으면 그 문단을 gap으로 바꾼다 —
 * 문단을 조용히 없애면 글이 왜 짧아졌는지 알 수 없다. gap이면 화면이 "여기를 채우면 완성"으로
 * 보여 주고, guardNotes에 이유가 남는다.
 *
 * 블로그 글 형식(format 'article')은 여기에 더해 문단 구실(role)을 받고, 사진 자리를 3곳까지 남기고,
 * 주소가 든 문장을 뺀다. 핵심 문장 · 그대로 쓸 말은 걸리면 칸째 뺀다(WHOLE_ROLES).
 */
function normalize(
  raw: unknown,
  facts: ContentDraftRequest['factGraph'],
  questionTexts: string[],
  format?: DraftFormat,
): ContentDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { canonicalFacts, guardSentence, notes } = createFactGuard(facts, questionTexts);
  const article = format === 'article';
  /** 주소로 써도 되는 글자 — 사실 값 · 항목 이름 · 질문(브랜드 홈페이지 주소가 사실로 들어 있으면 그 주소는 쓴다). */
  const allowedAddresses = [...facts.map((f) => `${f.claim} ${f.value}`), ...questionTexts].join('\n');
  /** 옛 형식은 가드만, 블로그 글 형식은 주소 문장을 먼저 뺀 뒤 가드. */
  const passes = (s: string): boolean => {
    if (article && foreignAddresses(s, allowedAddresses).length) {
      notes.push(`"${s.slice(0, 60)}…" — 주소가 든 문장은 넣지 않았습니다(링크는 확인한 것만 글 끝에 붙습니다).`);
      return false;
    }
    return guardSentence(s);
  };

  // 팩트 그래프의 **항목 이름**이 문장에 그대로 박힌 경우를 찾는다.
  //
  // 값을 글자 그대로 쓰라는 규칙을 판정이 과하게 적용해 "마취과 전담 원장 수: 3명이 상주하며"처럼
  // 쓴다(실측). 문장을 버리지는 않는다 — 내용은 맞고 어투만 어색하며, 여기서 이름을 기계적으로
  // 지우면 "3명이 상주하며"가 되어 뜻을 잃는다. 대신 기록에 남겨 사람이 다듬을 곳을 알려 준다.
  const noteLabelLeak = (sentence: string): void => {
    for (const f of facts) {
      if (!f.claim) continue;
      if (sentence.includes(`${f.claim}: ${f.value}`) || sentence.includes(`${f.claim}:${f.value}`)) {
        notes.push(`"${sentence.slice(0, 60)}…" — 사실 항목 이름 "${f.claim}"이 문장에 그대로 들어갔습니다. 우리말로 풀어 쓰세요.`);
      }
    }
  };

  const cleanBlocks = (input: unknown): DraftBlock[] => {
    if (!Array.isArray(input)) return [];
    const out: DraftBlock[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (o.kind === 'gap') {
        const need = String(o.need ?? '').trim();
        if (!need) continue;
        // 브랜드 밖의 정보(시장 통계 · 업계 평균 · 공공기관 · 다른 업체)가 필요한 빈칸은 브랜드가 채울 수 없다 — 실측으로
        // 초안 19편의 빈칸 79곳 중 값을 넣은 곳이 0곳이었다. 빈칸으로 두지 않고 기록만 남긴다(엔진이 external로 표시한 것만,
        // 표시가 없으면 브랜드 빈칸으로 둔다).
        if (article && o.scope === 'external') {
          notes.push(`「${need.slice(0, 80)}」 — 브랜드 밖의 정보라 빈칸으로 두지 않고 뺐습니다.`);
          continue;
        }
        out.push({ kind: 'gap', need });
        continue;
      }
      if (article && TABLE_LINE.test(String(o.body ?? ''))) {
        notes.push('표는 블로그 글 형식에 넣지 않아 표 줄을 뺐습니다 — 항목을 문장으로 풀어 쓰세요.');
      }
      const body = article ? plainArticleText(String(o.body ?? '')) : String(o.body ?? '').trim();
      if (!body) continue;
      const role = article && DRAFT_ROLES.includes(o.role as DraftRole) ? (o.role as DraftRole) : undefined;
      const all = splitSentences(body);
      const kept = all.filter(passes);
      if (role && WHOLE_ROLES.has(role) && kept.length < all.length) {
        if (all.length > 1) notes.push(`"${body.slice(0, 60)}…" — ${ROLE_NAME[role]}의 문장 일부가 걸려 칸째 뺐습니다.`);
        continue;
      }
      for (const s of kept) noteLabelLeak(s);
      if (kept.length === 0) {
        out.push({ kind: 'gap', need: '이 문단의 문장이 모두 사실 확인에 걸렸습니다 — 아래 검증 기록 참고' });
        continue;
      }
      out.push(role ? { kind: 'text', body: kept.join(' '), role } : { kind: 'text', body: kept.join(' ') });
    }
    return out;
  };

  // 사진 자리 — 장면(alt)과 설명(caption)도 사실 확인을 받는다. 장면이 걸리면 자리째, 설명만 걸리면 설명만 뺀다.
  const cleanImage = (input: unknown): DraftImage | undefined => {
    if (!article || !input || typeof input !== 'object') return undefined;
    const o = input as Record<string, unknown>;
    const alt = plainArticleText(String(o.alt ?? ''));
    if (!alt || alt.length > MAX_IMAGE_TEXT || !passes(alt)) return undefined;
    const caption = plainArticleText(String(o.caption ?? ''));
    return caption && caption.length <= MAX_IMAGE_TEXT && passes(caption) ? { alt, caption } : { alt };
  };

  let images = 0;
  const sections: DraftSection[] = Array.isArray(r.sections)
    ? (r.sections as unknown[])
        .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
        .map((x): DraftSection => {
          const heading = article ? stripHeadingNumber(String(x.heading ?? '')) : String(x.heading ?? '').trim();
          const section: DraftSection = { heading, answers: String(x.answers ?? '').trim(), blocks: cleanBlocks(x.blocks) };
          // 빠질 절(제목 없음 · 블로그 글 형식에서 문단 없음)의 사진은 세지 않는다 — 다음 절의 사진 자리를 뺏지 않게.
          const image = heading && (!article || section.blocks.length > 0) ? cleanImage(x.image) : undefined;
          if (image && images < MAX_IMAGES) {
            images += 1;
            section.image = image;
          }
          return section;
        })
        // 블로그 글 형식은 문단이 하나도 남지 않은 절(바깥 정보 빈칸만 있던 절)도 뺀다 — 제목만 남은 절은 글이 깨진 것처럼 보인다.
        .filter((s) => s.heading && (!article || s.blocks.length > 0))
    : [];

  const leadRaw = typeof r.lead === 'string' ? r.lead.trim() : '';
  const lead = splitSentences(article ? plainArticleText(leadRaw) : leadRaw).filter(passes).join(' ');

  // 초안이 실제로 쓴 사실 — 본문에 값이 그대로 들어간 것만 센다(정본 형태로).
  const blob = [lead, ...sections.flatMap((s) => [...s.blocks.map((b) => b.body ?? ''), ...imageTexts(s)])].join('\n');
  const usedFacts = canonicalFacts(facts.filter((f) => blob.includes(f.value)).map((f) => `${f.claim}: ${f.value}`));

  const gapCount = sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'gap').length, 0);
  const titleRaw = typeof r.title === 'string' ? r.title.trim() : '';

  return {
    title: article ? titleRaw.replace(/\*\*|^#+\s*/g, '').trim() : titleRaw,
    lead,
    sections,
    gapCount,
    usedFacts,
    ...(notes.length ? { guardNotes: notes } : {}),
    ...(article ? { format: 'article' as const } : {}),
  };
}

/** 사진 자리의 글자(장면 · 설명) — 쓴 사실을 셀 때와 격상 검사에 넣는다. */
function imageTexts(s: DraftSection): string[] {
  return s.image ? [s.image.alt, ...(s.image.caption ? [s.image.caption] : [])] : [];
}

/**
 * 격상 가드(claimGuard)에 걸린 문장을 초안에서 뺀다. 사실 가드와 같은 방식이다 — 문단이 비면 gap으로
 * 바꾸고, 쓴 사실 목록과 빈칸 수를 다시 센다.
 */
function dropOverclaims(draft: ContentDraft, overclaimed: Set<string>, facts: ContentDraftRequest['factGraph']): ContentDraft {
  const keep = (text: string) => splitSentences(text).filter((s) => !overclaimed.has(s)).join(' ');
  const sections = draft.sections.map((s): DraftSection => {
    const blocks = s.blocks.flatMap((b): DraftBlock[] => {
      if (b.kind !== 'text' || !b.body) return [b];
      const body = keep(b.body);
      // 핵심 문장 · 그대로 쓸 말은 한 문장이라도 빠지면 칸째 뺀다(normalize와 같은 원칙).
      if (b.role && WHOLE_ROLES.has(b.role) && body !== b.body) return [];
      return body
        ? [{ ...b, body }]
        : [{ kind: 'gap', need: '이 문단의 문장이 사실보다 크게 말해 빠졌습니다 — 아래 검증 기록 참고' }];
    });
    if (!s.image) return { ...s, blocks };
    // 사진 장면이 걸리면 자리째, 설명만 걸리면 설명만 뺀다.
    const { image, ...rest } = s;
    if (overclaimed.has(image.alt)) return { ...rest, blocks };
    const caption = image.caption && !overclaimed.has(image.caption) ? image.caption : undefined;
    return { ...rest, blocks, image: caption ? { alt: image.alt, caption } : { alt: image.alt } };
  });
  const lead = keep(draft.lead);
  const blob = [lead, ...sections.flatMap((s) => [...s.blocks.map((b) => b.body ?? ''), ...imageTexts(s)])].join('\n');
  const usedFacts = draft.usedFacts.filter((line) => {
    const fact = facts.find((f) => `${f.claim}: ${f.value}` === line);
    return fact ? blob.includes(fact.value) : true;
  });
  const gapCount = sections.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'gap').length, 0);
  return { ...draft, lead, sections, usedFacts, gapCount };
}

/** 초안의 문장 전부(첫머리 + 본문 + 사진 자리 글자). 격상 가드에 넘긴다. */
function draftSentences(draft: ContentDraft): string[] {
  return [
    ...splitSentences(draft.lead),
    ...draft.sections.flatMap((s) => [
      ...s.blocks.flatMap((b) => (b.kind === 'text' && b.body ? splitSentences(b.body) : [])),
      ...imageTexts(s),
    ]),
  ];
}

export async function generateDraft(
  tenantId: string,
  actionId: string,
  req: ContentDraftRequest,
  /** 글을 쓰는 엔진(WRITER_ENGINE). */
  writer: EngineClient,
  /** 쓴 글의 사실 격상을 검사하는 엔진 — 판정 엔진. 쓴 모델과 다른 모델이 검사한다. 없으면 writer. */
  checker: EngineClient = writer,
): Promise<StoredDraft> {
  const result = await writer.call(buildContentDraftPrompt(req));
  let draft = normalize(parseJsonLoose<unknown>(result.text), req.factGraph, req.questionTexts, articleFormatOf(req));
  if (!draft) throw new Error('초안 응답을 해석할 수 없습니다(JSON 아님). 다시 시도하세요.');
  if (draft.sections.length === 0) throw new Error('초안에 본문 절이 없습니다. 브리프를 먼저 확인하세요.');
  // 숫자 가드 다음에 격상 가드 — 숫자 없이 주체·범위가 커진 문장을 뺀다.
  const claims = await findOverclaims(draftSentences(draft), req.factGraph, checker, 'drop');
  if (claims.overclaimed.size) draft = dropOverclaims(draft, claims.overclaimed, req.factGraph);
  if (claims.notes.length) draft = { ...draft, guardNotes: [...(draft.guardNotes ?? []), ...claims.notes] };
  const fresh: StoredDraft = { actionId, generatedAt: new Date().toISOString(), ...(result.model ? { model: result.model } : {}), draft };
  return updateDrafts(tenantId, (map) => {
    // 빈칸 기록 · 고친 글 · 고른 사진은 옛 초안의 것이라 버리고, 실측 사례는 이어받는다.
    const evidence = map[actionId]?.evidence;
    const stored: StoredDraft = evidence ? { ...fresh, evidence } : fresh;
    map[actionId] = stored;
    return stored;
  });
}

/**
 * 실측 사례를 바꾼다 — update가 지금 사례(없으면 undefined)를 받아 새 사례를 돌려준다(undefined면 지운다).
 * 판정 호출이 없다. 초안이 없으면 throw.
 */
export async function saveEvidence(
  tenantId: string,
  actionId: string,
  update: (current: AnswerEvidence | undefined) => AnswerEvidence | undefined,
): Promise<StoredDraft> {
  return updateDrafts(tenantId, (map) => {
    const current = map[actionId];
    if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');
    const evidence = update(current.evidence);
    const stored: StoredDraft = { ...current, ...(evidence ? { evidence } : {}) };
    if (!evidence) delete stored.evidence;
    map[actionId] = stored;
    return stored;
  });
}

const GAP_KEY = /^\d{1,3}:\d{1,3}$/;
const MAX_FILL = 500;

/** 빈칸 기록을 저장한다. 판정 호출이 없다 — 값은 사람이 확인한 것이고, 화면이 브랜드 사실에도 넣는다. */
export async function saveGapFills(
  tenantId: string,
  actionId: string,
  fills: Record<string, unknown>,
): Promise<StoredDraft> {
  const clean: Record<string, GapFill> = {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FILL) : undefined);
  for (const [key, raw] of Object.entries(fills)) {
    if (!GAP_KEY.test(key) || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const fill: GapFill = {};
    const value = text(r.value);
    const suggested = text(r.suggested);
    const sourceUrl = text(r.sourceUrl);
    if (r.omit === true) fill.omit = true;
    else if (value) fill.value = value;
    if (suggested) fill.suggested = suggested;
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) fill.sourceUrl = sourceUrl;
    if (Object.keys(fill).length) clean[key] = fill;
  }
  return updateDrafts(tenantId, (map) => {
    const current = map[actionId];
    if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');
    const stored: StoredDraft = { ...current, gapFills: clean };
    if (!Object.keys(clean).length) delete stored.gapFills;
    map[actionId] = stored;
    return stored;
  });
}

/** 화면이 본 초안이 그사이 다시 만들어졌다 — 그 초안의 사진 자리에 고른 사진을 저장하지 않는다(라우트가 409로 답한다). */
export class DraftChangedError extends Error {}

/**
 * 고른 홈페이지 사진을 바꾼다 — update가 지금 목록을 받아 새 목록을 돌려준다. 판정 호출이 없다. 화면이 본 초안(generatedAt)과
 * 지금 초안이 다르면 DraftChangedError — 다시 만드는 1~2분 사이에 고른 사진이 새 초안에 엉뚱하게 붙지 않게.
 */
export async function savePhotoPicks(
  tenantId: string,
  actionId: string,
  generatedAt: string,
  update: (current: PhotoPick[]) => PhotoPick[],
): Promise<StoredDraft> {
  return updateDrafts(tenantId, (map) => {
    const current = map[actionId];
    if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');
    if (current.generatedAt !== generatedAt) throw new DraftChangedError('그사이 초안이 다시 만들어졌어요. 초안을 다시 불러온 뒤 사진을 골라 주세요.');
    const photos = update(current.photos ?? []);
    const stored: StoredDraft = { ...current, photos };
    if (!photos.length) delete stored.photos;
    map[actionId] = stored;
    return stored;
  });
}

/**
 * 「… {N}가지」 제목의 모양 — 코드가 채운 절 수는 고친 글의 사실 확인에서 뺀다(그 숫자는 글이 실은 절 수다).
 * 블로그 글 형식이고 제목에 {N}이 있을 때만.
 */
function countedTitle(draft: ContentDraft): RegExp | null {
  if (draft.format !== 'article' || !draft.title.includes('{N}')) return null;
  const parts = draft.title.split('{N}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('\\d+')}$`);
}

/**
 * 고친 글 한 줄을 사실 확인할 평문으로 — 마크다운 표식(제목 · 목록 · 인용 · 굵게) · 절 번호 · 링크 주소를 걷고,
 * 사진 자리 줄은 통째로 건너뛴다. 절 번호 「1.」와 주소 속 숫자가 「출처 없는 숫자」로 잡히지 않게.
 */
export function editedLinePlain(line: string, title: RegExp | null = null): string {
  const t = line.trim();
  // 사진 줄은 주소만 걷고 대체 텍스트(사진 설명)는 본다 — 설명에 넣은 숫자도 사실 확인을 받는다.
  const image = /^!\[([^\]]*)\]\([^)]*\)$/.exec(t);
  if (image) return image[1]!.trim();
  const h1 = /^#\s+(.+)$/.exec(t);
  if (h1 && title?.test(h1[1]!.trim())) return '';
  return t
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*\s]+/, '')
    .replace(/^\d{1,2}[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/\*+$/, '')
    .trim();
}

/**
 * 사람이 고친 초안을 저장한다. 가드는 경고만 남기고 저장 자체는 막지 않는다.
 * 문장 단위로 보되 마크다운 표식(제목·목록·인용)은 검사 전에 걷어낸다(editedLinePlain).
 */
export async function saveEditedDraft(
  tenantId: string,
  actionId: string,
  markdown: string,
  facts: ContentDraftRequest['factGraph'],
  questionTexts: string[],
  judge?: EngineClient,
): Promise<StoredDraft> {
  const before = (await readDrafts(tenantId))[actionId];
  if (!before) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');

  const { guardSentence, notes } = createFactGuard(facts, questionTexts, 'warn');
  const title = countedTitle(before.draft);
  const sentences: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const plain = editedLinePlain(line, title);
    if (!plain) continue;
    for (const sentence of splitSentences(plain)) {
      guardSentence(sentence);
      sentences.push(sentence);
    }
  }
  // 사람이 쓴 글도 격상 검사를 받는다 — 경고만 남기고 막지 않는다(숫자 가드와 같은 원칙).
  if (judge) notes.push(...(await findOverclaims(sentences, facts, judge, 'warn')).notes);

  // 판정 호출을 기다리는 사이 다른 길(빈칸 · 실측 사례)이 쓴 내용을 덮지 않게, 줄 안에서 다시 읽어 바꾼다.
  return updateDrafts(tenantId, (map) => {
    const current = map[actionId];
    if (!current) throw new Error('이 항목의 초안이 없습니다. 먼저 초안을 만드세요.');
    const stored: StoredDraft = {
      ...current,
      editedMarkdown: markdown,
      editedAt: new Date().toISOString(),
      ...(notes.length ? { editWarnings: notes } : {}),
    };
    if (!notes.length) delete stored.editWarnings;
    map[actionId] = stored;
    return stored;
  });
}
