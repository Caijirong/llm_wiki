import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { testSearchConnection } from "@/lib/connection-tests"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function WebSearchSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [connection, setConnection] = useState<{
    status: "idle" | "testing" | "success" | "error"
    message: string
  }>({ status: "idle", message: "" })
  const options = [
    { value: "none" as const, label: "Disabled" },
    { value: "tavily" as const, label: "Tavily" },
  ]

  async function handleTestConnection() {
    setConnection({ status: "testing", message: t("settings.testingConnection") })
    try {
      const result = await testSearchConnection({
        provider: draft.searchProvider,
        apiKey: draft.searchApiKey,
      })
      setConnection({
        status: "success",
        message: t("settings.connectionSuccess", { target: result.label }),
      })
    } catch (err) {
      setConnection({
        status: "error",
        message: t("settings.connectionFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("settings.sections.webSearch.title")} (Deep Research)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.webSearch.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("settings.sections.webSearch.provider", { defaultValue: "Search Provider" })}</Label>
        <div className="flex flex-wrap gap-2">
          {options.map((p) => {
            const active = draft.searchProvider === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setDraft("searchProvider", p.value)}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {p.label}
              </button>
            )
          })}
        </div>
      </div>

      {draft.searchProvider !== "none" && (
        <>
          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              value={draft.searchApiKey}
              onChange={(e) => setDraft("searchApiKey", e.target.value)}
              placeholder="Enter your Tavily API key (tavily.com)"
            />
          </div>
          <div className="space-y-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={connection.status === "testing"}
            >
              {connection.status === "testing"
                ? t("settings.testingConnection")
                : t("settings.testSearchConnection")}
            </Button>
            {connection.status !== "idle" && connection.status !== "testing" && (
              <p
                role={connection.status === "error" ? "alert" : "status"}
                className={`text-xs ${
                  connection.status === "success" ? "text-emerald-600" : "text-destructive"
                }`}
              >
                {connection.message}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
