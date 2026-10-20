import { useEffect, useMemo, useState } from 'react'
import { loadPublishSettings, saveDraftPhoto, savePhotoRights, type PhotoPlace, type StoredDraft, type TenantSummary } from '../lib/api'
import { isPhotoMedical, matchPhotos, photoSlotsOf, type PhotoPick, type PhotoSlot } from '../lib/articlePhotos'
import { publishMarkdownOf } from '../lib/draftGaps'
import type { PublishSettings } from '../lib/publishSettings'
import { loadSitePhotos, photoPageOf, type SitePhotoResult } from '../lib/sitePhotos'

/**
 * 글 확인 화면의 「홈페이지 사진」 — 글의 사진 자리마다 브랜드 홈페이지 사진을 사람이 한 장씩 고른다(src/lib/articlePhotos.ts).
 *
 * 고른 사진은 본문에 넣지 않고 내보낼 때(복사 · .md · .html)만 사진 자리에 들어간다. 홈페이지 사진도 예약 플랫폼 · 사진작가의
 * 사진이거나 사람이 찍혀 있을 수 있어, 브랜드마다 한 번 「써도 된다」는 확인을 받고(서버가 확인 없이 고르기를 막는다) 사진마다
 * 썸네일을 보고 고르게 한다 — 미리 골라 두지 않는다. 의료 업종은 기본으로 꺼 두고 의료광고 확인을 따로 받는다.
 */
export default function SitePhotoPanel({
  tenantId,
  brand,
  stored,
  disabled,
  onStored,
}: {
  tenantId: string
  brand: TenantSummary
  stored: StoredDraft
  /** 초안을 만들거나 다시 쓰는 중 — 그사이 고른 사진은 새 초안에 붙지 못한다. */
  disabled: boolean
  onStored: (s: StoredDraft) => void
}) {
  const md = useMemo(() => publishMarkdownOf(stored), [stored])
  const slots = useMemo(() => photoSlotsOf(md), [md])
  const match = useMemo(() => matchPhotos(md, stored.photos ?? []), [md, stored.photos])
  const medical = isPhotoMedical(brand.industry)

  const [settings, setSettings] = useState<PublishSettings | null | undefined>(undefined)
  const [agree, setAgree] = useState(false)
  const [agreeMedical, setAgreeMedical] = useState(false)
  const [pageUrl, setPageUrl] = useState('')
  const [found, setFound] = useState<SitePhotoResult | null>(null)
  const [loading, setLoading] = useState(false)
  /** 사진을 고르고 있는 자리(줄 번호)와 고른 사진. */
  const [openSlot, setOpenSlot] = useState<number | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadPublishSettings(tenantId).then(
      (s) => {
        if (!alive) return
        setSettings(s)
        setPageUrl((cur) => cur || photoPageOf(brand, s) || '')
      },
      (e: unknown) => {
        console.error('[SitePhotoPanel] 발행 설정을 읽지 못했습니다', e)
        if (alive) setSettings(null)
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId, brand])

  if (!slots.length && !(stored.photos ?? []).length) return null

  const rights = settings?.photoRights
  const allowed = Boolean(rights) && (!medical || Boolean(rights?.medical))
  const pickAt = (slot: PhotoSlot) => match.applied.find((a) => a.slot.line === slot.line)?.pick

  const confirmRights = async () => {
    setBusy(true)
    setError(null)
    try {
      setSettings(await savePhotoRights(tenantId, { medical }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const load = async (fresh: boolean) => {
    const url = pageUrl.trim()
    if (!url) return
    setLoading(true)
    setError(null)
    try {
      setFound(await loadSitePhotos(/^https?:\/\//i.test(url) ? url : `https://${url}`, fresh))
    } catch (e) {
      setFound(null)
      setError(`홈페이지를 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const save = async (body: Parameters<typeof saveDraftPhoto>[1]) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const next = await saveDraftPhoto(tenantId, body)
      setNote(next.photoNote ?? null)
      onStored(next)
      setOpenSlot(null)
      setChoice(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const placeOf = (p: PhotoPick): PhotoPlace => ({ slot: p.slot, nth: p.nth, heading: p.heading })
  const putPhoto = (slot: PhotoSlot, src: string, alt: string, page: string, replaces?: PhotoPick) =>
    save({
      actionId: stored.actionId,
      generatedAt: stored.generatedAt,
      op: 'pick',
      pick: { slot: slot.key, nth: slot.nth, same: slot.same, heading: slot.heading, src, alt, pageUrl: page },
      ...(replaces ? { replaces: placeOf(replaces) } : {}),
    })
  const remove = (p: PhotoPick) => save({ actionId: stored.actionId, generatedAt: stored.generatedAt, op: 'remove', place: placeOf(p) })
  const off = disabled || busy

  return (
    <section className="evidence-panel photo-panel">
      <h4>
        홈페이지 사진 <span className="muted">— 사진 자리 {slots.length}곳 · 고른 사진은 복사 · 내려받기 때만 들어갑니다</span>
      </h4>

      {settings === undefined && <p className="hint">불러오는 중…</p>}

      {settings !== undefined && !allowed && (
        <div className="fact-sheet">
          {medical && (
            <p className="hint warn" style={{ margin: 0 }}>
              의료 업종이라 기본으로 꺼 두었어요 — 환자 · 시술 전후 사진은 의료광고 심의 대상입니다.
            </p>
          )}
          <label>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 이 브랜드 홈페이지 사진을 글에 써도
            됩니다 — 사진을 찍은 사람 · 업체에게 쓸 권리가 있는지 확인했어요(예약 플랫폼 · 사진작가 사진일 수 있어요).
          </label>
          {medical && (
            <label>
              <input type="checkbox" checked={agreeMedical} onChange={(e) => setAgreeMedical(e.target.checked)} /> 환자 · 시술 전후 사진을
              쓰지 않고, 의료광고 기준을 확인했어요.
            </label>
          )}
          <div className="brief-bar">
            <button type="button" disabled={off || !agree || (medical && !agreeMedical)} onClick={() => void confirmRights()}>
              {busy ? '저장 중…' : '확인'}
            </button>
          </div>
        </div>
      )}

      {allowed && (
        <>
          <div className="gap-url">
            <input
              type="text"
              inputMode="url"
              aria-label="사진을 찾을 페이지 주소"
              placeholder="사진을 찾을 페이지 주소"
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
            />
            <button type="button" className="ghost" disabled={loading || !pageUrl.trim()} onClick={() => void load(Boolean(found))}>
              {loading ? '읽는 중…' : found ? '다시 읽기' : '홈페이지 사진 불러오기'}
            </button>
          </div>
          {found && (
            <p className="doc-meta" style={{ margin: 0 }}>
              {found.pageUrl}에서 사진 {found.photos.length}장
              {found.photos.length === 0 &&
                (found.skippedHttp > 0
                  ? ` — 사진 ${found.skippedHttp}장이 https가 아니라 뺐어요(블로그에서 깨집니다).`
                  : ' — 이 페이지에는 업체 사진으로 표시된 사진이 없어요. 사진이 있는 페이지 주소를 넣어 보세요.')}
            </p>
          )}
          {found && found.photos.length > 0 && (
            <p className="hint" style={{ margin: 0 }}>
              사람이 찍힌 사진은 초상권을 확인한 뒤 고르세요. 사진 아래 설명 줄이 사진과 어긋나면 「본문 편집」에서 고치세요.
            </p>
          )}
        </>
      )}

      {slots.map((slot) => {
        const picked = pickAt(slot)
        const open = openSlot === slot.line
        return (
          <div key={slot.line} className="photo-slot">
            <p className="doc-meta" style={{ margin: 0 }}>
              {slot.heading && <b>{slot.heading}</b>}
              {slot.heading && ' · '}사진 자리: {slot.alt}
            </p>
            {picked ? (
              <div className="photo-picked">
                <img src={picked.src} alt={picked.alt || slot.alt} referrerPolicy="no-referrer" loading="lazy" />
                <span>
                  {picked.alt || <span className="muted">(설명은 사진 자리 글자로)</span>}
                  <br />
                  <span className="doc-meta">
                    {picked.pageUrl} ·{' '}
                    <button type="button" className="link-btn" disabled={off} onClick={() => void remove(picked)}>
                      빼기
                    </button>
                    {allowed && found && found.photos.length > 0 && (
                      <>
                        {' · '}
                        <button type="button" className="link-btn" disabled={off} onClick={() => setOpenSlot(open ? null : slot.line)}>
                          바꾸기
                        </button>
                      </>
                    )}
                  </span>
                </span>
              </div>
            ) : (
              allowed &&
              found &&
              found.photos.length > 0 && (
                <button type="button" className="ghost" disabled={off} aria-expanded={open} onClick={() => setOpenSlot(open ? null : slot.line)}>
                  {open ? '닫기' : '홈페이지 사진 고르기'}
                </button>
              )
            )}
            {open && found && (
              <fieldset className="photo-choose" disabled={off}>
                <legend className="sr-only">「{slot.alt}」 자리에 넣을 사진</legend>
                <ul className="photo-grid">
                  {found.photos.map((p) => (
                    <li key={p.src}>
                      <label className={`photo-option${choice === p.src ? ' is-chosen' : ''}`}>
                        <input type="radio" name={`photo-${stored.actionId}-${slot.line}`} checked={choice === p.src} onChange={() => setChoice(p.src)} />
                        <img src={p.src} alt="" referrerPolicy="no-referrer" loading="lazy" />
                        <span>{p.alt || <span className="muted">설명 없음</span>}</span>
                        {p.where && <span className="doc-meta">{p.where}</span>}
                        {(stored.photos ?? []).some((x) => x.src === p.src && !(x.slot === slot.key && x.heading === slot.heading)) && (
                          <span className="doc-meta">다른 자리에 씀</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="brief-bar">
                  <button
                    type="button"
                    disabled={!choice}
                    onClick={() => {
                      const p = found.photos.find((x) => x.src === choice)
                      if (p) void putPhoto(slot, p.src, p.alt, found.pageUrl)
                    }}
                  >
                    이 사진 넣기
                  </button>
                </div>
              </fieldset>
            )}
          </div>
        )
      })}

      {match.suggested.map(({ pick, slot }) => (
        <p key={`s-${pick.slot}-${pick.nth}-${pick.heading}`} className="hint warn">
          「{pick.heading}」의 사진 자리({pick.slot})를 찾지 못했어요 — 「{slot.heading || slot.alt}」의 「{slot.alt}」 자리로 옮길까요?{' '}
          <button type="button" className="link-btn" disabled={off} onClick={() => void putPhoto(slot, pick.src, pick.alt, pick.pageUrl, pick)}>
            이 자리로 옮기기
          </button>{' '}
          ·{' '}
          <button type="button" className="link-btn" disabled={off} onClick={() => void remove(pick)}>
            빼기
          </button>
        </p>
      ))}
      {match.unmatched.map((pick) => (
        <p key={`u-${pick.slot}-${pick.nth}-${pick.heading}`} className="hint warn">
          「{pick.slot}」 자리를 찾지 못해 넣지 않는 사진이 있어요(글을 고치며 자리가 바뀌었어요).{' '}
          <button type="button" className="link-btn" disabled={off} onClick={() => void remove(pick)}>
            빼기
          </button>
        </p>
      ))}
      {medical && rights && !rights.medical && (stored.photos ?? []).length > 0 && (
        <p className="hint warn">의료 업종인데 의료광고 확인 없이 고른 사진이 있어요. 사진을 확인하거나 빼 주세요.</p>
      )}
      {note && <p className="hint">{note}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
