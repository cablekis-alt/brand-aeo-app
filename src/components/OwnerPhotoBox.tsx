import { useEffect, useState } from 'react'
import { loadOwnerPhotos, updateOwnerPhoto, uploadOwnerPhoto, type TenantSummary } from '../lib/api'
import { OWNER_PHOTO_MAX, OWNER_PHOTO_UPLOAD_EDGE, type OwnerPhotoView } from '../lib/ownerPhotos'
import { sceneMeta } from '../lib/photoScenes'

/**
 * 업주 사진 보관함(콘텐츠 생성 화면 — src/lib/ownerPhotos.ts) — 업주(자기 시설) 사진을 브랜드 홈페이지에 올리지 않고 이 PC에 올려 두면
 * 「사진 자동 채우기」와 글의 「사진 고르기」가 홈페이지 사진처럼 쓴다. 올릴 때 사진마다 장면 설명(자동 채우기가 사진 자리 글자와 맞춘다)과
 * 권리 확인(업주 · 촬영자에게 홈페이지 · 블로그 게시 허락을 받았다)을 받고, 장면(바깥 · 실내 · 시간)은 서버가 한 번 읽는다(1장 10~25원).
 * 긴 변이 OWNER_PHOTO_UPLOAD_EDGE를 넘거나 큰 파일은 올리기 전에 이 화면에서 JPEG로 줄인다. 데스크톱 앱에서만(웹은 보관함이 없다).
 */

/** 올리기 전에 줄이는 기준 — 이보다 크면 JPEG로 다시 저장한다(장면 읽기 한도 3.75MB 안으로). */
const SHRINK_BYTES = 3_000_000

/** 파일 이름에서 설명 첫 글자 — 「out-03-디딤돌마당-소나무-탁자.webp」 → 「디딤돌마당 소나무 탁자」(앞 번호 · 확장자를 뗀다). */
function altFromFileName(brandName: string, name: string): string {
  const words = name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^(?:out|in)-\d+-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return /^[0-9a-f]{16,}$/i.test(words) || !words ? '' : `${brandName} ${words}`
}

/** 긴 변을 OWNER_PHOTO_UPLOAD_EDGE 안으로 · 큰 파일은 JPEG로 — 줄일 필요가 없으면 그대로. */
async function shrinkForUpload(file: File): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file
  }
  const edge = Math.max(bitmap.width, bitmap.height)
  if (edge <= OWNER_PHOTO_UPLOAD_EDGE && file.size <= SHRINK_BYTES) {
    bitmap.close()
    return file
  }
  const scale = Math.min(1, OWNER_PHOTO_UPLOAD_EDGE / edge)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  return blob ?? file
}

type Pending = { file: File; url: string; alt: string }

export default function OwnerPhotoBox({ tenantId, brand }: { tenantId: string; brand: Pick<TenantSummary, 'brandName'> }) {
  const [box, setBox] = useState<{ key: string; photos: OwnerPhotoView[]; scenesAvailable: boolean } | null>(null)
  const [missing, setMissing] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [agree, setAgree] = useState(false)
  const [holder, setHolder] = useState('업주')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    loadOwnerPhotos(tenantId).then(
      (got) => {
        if (!alive) return
        if (got) setBox({ key: tenantId, ...got })
        else setMissing(true)
      },
      (e: unknown) => {
        console.warn('[OwnerPhotoBox] 업주 사진 목록을 읽지 못했습니다', e)
        if (alive) setMessage(`✗ 업주 사진 목록을 읽지 못했어요 — ${e instanceof Error ? e.message : String(e)}`)
      },
    )
    return () => {
      alive = false
    }
  }, [tenantId])

  // 고른 파일의 미리보기 주소는 다른 파일을 고르거나 화면을 떠날 때 놓는다.
  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.url)), [pending])

  if (missing) return null
  const photos = box?.key === tenantId ? box.photos : []

  const refresh = async () => {
    const got = await loadOwnerPhotos(tenantId)
    if (got) setBox({ key: tenantId, ...got })
  }

  const choose = (files: FileList | null) => {
    setMessage(null)
    setPending([...(files ?? [])].map((file) => ({ file, url: URL.createObjectURL(file), alt: altFromFileName(brand.brandName, file.name) })))
  }

  const upload = async () => {
    setBusy(true)
    setMessage(null)
    let done = 0
    let same = 0
    let calls = 0
    const failed: string[] = []
    for (const p of pending) {
      try {
        const out = await uploadOwnerPhoto(tenantId, await shrinkForUpload(p.file), { alt: p.alt, holder })
        done += 1
        if (out.existed) same += 1
        calls += out.sceneCalls
      } catch (e) {
        failed.push(`${p.file.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await refresh().catch((e: unknown) => console.warn('[OwnerPhotoBox] 목록을 다시 읽지 못했습니다', e))
    setPending([])
    setBusy(false)
    setMessage(
      [
        `${done}장 올렸어요${same ? `(그 가운데 ${same}장은 이미 있던 사진 — 설명만 새로 적었어요)` : ''}. 장면 읽기 ${calls}번.`,
        ...(failed.length ? [`✗ 올리지 못한 사진: ${failed.join(' / ')}`] : []),
      ].join(' '),
    )
  }

  const act = async (id: string, action: Parameters<typeof updateOwnerPhoto>[2], done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      await updateOwnerPhoto(tenantId, id, action)
      await refresh()
      setMessage(done)
    } catch (e) {
      setMessage(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const withoutScene = photos.filter((p) => !p.scene).length
  return (
    <details className="publish-settings">
      <summary>
        업주 사진 보관함 — 이 PC에만 둔 업주(숙소 · 매장) 사진 <span className="muted">{photos.length ? `${photos.length}장` : '아직 없음'}</span>
      </summary>
      <div className="publish-settings-body">
        <p className="hint" style={{ margin: 0 }}>
          홈페이지에 올리지 않은 업주 사진을 여기 올리면 「사진 자동 채우기」와 글의 「사진 고르기」가 홈페이지 사진처럼 씁니다. 사진마다 보이는
          장면을 설명에 적어 주세요(예: 「{brand.brandName} 독채 앞 디딤돌 마당과 정원, 맑은 낮」) — 자동 채우기가 이 낱말로 사진 자리와 맞춥니다.
          장면(바깥 · 실내 · 낮 · 밤)은 올릴 때 한 번 읽어요(1장 10~25원). 블로그로는 「사진 N장 받기」 파일 · 작성자 묶음으로 나갑니다(최대{' '}
          {OWNER_PHOTO_MAX}장, 큰 사진은 가로 {OWNER_PHOTO_UPLOAD_EDGE}px로 줄여 올립니다).
        </p>
        {box && !box.scenesAvailable && <p className="hint warn">이 PC에 Claude 키가 없어 장면을 읽지 못해요 — 설명 글자로만 맞춥니다.</p>}
        <label>
          사진 고르기 <span className="muted">(jpg · png · webp, 여러 장)</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={(e) => choose(e.target.files)} />
        </label>
        {pending.length > 0 && (
          <>
            <ul className="photo-grid">
              {pending.map((p, i) => (
                <li key={p.url}>
                  <div className="photo-option">
                    <img src={p.url} alt="" />
                    <input
                      aria-label={`${p.file.name} 설명`}
                      value={p.alt}
                      placeholder="보이는 장면(예: 독채 앞 정원과 나무 데크, 맑은 낮)"
                      onChange={(e) => setPending((cur) => cur.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))}
                    />
                  </div>
                </li>
              ))}
            </ul>
            <label>
              허락한 사람 <span className="muted">(이름은 적지 마세요 — 예: 업주, 업주 지인(촬영자))</span>
              <input value={holder} onChange={(e) => setHolder(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 업주(사진을 찍은 사람)에게 이 사진을 브랜드
              홈페이지 · 작성자 블로그에 써도 된다는 허락을 받았어요. 알아볼 수 있는 사람이 나온 사진은 따로 동의를 받았어요.
            </label>
            <div className="brief-bar">
              <button type="button" className="primary" disabled={busy || !agree || pending.some((p) => !p.alt.trim())} onClick={() => void upload()}>
                {busy ? '올리는 중…' : `${pending.length}장 올리기`}
              </button>
              {pending.some((p) => !p.alt.trim()) && <span className="hint">설명이 빈 사진이 있어요.</span>}
            </div>
          </>
        )}
        {message && (
          <p className={message.startsWith('✗') ? 'error' : 'hint'} role="status" style={{ margin: 0 }}>
            {message}
          </p>
        )}
        {photos.length > 0 && (
          <>
            <p className="doc-meta" style={{ margin: 0 }}>
              올린 사진 {photos.length}장{withoutScene ? ` · 장면을 읽지 못한 사진 ${withoutScene}장` : ''}
            </p>
            <ul className="photo-grid">
              {photos.map((p) => {
                const draft = edits[p.id] ?? p.alt
                return (
                  <li key={p.id}>
                    <div className="photo-option">
                      <img src={p.src} alt="" loading="lazy" />
                      <input aria-label="설명" value={draft} disabled={busy} onChange={(e) => setEdits((cur) => ({ ...cur, [p.id]: e.target.value }))} />
                      <span className="doc-meta">
                        {p.scene ? `장면: ${p.scene.text} (${sceneMeta(p.scene)})` : `장면 못 읽음${p.sceneError ? ` — ${p.sceneError}` : ''}`}
                      </span>
                      <span className="doc-meta">
                        허락: {p.rights.holder} · {p.uploadedAt.slice(0, 10)}
                      </span>
                      <span className="doc-meta">
                        {draft.trim() && draft !== p.alt && (
                          <>
                            <button type="button" className="link-btn" disabled={busy} onClick={() => void act(p.id, { alt: draft }, '설명을 고쳤어요.')}>
                              설명 저장
                            </button>
                            {' · '}
                          </>
                        )}
                        {!p.scene && box?.scenesAvailable && (
                          <>
                            <button type="button" className="link-btn" disabled={busy} onClick={() => void act(p.id, { rereadScene: true }, '장면을 다시 읽었어요.')}>
                              장면 다시 읽기
                            </button>
                            {' · '}
                          </>
                        )}
                        <button
                          type="button"
                          className="link-btn"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm('이 사진을 보관함에서 뺄까요? 이 PC의 파일도 지워지고, 글에 이미 넣은 이 사진은 내보낼 때 빠집니다.')) {
                              void act(p.id, { remove: true }, '보관함에서 뺐어요.')
                            }
                          }}
                        >
                          빼기
                        </button>
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </details>
  )
}
