import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildChannelAdaptPrompt,
  sourceKeyOf,
  type ChannelAdaptRequest,
  type ChannelStyle,
} from '../src/prompts/b9d-channel-adapt.js';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { findOverclaims } from './claimGuard.js';
import { foreignAddresses, splitSentences } from './contentDraft.js';
import type { EngineClient } from './engines/types.js';
import { createFactGuard } from './factGuard.js';
import { parseJsonLoose } from './jsonParse.js';

/**
 * 채널 다듬기 — 완성된 글을 올릴 채널 문체로 고친 결과(b9d-channel-adapt).
 *
 * 다듬은 글도 초안과 **같은 사실 대조**를 거친다. 판정 엔진에 "새 사실을 더하지 마라"고 말하는 것만으로는
 * 막히지 않는다 — 초안에서 실제로 사실 가드·격상 가드에 걸린 문장이 나왔다. 숫자 가드는 원문에 있던 숫자를
 * 출처로 친다(원문은 이미 가드를 통과했다). 걸린 문장은 빼고 몇 건 뺐는지 notes에 남긴다.
 *
 * 저장은 테넌트 파일 하나(adaptations.json)에 콘텐츠 항목 → 채널 항목 순서로. 원문 지문(sourceKey)을 함께
 * 두어, 원문을 고치거나 빈칸을 더 채우면 화면이 "다시 다듬기"를 띄운다.
 */
export interface ChannelAdaptation {
  /** 이 글을 쓴 모델(대체 모델로 답했으면 그 모델). 예전 기록에는 없다. */
  model?: string;
  contentActionId: string;
  channelActionId: string;
  channelDomain: string;
  style: ChannelStyle;
  title: string;
  /** 다듬은 마크다운 본문(제목 제외). */
  markdown: string;
  generatedAt: string;
  /** 다듬을 때 쓴 원문의 지문(sourceKeyOf). */
  sourceKey: string;
  /** 사실 대조에서 뺀 문장 기록. */
  notes?: string[];
  /**
   * 제목도 본문과 같은 사실 대조(숫자 · 주소 · 격상)를 거쳤나 — 걸리면 원문 제목으로 되돌린다. 화면의 「제목 복사」는 이 값이
   * true일 때만 다듬은 제목을 쓴다(예전 기록의 제목은 대조를 거치지 않았다).
   */
  titleChecked?: boolean;
}
type AdaptMap = Record<string, Record<string, ChannelAdaptation>>;

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'adaptations.json');
}

export async function readAdaptations(tenantId: string): Promise<AdaptMap> {
  try {
    const parsed = JSON.parse(await readFile(filePathFor(tenantId), 'utf-8')) as AdaptMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAdaptations(tenantId: string, map: AdaptMap): Promise<void> {
  const target = filePathFor(tenantId);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf-8');
  await rename(tmp, target);
}

/** 사진 자리 줄(src/lib/markdownFile.ts)과 그 아랫줄 설명. */
const IMAGE_SLOT_LINE = /^!\[[^\]]*\]\(#image-slot\)$/;
const CAPTION_LINE = /^\*(?!\*)(.+?)\*$/;
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s)\]]+/g;

/**
 * 다듬은 글의 사진 자리 · 링크를 원문 기준으로 거른다 — 사진 자리 줄과 설명은 원문에 있던 줄만 글자 그대로 남기고(사실 대조를
 * 건너뛴다 — 원문이 이미 거쳤다), 원문에 없는 링크는 글자만 남긴다. 원문에 없는 맨 주소가 든 문장은 뺀다. 판정이 지어낸 사진
 * 장면이나 주소는 확인할 수 없다.
 */
export function keepSourceMedia(body: string, sourceMarkdown: string): { lines: (string | { media: string })[]; notes: string[] } {
  const sourceLines = new Set(sourceMarkdown.split(/\r?\n/).map((l) => l.trim()));
  const sourceUrls = new Set(sourceMarkdown.match(BARE_URL) ?? []);
  const notes: string[] = [];
  let droppedMedia = 0;
  let unlinked = 0;
  /** 바로 앞 줄이 사진 자리였나 — 설명 줄은 그 사진 자리를 따라간다(남았으면 남고, 뺐으면 빠진다). */
  let prevImage: 'kept' | 'dropped' | null = null;
  const lines = body.split('\n').flatMap((line): (string | { media: string })[] => {
    const t = line.trim();
    if (IMAGE_SLOT_LINE.test(t)) {
      prevImage = sourceLines.has(t) ? 'kept' : 'dropped';
      if (prevImage === 'dropped') droppedMedia += 1;
      return prevImage === 'kept' ? [{ media: t }] : [];
    }
    if (prevImage && CAPTION_LINE.test(t)) {
      const keep = prevImage === 'kept' && sourceLines.has(t);
      prevImage = null;
      return keep ? [{ media: t }] : [];
    }
    if (t) prevImage = null;
    const relinked = line.replace(MD_LINK, (whole, text: string, url: string) => {
      if (sourceUrls.has(url)) return whole;
      unlinked += 1;
      return text;
    });
    return [relinked];
  });
  if (droppedMedia) notes.push(`원문에 없는 사진 자리 ${droppedMedia}곳을 뺐습니다.`);
  if (unlinked) notes.push(`원문에 없는 링크 ${unlinked}개는 글자만 남겼습니다.`);
  return { lines, notes };
}

/**
 * 원문에 없는 주소가 든 문장 — 스킴 · www. · 도메인 꼴 모두(초안 쪽 foreignAddresses와 같은 규칙). 링크는 주소를 걷고 글자만
 * 본다(원문에 없는 링크 주소는 keepSourceMedia가 이미 걷었다) — 링크 글자에 지어낸 주소를 쓴 경우도 잡는다.
 */
function foreignAddress(sentence: string, sourceMarkdown: string): boolean {
  return foreignAddresses(sentence.replace(MD_LINK, '$1'), sourceMarkdown).length > 0;
}

/**
 * 통째로 다루는 줄 — 줄 전체가 굵은 핵심 문장(**…**)이거나 인용(> …). 문장 하나라도 걸리면 줄째 뺀다(초안의 key · quote와
 * 같은 원칙). 일부만 빼면 닫는 **가 사라져 별표가 글자로 보이거나, 그대로 쓸 말의 뜻이 바뀐다.
 */
function wholeLine(marker: string, text: string): boolean {
  return marker.trim() === '>' || /^\*\*[^*].*\*\*$/.test(text);
}

/** 마크다운 한 줄의 표식(##, -, 1.)과 본문을 나눈다 — 가드는 본문 문장만 본다. */
function splitMarker(line: string): { marker: string; text: string } {
  const m = /^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)?)(.*)$/.exec(line);
  return { marker: m?.[1] ?? '', text: (m?.[2] ?? line).trim() };
}

export async function adaptForChannel(
  tenantId: string,
  ids: { contentActionId: string; channelActionId: string },
  req: ChannelAdaptRequest,
  /** 글을 쓰는 엔진(WRITER_ENGINE). */
  writer: EngineClient,
  /** 쓴 글의 사실 격상을 검사하는 엔진 — 판정 엔진. 쓴 모델과 다른 모델이 검사한다. 없으면 writer. */
  checker: EngineClient = writer,
): Promise<ChannelAdaptation> {
  const result = await writer.call(buildChannelAdaptPrompt(req));
  const raw = parseJsonLoose<Record<string, unknown>>(result.text);
  const rawTitle = typeof raw?.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw?.body === 'string' ? raw.body.replace(/\r\n/g, '\n').trim() : '';
  if (!body) throw new Error('다듬은 글을 해석할 수 없습니다(JSON 아님 또는 본문 없음). 다시 시도하세요.');

  // 숫자 가드 — 원문에 있던 숫자는 출처가 있는 숫자로 친다(질문 자리에 원문을 넘긴다).
  const { guardSentence, notes } = createFactGuard(req.factGraph, [req.sourceMarkdown]);
  // 사진 자리 · 설명 줄은 원문에 있던 것만 그대로(가드를 건너뛴다), 원문에 없는 링크는 글자만.
  const media = keepSourceMedia(body, req.sourceMarkdown);
  const passes = (s: string): boolean => {
    if (foreignAddress(s, req.sourceMarkdown)) {
      notes.push(`"${s.slice(0, 60)}…" — 원문에 없는 주소가 들어 있어 뺐습니다.`);
      return false;
    }
    return guardSentence(s);
  };
  const lines = media.lines.map((line) => {
    if (typeof line !== 'string') return line;
    const { marker, text } = splitMarker(line);
    if (!text || marker.startsWith('#')) return line;
    const all = splitSentences(text);
    const kept = all.filter(passes);
    if (wholeLine(marker, text) && kept.length < all.length) return null;
    return kept.length ? `${marker}${kept.join(' ')}` : null;
  });
  let kept = lines.filter((l): l is string | { media: string } => l !== null);

  // 격상 가드 — 숫자 없이 주체·범위가 커진 문장을 뺀다(초안과 같은 'drop').
  const sentences = kept.flatMap((l) => {
    if (typeof l !== 'string') return [];
    const { marker, text } = splitMarker(l);
    return marker.startsWith('#') || !text ? [] : splitSentences(text);
  });
  // 제목도 같은 대조를 받는다 — 「제목 복사」로 블로그 제목 칸에 그대로 들어간다. 걸리면 원문 제목(# 줄)으로 되돌린다.
  const sourceTitle = /^#\s+(.+)$/m.exec(req.sourceMarkdown)?.[1]?.trim() ?? '';
  let title = rawTitle && passes(rawTitle) ? rawTitle : sourceTitle;
  const claims = await findOverclaims(title ? [...sentences, title] : sentences, req.factGraph, checker, 'drop');
  if (title && claims.overclaimed.has(title)) title = sourceTitle;
  if (rawTitle && title !== rawTitle) notes.push(`제목 「${rawTitle.slice(0, 40)}」이 사실 대조에 걸려 원문 제목으로 되돌렸습니다.`);
  if (claims.overclaimed.size) {
    kept = kept
      .map((l) => {
        if (typeof l !== 'string') return l;
        const { marker, text } = splitMarker(l);
        if (marker.startsWith('#') || !text) return l;
        const all = splitSentences(text);
        const left = all.filter((s) => !claims.overclaimed.has(s));
        if (wholeLine(marker, text) && left.length < all.length) return null;
        return left.length ? `${marker}${left.join(' ')}` : null;
      })
      .filter((l): l is string | { media: string } => l !== null);
  }
  notes.push(...media.notes, ...claims.notes);
  const keptLines = kept.map((l) => (typeof l === 'string' ? l : l.media));

  // 본문이 빠진 소제목은 덜어낸다 — 빈 절이 남으면 글이 망가진 것처럼 보인다.
  const cleaned: string[] = [];
  for (let i = 0; i < keptLines.length; i += 1) {
    const line = keptLines[i]!;
    if (/^#{1,6}\s/.test(line)) {
      const next = keptLines.slice(i + 1).find((l) => l.trim());
      if (!next || /^#{1,6}\s/.test(next)) continue;
    }
    cleaned.push(line);
  }
  const markdown = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!markdown) throw new Error('다듬은 글의 문장이 모두 사실 대조에 걸렸습니다. 원문을 확인하세요.');

  const stored: ChannelAdaptation = {
    ...ids,
    channelDomain: req.channelDomain,
    style: req.style,
    title,
    markdown,
    generatedAt: new Date().toISOString(),
    ...(result.model ? { model: result.model } : {}),
    sourceKey: sourceKeyOf(req.sourceMarkdown),
    ...(notes.length ? { notes } : {}),
    titleChecked: true,
  };
  const map = await readAdaptations(tenantId);
  map[ids.contentActionId] = { ...(map[ids.contentActionId] ?? {}), [ids.channelActionId]: stored };
  await writeAdaptations(tenantId, map);
  return stored;
}
