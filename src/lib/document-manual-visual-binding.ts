import type {
  BoundVisualGroupCandidate,
  BoundVisualGroupItem,
  DocumentManualVisualOccurrence,
  ParsedDocumentManualTable,
} from "@/lib/document-manual-visual-types"

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function normalizeSemanticText(value: string | null | undefined): string {
  return normalizeText(
    (value ?? "").replace(/!\[[^\]]*\]\([^)\s]+\)/g, " "),
  )
}

function headingPathMatches(left: string[], right: string[]): boolean {
  const normalizedLeft = left.map((part) => normalizeText(part).toLowerCase()).filter(Boolean)
  const normalizedRight = right.map((part) => normalizeText(part).toLowerCase()).filter(Boolean)
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return true
  const shorter = normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft

  const matchesPrefix = shorter.every((part, index) => longer[index] === part)
  if (matchesPrefix) return true

  const offset = longer.length - shorter.length
  const matchesSuffix = shorter.every((part, index) => longer[index + offset] === part)
  return matchesSuffix
}

function parseTableOrdinal(tableId: string): number | null {
  const match = tableId.match(/(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

function buildTableContext(table: ParsedDocumentManualTable): string {
  return normalizeSemanticText([
    ...table.header,
    ...table.rows.flat(),
  ].join(" "))
}

function findIconColumnIndex(header: string[]): number {
  return header.findIndex((cell) => normalizeText(cell).includes("图标"))
}

function looksLikeVisualGroupTable(table: ParsedDocumentManualTable): boolean {
  if (table.rows.length === 0) return false
  return findIconColumnIndex(table.header) !== -1
}

function preferredHeaderCell(header: string[]): string {
  const descriptionIndex = header.findIndex((cell) => {
    const text = normalizeText(cell)
    return text.includes("含义") || text.includes("说明") || text.includes("描述")
  })
  if (descriptionIndex >= 0) {
    return normalizeSemanticText(header[descriptionIndex])
  }
  return normalizeSemanticText(
    header.find((cell) => normalizeText(cell)) ?? "",
  )
}

function extractMarkdownImageUrl(value: string): string {
  const match = value.match(/!\[[^\]]*\]\(([^)\s]+)\)/)
  return normalizeText(match?.[1])
}

function preferredDescriptionCell(row: string[], header: string[]): string {
  const headerIndex = header.findIndex((cell) => {
    const text = normalizeText(cell)
    return text.includes("含义") || text.includes("说明") || text.includes("描述")
  })
  if (headerIndex >= 0) {
    return normalizeSemanticText(row[headerIndex])
  }
  const firstTextCell = row.find((cell) => {
    const text = normalizeSemanticText(cell)
    if (!text) return false
    return !/^!\[[^\]]*\]\([^)\s]+\)$/.test(text)
  })
  return normalizeSemanticText(firstTextCell)
}

function buildItem(
  occurrence: DocumentManualVisualOccurrence | null,
  table: ParsedDocumentManualTable,
  row: string[],
  dataRowIndex: number,
): BoundVisualGroupItem {
  const cellText = normalizeText(
    preferredDescriptionCell(row, table.header) ||
      occurrence?.cellText ||
      occurrence?.rowText,
  )
  const iconColumnIndex = findIconColumnIndex(table.header)
  const rowImage = row
    .map((cell) => extractMarkdownImageUrl(cell))
    .find(Boolean) ?? ""

  return {
    occurrence,
    image: occurrence?.relPath || rowImage,
    rowIndex: dataRowIndex,
    colIndex: occurrence?.colIndex ?? iconColumnIndex,
    rowText: normalizeSemanticText(row.join(" ")) || normalizeSemanticText(occurrence?.rowText),
    cellText: normalizeSemanticText(cellText),
    headerText: normalizeSemanticText(
      occurrence?.rowHeaderText ||
        preferredHeaderCell(table.header) ||
        table.header[occurrence?.colIndex ?? iconColumnIndex] ||
        table.header[iconColumnIndex] ||
        table.header[0] ||
        "",
    ),
    descriptionSource: normalizeSemanticText([
      preferredDescriptionCell(row, table.header),
      occurrence?.rowText,
      occurrence?.cellText,
      occurrence?.localTextBefore,
      occurrence?.localTextAfter,
    ].join(" ")),
  }
}

function candidateRowIndexes(occurrence: DocumentManualVisualOccurrence): number[] {
  return [...new Set([
    occurrence.rowIndex != null ? occurrence.rowIndex - 1 : -1,
    occurrence.rowIndex ?? -1,
  ])].filter((index) => index >= 0)
}

function rowMatchesOccurrence(
  row: string[],
  occurrence: DocumentManualVisualOccurrence,
): boolean {
  const rowText = normalizeText(row.join(" "))
  if (!rowText) return false
  const occurrenceRowText = normalizeText(occurrence.rowText)
  const occurrenceCellText = normalizeText(occurrence.cellText)

  if (!occurrenceRowText && !occurrenceCellText) {
    return true
  }

  if (occurrenceRowText && rowText.includes(occurrenceRowText)) {
    return true
  }

  if (
    occurrenceCellText &&
    row.some((cell) => normalizeText(cell).includes(occurrenceCellText))
  ) {
    return true
  }

  return false
}

function findMatchingDataRowIndex(
  table: ParsedDocumentManualTable,
  occurrence: DocumentManualVisualOccurrence,
): number | null {
  const indexedCandidates = candidateRowIndexes(occurrence)

  for (const index of indexedCandidates) {
    const row = table.rows[index]
    if (!row) continue
    if (rowMatchesOccurrence(row, occurrence)) return index
  }

  const occurrenceRowText = normalizeText(occurrence.rowText)
  const occurrenceCellText = normalizeText(occurrence.cellText)
  if (occurrenceRowText || occurrenceCellText) {
    const fallbackIndex = table.rows.findIndex((row) => rowMatchesOccurrence(row, occurrence))
    if (fallbackIndex >= 0) return fallbackIndex
  }

  for (const index of indexedCandidates) {
    if (table.rows[index]) return index
  }

  return null
}

export function bindVisualRowsToOccurrences(
  tables: ParsedDocumentManualTable[],
  occurrences: DocumentManualVisualOccurrence[],
): BoundVisualGroupCandidate[] {
  const groups: BoundVisualGroupCandidate[] = []

  for (const table of tables) {
    if (!looksLikeVisualGroupTable(table)) continue

    const exactTableId = parseTableOrdinal(table.tableId)
    const items = table.rows.map((row, dataRowIndex) => {
      const candidates = occurrences
        .filter((occurrence) => {
          if (occurrence.tableId != null) {
            if (exactTableId == null || occurrence.tableId !== exactTableId) return false
          } else if (!headingPathMatches(table.headingPath, occurrence.headingPath)) {
            return false
          }

          return findMatchingDataRowIndex(table, occurrence) === dataRowIndex
        })
        .sort((left, right) => {
          const leftExactTable = exactTableId != null && left.tableId === exactTableId ? 1 : 0
          const rightExactTable = exactTableId != null && right.tableId === exactTableId ? 1 : 0
          if (leftExactTable !== rightExactTable) return rightExactTable - leftExactTable

          const iconColumnIndex = findIconColumnIndex(table.header)
          const leftIconMatch = left.colIndex === iconColumnIndex ? 1 : 0
          const rightIconMatch = right.colIndex === iconColumnIndex ? 1 : 0
          if (leftIconMatch !== rightIconMatch) return rightIconMatch - leftIconMatch

          return left.docOrder - right.docOrder
        })

      return buildItem(candidates[0] ?? null, table, row, dataRowIndex)
    }).filter((item) => Boolean(item.image) || Boolean(
      normalizeSemanticText(item.cellText || item.rowText || item.descriptionSource),
    ))

    if (items.length === 0) continue

    groups.push({
      tableId: table.tableId,
      headingPath: table.headingPath,
      precedingParagraph: table.precedingParagraph,
      followingParagraph: table.followingParagraph,
      tableContext: buildTableContext(table),
      rawMarkdown: table.rawMarkdown,
      items,
    })
  }

  return groups
}
