import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PIPELINE_DATA_DIR } from './appPaths.js';
import { extraArticleGate } from './probePlanStore.js';
import { queueTenantWrite, writeJsonAtomic } from './tenantWriteQueue.js';
import {
  checkExtraArticlePatch,
  checkNewExtraArticle,
  normalizeExtraArticles,
  type ExtraArticle,
  type ExtraArticleCheck,
  type ExtraArticleRules,
} from '../src/lib/extraArticles.js';

/**
 * 추가 글 정의 — data/<tenant>/extra-articles.json(src/lib/extraArticles.ts 주석).
 *
 * 쓰기는 테넌트 쓰기 줄(tenantWriteQueue.ts)에 선다 — 같은 화면에서 두 글을 잇달아 만들면 앞 쓰기를 덮지 않게, 그리고 집행 원장과
 * 같은 줄이라 읽는 중인 파일 위로 rename이 실패하지 않게. 지우지 않는다 — 「목록에서 빼기」는 removedAt만 남기고, 같은 질문으로 다시
 * 만들면 되살린다(초안 · 올린 기록이 같은 id로 이어진다).
 *
 * 작성자 배정 기간에는 새로 만들기와 되살리기를 배정표 글만 허용하고, 대신 살아 있는 글 상한을 배정 글 수까지 늘리고 배정 글끼리 질문이
 * 겹쳐도 받는다(server/probePlanStore.ts extraArticleGate — 배정 파일이 없으면 지금과 같다). 이름 · 각도 고치기와 빼기는 막지 않는다 —
 * 글이 늘지 않는다.
 *
 * 웹(Vercel)에는 라우트가 없다(함수 12/12). 화면은 404를 「이 환경에는 추가 글 기능이 없음」으로 읽고 칸을 숨긴다.
 */
interface ExtraArticlesFile {
  version: 1;
  articles: ExtraArticle[];
}

/** 라우트가 그대로 상태 코드로 쓰는 오류(400 잘못된 값 · 409 다른 글과 부딪힘 · 500 파일이 깨짐). */
export class ExtraArticlesError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ExtraArticlesState {
  /** 뺀 글도 함께 준다 — 화면이 살아 있는 글만 고른다. */
  articles: ExtraArticle[];
  /** 파일이 깨져 읽지 못했다 — articles는 빈 목록이고 쓰기는 거절한다. */
  corrupt: boolean;
}

function filePathFor(tenantId: string): string {
  return path.join(PIPELINE_DATA_DIR, tenantId, 'extra-articles.json');
}

/**
 * 파일만 읽는다(줄 밖). 없으면 빈 목록. JSON이 깨졌거나, 모양이 틀렸거나, 읽지 못한 줄이 하나라도 있으면 로그를 남기고 corrupt —
 * 그 상태로 쓰면 읽지 못한 정의가 사라진다.
 */
async function readState(tenantId: string): Promise<ExtraArticlesState> {
  let text: string;
  try {
    text = await readFile(filePathFor(tenantId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { articles: [], corrupt: false };
    throw err;
  }
  try {
    const raw = JSON.parse(text) as Partial<ExtraArticlesFile> | null;
    if (!raw || !Array.isArray(raw.articles)) throw new Error('articles 목록이 없습니다');
    const articles = normalizeExtraArticles(raw);
    if (articles.length !== raw.articles.length) {
      throw new Error(`읽지 못한 줄이 있습니다(${raw.articles.length}줄 중 ${articles.length}줄만 읽음)`);
    }
    return { articles, corrupt: false };
  } catch (err) {
    console.error(`[extraArticles] ${tenantId} extra-articles.json을 읽지 못했습니다 — 추가 글 없이 계산하고 쓰지 않습니다:`, err);
    return { articles: [], corrupt: true };
  }
}

/** 추가 글 목록. 읽기도 쓰기 줄에 세운다(server/publishedPosts.ts readPublishedPosts와 같은 이유). */
export function readExtraArticles(tenantId: string): Promise<ExtraArticlesState> {
  return queueTenantWrite(tenantId, () => readState(tenantId));
}

/**
 * 줄 안에서 읽고 검사해 쓴다. 깨진 파일은 덮지 않는다. probe가 'create'면 늘 · 'revive'면 되살리기를 청할 때만(removed:false) 작성자
 * 배정을 읽는다 — 운영 기간이면 편수 · 겹침 규칙을 넓혀 검사하고(extraArticleGate rules), 새로 만든 글 · 되살린 글은 배정 글인지 본다
 * (판은 그 글의 판 — 만들 때 고정한 값). 거절이면 400이고 쓰지 않는다. 배정을 읽지 않으면 규칙은 기본값(10편 · 겹침 409)이다.
 */
function writeChecked(
  tenantId: string,
  probe: 'create' | 'revive',
  wantsGate: boolean,
  check: (all: ExtraArticle[], now: string, rules: ExtraArticleRules | undefined) => ExtraArticleCheck,
): Promise<{ article: ExtraArticle; articles: ExtraArticle[]; revived: boolean }> {
  return queueTenantWrite(tenantId, async () => {
    const state = await readState(tenantId);
    if (state.corrupt) {
      throw new ExtraArticlesError('추가 글 파일(extra-articles.json)이 깨져 있어 쓰지 않았습니다. 관리자에게 확인을 요청해 주세요.', 500);
    }
    const gate = wantsGate ? await extraArticleGate(tenantId) : null;
    const result = check(state.articles, new Date().toISOString(), gate?.rules);
    if (!result.ok) throw new ExtraArticlesError(result.error, result.status);
    if (gate && (probe === 'create' || result.revived)) {
      const refused = gate.refuse(result.article);
      if (refused) throw new ExtraArticlesError(refused, 400);
    }
    await writeJsonAtomic(filePathFor(tenantId), { version: 1, articles: result.articles } satisfies ExtraArticlesFile);
    return { article: result.article, articles: result.articles, revived: result.revived };
  });
}

/** 새로 만들기(같은 질문의 뺀 글이면 되살리기) — 받는 값은 src/lib/extraArticles.ts checkNewExtraArticle. 작성자 배정을 늘 본다. */
export function createExtraArticle(tenantId: string, input: unknown) {
  return writeChecked(tenantId, 'create', true, (all, now, rules) => checkNewExtraArticle(input, all, now, rules));
}

/** 이름 · 각도 고치기, 목록에서 빼기 · 되살리기 — 받는 값은 checkExtraArticlePatch. 작성자 배정은 되살리기를 청할 때만 본다. */
export function patchExtraArticle(tenantId: string, input: unknown) {
  const wantsRevive = typeof input === 'object' && input !== null && (input as { removed?: unknown }).removed === false;
  return writeChecked(tenantId, 'revive', wantsRevive, (all, now, rules) => checkExtraArticlePatch(input, all, now, rules));
}
