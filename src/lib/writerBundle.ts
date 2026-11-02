import { fetchDraftPhotoFile, type FactNode, type StoredDraft, type TenantSummary } from './api'
import type { AppliedPhoto } from './articlePhotos'
import { workMarkdownOf } from './draftGaps'
import { buildPublishHtml } from './htmlFile'
import { countGapNotes, downloadBlob, safeFileName } from './markdownFile'
import type { WriterPlan } from './probePlan'
import type { PublishSettings } from './publishSettings'
import { articlePhotoFiles, photoFileName } from './sitePhotos'

/**
 * 작성자 묶음 — 작성자 한 명 몫의 초안(배정 글)을 한 폴더로 받는다(작성자 배정 운영, 2026-11-02).
 *
 * 글은 운영자 PC 한 곳에서 모두 만들고 작성자는 받은 초안을 자기 블로그에 올린다. 글 카드마다 「홈페이지용 .html」 · 「사진 N장 받기」를
 * 눌러 모으면 작성자 8명 × 10편에 저장 창이 백 번 넘게 뜨고, 어느 사진이 어느 글 것인지도 섞인다. 그래서 작성자 단추 옆에서 한 번에 받는다.
 *
 * 담는 것은 글 카드의 내보내기와 같다 — 글마다 홈페이지용 .html(buildPublishHtml: 빈칸 줄을 뺀 발행본 + 고른 사진 + 글 끝 + JSON-LD)과
 * 그 글에 들어간 홈페이지 사진 파일(articlePhotoFiles — 사진 사용 확인이 없으면 없다). 파일 이름 앞의 두 자리 번호는 배정표(scripts/
 * writer-plan.ts writerHandouts)의 번호 — 작성자 안의 배정 순서 — 라 작성자가 배정표와 맞춰 본다. 초안이 없는 글은 빼고 알린다.
 *
 * zip 라이브러리는 넣지 않는다 — 폴더를 고를 수 있는 곳(데스크톱 앱 · 크롬 계열)에서는 고른 폴더 안에 묶음 폴더를 만들어 쓰고, 그렇지 않으면
 * 파일마다 내려받는다(이름 앞에 묶음 이름을 붙여 한데 모인다).
 */

/** html은 글자를 그대로, photo는 저장할 때 서버에서 받아 형식(확장자)을 정한다. */
export type WriterBundleFile =
  | { kind: 'html'; name: string; text: string }
  | { kind: 'photo'; prefix: string; k: number; photo: AppliedPhoto; actionId: string; generatedAt: string }

export interface WriterBundle {
  /** 묶음 폴더 이름 — 「브랜드-w1-작성자-날짜」. */
  folder: string
  files: WriterBundleFile[]
  /** 담은 글 수(초안이 있는 배정 글). */
  articles: number
  /** 담은 사진 수. */
  photos: number
  /** 초안이 없어 뺀 배정 글의 주제 이름(배정 순서). */
  missing: string[]
  /** 빈칸이 남은 글 수 — 빈칸 줄은 발행본에서 빠진다(글 카드의 내보내기와 같다). */
  withGaps: number
}

export interface WriterBundleInput {
  plan: WriterPlan
  writerKey: string
  drafts: Record<string, StoredDraft>
  brand: TenantSummary
  facts: FactNode[]
  settings: PublishSettings | null
  /** 폴더 이름에 붙는 날(YYYY-MM-DD, KST). */
  today: string
}

const two = (n: number) => String(n).padStart(2, '0')

/** 작성자 한 명의 묶음 — 화면 없이 계산만 한다(scripts/verify-writer-bundle.ts). 배정에 없는 작성자면 빈 묶음이다. */
export function writerBundle(input: WriterBundleInput): WriterBundle {
  const mine = input.plan.articles.filter((a) => a.writer.key === input.writerKey)
  const writerName = mine[0]?.writer.name ?? input.writerKey
  const folder = [safeFileName(input.brand.brandName), safeFileName(input.writerKey), safeFileName(writerName), input.today].join('-')
  const files: WriterBundleFile[] = []
  const missing: string[] = []
  let articles = 0
  let photos = 0
  let withGaps = 0
  mine.forEach((a, i) => {
    const stored = input.drafts[a.id]
    if (!stored) {
      missing.push(a.name)
      return
    }
    const prefix = two(i + 1)
    articles += 1
    if (countGapNotes(workMarkdownOf(stored)) > 0) withGaps += 1
    files.push({
      kind: 'html',
      name: `${prefix}-${safeFileName(a.name)}.html`,
      text: buildPublishHtml({ stored, brand: input.brand, facts: input.facts, settings: input.settings }),
    })
    articlePhotoFiles(stored, { settings: input.settings, industry: input.brand.industry }).forEach((photo, j) => {
      photos += 1
      files.push({ kind: 'photo', prefix, k: j + 1, photo, actionId: stored.actionId, generatedAt: stored.generatedAt })
    })
  })
  return { folder, files, articles, photos, missing, withGaps }
}

/** 사진 파일 이름 — 글 번호 + 「사진1-소제목.jpg」(sitePhotos.ts photoFileName). 한 폴더에 여러 글의 사진이 섞이지 않게 번호를 붙인다. */
export function bundlePhotoName(file: Extract<WriterBundleFile, { kind: 'photo' }>, type: string): string {
  return `${file.prefix}-${photoFileName(file.k, file.photo, type)}`
}

/** 폴더 고르기 창 — 크롬 계열 · Electron에만 있다(File System Access API). lib.dom에는 아직 없다. */
type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>

function directoryPicker(): DirectoryPicker | null {
  const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  return typeof picker === 'function' ? picker.bind(window) : null
}

/** 폴더에 저장할 수 있는 곳인가 — 아니면 파일마다 내려받는다. */
export function canSaveToFolder(): boolean {
  return directoryPicker() !== null
}

/** 파일 하나의 내용 — 사진은 서버에서 받는다(글 카드 「사진 N장 받기」와 같은 길). 실패하면 throw. */
async function contentOf(tenantId: string, file: WriterBundleFile): Promise<{ name: string; blob: Blob }> {
  if (file.kind === 'html') return { name: file.name, blob: new Blob([file.text], { type: 'text/html;charset=utf-8' }) }
  const blob = await fetchDraftPhotoFile(tenantId, { actionId: file.actionId, generatedAt: file.generatedAt, place: file.photo.place })
  return { name: bundlePhotoName(file, blob.type), blob }
}

/**
 * 묶음을 저장한다. 폴더를 고를 수 있으면 고른 폴더 안에 묶음 폴더를 만들고(있으면 그 안에 같은 이름 파일을 덮어쓴다) 파일을 쓴다 —
 * 폴더 고르기를 닫으면 null. 고를 수 없으면 파일마다 내려받는다. 하나라도 실패하면 throw — 그때까지 쓴 파일은 남는다.
 */
export async function saveWriterBundle(tenantId: string, bundle: WriterBundle): Promise<{ saved: number; where: string } | null> {
  const picker = directoryPicker()
  if (!picker) {
    for (const file of bundle.files) {
      const { name, blob } = await contentOf(tenantId, file)
      downloadBlob(`${bundle.folder}-${name}`, blob)
    }
    return { saved: bundle.files.length, where: '내려받기 폴더' }
  }
  let parent: FileSystemDirectoryHandle
  try {
    parent = await picker({ id: 'writer-bundle', mode: 'readwrite' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null
    throw err
  }
  const dir = await parent.getDirectoryHandle(bundle.folder, { create: true })
  for (const file of bundle.files) {
    const { name, blob } = await contentOf(tenantId, file)
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
    try {
      await writable.write(blob)
    } catch (err) {
      // 쓰다 멈춘 파일을 닫으면 반쪽 파일이 남는다 — 버리고 원래 오류를 올린다.
      await writable.abort()
      throw err
    }
    await writable.close()
  }
  return { saved: bundle.files.length, where: `${parent.name}/${bundle.folder}` }
}
