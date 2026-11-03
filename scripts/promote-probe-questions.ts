/**
 * 실증 질문(probe)을 일반 질문으로 올린다 — 실증(처치 · 대조) 실험을 끝내고(2026-11-02 운영 방식 전환), 실증 · 홀드아웃 질문도
 * 점수에 넣는다. 질문 수는 늘리지 않는다(지금 이름 없는 질문 그대로).
 *
 *   npx tsx scripts/promote-probe-questions.ts <tenantId…> --app-data "<userData>"            # dry-run(기본)
 *   npx tsx scripts/promote-probe-questions.ts <tenantId…> --app-data "<userData>" --write    # 앱을 끄고
 *   npx tsx scripts/promote-probe-questions.ts web4ai gunsan --app-data "<userData>" --baked-bank-only [--write]
 *                                                     # 저장소 설정 브랜드(web4ai)는 새 판 파일만 — 아래 참고
 *
 * 지금 판 질문지를 그대로 옮긴 다음 판 파일을 만든다(v5 → v6 꼴 — 그 브랜드의 질문지 파일 · 주차 카드에 아직 없는 다음 번호,
 * server/questionHandoff.ts nextBankVersion). 문항 순서 · id · 문장 · 범주 · 단계 · 주제 · cohortShared · 문항의 version은 그대로 두고
 * probe · paraphraseOf 표시만 뗀다. 질문지의 version은 새 판, generatedAt은 올린 시각, cohortBank는 그대로다. 그리고 오버레이
 * (tenants.overlay.json)의 그 브랜드 questionBankVersion만 새 판으로 바꾼다. 점수 코드는 고치지 않는다 — 표시가 없으면 모든 이름 없는
 * 질문이 점수에 든다(src/lib/questionScope.ts). 판이 바뀌므로 「같은 조건」 비교는 새 판에서 새로 시작한다(src/lib/comparability.ts).
 * 지난 주차는 자기 판의 질문지를 그대로 읽는다. 추가 글은 판이 달라도 같은 문장으로 질문을 다시 찾는다(src/lib/extraArticles.ts).
 *
 * 다음 측정이 새 판 파일을 그대로 쓰는 까닭(server/pipeline.ts ensureQuestionBank):
 *   - 코호트 공통 질문지를 쓰는 브랜드 — cohortQuestionBank.ts ensureComposedQuestionBank가 그 판 파일이 있고 cohortBank(키 · 판)가
 *     지금 코호트 질문지와 같으면 저장된 문항을 그대로 돌려준다. 다르면 멈추므로 쓰기 전에 같은지 본다.
 *   - 그렇지 않은 브랜드 — 일반 질문 하한(enforceAgnosticQuota)을 이미 채우면 문항을 바꾸지 않는다. 표시를 떼면 일반 질문이 늘 뿐이다.
 *   - questionBankSize는 은행을 새로 만들 때만 본다 — 문항 수가 설정보다 많아도 자르거나 새로 만들지 않는다. 그래서 고치지 않는다
 *     (경쟁사 초안 · 「모두 새로 쓰기」가 새로 만들 브랜드 질문 수라, 늘리면 측정 비용만 는다).
 * scripts/verify-promote-probe-questions.ts가 임시 폴더의 가짜 브랜드로 실제 ensureQuestionBank를 불러(AI 없이) 이를 확인한다.
 *
 * 판을 오버레이가 정하지 않는 브랜드는 그대로는 쓰지 않는다(dry-run도 ✗로 알린다).
 *   - 저장소 설정(server/tenants.config.json)에 있는 브랜드(web4ai 등) — 병합은 저장소 설정이 이겨 오버레이의 판은 무시된다
 *     (tenantRegistry.ts). 오버레이만 바꾸면 측정은 계속 옛 판을 잰다. --baked-bank-only를 주면 이런 브랜드는 새 판 파일만 쓰고
 *     오버레이는 건드리지 않는다. 그 뒤 저장소 설정의 questionBankVersion을 새 판으로 바꾸는 릴리스를 낸다. 순서가 중요하다 — 새 판
 *     파일 없이 판만 오르면 측정이 질문지를 AI로 새로 만들어(ensureComposedQuestionBank · ensureQuestionBank) 실증 질문이 사라지고
 *     브랜드 질문이 바뀐다. 새 판 파일은 릴리스 전까지 측정에 쓰이지 않는다(측정은 저장소 설정의 판 파일만 읽는다).
 *   - 앱에서 고친 경쟁사 목록(competitors.json)이 쓰이는 브랜드 — 판은 그 파일이 정하고, 오버레이 · 저장소 설정의 판을 바꾸면 베이스
 *     지문이 달라져 고친 경쟁사 목록이 조용히 꺼진다(tenantCompetitorsStore.ts baseFingerprint). --baked-bank-only여도 쓰지 않는다.
 *
 * --write가 지키는 것(scripts/add-probe-questions.ts와 같다):
 *   - 고른 브랜드 가운데 하나라도 걸리면 아무것도 쓰지 않는다.
 *   - 가상화 사본 경로(Packages\Claude_…)를 거절하고, 브랜드 폴더 · 앱 데이터 폴더에 표지 파일을 써 보아 쓰기가 가상화 위치로 가면
 *     멈춘다(server/probeQuestions.ts writeRedirects). Claude 셸에서는 //localhost/C$/… 경로로 실행한다.
 *   - 앱이 실행 중이면 멈춘다 — 측정이 질문지 · 오버레이를 읽는다.
 *   - 지금 판 질문지와 오버레이를 <tenantDir>/before-promote-<시각>/에 복사한 뒤, 새 판 파일을 쓰고(있으면 멈춘다) 오버레이를 원자적으로
 *     바꿔 쓴다. 다시 읽어 쓴 그대로인지, 옛 판 파일이 그대로인지 본다. 옛 판 파일 · cohort-banks · questionBankSize는 건드리지 않는다.
 *     오버레이를 바꿀 브랜드가 없으면(모두 새 판 파일만 쓰는 저장소 설정 브랜드) 오버레이는 백업 · 쓰기 없이 그대로인지만 본다.
 * 되돌리기는 백업의 오버레이를 제자리로 복사하면 된다(새 판 파일은 쓰이지 않게 된다). 새 판 파일만 쓴 저장소 설정 브랜드는 되돌릴 것이
 * 없다 — 저장소 설정의 판을 바꾸기 전까지 측정은 옛 판을 잰다.
 *
 * 동봉본 만들기(v0.4.49 브랜드 통일):
 *   npx tsx scripts/promote-probe-questions.ts web4ai gunsan --app-data "<userData>" --bundle-out src/data/question-banks
 *     [--cohort-out cohort-banks]
 * 앱 데이터는 읽기만 하고, 저장소 폴더에만 쓴다 — 설치본이 측정 때 userData에 없으면 가져오는 질문지(server/bundledBanks.ts).
 *   - 실증 질문이 있는 브랜드는 위와 같은 다음 판(표시만 뗌)을, 없는 브랜드는 지금 판을 그대로 <bundle-out>/<tenantId>/<판>.json에 쓴다.
 *     오버레이 · 저장소 설정 어느 쪽이 판을 정하든 같다(판은 저장소 설정 server/tenants.config.json을 바꾸는 릴리스가 정한다).
 *   - 그 질문지가 쓰는 코호트 공통 질문지를 <cohort-out>(기본 저장소 cohort-banks/)에 둔다 — 없으면 앱 데이터의 것을 그대로 복사하고,
 *     있으면 내용(JSON)이 같은지만 본다(autocrlf로 줄 끝이 달라 바이트는 다를 수 있다).
 *   - 같은 자리에 동봉본이 이미 있으면 내용(판 · 코호트 출처 · 문항)이 같을 때만 그대로 두고, 다르면 쓰지 않고 멈춘다(덮지 않는다).
 *   - 하나라도 걸리면 아무것도 쓰지 않는다. --write와 함께 쓸 수 없다(앱 데이터에는 쓰지 않는다). 가상화 사본 경로는 거절한다.
 */
import { execFileSync } from 'node:child_process'
import { constants as fsConstants, existsSync, readFileSync, realpathSync } from 'node:fs'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bankPathProblem, findRedirectedCopies, looksVirtualized, writeRedirects } from '../server/probeQuestions'
import { nextBankVersion } from '../server/questionHandoff'
import type { QuestionBank } from '../server/store'
import { writeJsonAtomic } from '../server/tenantWriteQueue'
import { isProbe, isScoredAgnostic } from '../src/lib/questionScope'
import type { QuestionSpec } from '../src/prompts/types'

/** 그 브랜드의 판을 어디서 정하는가 — 오버레이만 고치므로, 오버레이가 정하는 브랜드만 올린다. */
export interface PromoteSource {
  /** 저장소 설정(server/tenants.config.json)에 있는 브랜드인가. */
  baked: boolean
  /** 오버레이에 적힌 판. 오버레이에 없으면 undefined. */
  overlayVersion?: string
  /** 앱에서 고친 경쟁사 목록(competitors.json)이 지금 쓰이는가. */
  competitorEdit: boolean
}

export interface PromoteInput {
  tenantId: string
  /** 측정이 지금 쓰는 판(런타임 설정의 questionBankVersion). */
  version: string
  /** 그 판의 질문지. */
  bank: QuestionBank
  source: PromoteSource
  /** 코호트 공통 질문지를 쓰면 지금 코호트 키 · 판 — 측정이 저장된 질문지를 그대로 쓰는 조건이다(ensureComposedQuestionBank). */
  cohort: { key: string; version: string } | null
  /** 판 이름으로 이미 쓰인 것(질문지 파일 · 주차 카드) — 새 판은 이 이름을 피한다. */
  taken: string[]
  now: Date
  /** --baked-bank-only — 저장소 설정 브랜드도 새 판 파일만 쓴다(오버레이는 그대로, 판은 릴리스가 올린다). */
  bakedBankOnly?: boolean
}

export interface PromotePlan {
  tenantId: string
  fromVersion: string
  toVersion: string
  /** 새 판 파일만 쓰고 오버레이는 바꾸지 않는다 — 저장소 설정 브랜드(판은 저장소 설정을 바꾸는 릴리스가 올린다). */
  bankOnly: boolean
  /** 새 판 질문지 — 이대로 쓴다. */
  bank: QuestionBank
  /** 표시를 뗄 실증 질문 수와 그중 바꿔 쓴 질문(홀드아웃) 수. */
  probes: number
  paraphrases: number
  /** 이름 없는 질문(category-agnostic) 수 — 올리기 전후 같다. */
  agnostic: number
  /** 점수에 세는 이름 없는 질문 수 — 올리기 전 · 뒤. */
  scoredBefore: number
  scoredAfter: number
}

/** 문항 하나의 실증 표시를 뗀다. 나머지 필드 · 순서는 그대로다. */
export function promoteQuestion(q: QuestionSpec): QuestionSpec {
  const next = { ...q }
  delete next.probe
  delete next.paraphraseOf
  return next
}

/**
 * 새 판 질문지를 정한다. 판을 오버레이가 정하지 않거나, 질문지가 측정이 쓰는 판 · 코호트와 어긋나거나, 올릴 실증이 없으면 아무것도
 * 정하지 않는다. 경쟁사 편집이 만든 질문지(derivedFrom · regeneratedFrom)는 그 편집이 쓰일 때만 측정되므로 올리지 않는다.
 * 저장소 설정 브랜드는 bakedBankOnly일 때만 새 판 파일만 쓰는 계획을 세운다(판은 저장소 설정을 바꾸는 릴리스가 올린다).
 */
export function planPromotion(input: PromoteInput): { ok: true; plan: PromotePlan } | { ok: false; errors: string[] } {
  const { bank, source, version } = input
  const errors: string[] = []
  const bankOnly = source.baked && input.bakedBankOnly === true
  if (source.baked && !bankOnly) {
    errors.push(
      `저장소 설정(server/tenants.config.json)에 있는 브랜드입니다 — 판은 저장소 설정이 정하고 오버레이의 판은 무시됩니다. ` +
        `오버레이만 바꾸면 측정은 계속 지금 판(${version})을 잽니다. --baked-bank-only로 새 판 파일만 먼저 쓰고, ` +
        '저장소 설정의 questionBankVersion을 그 판으로 바꾸는 릴리스를 내야 합니다.',
    )
  } else if (source.competitorEdit) {
    errors.push(
      '앱에서 고친 경쟁사 목록(competitors.json)이 쓰이고 있습니다 — 판은 그 파일이 정하고, ' +
        `${bankOnly ? '저장소 설정' : '오버레이'}의 판을 바꾸면 베이스 지문이 달라져 고친 경쟁사 목록이 조용히 꺼집니다.`,
    )
  } else if (bankOnly) {
    // 저장소 설정이 판을 정한다 — 오버레이에 같은 브랜드가 남아 있어도 무시되므로 오버레이의 판은 보지 않는다.
  } else if (source.overlayVersion === undefined) {
    errors.push('오버레이(tenants.overlay.json)에 없는 브랜드입니다.')
  } else if (source.overlayVersion !== version) {
    errors.push(`오버레이의 판(${source.overlayVersion})이 측정이 쓰는 판(${version})과 다릅니다.`)
  }
  if (bank.version !== version) errors.push(`질문지 파일의 판(${bank.version})이 측정이 쓰는 판(${version})과 다릅니다.`)
  if (bank.derivedFrom || bank.regeneratedFrom) {
    errors.push('경쟁사 편집이 만든 질문지(derivedFrom · regeneratedFrom)입니다 — 그 편집이 쓰일 때만 측정되므로 올리지 않습니다.')
  }
  if (input.cohort) {
    const from = bank.cohortBank
    if (!from || from.key !== input.cohort.key || from.version !== input.cohort.version) {
      errors.push(
        `질문지의 코호트 출처(${from ? `${from.key}/${from.version}` : '없음'})가 지금 코호트 질문지(${input.cohort.key}/${input.cohort.version})와 ` +
          '다릅니다 — 측정이 새 판을 쓰지 않고 멈춥니다(ensureComposedQuestionBank).',
      )
    }
  }
  const questions = bank.questions ?? []
  const ids = questions.map((q) => q.questionId)
  if (new Set(ids).size !== ids.length) errors.push('질문 id가 겹칩니다.')
  const probes = questions.filter(isProbe)
  if (probes.length === 0) errors.push('실증 질문이 없습니다 — 올릴 것이 없습니다.')
  if (errors.length > 0) return { ok: false, errors }

  const toVersion = nextBankVersion(version, [...input.taken, version])
  const promoted = questions.map(promoteQuestion)
  return {
    ok: true,
    plan: {
      tenantId: input.tenantId,
      fromVersion: version,
      toVersion,
      bankOnly,
      bank: {
        version: toVersion,
        generatedAt: input.now.toISOString(),
        questions: promoted,
        ...(bank.cohortBank ? { cohortBank: { ...bank.cohortBank } } : {}),
      },
      probes: probes.length,
      paraphrases: probes.filter((q) => q.paraphraseOf).length,
      agnostic: questions.filter((q) => q.category === 'category-agnostic').length,
      scoredBefore: questions.filter(isScoredAgnostic).length,
      scoredAfter: promoted.filter(isScoredAgnostic).length,
    },
  }
}

/**
 * 오버레이에서 그 브랜드들의 questionBankVersion만 바꾼 배열 — 다른 브랜드 · 다른 필드 · 필드 순서는 그대로다. 오버레이에 없거나 판이
 * 기대와 다르면 아무것도 바꾸지 않는다.
 */
export function promoteOverlay(
  overlay: unknown,
  changes: { tenantId: string; from: string; to: string }[],
): { ok: true; overlay: Record<string, unknown>[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(overlay)) return { ok: false, errors: ['오버레이가 배열이 아닙니다.'] }
  const errors: string[] = []
  const next = (overlay as Record<string, unknown>[]).map((entry) => entry)
  for (const change of changes) {
    const indexes = next.flatMap((entry, i) => (entry && entry.tenantId === change.tenantId ? [i] : []))
    if (indexes.length !== 1) {
      errors.push(`오버레이에 이 브랜드(${change.tenantId})가 ${indexes.length}개 있습니다(1개여야 합니다).`)
      continue
    }
    const i = indexes[0]!
    if (next[i]!.questionBankVersion !== change.from) {
      errors.push(`오버레이의 ${change.tenantId} 판(${String(next[i]!.questionBankVersion)})이 기대한 판(${change.from})과 다릅니다.`)
      continue
    }
    next[i] = { ...next[i]!, questionBankVersion: change.to }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, overlay: next }
}

/** 설치본에 담을 질문지 한 벌(--bundle-out). */
export interface BundlePlan {
  tenantId: string
  /** 측정이 지금 쓰는 판(앱 데이터). */
  fromVersion: string
  /** 동봉할 판 — 실증이 있으면 다음 판(표시를 뗌), 없으면 지금 판 그대로. */
  version: string
  /** 실증 표시를 떼어 다음 판으로 올렸는가. */
  promoted: boolean
  bank: QuestionBank
  probes: number
  paraphrases: number
  /** 이름 없는 질문(category-agnostic) 수 — 동봉본에서는 모두 점수에 센다. */
  agnostic: number
}

/**
 * 동봉할 질문지를 정한다 — 파일을 읽지도 쓰지도 않는다. 실증 질문이 있으면 planPromotion과 같은 다음 판(새 판 파일만 쓰는 저장소 설정
 * 브랜드와 같다 — 판은 저장소 설정을 바꾸는 릴리스가 정하므로 오버레이의 판은 보지 않는다), 없으면 지금 판을 한 글자도 바꾸지 않고 담는다.
 * 앱에서 고친 경쟁사 목록이 판을 정하거나, 경쟁사 편집이 만든 질문지이거나, 코호트 출처가 어긋나면 담지 않는다.
 */
export function planBundle(input: Omit<PromoteInput, 'bakedBankOnly'>): { ok: true; plan: BundlePlan } | { ok: false; errors: string[] } {
  const questions = input.bank.questions ?? []
  if (questions.some(isProbe)) {
    const promoted = planPromotion({ ...input, source: { baked: true, competitorEdit: input.source.competitorEdit }, bakedBankOnly: true })
    if (!promoted.ok) return promoted
    const { plan } = promoted
    return {
      ok: true,
      plan: {
        tenantId: input.tenantId,
        fromVersion: plan.fromVersion,
        version: plan.toVersion,
        promoted: true,
        bank: plan.bank,
        probes: plan.probes,
        paraphrases: plan.paraphrases,
        agnostic: plan.agnostic,
      },
    }
  }
  const errors: string[] = []
  if (input.source.competitorEdit) errors.push('앱에서 고친 경쟁사 목록(competitors.json)이 쓰이고 있습니다 — 판은 그 파일이 정합니다.')
  if (input.bank.version !== input.version) errors.push(`질문지 파일의 판(${input.bank.version})이 측정이 쓰는 판(${input.version})과 다릅니다.`)
  if (input.bank.derivedFrom || input.bank.regeneratedFrom) {
    errors.push('경쟁사 편집이 만든 질문지(derivedFrom · regeneratedFrom)입니다 — 그 편집이 쓰일 때만 측정되므로 담지 않습니다.')
  }
  if (input.cohort) {
    const from = input.bank.cohortBank
    if (!from || from.key !== input.cohort.key || from.version !== input.cohort.version) {
      errors.push(`질문지의 코호트 출처(${from ? `${from.key}/${from.version}` : '없음'})가 지금 코호트 질문지(${input.cohort.key}/${input.cohort.version})와 다릅니다.`)
    }
  }
  const ids = questions.map((q) => q.questionId)
  if (ids.length === 0) errors.push('문항이 없습니다.')
  if (new Set(ids).size !== ids.length) errors.push('질문 id가 겹칩니다.')
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    plan: {
      tenantId: input.tenantId,
      fromVersion: input.version,
      version: input.version,
      promoted: false,
      bank: JSON.parse(JSON.stringify(input.bank)) as QuestionBank,
      probes: 0,
      paraphrases: 0,
      agnostic: questions.filter((q) => q.category === 'category-agnostic').length,
    },
  }
}

/** 동봉본이 같은가 — 판 · 코호트 출처 · 문항(모든 필드 · 순서)이 같다. generatedAt은 보지 않는다(다시 만들면 시각만 다르다). */
export function sameBundledBank(a: QuestionBank, b: QuestionBank): boolean {
  return (
    a.version === b.version &&
    JSON.stringify(a.cohortBank ?? null) === JSON.stringify(b.cohortBank ?? null) &&
    JSON.stringify(a.questions) === JSON.stringify(b.questions)
  )
}

/** 동봉본 · 코호트 공통 질문지 파일 내용 — 저장소의 다른 JSON처럼 두 칸 들여쓰기에 끝 줄바꿈. */
export const bundleFileText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** 백업 폴더 이름 — 다른 편집의 백업(before-probe-… · before-profile-…)과 같은 꼴. */
export function promoteBackupDirName(now: Date): string {
  return `before-promote-${now.toISOString().replace(/[:.]/g, '-')}`
}

export interface PromoteWriteItem {
  tenantDir: string
  /** 지금 판 질문지 경로와 계획을 세울 때 읽은 원문. */
  fromPath: string
  before: string
  /** 새 판 질문지 경로와 내용. */
  toPath: string
  bank: QuestionBank
}

export interface PromoteWriteInput {
  items: PromoteWriteItem[]
  overlayPath: string
  /** 계획을 세울 때 읽은 오버레이 원문. 오버레이 파일이 없으면 null. */
  overlayBefore: string | null
  /** 바꿔 쓸 오버레이. null이면 오버레이는 읽지도 · 백업하지도 · 쓰지도 않는다(모두 새 판 파일만 쓰는 저장소 설정 브랜드). */
  overlay: unknown[] | null
  now: Date
}

const fileExists = (p: string) =>
  access(p).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    },
  )

/**
 * 파일 쓰기 — 모두 확인한 뒤에 쓴다. 계획을 세울 때 읽은 원문과 지금 파일이 다르거나(그 사이 앱 · 다른 실행이 고쳤다) 새 판 파일이 이미
 * 있으면 아무것도 쓰지 않고 던진다. 브랜드마다 <tenantDir>/before-promote-<시각>/에 지금 판 질문지와 오버레이를 복사하고(있는 백업은
 * 덮지 않는다), 새 판 파일들을 쓴 뒤 오버레이를 한 번 바꿔 쓴다. 오버레이를 마지막에 쓰므로 중간에 멈추면 새 판 파일만 남고 측정은
 * 옛 판 그대로다. 오버레이를 바꾸지 않으면(overlay null) 오버레이는 보지도 · 백업하지도 · 쓰지도 않는다.
 */
export async function writePromotion(input: PromoteWriteInput): Promise<{ backups: string[] }> {
  if (input.overlay !== null && (input.overlayBefore === null || (await readFile(input.overlayPath, 'utf-8')) !== input.overlayBefore)) {
    throw new Error(`오버레이가 그 사이 바뀌었습니다 — 다시 실행하세요: ${input.overlayPath}`)
  }
  for (const item of input.items) {
    if ((await readFile(item.fromPath, 'utf-8')) !== item.before) throw new Error(`질문지가 그 사이 바뀌었습니다 — 다시 실행하세요: ${item.fromPath}`)
    if (await fileExists(item.toPath)) throw new Error(`새 판 파일이 이미 있습니다 — 덮지 않습니다: ${item.toPath}`)
  }
  const backups: string[] = []
  for (const item of input.items) {
    const backupDir = path.join(item.tenantDir, promoteBackupDirName(input.now))
    await mkdir(backupDir, { recursive: true })
    for (const source of input.overlay !== null ? [item.fromPath, input.overlayPath] : [item.fromPath]) {
      const target = path.join(backupDir, path.basename(source))
      // 있는 백업은 덮지 않는다 — 같은 시각에 두 번 쓰면 첫 백업(원래 파일)이 사라진다.
      await copyFile(source, target, fsConstants.COPYFILE_EXCL).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') throw new Error(`백업 자리에 이미 파일이 있어 쓰지 않습니다(있는 백업을 덮지 않음): ${target}`)
        throw err
      })
    }
    backups.push(backupDir)
  }
  for (const item of input.items) await writeJsonAtomic(item.toPath, item.bank)
  if (input.overlay !== null) await writeJsonAtomic(input.overlayPath, input.overlay)
  return { backups }
}

/**
 * 쓴 뒤 다시 읽어 본다 — 새 판 파일 · 오버레이가 쓴 그대로이고 옛 판 파일이 그대로인가(오버레이를 바꾸지 않았으면 오버레이도 그대로인가).
 * 어긋난 곳을 돌려준다(빈 배열이면 통과).
 */
export async function checkPromotion(input: PromoteWriteInput): Promise<string[]> {
  const problems: string[] = []
  const same = async (file: string, expected: unknown) => JSON.stringify(JSON.parse(await readFile(file, 'utf-8'))) === JSON.stringify(expected)
  for (const item of input.items) {
    if (!(await same(item.toPath, item.bank))) problems.push(`새 판 질문지가 쓴 내용과 다릅니다: ${item.toPath}`)
    if ((await readFile(item.fromPath, 'utf-8')) !== item.before) problems.push(`옛 판 질문지가 바뀌었습니다: ${item.fromPath}`)
  }
  if (input.overlay !== null) {
    if (!(await same(input.overlayPath, input.overlay))) problems.push(`오버레이가 쓴 내용과 다릅니다: ${input.overlayPath}`)
  } else if (input.overlayBefore !== null && (await readFile(input.overlayPath, 'utf-8')) !== input.overlayBefore) {
    problems.push(`바꾸지 않을 오버레이가 바뀌었습니다: ${input.overlayPath}`)
  }
  return problems
}

// ── 실행 ────────────────────────────────────────────────────────────────────
function fail(...lines: string[]): never {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** 셸이 확장하지 못한 환경변수 토큰을 직접 푼다(scripts/add-probe-questions.ts와 같은 헬퍼). */
const expandEnvTokens = (input: string) =>
  input
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => process.env[name] ?? m)

/**
 * 앱이 실행 중이면 중단한다 — 측정이 질문지 · 오버레이를 읽고, 브랜드 편집이 오버레이를 쓴다. scripts/add-probe-questions.ts와 같은
 * 방식으로 실제로 확인한다. 확인에 실패하면 그 사실을 밝힐 뿐 통과시키지 않는다.
 */
function assertAppClosed(): void {
  const EXE = 'Web4AI Brand AEO.exe'
  let out = ''
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' })
  } catch (err) {
    fail(`✗ tasklist 실행에 실패해 앱 실행 여부를 확인할 수 없습니다(${err instanceof Error ? err.message : String(err)}). 앱을 끄고 다시 시도하세요.`)
  }
  const pids = [...out.matchAll(/^"([^"]+)","(\d+)"/gm)]
    .filter((m) => m[1].toLowerCase() === EXE.toLowerCase())
    .map((m) => m[2])
  if (pids.length > 0) {
    fail(
      `✗ 앱이 실행 중입니다(${EXE} · PID ${pids.join(', ')}). 완전히 종료한 뒤 다시 실행하세요.`,
      '  측정이 질문지 · 오버레이를 읽고 쓰므로 동시에 고치면 한쪽 변경이 사라집니다. 아무것도 쓰지 않았습니다.',
    )
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const VALUE_FLAGS = new Set(['--app-data', '--bundle-out', '--cohort-out'])
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const USAGE =
    '사용법: npx tsx scripts/promote-probe-questions.ts <tenantId…> --app-data <dir> [--baked-bank-only] [--write]\n' +
    '        npx tsx scripts/promote-probe-questions.ts <tenantId…> --app-data <dir> --bundle-out <dir> [--cohort-out <dir>]'
  const unknownFlag = args.find((x) => x.startsWith('--') && !VALUE_FLAGS.has(x) && x !== '--write' && x !== '--baked-bank-only')
  if (unknownFlag) fail(`모르는 옵션입니다: ${unknownFlag}`, USAGE)
  const missingValue = args.findIndex((x, i) => VALUE_FLAGS.has(x) && (args[i + 1] === undefined || args[i + 1]!.startsWith('--')))
  if (missingValue >= 0) fail(`${args[missingValue]}에 값이 없습니다.`, USAGE)
  // 같은 브랜드를 두 번 주면 한 번만 본다 — 두 번 계획하면 같은 새 판 파일 · 백업 자리를 두 번 쓰려 한다.
  const tenantIds = [...new Set(args.filter((x, i) => !x.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? '')))]
  const write = args.includes('--write')
  const bakedBankOnly = args.includes('--baked-bank-only')
  const rawAppData = flag('--app-data')
  if (!rawAppData || tenantIds.length === 0) fail(USAGE)

  const expanded = expandEnvTokens(rawAppData)
  if (expanded !== rawAppData) console.log(`인자 확장: ${rawAppData} → ${expanded}`)
  const appData = path.resolve(expanded)
  if (!existsSync(appData)) fail(`앱 데이터 폴더가 없습니다: ${appData}`)

  const bundleOut = flag('--bundle-out')
  if (bundleOut === undefined && flag('--cohort-out') !== undefined) fail('--cohort-out은 --bundle-out과 함께만 씁니다.', USAGE)
  if (bundleOut !== undefined) {
    if (write || bakedBankOnly) fail('--bundle-out은 --write · --baked-bank-only와 함께 쓸 수 없습니다 — 동봉본 만들기는 앱 데이터에 쓰지 않습니다.', USAGE)
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const cohortOut = path.resolve(flag('--cohort-out') ?? path.join(repoRoot, 'cohort-banks'))
    await bundleMain({ tenantIds, appData, bundleOut: path.resolve(bundleOut), cohortOut })
    return
  }

  // 로컬 앱 데이터만 읽고 쓴다 — .env에 Blob 토큰이 있으면 오버레이(브랜드 목록)를 클라우드에서 읽는다(tenantOverlay.ts).
  process.env.BLOB_READ_WRITE_TOKEN = ''
  process.env.BLOB_STORE_ID = ''
  // APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
  process.env.APP_DATA_DIR = appData
  const { COHORT_BANK_DIR, PIPELINE_DATA_DIR, stateFilePath } = await import('../server/appPaths')
  const { findBakedTenant, loadRuntimeTenants, loadTenantWithoutCompetitorEdit } = await import('../server/tenantRegistry')
  const { overrideApplies, readCompetitorOverride } = await import('../server/tenantCompetitorsStore')
  const { cohortKey } = await import('../server/cohortQuestionBank')
  const { FileResultStore } = await import('../server/store')
  const { PROBE_PLAN_FILE } = await import('../server/probePlanStore')

  const overlayPath = stateFilePath('tenants.overlay.json')
  const overlayBefore = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : null
  let overlay: unknown = []
  if (overlayBefore !== null) {
    try {
      overlay = JSON.parse(overlayBefore)
    } catch (err) {
      fail(`오버레이를 읽지 못했습니다: ${overlayPath} — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const overlayEntries = Array.isArray(overlay) ? (overlay as { tenantId?: unknown; questionBankVersion?: unknown }[]) : []

  const virtualized = [appData, realpathSync.native(appData)].some(looksVirtualized)
  console.log(`앱 데이터: ${appData}`)
  console.log(`오버레이: ${overlayPath}${overlayBefore === null ? ' (없음)' : ''}`)
  if (virtualized) console.warn('⚠ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다.')

  const store = new FileResultStore()
  const runtime = await loadRuntimeTenants()
  const planned: { plan: PromotePlan; item: PromoteWriteItem }[] = []
  let problems = false
  for (const tenantId of tenantIds) {
    console.log(`\n■ ${tenantId}`)
    const errorLine = (e: string) => {
      problems = true
      console.log(`  ✗ ${e}`)
    }
    const tenant = runtime.find((t) => t.tenantId === tenantId)
    if (!tenant) {
      errorLine(`브랜드를 찾을 수 없습니다(저장소 설정 · ${overlayPath}).`)
      continue
    }
    if (tenant.cohortOnly) {
      errorLine('경쟁사로만 재는 브랜드입니다 — 실증 질문은 고객 브랜드에만 있습니다.')
      continue
    }
    const tenantDir = path.join(PIPELINE_DATA_DIR, tenantId)
    const version = tenant.questionBankVersion
    const bankPath = path.join(tenantDir, 'question-bank', `${version}.json`)
    console.log(`  ${tenant.brandName} · 질문지 ${bankPath}`)
    const pathProblem = bankPathProblem(bankPath, PIPELINE_DATA_DIR, tenantId)
    if (pathProblem) {
      errorLine(pathProblem)
      continue
    }
    if (!existsSync(bankPath)) {
      errorLine(`질문지가 없습니다: ${bankPath}`)
      continue
    }
    const before = readFileSync(bankPath, 'utf8')
    let bank: QuestionBank
    try {
      bank = JSON.parse(before) as QuestionBank
    } catch (err) {
      errorLine(`질문지를 읽지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }

    const repo = await loadTenantWithoutCompetitorEdit(tenantId)
    const edit = (await readCompetitorOverride(tenantId))?.current ?? null
    const overlayEntry = overlayEntries.find((e) => e?.tenantId === tenantId)
    const source: PromoteSource = {
      baked: Boolean(await findBakedTenant(tenantId)),
      ...(typeof overlayEntry?.questionBankVersion === 'string' ? { overlayVersion: overlayEntry.questionBankVersion } : {}),
      competitorEdit: Boolean(repo && overrideApplies(edit, repo)),
    }
    const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER)
    const taken = [
      ...(await store.listQuestionBankVersions(tenantId)),
      ...history.map((c) => c.questionBankVersion).filter((v): v is string => Boolean(v)),
      ...(edit?.questionBank ? [edit.questionBank.version] : []),
    ]
    const cohort = tenant.cohortQuestionBank ? { key: cohortKey(tenant.industry, tenant.region), version: tenant.cohortQuestionBank } : null
    const result = planPromotion({ tenantId, version, bank, source, cohort, taken, now: new Date(), bakedBankOnly })
    if (!result.ok) {
      result.errors.forEach(errorLine)
      continue
    }
    const { plan } = result
    const toPath = path.join(tenantDir, 'question-bank', `${plan.toVersion}.json`)
    console.log(`  판 ${plan.fromVersion} → ${plan.toVersion} · 문항 ${plan.bank.questions.length}개 그대로(순서 · id · 문장 · 범주 · 단계 · 주제)`)
    console.log(`  실증 표시를 뗄 질문 ${plan.probes}개(그중 바꿔 쓴 질문 ${plan.paraphrases}개)`)
    console.log(`  이름 없는 질문 ${plan.agnostic}개 — 점수에 세는 것 ${plan.scoredBefore} → ${plan.scoredAfter}`)
    if (cohort) {
      const cohortFile = path.join(COHORT_BANK_DIR, cohort.key, `${cohort.version}.json`)
      console.log(`  코호트 공통 질문지: ${cohort.key}/${cohort.version} — ${existsSync(cohortFile) ? '있음' : `없음(${cohortFile}) — 다음 측정이 동봉본을 가져오거나 새로 만든다`}`)
    }
    if (plan.bankOnly) {
      console.log(`  저장소 설정 브랜드 — 새 판 파일만 씁니다(오버레이 그대로). 쓴 뒤에도 측정은 저장소 설정의 판(${plan.fromVersion})을 잽니다.`)
      console.log(`  릴리스: server/tenants.config.json ${tenantId}의 questionBankVersion ${plan.fromVersion} → ${plan.toVersion} (questionBankSize ${tenant.questionBankSize} 그대로)`)
      console.log('  ⚠ 이 파일을 쓴 뒤에 그 릴리스를 설치하세요 — 새 판 파일 없이 판만 오르면 측정이 질문지를 AI로 새로 만들어 실증 질문이 사라집니다.')
    } else {
      console.log(`  오버레이: questionBankVersion ${plan.fromVersion} → ${plan.toVersion} (questionBankSize ${tenant.questionBankSize} 그대로 — 측정은 저장된 질문지를 그대로 쓴다)`)
    }
    console.log(`  새 판 파일: ${toPath}`)
    console.log(`  백업 자리: ${path.join(tenantDir, 'before-promote-<시각>')}`)
    if (existsSync(path.join(tenantDir, PROBE_PLAN_FILE))) {
      console.log(`  ⚠ ${PROBE_PLAN_FILE}이 있습니다 — 배정 파일의 판이 ${plan.toVersion}이 아니면 글 만들기 잠금이 거절합니다. 새 판으로 배정을 다시 쓰세요.`)
    }
    planned.push({ plan, item: { tenantDir, fromPath: bankPath, before, toPath, bank: plan.bank } })
  }

  if (!write) {
    console.log('\ndry-run — 아무것도 쓰지 않았습니다.')
    if (problems) fail('✗ 검사에 걸린 곳이 있습니다(위 ✗).')
    return
  }

  if (problems) fail('✗ 쓰지 않았습니다 — 검사에 걸린 곳이 있습니다(위 ✗).')
  // 저장소 설정 브랜드(새 판 파일만)는 오버레이를 바꾸지 않는다 — 모두 그런 브랜드면 오버레이는 건드리지 않는다.
  const overlayChanges = planned
    .filter(({ plan }) => !plan.bankOnly)
    .map(({ plan }) => ({ tenantId: plan.tenantId, from: plan.fromVersion, to: plan.toVersion }))
  let nextOverlay: unknown[] | null = null
  if (overlayChanges.length > 0) {
    if (overlayBefore === null) fail(`✗ 오버레이가 없습니다: ${overlayPath}`)
    const promoted = promoteOverlay(overlay, overlayChanges)
    if (!promoted.ok) fail('✗ 쓰지 않았습니다:', ...promoted.errors.map((e) => `  - ${e}`))
    nextOverlay = promoted.overlay
  }
  if (virtualized) fail('✗ 가상화 사본 경로에는 쓰지 않습니다. 사용자 터미널이나 //localhost/C$/… 경로로 실행하세요.')

  // 경로 글자로는 안 보이는 쓰기 리다이렉트 — 쓸 폴더마다 표지 파일을 써 보고 가상화 위치에 생기는지 본다. 모두 확인한 뒤에 쓴다.
  const roots = { appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA }
  const writeDirs = [...(nextOverlay !== null ? [path.dirname(overlayPath)] : []), ...planned.map(({ item }) => path.dirname(item.toPath))]
  for (const dir of writeDirs) {
    let redirected: string[] = []
    try {
      redirected = await writeRedirects(dir, roots)
    } catch (err) {
      fail(`✗ ${dir}에 써 보는 확인을 하지 못했습니다(${err instanceof Error ? err.message : String(err)}). 아무것도 쓰지 않았습니다.`)
    }
    if (redirected.length > 0) {
      fail(
        `✗ 이 셸에서 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갑니다: ${redirected.join(', ')}`,
        '  사용자 터미널이나 //localhost/C$/… 경로로 실행하세요. 아무것도 쓰지 않았습니다(표지 파일은 지웠습니다).',
      )
    }
    console.log(`쓰기 확인: ${dir}에 쓴 파일이 그 자리에 갑니다(가상화 사본 아님).`)
  }

  // 앱 확인은 쓰기 바로 앞에서 한다 — 확인과 쓰기 사이에 앱을 켤 틈을 줄인다.
  assertAppClosed()
  const input: PromoteWriteInput = {
    items: planned.map(({ item }) => item),
    overlayPath,
    overlayBefore,
    overlay: nextOverlay,
    now: new Date(),
  }
  let backups: string[]
  try {
    backups = (await writePromotion(input)).backups
  } catch (err) {
    fail(`✗ ${err instanceof Error ? err.message : String(err)}`)
  }
  // 표지 파일 확인 뒤에도 쓰기가 가상화 사본으로 갔다면(새 이름인 백업 폴더 · 새 판 파일로 본다) 성공으로 알리지 않는다.
  const moved = [
    ...(await Promise.all(backups.map((b) => findRedirectedCopies(b, roots)))).flat(),
    ...(await Promise.all(input.items.map((i) => findRedirectedCopies(i.toPath, roots)))).flat(),
  ]
  if (moved.length > 0) fail(`✗ 쓴 파일이 실제 폴더가 아닌 가상화 사본으로 갔습니다: ${moved.join(', ')}`)
  const after = await checkPromotion(input)
  if (after.length > 0) {
    const restore =
      nextOverlay !== null
        ? ['  백업의 오버레이를 제자리로 복사해 되돌리세요:', ...backups.map((b) => `  ${path.join(b, path.basename(overlayPath))}`)]
        : ['  오버레이는 바꾸지 않았습니다 — 새 판 파일은 저장소 설정의 판을 바꾸기 전까지 측정에 쓰이지 않습니다.']
    fail('✗ 다시 읽은 파일이 기대와 다릅니다:', ...after.map((p) => `  - ${p}`), ...restore)
  }

  for (const [i, { plan, item }] of planned.entries()) {
    console.log(`\n저장: ${item.toPath} (${plan.toVersion} · 문항 ${plan.bank.questions.length}개 · 실증 표시 없음)`)
    if (plan.bankOnly) {
      console.log(`  오버레이 그대로 — 릴리스에서 server/tenants.config.json ${plan.tenantId}의 questionBankVersion을 ${plan.fromVersion} → ${plan.toVersion}로 바꾸세요.`)
    } else {
      console.log(`  오버레이 ${plan.tenantId}: ${plan.fromVersion} → ${plan.toVersion}`)
    }
    console.log(`  백업: ${backups[i]}`)
  }
  console.log(
    `\n다시 읽음 — ${nextOverlay !== null ? '새 판 파일 · 오버레이가' : '새 판 파일이'} 쓴 그대로이고 옛 판 파일은 그대로입니다. ` +
      `${nextOverlay !== null ? '' : '오버레이 · '}cohort-banks · questionBankSize는 건드리지 않았습니다.`,
  )
  if (nextOverlay !== null) console.log('앱을 켜면 다음 측정이 새 판을 그대로 잽니다(오버레이 브랜드). 판이 바뀌어 「같은 조건」 비교는 새 판에서 새로 시작합니다.')
  if (planned.some(({ plan }) => plan.bankOnly)) {
    console.log('저장소 설정 브랜드는 그 판을 바꾼 릴리스를 설치한 뒤 다음 측정부터 새 판을 그대로 잽니다. 그 전까지는 옛 판을 잽니다.')
  }
}

/** 그 폴더 안이거나 같은 곳인가 — 동봉본 만들기는 앱 데이터에 쓰지 않는다. */
const insideDir = (dir: string, target: string) => {
  const rel = path.relative(dir, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * --bundle-out — 앱 데이터는 읽기만 하고 저장소 폴더(동봉본 · 코호트 공통 질문지)에만 쓴다. 모든 브랜드를 검사한 뒤 하나라도 걸리면
 * 아무것도 쓰지 않는다. 같은 자리의 파일은 내용이 같으면 그대로 두고, 다르면 멈춘다(덮지 않는다).
 */
async function bundleMain(opts: { tenantIds: string[]; appData: string; bundleOut: string; cohortOut: string }): Promise<void> {
  const { tenantIds, appData, bundleOut, cohortOut } = opts
  const realAppData = realpathSync.native(appData)
  if ([appData, realAppData].some(looksVirtualized)) {
    fail('✗ 이 셸의 가상화 사본(Packages\\Claude_…) 경로로 보입니다 — 실제 앱 데이터가 아닙니다. //localhost/C$/… 경로로 실행하세요.')
  }
  for (const out of [bundleOut, cohortOut]) {
    if (insideDir(appData, out) || insideDir(realAppData, out)) fail(`✗ 앱 데이터 폴더 안에는 쓰지 않습니다: ${out}`)
  }

  // 로컬 앱 데이터만 읽는다 — .env에 Blob 토큰이 있으면 오버레이(브랜드 목록)를 클라우드에서 읽는다(tenantOverlay.ts).
  process.env.BLOB_READ_WRITE_TOKEN = ''
  process.env.BLOB_STORE_ID = ''
  // APP_DATA_DIR은 server/appPaths.ts가 모듈 로드 시점에 읽으므로, 그 전에 설정해야 한다.
  process.env.APP_DATA_DIR = appData
  const { COHORT_BANK_DIR, PIPELINE_DATA_DIR } = await import('../server/appPaths')
  const { findBakedTenant, loadRuntimeTenants, loadTenantWithoutCompetitorEdit } = await import('../server/tenantRegistry')
  const { overrideApplies, readCompetitorOverride } = await import('../server/tenantCompetitorsStore')
  const { cohortKey } = await import('../server/cohortQuestionBank')
  const { FileResultStore } = await import('../server/store')

  console.log(`앱 데이터(읽기만): ${appData}`)
  console.log(`동봉본 폴더: ${bundleOut}`)
  console.log(`코호트 공통 질문지 폴더: ${cohortOut}`)

  // 질문지 파일은 store를 거치지 않고 직접 읽는다 — store.getQuestionBank는 없는 판을 동봉본에서 가져와 앱 데이터에 쓴다.
  const store = new FileResultStore()
  const runtime = await loadRuntimeTenants()
  const bankWrites: { file: string; text: string }[] = []
  const cohortWrites = new Map<string, string>()
  let problems = false
  for (const tenantId of tenantIds) {
    console.log(`\n■ ${tenantId}`)
    const errorLine = (e: string) => {
      problems = true
      console.log(`  ✗ ${e}`)
    }
    const tenant = runtime.find((t) => t.tenantId === tenantId)
    if (!tenant) {
      errorLine('브랜드를 찾을 수 없습니다(저장소 설정 · 오버레이 · 지운 브랜드 목록).')
      continue
    }
    if (tenant.cohortOnly) {
      errorLine('경쟁사로만 재는 브랜드입니다 — 동봉본은 고객 브랜드만 담습니다.')
      continue
    }
    const version = tenant.questionBankVersion
    const bankPath = path.join(PIPELINE_DATA_DIR, tenantId, 'question-bank', `${version}.json`)
    const pathProblem = bankPathProblem(bankPath, PIPELINE_DATA_DIR, tenantId)
    if (pathProblem) {
      errorLine(pathProblem)
      continue
    }
    if (!existsSync(bankPath)) {
      // 저장소 설정이 이미 동봉본의 판을 가리키면(굽고 난 뒤 다시 실행) 이 PC에는 그 판이 아직 없다 — 측정 때 동봉본을 가져온다.
      const bundled = path.join(bundleOut, tenantId, `${version}.json`)
      if (existsSync(bundled)) console.log(`  판 ${version}은 이 PC에 아직 없고 동봉본이 있습니다 — 그대로 둡니다(측정 때 가져옴): ${bundled}`)
      else errorLine(`질문지가 없습니다: ${bankPath}`)
      continue
    }
    let bank: QuestionBank
    try {
      bank = JSON.parse(readFileSync(bankPath, 'utf8')) as QuestionBank
    } catch (err) {
      errorLine(`질문지를 읽지 못했습니다 — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const repo = await loadTenantWithoutCompetitorEdit(tenantId)
    const edit = (await readCompetitorOverride(tenantId))?.current ?? null
    const baked = await findBakedTenant(tenantId)
    const history = await store.getScorecardHistory(tenantId, Number.MAX_SAFE_INTEGER)
    const taken = [
      ...(await store.listQuestionBankVersions(tenantId)),
      ...history.map((c) => c.questionBankVersion).filter((v): v is string => Boolean(v)),
      ...(edit?.questionBank ? [edit.questionBank.version] : []),
    ]
    const cohort = tenant.cohortQuestionBank ? { key: cohortKey(tenant.industry, tenant.region), version: tenant.cohortQuestionBank } : null
    const result = planBundle({
      tenantId,
      version,
      bank,
      source: { baked: Boolean(baked), competitorEdit: Boolean(repo && overrideApplies(edit, repo)) },
      cohort,
      taken,
      now: new Date(),
    })
    if (!result.ok) {
      result.errors.forEach(errorLine)
      continue
    }
    const { plan } = result
    console.log(`  ${tenant.brandName} · 지금 판 ${plan.fromVersion}(${bankPath})`)
    console.log(
      plan.promoted
        ? `  동봉 판 ${plan.version} — 실증 표시 ${plan.probes}개(그중 바꿔 쓴 질문 ${plan.paraphrases}개)를 뗌 · 문항 ${plan.bank.questions.length}개 그대로`
        : `  동봉 판 ${plan.version} — 실증 질문이 없어 지금 판을 그대로 담음 · 문항 ${plan.bank.questions.length}개`,
    )
    console.log(`  이름 없는 질문 ${plan.agnostic}개(모두 점수에 셈)`)
    const target = path.join(bundleOut, tenantId, `${plan.version}.json`)
    if (existsSync(target)) {
      let present: QuestionBank
      try {
        present = JSON.parse(readFileSync(target, 'utf8')) as QuestionBank
      } catch (err) {
        errorLine(`있는 동봉본을 읽지 못했습니다: ${target} — ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!sameBundledBank(present, plan.bank)) {
        errorLine(`같은 자리에 내용이 다른 동봉본이 있습니다 — 덮지 않습니다: ${target}`)
        continue
      }
      console.log(`  동봉본: ${target} — 이미 같은 내용(그대로 둠)`)
    } else {
      console.log(`  동봉본: ${target} — 새로 씀`)
      bankWrites.push({ file: target, text: bundleFileText(plan.bank) })
    }
    if (baked?.questionBankVersion === plan.version) {
      console.log(`  저장소 설정: questionBankVersion ${plan.version} — 맞음`)
    } else {
      const now = baked ? `바꾸세요(지금 ${baked.questionBankVersion})` : '넣어 구우세요(지금 없음)'
      console.log(`  ⚠ 저장소 설정(server/tenants.config.json) ${tenantId}의 questionBankVersion을 ${plan.version}로 ${now}.`)
    }

    if (!cohort) continue
    const source = path.join(COHORT_BANK_DIR, cohort.key, `${cohort.version}.json`)
    const repoFile = path.join(cohortOut, cohort.key, `${cohort.version}.json`)
    if (!existsSync(source)) {
      errorLine(`앱 데이터에 코호트 공통 질문지가 없습니다: ${source}`)
      continue
    }
    const sourceText = readFileSync(source, 'utf8')
    let cohortQuestions: QuestionSpec[]
    try {
      cohortQuestions = (JSON.parse(sourceText) as { questions: QuestionSpec[] }).questions
    } catch (err) {
      errorLine(`코호트 공통 질문지를 읽지 못했습니다: ${source} — ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const shared = plan.bank.questions.filter((q) => q.cohortShared)
    const sharedMatches =
      shared.length === cohortQuestions.length &&
      shared.every((q, i) => q.questionId === cohortQuestions[i]!.questionId && q.text === cohortQuestions[i]!.text)
    if (!sharedMatches) {
      errorLine(`질문지의 코호트 공통 문항(${shared.length}개)이 코호트 공통 질문지 ${cohort.key}/${cohort.version}(${cohortQuestions.length}개)와 다릅니다.`)
      continue
    }
    if (existsSync(repoFile)) {
      let same: boolean
      try {
        same = JSON.stringify(JSON.parse(readFileSync(repoFile, 'utf8'))) === JSON.stringify(JSON.parse(sourceText))
      } catch (err) {
        errorLine(`저장소의 코호트 공통 질문지를 읽지 못했습니다: ${repoFile} — ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      if (!same) {
        errorLine(`저장소의 코호트 공통 질문지가 앱 데이터의 것과 내용이 다릅니다 — 덮지 않습니다: ${repoFile}`)
        continue
      }
      console.log(`  코호트 공통 질문지 ${cohort.key}/${cohort.version}: 저장소에 같은 내용으로 있음(${repoFile})`)
    } else if (cohortWrites.has(repoFile)) {
      console.log(`  코호트 공통 질문지 ${cohort.key}/${cohort.version}: 앞 브랜드와 같이 복사`)
    } else {
      console.log(`  코호트 공통 질문지 ${cohort.key}/${cohort.version}: 저장소에 없음 — 앱 데이터의 것을 그대로 복사(${repoFile})`)
      cohortWrites.set(repoFile, sourceText)
    }
  }

  if (problems) fail('\n✗ 아무것도 쓰지 않았습니다 — 검사에 걸린 곳이 있습니다(위 ✗).')
  // 'wx' — 검사한 뒤 그 자리에 파일이 생겼으면 덮지 않고 멈춘다.
  for (const { file, text } of [...bankWrites, ...[...cohortWrites].map(([file, text]) => ({ file, text }))]) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text, { encoding: 'utf8', flag: 'wx' })
  }
  console.log(`\n동봉본 ${bankWrites.length}개 · 코호트 공통 질문지 ${cohortWrites.size}개를 썼습니다. 앱 데이터에는 아무것도 쓰지 않았습니다.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
