import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadPublishedPosts,
  patchPublishedPost,
  recordPublishedPost,
  type ActionStateMap,
  type PostEditInput,
  type PostRemovedReason,
  type PublishedPost,
  type RecordPostInput,
} from './api'

/**
 * 집행 원장을 불러오고 고친다(server/publishedPosts.ts).
 *
 * available이 false면 이 환경에 기록 기능이 없다(웹 — 라우트가 없다). 화면은 그때 기록 칸을 숨긴다. 읽다가 실패하면(파일이
 * 깨짐 등) available은 true로 두고 error에 이유를 싣는다 — 기능을 조용히 숨기면 왜 적을 수 없는지 모른다.
 *
 * 날짜 고치기 · 빼기 · 되살리기는 화면에 먼저 반영하고 실패하면 되돌린다. 새 주소 기록은 서버가 키 · id를 정하므로 응답을
 * 기다린다(로컬 서버라 짧다). 기록 실패는 그 칸에만 돌려준다 — 한 줄의 409가 모든 줄에 뜨지 않게. error는 읽기 · 고치기 실패다.
 *
 * 요청 중에 브랜드를 바꾸면 늦게 온 응답을 버린다 — 새 브랜드의 기록을 앞 브랜드 것으로 덮지 않는다.
 */
export function usePublishedPosts(tenantId: string) {
  const [loaded, setLoaded] = useState<{ key: string; posts: PublishedPost[] | null; available: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 서버가 원장을 고쳐 돌려준 횟수 — 원장으로 계산하는 화면(인용 이력)이 저장이 끝난 뒤에 다시 읽게 한다. 화면 먼저 반영(낙관적)
  // 때 올리면 서버가 아직 고치기 전 원장으로 계산할 수 있다.
  const [saved, setSaved] = useState(0)
  const current = useRef(tenantId)
  useEffect(() => {
    current.current = tenantId
  }, [tenantId])

  useEffect(() => {
    if (!tenantId) return
    let alive = true
    void loadPublishedPosts(tenantId).then(
      (posts) => {
        if (!alive) return
        setLoaded({ key: tenantId, posts, available: posts !== null })
        setError(null)
      },
      (err: unknown) => {
        if (!alive) return
        setLoaded({ key: tenantId, posts: null, available: true })
        setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  const fresh = loaded?.key === tenantId ? loaded : null
  const posts = fresh?.posts ?? null

  /**
   * 새 주소 기록. 성공하면 바뀐 집행 상태(markDone)를, 실패하면 이유를 돌려준다. 그사이 브랜드가 바뀌었으면 결과를 버리고
   * stale로 알린다.
   */
  const record = useCallback(
    async (input: RecordPostInput): Promise<{ ok: true; states?: ActionStateMap } | { ok: false; error: string; stale?: true }> => {
      if (!tenantId) return { ok: false, error: '브랜드가 정해지지 않았습니다.' }
      setBusy(true)
      try {
        const r = await recordPublishedPost(tenantId, input)
        if (current.current !== tenantId) return { ok: false, error: '브랜드가 바뀌어 결과를 버렸습니다.', stale: true }
        setLoaded({ key: tenantId, posts: r.posts, available: true })
        setSaved((n) => n + 1)
        // 새 원장을 받았으니 앞서 읽기 · 고치기에 실패했다는 안내는 더 이상 맞지 않는다.
        setError(null)
        return { ok: true, ...(r.states ? { states: r.states } : {}) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      } finally {
        setBusy(false)
      }
    },
    [tenantId],
  )

  // 고친 날은 미리 반영하지 않는다 — 같은 주소의 다른 줄(자사 · 채널)에도 서버가 함께 두므로 응답을 그대로 쓴다(로컬 서버라 짧다).
  const patch = useCallback(
    async (postId: string, change: { publishedOn?: string; remove?: PostRemovedReason; restore?: true; addEdit?: PostEditInput; removeEdit?: string }) => {
      if (!tenantId || !posts) return
      const before = posts
      const now = new Date().toISOString()
      setLoaded({
        key: tenantId,
        available: true,
        posts: posts.map((p) => {
          if (p.id !== postId) return p
          if (change.restore) {
            const copy = { ...p }
            delete copy.removedAt
            delete copy.removedReason
            return copy
          }
          return {
            ...p,
            ...(change.publishedOn ? { publishedOn: change.publishedOn, publishedOnSource: 'user' as const } : {}),
            ...(change.remove ? { removedAt: now, removedReason: change.remove } : {}),
          }
        }),
      })
      setError(null)
      try {
        const r = await patchPublishedPost(tenantId, postId, change)
        if (current.current === tenantId) {
          setLoaded({ key: tenantId, posts: r.posts, available: true })
          setSaved((n) => n + 1)
        }
      } catch (err) {
        if (current.current !== tenantId) return
        setLoaded({ key: tenantId, posts: before, available: true })
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [tenantId, posts],
  )

  return {
    posts,
    /** 이 환경에서 기록할 수 있는가(웹은 false). 읽기 실패여도 true — 이유는 error에 있다. */
    available: fresh?.available ?? false,
    ready: fresh !== null,
    /** 저장이 끝날 때마다 바뀐다 — 원장에서 계산한 값을 다시 읽을 때 쓴다. */
    saved,
    busy,
    error,
    record,
    remove: (postId: string, reason: PostRemovedReason) => patch(postId, { remove: reason }),
    restore: (postId: string) => patch(postId, { restore: true }),
    setPublishedOn: (postId: string, publishedOn: string) => patch(postId, { publishedOn }),
    /** 기존 글을 고친 날을 남긴다(같은 날이면 그 판으로 바꾼다). */
    addEdit: (postId: string, edit: PostEditInput) => patch(postId, { addEdit: edit }),
    /** 잘못 남긴 고친 날을 뺀다. */
    removeEdit: (postId: string, editedOn: string) => patch(postId, { removeEdit: editedOn }),
  }
}
