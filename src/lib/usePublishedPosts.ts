import { useCallback, useEffect, useState } from 'react'
import {
  loadPublishedPosts,
  patchPublishedPost,
  recordPublishedPost,
  type ActionStateMap,
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
 * 기다린다(로컬 서버라 짧다).
 */
export function usePublishedPosts(tenantId: string) {
  const [loaded, setLoaded] = useState<{ key: string; posts: PublishedPost[] | null; available: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  /** 새 주소 기록. 성공하면 바뀐 집행 상태(markDone)를 돌려준다 — 실패하면 null이고 error에 이유가 남는다. */
  const record = useCallback(
    async (input: RecordPostInput): Promise<{ states?: ActionStateMap } | null> => {
      if (!tenantId) return null
      setBusy(true)
      setError(null)
      try {
        const r = await recordPublishedPost(tenantId, input)
        setLoaded({ key: tenantId, posts: r.posts, available: true })
        return { ...(r.states ? { states: r.states } : {}) }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        setBusy(false)
      }
    },
    [tenantId],
  )

  const patch = useCallback(
    async (postId: string, change: { publishedOn?: string; remove?: PostRemovedReason; restore?: true }) => {
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
        setLoaded({ key: tenantId, posts: r.posts, available: true })
      } catch (err) {
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
    busy,
    error,
    record,
    remove: (postId: string, reason: PostRemovedReason) => patch(postId, { remove: reason }),
    restore: (postId: string) => patch(postId, { restore: true }),
    setPublishedOn: (postId: string, publishedOn: string) => patch(postId, { publishedOn }),
  }
}
