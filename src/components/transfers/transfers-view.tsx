import { useEffect, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Server,
  Upload,
} from "lucide-react"
import {
  fileReceiverStatus,
  listUploads,
  type FileReceiverStatus,
  type UploadRecord,
} from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { getQueue, getQueueSummary, syncQueueFromDisk, type IngestTask } from "@/lib/ingest-queue"
import { normalizePath } from "@/lib/path-utils"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"

export function TransfersView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [runtime, setRuntime] = useState<FileReceiverStatus | null>(null)
  const [uploads, setUploads] = useState<UploadRecord[]>([])
  const [queueTasks, setQueueTasks] = useState<IngestTask[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    if (!project) return
    setRefreshing(true)
    try {
      await syncQueueFromDisk(project.id, normalizePath(project.path))
      const [runtimeState, uploadList] = await Promise.all([
        fileReceiverStatus(),
        listUploads({ projectPath: project.path, limit: 50 }),
      ])
      setRuntime(runtimeState)
      setUploads(uploadList.uploads)
      setQueueTasks([...getQueue()])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!project) return

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 2000)

    return () => {
      window.clearInterval(timer)
    }
  }, [project?.id, project?.path])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("transfers.noProject")}
      </div>
    )
  }

  const queueSummary = getQueueSummary()
  const uploadingCount = uploads.filter((upload) => upload.status === "uploading").length
  const failedUploadCount = uploads.filter((upload) => upload.status === "failed").length

  return (
    <div className="h-full overflow-auto p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold">{t("transfers.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("transfers.description")}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("transfers.project")}: {project.path}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="gap-2"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("transfers.refresh")}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <SummaryCard
            icon={Server}
            label={t("transfers.runtime")}
            value={runtime ? formatStatus(runtime.status) : t("transfers.loading")}
            detail={runtime ? `${runtime.host}:${runtime.port}` : undefined}
          />
          <SummaryCard
            icon={Upload}
            label={t("transfers.uploading")}
            value={String(uploadingCount)}
            detail={t("transfers.recentUploads", { count: uploads.length })}
          />
          <SummaryCard
            icon={Clock3}
            label={t("transfers.queuePending")}
            value={String(queueSummary.pending + queueSummary.processing)}
            detail={t("transfers.queueHistory", { count: queueSummary.history })}
          />
          <SummaryCard
            icon={failedUploadCount > 0 ? AlertCircle : CheckCircle2}
            label={t("transfers.failures")}
            value={String(failedUploadCount + queueSummary.failed)}
            detail={runtime?.lastError ?? t("transfers.knownProjects", { count: runtime?.knownProjects.length ?? 0 })}
            tone={failedUploadCount + queueSummary.failed > 0 ? "danger" : "normal"}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="font-semibold">{t("transfers.uploadHistory")}</h3>
                <p className="text-xs text-muted-foreground">{t("transfers.uploadHistoryHint")}</p>
              </div>
              <span className="text-xs text-muted-foreground">{uploads.length}</span>
            </div>
            <div className="divide-y">
              {loading ? (
                <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("transfers.loading")}
                </div>
              ) : uploads.length === 0 ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {t("transfers.noUploads")}
                </div>
              ) : (
                uploads.map((upload) => (
                  <UploadRow key={upload.uploadId} upload={upload} />
                ))
              )}
            </div>
          </section>

          <section className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h3 className="font-semibold">{t("transfers.ingestQueue")}</h3>
                <p className="text-xs text-muted-foreground">{t("transfers.ingestQueueHint")}</p>
              </div>
              <span className="text-xs text-muted-foreground">{queueSummary.total}</span>
            </div>
            <div className="space-y-3 px-4 py-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <QueueMetric label={t("transfers.queuePending")} value={queueSummary.pending} />
                <QueueMetric label={t("transfers.queueProcessing")} value={queueSummary.processing} />
                <QueueMetric label={t("transfers.queueFailed")} value={queueSummary.failed} />
                <QueueMetric label={t("transfers.queueDone")} value={queueSummary.done} />
              </div>

              <div className="space-y-2">
                {queueTasks.length === 0 ? (
                  <div className="rounded-md bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
                    {t("transfers.noQueueTasks")}
                  </div>
                ) : (
                  queueTasks.map((task) => (
                    <QueueTaskRow key={task.id} task={task} />
                  ))
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "normal",
}: {
  icon: typeof Server
  label: string
  value: string
  detail?: string
  tone?: "normal" | "danger"
}) {
  return (
    <div className={`rounded-lg border p-4 ${tone === "danger" ? "border-red-200 bg-red-50/50" : ""}`}>
      <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className={`h-4 w-4 ${tone === "danger" ? "text-red-600" : ""}`} />
        <span>{label}</span>
      </div>
      <div className={`text-2xl font-semibold ${tone === "danger" ? "text-red-700" : ""}`}>{value}</div>
      {detail && <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

function UploadRow({ upload }: { upload: UploadRecord }) {
  const statusTone = getUploadStatusTone(upload.status)

  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="truncate font-medium">{upload.fileName}</div>
          <div className="text-xs text-muted-foreground">
            {upload.folderContext || "raw/sources"}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone}`}>
          {formatStatus(upload.status)}
        </span>
      </div>

      {upload.status === "uploading" && (
        <div className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(upload.receivedBytes)}
          </div>
        </div>
      )}

      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <div>{upload.taskId ? `Task: ${upload.taskId}` : "Task: -"}</div>
        <div>{timestamplike(upload.updatedAt)}</div>
        <div className="truncate">
          {upload.storedSourcePath ? `Source: ${upload.storedSourcePath}` : `Received: ${formatBytes(upload.receivedBytes)}`}
        </div>
        <div className="truncate">
          {upload.mimeType || "mimeType: -"}
        </div>
      </div>

      {upload.error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {upload.error}
        </div>
      )}
    </div>
  )
}

function QueueMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}

function QueueTaskRow({ task }: { task: IngestTask }) {
  const statusTone = getQueueStatusTone(task.status)
  const fileName = task.sourcePath.split("/").pop() || task.sourcePath

  return (
    <div className="rounded-md border px-3 py-3">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{fileName}</div>
          {task.folderContext && (
            <div className="truncate text-xs text-muted-foreground">{task.folderContext}</div>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusTone}`}>
          {formatStatus(task.status)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {task.error || task.sourcePath}
      </div>
    </div>
  )
}

function getUploadStatusTone(status: UploadRecord["status"]): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700"
    case "failed":
      return "bg-red-100 text-red-700"
    case "expired":
      return "bg-slate-200 text-slate-700"
    default:
      return "bg-blue-100 text-blue-700"
  }
}

function getQueueStatusTone(status: IngestTask["status"]): string {
  switch (status) {
    case "done":
      return "bg-emerald-100 text-emerald-700"
    case "failed":
      return "bg-red-100 text-red-700"
    case "processing":
      return "bg-blue-100 text-blue-700"
    default:
      return "bg-amber-100 text-amber-700"
  }
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ")
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function timestamplike(value: number): string {
  if (!value) return "-"
  return new Date(value).toLocaleString()
}
