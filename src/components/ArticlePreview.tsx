import { useEffect, useState } from 'react'
import { fetchScreenFile } from '../lib/api'
import { inlineScreens, screenPreviewHtml } from '../lib/screenExport'

/**
 * 앱 안 글 미리보기(콘텐츠 보관함 「본문 보기」 · 올리기 목록의 줄 미리보기) — html은 markdownToHtml의 결과(모든 글자를 이스케이프한다).
 * 이 PC에만 있는 그림(자사 화면 · 앱이 그린 지도 · 업주 사진 — 앱 주소)은 먼저 「[화면: 이름]」 · 「[지도: …]」 · 「[사진: …]」 글자로
 * 보이고(screenPreviewHtml), 그림을 받으면 복사 · 홈페이지용 .html처럼 문서 안(data:) 그림으로 바꿔 다시 그린다(inlineScreens) —
 * 미리보기가 내보낼 글과 같아지고, 미리보기에서 골라 복사해도 앱 주소(127.0.0.1)가 블로그로 나가지 않는다. 받지 못한 그림은 글자로 남는다.
 * 2026-11-06 — 스테이,머뭄은 사진 대부분이 업주 사진이라 「본문 보기」가 글자뿐이어서 사진을 바꾼 것이 보이지 않았다.
 */
export default function ArticlePreview({ html }: { html: string }) {
  const [inlined, setInlined] = useState<{ from: string; html: string } | null>(null)
  useEffect(() => {
    let alive = true
    inlineScreens(html, fetchScreenFile).then(
      (out) => {
        if (alive) setInlined({ from: html, html: out.html })
      },
      (e: unknown) => console.warn('[ArticlePreview] 미리보기에 그림을 넣지 못해 글자로 둡니다', e),
    )
    return () => {
      alive = false
    }
  }, [html])
  const shown = inlined?.from === html ? inlined.html : screenPreviewHtml(html)
  return <div className="channel-preview" dangerouslySetInnerHTML={{ __html: shown }} />
}
