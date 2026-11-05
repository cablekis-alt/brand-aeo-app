import type { ReactNode } from 'react'
import { MAP_CREDIT, MAP_PICK_CHIP } from '../lib/mapImage'

/** 그린 지도는 늘 1280×800 — 썸네일도 그 비율(16:10) 그대로(잘리지 않게). */
const MAP_THUMB_RATIO = '16 / 10'

/**
 * 앱이 그린 군산 지도 한 장(src/lib/mapImage.ts) — 썸네일(16:10, 아직 그리지 않았으면 빈 자리) · 「자동」 · 「군산 지도(OSM) · 확인 필요」 칩 ·
 * 대체 텍스트 · 출처 줄 · 위치 문장(내보낼 때 그림 아래 차례와 같다). 자동 채우기 미리보기(PhotoAutoFill)와 글의 「홈페이지 사진」 칸(SitePhotoPanel)이 함께 쓴다 — 어디서 보든
 * 사이트 화면이 아니라 앱이 그린 지도이고, 늘 확인할 것이며, 내보낼 때 그림 바로 아래에 출처 줄이 붙는다는 것이 보이게. 썸네일은 앱 주소
 * (같은 출처)라 앱 안에서만 보인다. children은 글 끝(빼기 · 바꾸기 단추 등).
 */
export default function MapPickBrief({
  src,
  alt,
  caption,
  auto = false,
  className = 'photo-auto-pick',
  children,
}: {
  /** 그린 지도의 앱 주소 — 없으면 아직 그리지 않았다. */
  src?: string
  alt: string
  caption?: string
  auto?: boolean
  /** 바깥 틀 — 미리보기 표는 photo-auto-pick, 글의 사진 칸은 photo-picked. */
  className?: string
  children?: ReactNode
}) {
  return (
    <span className={`${className} is-map`}>
      {src ? (
        <img src={src} alt="" loading="lazy" style={{ aspectRatio: MAP_THUMB_RATIO }} />
      ) : (
        <span className="photo-option-empty map-thumb-empty">아직 그리지 않음</span>
      )}
      <span>
        {auto && <span className="status-pill st-info no-glyph">자동</span>} <span className="status-pill st-warn no-glyph">{MAP_PICK_CHIP}</span> {alt}
        <span className="doc-meta" style={{ display: 'block' }}>
          {MAP_CREDIT}
        </span>
        {caption && (
          <span className="doc-meta" style={{ display: 'block' }}>
            {caption}
          </span>
        )}
        {children}
      </span>
    </span>
  )
}

/**
 * 글 보기(DraftPanel)의 사진 자리에 들어간 군산 지도 — 큰 그림(16:10 그대로) · 「군산 지도(OSM) · 확인 필요」 칩 · 대체 텍스트. 그림 설명은
 * 자리의 사이트 기능 문장 대신 출처 줄 다음 위치 문장이다(내보낼 때 그림 아래 차례와 같다 — src/lib/articlePhotos.ts placePhotos). 「홈페이지
 * 사진」이라고 쓰지 않는다.
 */
export function MapDraftFigure({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="draft-image-slot is-picked is-map">
      <img className="draft-image-photo" src={src} alt={alt} loading="lazy" style={{ aspectRatio: MAP_THUMB_RATIO }} />
      <span className="status-pill st-warn no-glyph">{MAP_PICK_CHIP}</span> {alt}
      <figcaption>
        <span style={{ display: 'block' }}>{MAP_CREDIT}</span>
        {caption && <span style={{ display: 'block' }}>{caption}</span>}
      </figcaption>
    </figure>
  )
}
