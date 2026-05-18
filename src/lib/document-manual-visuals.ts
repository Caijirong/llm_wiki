import { extractDocumentManualTables } from "@/lib/document-manual-cache-table-parser"
import { bindVisualRowsToOccurrences } from "@/lib/document-manual-visual-binding"
import {
  serializeVisualGroupBlock,
} from "@/lib/document-manual-visual-block"
import {
  fallbackGroupSummary,
  fallbackIconDescription,
} from "@/lib/document-manual-visual-prompts"
import type {
  BoundVisualGroupItem,
  DocumentManualVisualOccurrence,
  IconDescriptionResult,
  IconGroupSummaryResult,
  StoredVisualGroup,
  StoredVisualGroupItem,
  VisualClass,
  VisualContainerKind,
} from "@/lib/document-manual-visual-types"

export type { VisualClass, VisualContainerKind }
export type {
  DocumentManualVisualOccurrence,
  IconDescriptionResult,
  IconGroupSummaryResult,
  StoredVisualGroup,
  StoredVisualGroupItem,
} from "@/lib/document-manual-visual-types"

interface BuildDocumentManualVisualGroupsOptions {
  resolveMemberDescription?: (
    input: {
      occurrence: DocumentManualVisualOccurrence
      rowText: string
      cellText: string
      headerText: string
    },
  ) => Promise<IconDescriptionResult | null | undefined>
  resolveGroupSummary?: (
    input: {
      headingPath: string[]
      tableContext: string
      precedingParagraph: string
      followingParagraph: string
      memberDescriptions: string[]
      items: StoredVisualGroupItem[]
    },
  ) => Promise<IconGroupSummaryResult | null | undefined>
  concurrency?: number
  onProgress?: (progress: BuildDocumentManualVisualGroupsProgress) => void
}

export interface BuildDocumentManualVisualGroupsProgress {
  phase: "member_descriptions" | "group_summaries"
  completed: number
  total: number
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function normalizeDescriptionText(value: string | null | undefined): string {
  return normalizeText(
    (value ?? "")
      .replace(/!\[[^\]]*\]\([^)\s]+\)/g, " ")
      .replace(/\|/g, " "),
  )
}

function hasMeaningfulDescriptionText(value: string | null | undefined): boolean {
  const normalized = normalizeDescriptionText(value)
  if (!normalized) return false
  return /[\p{L}\p{N}\u4e00-\u9fff]/u.test(normalized)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onItemDone?: (completed: number, total: number) => void,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1))
  const results = new Array<R>(items.length)
  let nextIndex = 0
  let completed = 0

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
      completed += 1
      onItemDone?.(completed, items.length)
    }
  }

  await Promise.all(
    Array.from({ length: safeConcurrency }, () => runWorker()),
  )

  return results
}

function deriveTextFirstDescription(
  item: BoundVisualGroupItem,
  occurrence: DocumentManualVisualOccurrence | null,
): IconDescriptionResult | null {
  for (const candidate of [
    item.cellText,
    item.rowText,
    occurrence?.localTextAfter,
    occurrence?.localTextBefore,
  ]) {
    const description = normalizeDescriptionText(candidate)
    if (hasMeaningfulDescriptionText(description)) {
      return {
        description,
        confidence: null,
        evidenceText: description,
      }
    }
  }

  return null
}

async function resolveMemberDescription(
  item: BoundVisualGroupItem,
  options?: BuildDocumentManualVisualGroupsOptions,
): Promise<IconDescriptionResult> {
  const textFirst = deriveTextFirstDescription(item, item.occurrence)
  if (textFirst) return textFirst

  if (item.occurrence) {
    try {
      const resolved = await options?.resolveMemberDescription?.({
        occurrence: item.occurrence,
        rowText: item.rowText,
        cellText: item.cellText,
        headerText: item.headerText,
      })
      const normalized = normalizeDescriptionText(resolved?.description ?? "")
      if (normalized) return {
        description: normalized,
        confidence: resolved?.confidence ?? null,
        evidenceText: normalizeText(resolved?.evidenceText ?? ""),
      }
    } catch {
      // Fall back to contextual text below.
    }
  }

  return fallbackIconDescription({
    occurrenceIndex: item.occurrence?.occurrenceIndex,
    rowText: item.rowText,
    cellText: item.cellText,
    headerText: item.headerText,
    localTextAfter: item.occurrence?.localTextAfter,
    localTextBefore: item.occurrence?.localTextBefore,
  })
}

export async function buildDocumentManualVisualGroups(
  input: {
    source: string
    sourceContent: string
    occurrences: DocumentManualVisualOccurrence[]
  },
  options?: BuildDocumentManualVisualGroupsOptions,
): Promise<StoredVisualGroup[]> {
  const tables = extractDocumentManualTables(input.sourceContent)
  const candidates = bindVisualRowsToOccurrences(tables, input.occurrences)
  const concurrency = Math.max(1, Math.min(options?.concurrency ?? 1, 4))

  const memberTasks = candidates.flatMap((candidate, groupIndex) =>
    candidate.items.map((item, memberIndex) => ({
      item,
      groupIndex,
      memberIndex,
    })),
  )
  const resolvedMembersByGroup = candidates.map((candidate) =>
    new Array<{
      item: BoundVisualGroupItem
      resolved: IconDescriptionResult
    }>(candidate.items.length),
  )

  if (memberTasks.length > 0) {
    const resolvedMembers = await mapWithConcurrency(
      memberTasks,
      concurrency,
      async (task) => ({
        ...task,
        resolved: await resolveMemberDescription(task.item, options),
      }),
      (completed, total) => {
        options?.onProgress?.({
          phase: "member_descriptions",
          completed,
          total,
        })
      },
    )
    for (const task of resolvedMembers) {
      resolvedMembersByGroup[task.groupIndex][task.memberIndex] = {
        item: task.item,
        resolved: task.resolved,
      }
    }
  }

  const draftGroups = candidates.map((candidate, index) => {
    const items: StoredVisualGroupItem[] = []
    const memberDescriptions: string[] = []

    for (const item of resolvedMembersByGroup[index]) {
      if (!item) continue
      const description = normalizeDescriptionText(item.resolved.description)
      if (!description) continue
      memberDescriptions.push(description)
      items.push({
        image: item.item.image,
        description,
        rowText: normalizeDescriptionText(item.item.rowText),
        cellText: normalizeDescriptionText(item.item.cellText),
        headerText: normalizeDescriptionText(item.item.headerText),
      })
    }

    return {
      id: `vg-${input.source.replace(/\.[^.]+$/, "")}-${index + 1}`,
      source: input.source,
      headingPath: candidate.headingPath,
      precedingParagraph: candidate.precedingParagraph,
      followingParagraph: candidate.followingParagraph,
      tableContext: candidate.tableContext,
      items,
      memberDescriptions,
      fallbackSummary: fallbackGroupSummary(
        {
          headingPath: candidate.headingPath,
          tableContext: candidate.tableContext,
          precedingParagraph: candidate.precedingParagraph,
          followingParagraph: candidate.followingParagraph,
        },
        memberDescriptions,
      ),
    }
  })

  const resolvedSummaries = draftGroups.length > 0
    ? await mapWithConcurrency(
      draftGroups,
      concurrency,
      async (group) => {
        let resolvedSummary = group.fallbackSummary
        try {
          const fromModel = await options?.resolveGroupSummary?.({
            headingPath: group.headingPath,
            tableContext: group.tableContext,
            precedingParagraph: group.precedingParagraph,
            followingParagraph: group.followingParagraph,
            memberDescriptions: group.memberDescriptions,
            items: group.items,
          })
          if (fromModel?.title || fromModel?.summary) {
            resolvedSummary = {
              title: normalizeText(fromModel.title) || group.fallbackSummary.title,
              summary: normalizeText(fromModel.summary) || group.fallbackSummary.summary,
              context: normalizeText(fromModel.context) || group.fallbackSummary.context,
              confidence: fromModel.confidence ?? null,
            }
          }
        } catch {
          resolvedSummary = group.fallbackSummary
        }
        return resolvedSummary
      },
      (completed, total) => {
        options?.onProgress?.({
          phase: "group_summaries",
          completed,
          total,
        })
      },
    )
    : []

  const groups: StoredVisualGroup[] = draftGroups
    .filter((group) => group.items.length > 0)
    .map((group, index) => {
    const resolvedSummary = resolvedSummaries[index] ?? group.fallbackSummary
    return {
      id: group.id,
      source: group.source,
      headingPath: group.headingPath,
      title: resolvedSummary.title,
      summary: resolvedSummary.summary,
      tableContext: resolvedSummary.context ?? group.tableContext,
      items: group.items,
    }
  })

  return groups
}

export function buildUiVisualElementsMarkdown(
  groups: StoredVisualGroup[],
): string {
  if (groups.length === 0) return ""

  const lines: string[] = ["", "", "## UI Visual Elements", ""]
  for (const group of groups) {
    lines.push(serializeVisualGroupBlock(group), "")
  }

  return lines.join("\n").trimEnd()
}
