import type {
  DocumentManualVisualOccurrence,
  IconDescriptionResult,
  IconGroupSummaryResult,
  StoredVisualGroupItem,
} from "@/lib/document-manual-visual-types"

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = normalizeText(value)
    if (normalized) return normalized
  }
  return ""
}

export function buildIconDescriptionPrompt(
  occurrence: DocumentManualVisualOccurrence,
  context: {
    rowText: string
    cellText: string
    headerText: string
  },
  outputLanguage?: string,
): string {
  const languageDirective = outputLanguage && outputLanguage !== "auto"
    ? `用 ${outputLanguage} 输出。`
    : ""

  return [
    languageDirective,
    "你正在为文档手册中的单个图标生成结构化描述。",
    "只允许依据这张图本身，以及同一行的局部上下文判断，不要借用其他行的含义。",
    "返回 JSON，字段固定为：iconDescription, confidence, evidenceText。",
    `rowText: ${normalizeText(context.rowText || occurrence.rowText) || "(none)"}`,
    `cellText: ${normalizeText(context.cellText || occurrence.cellText) || "(none)"}`,
    `rowHeaderText: ${normalizeText(context.headerText || occurrence.rowHeaderText) || "(none)"}`,
  ].filter(Boolean).join("\n")
}

export function buildGroupSummaryPrompt(
  input: {
    headingPath: string[]
    tableContext: string
    precedingParagraph: string
    followingParagraph: string
    memberDescriptions: string[]
  },
  _items: StoredVisualGroupItem[],
  memberDescriptions: string[],
  outputLanguage?: string,
): string {
  const languageDirective = outputLanguage && outputLanguage !== "auto"
    ? `用 ${outputLanguage} 输出。`
    : ""

  return [
    languageDirective,
    "你正在为一组文档手册图标生成组标题和组说明。",
    "综合组内图标描述、表格附近上下文和章节标题，生成最能代表整组语义的标题。",
    "返回 JSON，字段固定为：groupTitle, groupSummary, confidence。",
    `headingPath: ${normalizeText(input.headingPath.join(" > ")) || "(none)"}`,
    `tableContext: ${normalizeText(input.tableContext) || "(none)"}`,
    `precedingParagraph: ${normalizeText(input.precedingParagraph) || "(none)"}`,
    `followingParagraph: ${normalizeText(input.followingParagraph) || "(none)"}`,
    `memberDescriptions: ${memberDescriptions.join(" | ") || "(none)"}`,
  ].filter(Boolean).join("\n")
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

export function fallbackIconDescription(
  input: {
    occurrenceIndex?: number
    rowText?: string
    cellText?: string
    headerText?: string
    localTextBefore?: string
    localTextAfter?: string
  },
): IconDescriptionResult {
  const rowOrCell = firstNonEmpty(
    input.cellText,
    input.rowText,
    input.localTextAfter,
    input.localTextBefore,
  )

  return {
    description: rowOrCell || `Item ${input.occurrenceIndex ?? "unknown"}`,
    confidence: null,
    evidenceText: firstNonEmpty(
      input.rowText,
      input.cellText,
      rowOrCell,
    ),
  }
}

export function parseIconDescriptionResult(
  raw: string,
  fallback: {
    occurrenceIndex?: number
    rowText?: string
    cellText?: string
    headerText?: string
    localTextBefore?: string
    localTextAfter?: string
  },
): IconDescriptionResult {
  const parsed = extractJsonObject(raw)
  const iconDescription = normalizeText(
    typeof parsed?.iconDescription === "string" ? parsed.iconDescription : "",
  )
  if (!iconDescription) return fallbackIconDescription(fallback)

  return {
    description: iconDescription,
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
    evidenceText: normalizeText(
      typeof parsed?.evidenceText === "string" ? parsed.evidenceText : "",
    ),
  }
}

export function fallbackGroupSummary(
  input: {
    headingPath: string[]
    tableContext: string
    precedingParagraph: string
    followingParagraph: string
  },
  memberDescriptions: string[],
): IconGroupSummaryResult {
  const title = firstNonEmpty(
    input.headingPath[input.headingPath.length - 1],
    input.headingPath.join(" > "),
    memberDescriptions[0],
  ) || "UI Visual Group"
  const context = firstNonEmpty(
    input.tableContext,
    input.precedingParagraph,
    input.followingParagraph,
    input.headingPath.join(" > "),
  )
  const summary = context
    ? `${context} 成员：${memberDescriptions.join("、")}`
    : `成员：${memberDescriptions.join("、")}`

  return {
    title,
    summary,
    context,
    confidence: null,
  }
}

export function parseGroupSummaryResult(
  raw: string,
  input: {
    headingPath: string[]
    tableContext: string
    precedingParagraph: string
    followingParagraph: string
  },
  memberDescriptions: string[],
): IconGroupSummaryResult {
  const parsed = extractJsonObject(raw)
  const groupTitle = normalizeText(
    typeof parsed?.groupTitle === "string" ? parsed.groupTitle : "",
  )
  const groupSummary = normalizeText(
    typeof parsed?.groupSummary === "string" ? parsed.groupSummary : "",
  )

  if (!groupTitle && !groupSummary) {
    return fallbackGroupSummary(input, memberDescriptions)
  }

  const fallback = fallbackGroupSummary(input, memberDescriptions)
  return {
    title: groupTitle || fallback.title,
    summary: groupSummary || fallback.summary,
    context: fallback.context,
    confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
  }
}
