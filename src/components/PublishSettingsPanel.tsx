import { useState } from 'react'
import { savePublishSettings } from '../lib/api'
import { markdownToHtml } from '../lib/htmlFile'
import { articleTailMarkdown, type ArticleBrand } from '../lib/publishArticle'
import { normalizePublishSettings, PUBLISH_LIMITS, type PublishSettings } from '../lib/publishSettings'

/**
 * 브랜드별 발행 설정 — 글 끝 상담 안내 · 문의 링크 · 태그 · 카테고리 · 블로그 주소(src/lib/publishSettings.ts).
 *
 * 한 번 적어 두면 자사 사이트 · 블로그에 올리는 발행본 끝에 붙는다(src/lib/publishArticle.ts). 글쓰기 모델은 이 값을
 * 모른다 — 본문은 그대로이고 다듬어 둔 채널 글도 「원문 바뀜」이 되지 않는다. 브랜드를 바꾸면 부모가 key로 다시 그린다.
 */
export default function PublishSettingsPanel({
  tenantId,
  brand,
  settings,
  onSaved,
}: {
  tenantId: string
  brand: ArticleBrand
  settings: PublishSettings
  onSaved: (s: PublishSettings) => void
}) {
  const [ctaText, setCtaText] = useState(settings.ctaText ?? '')
  const [inquiryUrl, setInquiryUrl] = useState(settings.inquiryUrl ?? '')
  const [tags, setTags] = useState((settings.tags ?? []).join(', '))
  const [category, setCategory] = useState(settings.category ?? '')
  const [blogUrl, setBlogUrl] = useState(settings.blogUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // 저장 전에도 글 끝이 어떻게 붙는지 보인다 — 화면과 저장이 같은 규칙(normalizePublishSettings)을 쓴다.
  let draft: PublishSettings | null = null
  let invalid: string | null = null
  try {
    draft = normalizePublishSettings({ ctaText, inquiryUrl, tags, category, blogUrl })
  } catch (e) {
    invalid = e instanceof Error ? e.message : String(e)
  }
  const tail = draft ? articleTailMarkdown('', { brand, settings: draft }) : ''
  const configured = [
    settings.ctaText && '상담 안내',
    settings.inquiryUrl && '문의 링크',
    settings.tags?.length && `태그 ${settings.tags.length}`,
    settings.category && '카테고리',
    settings.blogUrl && '블로그',
  ]
    .filter(Boolean)
    .join(' · ')

  // 저장한 뒤 다시 고치면 「저장했어요」를 지운다 — 저장 안 된 편집이 저장된 것처럼 보이지 않게.
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value)
    setMessage(null)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setMessage(null)
    try {
      const saved = await savePublishSettings(tenantId, draft)
      onSaved(saved)
      setMessage('저장했어요. 다음 복사 · 내려받기부터 글 끝에 붙습니다.')
    } catch (e) {
      setMessage(`✗ ${e instanceof Error ? e.message : '저장하지 못했어요.'}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="publish-settings">
      <summary>
        발행 설정 — 글 끝 상담 안내 · 태그 · 블로그 <span className="muted">{configured || '아직 없음'}</span>
      </summary>
      <div className="publish-settings-body">
        <label>
          상담 안내 <span className="muted">(글 끝 한 문단 · {ctaText.trim().length}/{PUBLISH_LIMITS.cta}자)</span>
          <textarea
            rows={2}
            value={ctaText}
            onChange={edit(setCtaText)}
            placeholder="예: 사이트 주소와 자주 받는 질문 2~3개를 준비해 문의해 주세요."
          />
        </label>
        {/\d/.test(ctaText) && <p className="hint warn">숫자(가격 · 기간 · 횟수)는 확인한 값만 쓰세요 — 글 끝은 사실 대조를 거치지 않습니다.</p>}
        <label>
          문의 링크
          <input value={inquiryUrl} onChange={edit(setInquiryUrl)} placeholder="예: https://example.com/contact" />
        </label>
        <label>
          태그 <span className="muted">(쉼표로 구분 · 최대 {PUBLISH_LIMITS.tags}개 — 올리기 목록에서 「태그 복사」)</span>
          <input value={tags} onChange={edit(setTags)} placeholder="예: 군산여행, 군산 관광" />
        </label>
        <label>
          카테고리
          <input value={category} onChange={edit(setCategory)} placeholder="예: AI 검색 최적화" />
        </label>
        <label>
          블로그 주소 <span className="muted">(티스토리면 「자사 블로그」 줄이 그 블로그의 글쓰기 화면을 엽니다)</span>
          <input value={blogUrl} onChange={edit(setBlogUrl)} placeholder="예: https://myblog.tistory.com" />
        </label>
        {invalid && (
          <p className="error" role="alert">
            {invalid}
          </p>
        )}
        {tail && (
          <div className="publish-settings-preview">
            <span className="muted">글 끝 미리보기</span>
            {/* markdownToHtml은 모든 글자를 이스케이프한다. */}
            <div className="channel-preview" dangerouslySetInnerHTML={{ __html: markdownToHtml(tail) }} />
          </div>
        )}
        <div className="brief-bar">
          <button type="button" className="primary" disabled={saving || !draft} onClick={() => void save()}>
            {saving ? '저장하는 중…' : '발행 설정 저장'}
          </button>
          {message && (
            <span className={message.startsWith('✗') ? 'error' : 'hint'} role="status">
              {message}
            </span>
          )}
        </div>
      </div>
    </details>
  )
}
