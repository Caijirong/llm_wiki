import { encodeMarkdownImageUrl } from "@/lib/markdown-image-url"
import type {
  StoredVisualGroup,
  StoredVisualGroupItem,
} from "@/lib/document-manual-visual-types"

const LEGACY_BLOCK_RE = /<!--\s*llm-wiki:visual-group\s*\n([\s\S]*?)-->/g
export const VISUAL_GROUP_BLOCK_FENCE_INFO = "llm-wiki-visual-group"
const BLOCK_START = `\`\`\`${VISUAL_GROUP_BLOCK_FENCE_INFO}`
const BLOCK_END = "```"
const BLOCK_RE = /```llm-wiki-visual-group\s*\n([\s\S]*?)\n```/g
export const VISUAL_GROUP_ICON_TITLE = "llm-wiki-visual-group-icon"

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function escapeValue(value: string): string {
  return value.replace(/\n/g, " ").trim()
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|")
}

function parseItemLine(
  lines: string[],
  startIndex: number,
): { item: StoredVisualGroupItem | null, nextIndex: number } {
  const rawItem: Partial<StoredVisualGroupItem> = {}
  let index = startIndex + 1

  while (index < lines.length) {
    const line = lines[index]
    if (!line.startsWith("  ")) break
    const trimmed = line.trim()
    const separator = trimmed.indexOf(":")
    if (separator !== -1) {
      const key = trimmed.slice(0, separator).trim()
      const value = trimmed.slice(separator + 1).trim()
      if (key === "image") rawItem.image = value
      if (key === "description") rawItem.description = value
      if (key === "row-text") rawItem.rowText = value
      if (key === "cell-text") rawItem.cellText = value
      if (key === "header-text") rawItem.headerText = value
    }
    index += 1
  }

  if (rawItem.image == null || !rawItem.description) {
    return { item: null, nextIndex: index }
  }

  return {
    item: {
      image: rawItem.image,
      description: rawItem.description,
      rowText: rawItem.rowText ?? "",
      cellText: rawItem.cellText ?? "",
      headerText: rawItem.headerText ?? "",
    },
    nextIndex: index,
  }
}

function parseSingleBlock(body: string): StoredVisualGroup | null {
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  const rawGroup: Partial<StoredVisualGroup> = {
    headingPath: [],
    items: [],
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (line === "item:") {
      const parsed = parseItemLine(lines, index)
      if (parsed.item) {
        ;(rawGroup.items as StoredVisualGroupItem[]).push(parsed.item)
      }
      index = parsed.nextIndex
      continue
    }

    const separator = line.indexOf(":")
    if (separator === -1) {
      index += 1
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === "id") rawGroup.id = value
    if (key === "source") rawGroup.source = value
    if (key === "heading-path") {
      rawGroup.headingPath = value
        .split(">")
        .map((part) => normalizeText(part))
        .filter(Boolean)
    }
    if (key === "title") rawGroup.title = value
    if (key === "summary") rawGroup.summary = value
    if (key === "table-context") rawGroup.tableContext = value
    index += 1
  }

  if (
    !rawGroup.id ||
    !rawGroup.source ||
    !rawGroup.title ||
    !rawGroup.tableContext ||
    !rawGroup.items ||
    rawGroup.items.length === 0
  ) {
    return null
  }

  return {
    id: rawGroup.id,
    source: rawGroup.source,
    headingPath: rawGroup.headingPath ?? [],
    title: rawGroup.title,
    summary: rawGroup.summary ?? "",
    tableContext: rawGroup.tableContext,
    items: rawGroup.items,
  }
}

export function serializeVisualGroupBlock(group: StoredVisualGroup): string {
  const lines: string[] = [
    BLOCK_START,
    `id: ${escapeValue(group.id)}`,
    `source: ${escapeValue(group.source)}`,
    `heading-path: ${escapeValue(group.headingPath.join(" > "))}`,
    `title: ${escapeValue(group.title)}`,
    `summary: ${escapeValue(group.summary)}`,
    `table-context: ${escapeValue(group.tableContext)}`,
  ]

  for (const item of group.items) {
    lines.push("item:")
    lines.push(`  image: ${escapeValue(item.image)}`)
    lines.push(`  description: ${escapeValue(item.description)}`)
    lines.push(`  row-text: ${escapeValue(item.rowText)}`)
    lines.push(`  cell-text: ${escapeValue(item.cellText)}`)
    lines.push(`  header-text: ${escapeValue(item.headerText)}`)
  }

  lines.push(BLOCK_END)
  return lines.join("\n")
}

export function parseVisualGroupBlocks(markdown: string): StoredVisualGroup[] {
  const groups: StoredVisualGroup[] = []
  for (const match of markdown.matchAll(BLOCK_RE)) {
    const parsed = parseSingleBlock(match[1] ?? "")
    if (parsed) groups.push(parsed)
  }
  for (const match of markdown.matchAll(LEGACY_BLOCK_RE)) {
    const parsed = parseSingleBlock(match[1] ?? "")
    if (parsed) groups.push(parsed)
  }
  return groups
}

export function renderVisualGroupTable(group: StoredVisualGroup): string {
  const lines: string[] = []
  lines.push(`### ${group.title}`, "")
  if (group.summary) {
    lines.push(group.summary, "")
  }
  lines.push("| 图标 | 图标描述 |")
  lines.push("| --- | --- |")
  for (const item of group.items) {
    const iconCell = item.image
      ? `![](${encodeMarkdownImageUrl(item.image)} "${VISUAL_GROUP_ICON_TITLE}")`
      : ""
    lines.push(
      `| ${iconCell} | ${escapeTableCell(item.description)} |`,
    )
  }
  return lines.join("\n")
}
