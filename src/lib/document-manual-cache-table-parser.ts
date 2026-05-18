import type {
  ParsedDocumentManualTable,
} from "@/lib/document-manual-visual-types"

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim()
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(trimmed)
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false
  return trimmed.split("|").length >= 4
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => normalizeText(cell.replace(/\\\|/g, "|")))
}

function findNearestParagraph(lines: string[], start: number, step: -1 | 1): string {
  let index = start
  while (index >= 0 && index < lines.length) {
    const line = normalizeText(lines[index])
    if (line && !line.startsWith("|") && !line.startsWith("#")) return line
    index += step
  }
  return ""
}

function headingLevel(line: string): number | null {
  const match = line.match(/^(#+)\s+(.*)$/)
  return match ? match[1].length : null
}

function looksLikeSectionHeading(line: string): boolean {
  const text = normalizeText(line)
  if (!text) return false
  if (text.startsWith("|") || text.startsWith("-") || text.startsWith("*")) return false
  if (/^(图|表)\s*\d+/.test(text)) return false
  if (/[。！？；：]$/.test(text)) return false
  if (text.length > 80) return false

  return (
    /^[0-9]+(?:-[A-Z])?区，/.test(text) ||
    /^第?[0-9]+(?:\.[0-9]+)*[章节]/.test(text) ||
    /^附录[A-Z0-9一二三四五六七八九十]/.test(text)
  )
}

function findNearestSectionHeading(lines: string[], start: number): string {
  let index = start
  while (index >= 0) {
    const line = normalizeText(lines[index])
    if (looksLikeSectionHeading(line)) return line
    index -= 1
  }
  return ""
}

function buildHeadingPath(lines: string[], endExclusive: number): string[] {
  const headings: Array<{ level: number, text: string }> = []
  for (let index = 0; index < endExclusive; index++) {
    const line = normalizeText(lines[index])
    const level = headingLevel(line)
    if (!level) continue
    const text = normalizeText(line.slice(level + 1))
    while (headings.length > 0 && headings[headings.length - 1].level >= level) {
      headings.pop()
    }
    headings.push({ level, text })
  }
  if (headings.length > 0) {
    return headings.map((heading) => heading.text)
  }

  const sectionHeading = findNearestSectionHeading(lines, endExclusive - 1)
  return sectionHeading ? [sectionHeading] : []
}

export function extractDocumentManualTables(
  sourceContent: string,
): ParsedDocumentManualTable[] {
  const lines = sourceContent.replace(/\r\n/g, "\n").split("\n")
  const tables: ParsedDocumentManualTable[] = []
  let tableCounter = 0
  let index = 0

  while (index < lines.length) {
    if (!isTableRow(lines[index])) {
      index += 1
      continue
    }
    if (index + 1 >= lines.length || !isTableDivider(lines[index + 1])) {
      index += 1
      continue
    }

    const start = index
    const header = splitTableRow(lines[index])
    index += 2

    const rows: string[][] = []
    const rawLines = [lines[start], lines[start + 1]]

    while (index < lines.length && isTableRow(lines[index])) {
      rows.push(splitTableRow(lines[index]))
      rawLines.push(lines[index])
      index += 1
    }

    tableCounter += 1
    tables.push({
      tableId: `cache-table-${tableCounter}`,
      headingPath: buildHeadingPath(lines, start),
      precedingParagraph: findNearestParagraph(lines, start - 1, -1),
      followingParagraph: findNearestParagraph(lines, index, 1),
      header,
      rows,
      rawMarkdown: rawLines.join("\n"),
    })
  }

  return tables
}
