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
import { splitSentences } from './contentDraft.js';
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

/** 마크다운 한 줄의 표식(##, -, 1.)과 본문을 나눈다 — 가드는 본문 문장만 본다. */
function splitMarker(line: string): { marker: string; text: string } {
  const m = /^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s+)?)(.*)$/.exec(line);
  return { marker: m?.[1] ?? '', text: (m?.[2] ?? line).trim() };
}

export async function adaptForChannel(
  tenantId: string,
  ids: { contentActionId: string; channelActionId: string },
  req: ChannelAdaptRequest,
  judge: EngineClient,
): Promise<ChannelAdaptation> {
  const result = await judge.call(buildChannelAdaptPrompt(req));
  const raw = parseJsonLoose<Record<string, unknown>>(result.text);
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw?.body === 'string' ? raw.body.replace(/\r\n/g, '\n').trim() : '';
  if (!body) throw new Error('다듬은 글을 해석할 수 없습니다(JSON 아님 또는 본문 없음). 다시 시도하세요.');

  // 숫자 가드 — 원문에 있던 숫자는 출처가 있는 숫자로 친다(질문 자리에 원문을 넘긴다).
  const { guardSentence, notes } = createFactGuard(req.factGraph, [req.sourceMarkdown]);
  const lines = body.split('\n').map((line) => {
    const { marker, text } = splitMarker(line);
    if (!text || marker.startsWith('#')) return line;
    const kept = splitSentences(text).filter(guardSentence);
    return kept.length ? `${marker}${kept.join(' ')}` : null;
  });
  let kept = lines.filter((l): l is string => l !== null);

  // 격상 가드 — 숫자 없이 주체·범위가 커진 문장을 뺀다(초안과 같은 'drop').
  const sentences = kept.flatMap((l) => {
    const { marker, text } = splitMarker(l);
    return marker.startsWith('#') || !text ? [] : splitSentences(text);
  });
  const claims = await findOverclaims(sentences, req.factGraph, judge, 'drop');
  if (claims.overclaimed.size) {
    kept = kept
      .map((l) => {
        const { marker, text } = splitMarker(l);
        if (marker.startsWith('#') || !text) return l;
        const left = splitSentences(text).filter((s) => !claims.overclaimed.has(s));
        return left.length ? `${marker}${left.join(' ')}` : null;
      })
      .filter((l): l is string => l !== null);
  }
  notes.push(...claims.notes);

  // 본문이 빠진 소제목은 덜어낸다 — 빈 절이 남으면 글이 망가진 것처럼 보인다.
  const cleaned: string[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i]!;
    if (/^#{1,6}\s/.test(line)) {
      const next = kept.slice(i + 1).find((l) => l.trim());
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
    sourceKey: sourceKeyOf(req.sourceMarkdown),
    ...(notes.length ? { notes } : {}),
  };
  const map = await readAdaptations(tenantId);
  map[ids.contentActionId] = { ...(map[ids.contentActionId] ?? {}), [ids.channelActionId]: stored };
  await writeAdaptations(tenantId, map);
  return stored;
}
