export type VisualClass = "regular_visual" | "small_visual"
export type VisualContainerKind = "paragraph" | "list_item" | "table_cell"
export type SemanticRole = "regular_image" | "icon_candidate" | "ambiguous_visual"

export interface DocumentManualVisualOccurrence {
  occurrenceIndex: number
  relPath: string
  absPath: string
  mimeType: string
  width: number
  height: number
  sha256: string
  visualClass: VisualClass
  docOrder: number
  sectionTitle: string | null
  headingPath: string[]
  containerKind: VisualContainerKind
  tableId: number | null
  rowIndex: number | null
  colIndex: number | null
  rowText: string
  cellText: string
  rowHeaderText: string
  tableTextSnapshot: string
  precedingParagraph: string
  followingParagraph: string
  rowImageCount: number
  tableImageCount: number
  tableRowCount: number
  tableColCount: number
  localTextBefore: string
  localTextAfter: string
  contextBefore: string
  contextAfter: string
}

export interface IconDescriptionResult {
  description: string
  confidence?: number | null
  evidenceText?: string
}

export interface IconGroupSummaryResult {
  title: string
  summary: string
  context?: string
  confidence?: number | null
}

export interface ParsedDocumentManualTable {
  tableId: string
  headingPath: string[]
  precedingParagraph: string
  followingParagraph: string
  header: string[]
  rows: string[][]
  rawMarkdown: string
}

export interface BoundVisualGroupItem {
  occurrence: DocumentManualVisualOccurrence | null
  image: string
  rowIndex: number
  colIndex: number
  rowText: string
  cellText: string
  headerText: string
  descriptionSource: string
}

export interface BoundVisualGroupCandidate {
  tableId: string
  headingPath: string[]
  precedingParagraph: string
  followingParagraph: string
  tableContext: string
  rawMarkdown: string
  items: BoundVisualGroupItem[]
}

export interface DocumentManualVisualGroupCandidate {
  occurrences: DocumentManualVisualOccurrence[]
  context: string
}

export interface StoredVisualGroupItem {
  image: string
  description: string
  rowText: string
  cellText: string
  headerText: string
}

export interface StoredVisualGroup {
  id: string
  source: string
  headingPath: string[]
  title: string
  summary: string
  tableContext: string
  items: StoredVisualGroupItem[]
}
