import { useEffect, useState } from 'react'
import { loadOwnerPhotos, updateOwnerPhoto, uploadOwnerPhoto, type TenantSummary } from '../lib/api'
import {
  cleanProductScreen,
  OWNER_PHOTO_MAX,
  OWNER_PHOTO_UPLOAD_EDGE,
  PRODUCT_SCREEN_MAX,
  productGuessFromAlt,
  productLabel,
  type OwnerPhotoView,
} from '../lib/ownerPhotos'
import { ownerUnmarkedScreen, productNamedIn } from '../lib/photoAutoPick'
import { sceneMeta } from '../lib/photoScenes'

/**
 * 업주 사진 보관함(콘텐츠 생성 화면 — src/lib/ownerPhotos.ts) — 업주(자기 시설) 사진을 브랜드 홈페이지에 올리지 않고 이 PC에 올려 두면
 * 「사진 자동 채우기」와 글의 「사진 고르기」가 홈페이지 사진처럼 쓴다. 올릴 때 사진마다 장면 설명(자동 채우기가 사진 자리 글자와 맞춘다)과
 * 권리 확인(업주 · 촬영자에게 홈페이지 · 블로그 게시 허락을 받았다)을 받고, 장면(바깥 · 실내 · 시간)은 서버가 한 번 읽는다(1장 10~25원).
 * 긴 변이 OWNER_PHOTO_UPLOAD_EDGE를 넘거나 큰 파일은 올리기 전에 이 화면에서 JPEG로 줄인다. 데스크톱 앱에서만(웹은 보관함이 없다).
 *
 * 회사가 준 제품 화면 캡처는 「제품 화면(캡처)」으로 표시하고 제품 이름을 적는다(2026-11-07 설계 D1 — 회사의 게시 확인 · 실제 고객 정보가
 * 보이지 않는다는 확인을 받는다). 자동 채우기는 자리 글자가 그 제품과 화면을 말하는 자리에만 넣는다. 표시하지 않은 사진의 장면이 화면으로
 * 읽혔으면(또는 설명이 화면 캡처로 읽히면) 표시를 제안한다 — 표시가 결정한다. 제품 이름은 설명의 화면 낱말 앞에서 제안하고(이미 표시한 제품을
 * 먼저 — 요청서 파일 번호 「N1」 · 흔한 낱말은 건너뛴다), 사람이 이름을 고치기 전에는 설명이 바뀌면 다시 제안한다. 이름이 이 브랜드 글의 사진
 * 자리 글자 어디에도 없으면 알린다(slotTexts — 자동 채우기가 쓰지 않는다, 2026-11-07 검토 2차).
 */

/** 제품 화면을 올리거나 표시할 때 받는 확인. */
const SCREEN_RIGHTS = '회사가 이 제품 화면을 작성자 블로그에 실어도 된다고 확인했고, 실제 고객 정보(고객사 · 공급사 실명, 연락처, 실제 단가)가 보이지 않아요.'
const PRODUCT_HINT = `제품 이름(쉼표로 다른 이름, ${PRODUCT_SCREEN_MAX}자까지 — 예: NEGOTIUM, 네고시움)`

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

/** screen — 「제품 화면(캡처)」으로 올린다(product가 제품 이름). productTouched — 사람이 제품 이름을 고쳤다(설명이 바뀌어도 다시 제안하지 않는다). */
type Pending = { file: File; url: string; alt: string; screen: boolean; product: string; productTouched: boolean }

export default function OwnerPhotoBox({
  tenantId,
  brand,
  slotTexts,
}: {
  tenantId: string
  brand: Pick<TenantSummary, 'brandName' | 'aliases'>
  /** 이 브랜드 글의 사진 자리 글자(장면 글자) — 표시한 제품 이름이 어느 자리에도 없으면 알린다. 없으면 알리지 않는다. */
  slotTexts?: readonly string[]
}) {
  const [box, setBox] = useState<{ key: string; photos: OwnerPhotoView[]; scenesAvailable: boolean } | null>(null)
  const [missing, setMissing] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [agree, setAgree] = useState(false)
  const [screenAgree, setScreenAgree] = useState(false)
  const [holder, setHolder] = useState('업주')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  /** 보관한 사진의 제품 이름 고치기(표시한 사진) · 표시 제안(화면으로 읽힌 사진). */
  const [products, setProducts] = useState<Record<string, string>>({})

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
    setPending(
      [...(files ?? [])].map((file) => ({ file, url: URL.createObjectURL(file), alt: altFromFileName(brand.brandName, file.name), screen: false, product: '', productTouched: false })),
    )
  }
  /** 이 브랜드에 이미 표시한 제품 이름(다른 이름까지) — 제안이 먼저 고른다. */
  const known = [...new Set(photos.flatMap((p) => (p.productScreen ? [p.productScreen.product] : [])))]
  const guess = (alt: string) => productGuessFromAlt(alt, { known, brandNames: [brand.brandName, ...(brand.aliases ?? [])] })
  /** 제품 이름이 이 브랜드 글의 사진 자리 글자에 한 번도 나오지 않는다 — 그 화면은 자동 채우기가 쓰지 않는다(자리 글자를 받은 때만 본다). */
  const unused = (product: string) => Boolean(slotTexts?.length) && !slotTexts!.some((t) => productNamedIn(t, product))
  const unusedNote = (product: string) => (
    <span className="hint warn" style={{ margin: 0 }}>
      「{productLabel(product)}」은(는) 이 브랜드 글의 사진 자리 글자 어디에도 없어요 — 자동 채우기가 쓰지 않아요(제품 이름 · 다른 이름을 확인해 주세요).
    </span>
  )
  const setPendingAt = (i: number, change: Partial<Pending>) => setPending((cur) => cur.map((x, j) => (j === i ? { ...x, ...change } : x)))
  const hasPhoto = pending.some((p) => !p.screen)
  const hasScreen = pending.some((p) => p.screen)
  const badProduct = pending.some((p) => p.screen && !cleanProductScreen(p.product))

  const upload = async () => {
    setBusy(true)
    setMessage(null)
    let done = 0
    let same = 0
    let calls = 0
    const failed: string[] = []
    for (const p of pending) {
      try {
        const out = await uploadOwnerPhoto(tenantId, await shrinkForUpload(p.file), { alt: p.alt, holder, ...(p.screen ? { product: p.product } : {}) })
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
  const screens = photos.filter((p) => p.productScreen).length
  /** 제품 화면 표시를 바꾼다 — 표시는 회사의 게시 확인을 받는다(빼기는 묻지 않는다). */
  const markScreen = (p: OwnerPhotoView, product: string | null) => {
    if (product !== null && !window.confirm(`${SCREEN_RIGHTS}\n\n「${productLabel(product)}」 제품 화면으로 표시할까요?`)) return
    void act(p.id, { productScreen: product === null ? null : { product } }, product === null ? '제품 화면 표시를 뺐어요.' : '제품 화면으로 표시했어요.')
  }
  return (
    <details className="publish-settings">
      <summary>
        업주 사진 보관함 — 이 PC에만 둔 업주(숙소 · 매장) 사진{' '}
        <span className="muted">{photos.length ? `${photos.length}장${screens ? `(제품 화면 ${screens}장)` : ''}` : '아직 없음'}</span>
      </summary>
      <div className="publish-settings-body">
        <p className="hint" style={{ margin: 0 }}>
          홈페이지에 올리지 않은 업주 사진을 여기 올리면 「사진 자동 채우기」와 글의 「사진 고르기」가 홈페이지 사진처럼 씁니다. 사진마다 보이는
          장면을 설명에 적어 주세요(예: 「{brand.brandName} 독채 앞 디딤돌 마당과 정원, 맑은 낮」) — 자동 채우기가 이 낱말로 사진 자리와 맞춥니다.
          장면(바깥 · 실내 · 낮 · 밤)은 올릴 때 한 번 읽어요(1장 10~25원). 블로그로는 「사진 N장 받기」 파일 · 작성자 묶음으로 나갑니다(최대{' '}
          {OWNER_PHOTO_MAX}장, 큰 사진은 가로 {OWNER_PHOTO_UPLOAD_EDGE}px로 줄여 올립니다). 회사가 준 제품 화면 캡처는 「제품 화면(캡처)」에
          표시하고 제품 이름을 적어 주세요 — 자동 채우기가 자리 글자에 그 제품과 화면이 함께 나온 자리에만 넣어요(늘 「확인 필요」).
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
                  <div className="photo-option owner-photo-card">
                    <img src={p.url} alt="" />
                    <input
                      aria-label={`${p.file.name} 설명`}
                      value={p.alt}
                      placeholder={p.screen ? '보이는 화면(예: NEGOTIUM 협상 화면 — 공급사별 협상 로그)' : '보이는 장면(예: 독채 앞 정원과 나무 데크, 맑은 낮)'}
                      onChange={(e) => setPendingAt(i, { alt: e.target.value, ...(p.screen && !p.productTouched ? { product: guess(e.target.value) } : {}) })}
                    />
                    <label className="doc-meta">
                      <input
                        type="checkbox"
                        checked={p.screen}
                        onChange={(e) => {
                          setPendingAt(i, { screen: e.target.checked, ...(p.productTouched ? {} : { product: guess(p.alt) }) })
                          // 제품 화면은 회사가 확인한다 — 허락한 사람이 기본값(업주)이면 회사로 바꾼다.
                          if (e.target.checked && holder === '업주') setHolder('회사')
                        }}
                      />{' '}
                      제품 화면(캡처)
                    </label>
                    {p.screen && (
                      <input
                        aria-label={`${p.file.name} 제품 이름`}
                        value={p.product}
                        placeholder={PRODUCT_HINT}
                        onChange={(e) => setPendingAt(i, { product: e.target.value, productTouched: true })}
                      />
                    )}
                    {p.screen && cleanProductScreen(p.product) && unused(p.product) && unusedNote(p.product)}
                  </div>
                </li>
              ))}
            </ul>
            <label>
              허락한 사람 <span className="muted">(이름은 적지 마세요 — 예: 업주, 업주 지인(촬영자), 회사)</span>
              <input value={holder} onChange={(e) => setHolder(e.target.value)} />
            </label>
            {hasPhoto && (
              <label>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> 업주(사진을 찍은 사람)에게 이 사진을 브랜드
                홈페이지 · 작성자 블로그에 써도 된다는 허락을 받았어요. 알아볼 수 있는 사람이 나온 사진은 따로 동의를 받았어요.
              </label>
            )}
            {hasScreen && (
              <label>
                <input type="checkbox" checked={screenAgree} onChange={(e) => setScreenAgree(e.target.checked)} /> {SCREEN_RIGHTS}
              </label>
            )}
            <div className="brief-bar">
              <button
                type="button"
                className="primary"
                disabled={busy || (hasPhoto && !agree) || (hasScreen && !screenAgree) || badProduct || pending.some((p) => !p.alt.trim())}
                onClick={() => void upload()}
              >
                {busy ? '올리는 중…' : `${pending.length}장 올리기`}
              </button>
              {pending.some((p) => !p.alt.trim()) && <span className="hint">설명이 빈 사진이 있어요.</span>}
              {badProduct && (
                <span className="hint">
                  제품 화면의 제품 이름을 적어 주세요(이름마다 2자 이상, {PRODUCT_SCREEN_MAX}자까지 — 화면 · 앱 · AI 같은 흔한 낱말과 줄바꿈 · &lt;&gt;는 쓸 수 없어요).
                </span>
              )}
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
                const marked = p.productScreen?.product
                // 표시하지 않았는데 화면 캡처로 읽힌 사진 — 표시를 제안한다(제품 이름은 설명의 화면 낱말 앞 — 이미 표시한 제품 먼저).
                const suggest = !marked && ownerUnmarkedScreen({ alt: p.alt, scene: p.scene ?? null })
                const product = products[p.id] ?? marked ?? (suggest ? guess(p.alt) : '')
                const productOk = cleanProductScreen(product)
                return (
                  <li key={p.id}>
                    <div className="photo-option owner-photo-card">
                      <img src={p.src} alt="" loading="lazy" />
                      <input aria-label="설명" value={draft} disabled={busy} onChange={(e) => setEdits((cur) => ({ ...cur, [p.id]: e.target.value }))} />
                      {marked && (
                        <span>
                          <span className="status-pill st-info no-glyph">제품 화면 · {productLabel(marked)}</span>
                        </span>
                      )}
                      {suggest && (
                        <span className="hint" style={{ margin: 0 }}>
                          {p.scene ? '장면이 화면으로 읽혔어요' : '설명이 화면 캡처로 읽혀요'} — 제품 화면이면 표시해 주세요(표시하지 않으면 자동 채우기가 쓰지 않아요).
                        </span>
                      )}
                      {(marked || suggest) && (
                        <input
                          aria-label="제품 이름"
                          value={product}
                          placeholder={PRODUCT_HINT}
                          disabled={busy}
                          onChange={(e) => setProducts((cur) => ({ ...cur, [p.id]: e.target.value }))}
                        />
                      )}
                      {(marked || suggest) && productOk && unused(productOk.product) && unusedNote(productOk.product)}
                      {(marked || suggest) && (
                        <span className="doc-meta">
                          {suggest && (
                            <button type="button" className="link-btn" disabled={busy || !productOk} onClick={() => markScreen(p, productOk!.product)}>
                              제품 화면으로 표시
                            </button>
                          )}
                          {marked && productOk && productOk.product !== marked && (
                            <>
                              <button
                                type="button"
                                className="link-btn"
                                disabled={busy}
                                onClick={() => void act(p.id, { productScreen: { product: productOk.product } }, '제품 이름을 고쳤어요.')}
                              >
                                제품 이름 저장
                              </button>
                              {' · '}
                            </>
                          )}
                          {marked && (
                            <button type="button" className="link-btn" disabled={busy} onClick={() => markScreen(p, null)}>
                              제품 화면 표시 빼기
                            </button>
                          )}
                        </span>
                      )}
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
