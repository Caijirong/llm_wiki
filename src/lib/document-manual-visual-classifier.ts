import type {
  DocumentManualVisualOccurrence,
  SemanticRole,
} from "@/lib/document-manual-visual-types"

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function looksLikeScreenshot(occurrence: DocumentManualVisualOccurrence): boolean {
  const area = occurrence.width * occurrence.height
  const aspectRatio = occurrence.width / Math.max(occurrence.height, 1)
  return (
    occurrence.width >= 220 &&
    occurrence.height >= 140 &&
    area >= 90_000 &&
    aspectRatio >= 1.2 &&
    aspectRatio <= 2.8
  )
}

function hasIconKeywords(occurrence: DocumentManualVisualOccurrence): boolean {
  const text = normalizeText([
    occurrence.sectionTitle,
    occurrence.headingPath.join(" "),
    occurrence.rowHeaderText,
    occurrence.tableTextSnapshot,
    occurrence.rowText,
  ].join(" ")).toLowerCase()

  return [
    "图标",
    "状态",
    "按钮",
    "报警",
    "显示",
    "指示",
    "模式",
    "含义",
    "icon",
    "status",
    "button",
    "indicator",
  ].some((keyword) => text.includes(keyword))
}

export function classifyDocumentManualVisualSemanticRole(
  occurrence: DocumentManualVisualOccurrence,
): SemanticRole {
  if (occurrence.containerKind !== "table_cell") {
    return occurrence.visualClass === "small_visual"
      ? "icon_candidate"
      : "regular_image"
  }

  let iconScore = 0
  let regularScore = 0

  if (occurrence.tableImageCount >= 2) iconScore += 2
  if (occurrence.rowImageCount >= 1) iconScore += 1
  if (normalizeText(occurrence.rowText) || normalizeText(occurrence.rowHeaderText)) {
    iconScore += 2
  }
  if (hasIconKeywords(occurrence)) iconScore += 1
  if (occurrence.width <= 420 && occurrence.height <= 420) iconScore += 1

  if (occurrence.visualClass === "regular_visual") regularScore += 1
  if (looksLikeScreenshot(occurrence)) regularScore += 2
  if (!normalizeText(occurrence.rowText) && !normalizeText(occurrence.rowHeaderText)) {
    regularScore += 1
  }

  if (iconScore >= regularScore + 2) return "icon_candidate"
  if (regularScore >= iconScore + 2) return "regular_image"
  return "ambiguous_visual"
}
