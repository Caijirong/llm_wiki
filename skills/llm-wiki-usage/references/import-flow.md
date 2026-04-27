# Import Flow

Use this flow when the user wants to add materials into the `llm-wiki` knowledge base.

## Scope

For `llm-wiki`, knowledge-base writing means **file upload and ingest**.

It does **not** mean direct page mutation over MCP.

This flow targets the embedded `llm-wiki` MCP server. The upload contract is discovered at runtime because endpoint, forwarded headers, project id, and service status can vary by deployment.

## 1. Confirm MCP access

Prefer already exposed MCP tools. Use `llm_wiki_get_upload_guide` to discover the current import contract.

If no first-class MCP tools are exposed, inspect the host client's MCP configuration. For OpenClaw, useful checks are:

```bash
openclaw mcp list
openclaw mcp show llm-wiki
```

For other clients, use their equivalent MCP diagnostics. Do not require OpenClaw commands outside OpenClaw.

## 2. Discover upload contract

Establish MCP session, then call:

- `llm_wiki_get_upload_guide`

Use that result as the source of truth for:
- upload endpoint
- required fields
- optional fields
- forward headers
- auth handling
- current project id when provided
- upload service status

## 3. Upload the file

Upload through `/uploads`, not through MCP `tools/call` file bytes.

Rules:
- if `serviceStatus` is not running, report that imports are unavailable until the embedded upload service is running
- send metadata fields before the file part when required by the service contract
- reuse server-provided headers from the upload guide
- reuse the client's existing MCP/upload authentication when the guide does not return forward headers
- prefer one clear upload request over repeated retries

## 4. Track ingest status

After upload, query one of:
- `llm_wiki_get_ingest_queue`
- `llm_wiki_get_ingest_task`

Prefer targeted task lookup when you have a task id.

## 5. Polling behavior

Do not poll aggressively.

Use the server-returned `recommendedPollIntervalSeconds` when available. If the task is still pending or processing, tell the user that ingest is asynchronous and still running.

## 6. Response format

Default structure:

1. Upload accepted / not accepted
2. Task id if returned
3. Current status: pending / processing / done / failed
4. Next step or wait guidance

## 7. Failure handling

### If upload guide is unavailable
State that the upload contract could not be retrieved from the embedded `llm-wiki` MCP server.

### If upload service is stopped
Report the returned `serviceStatus` and do not attempt `/uploads` until the service is running.

### If upload fails
Report the HTTP/MCP-visible failure directly.

### If ingest fails
Report task status and surfaced error text if available.

## 8. Guardrails

- Do not describe file import as direct wiki-page writing
- Do not invent upload fields; use the guide result
- Do not claim completion before ingest status confirms it
- Do not bypass `llm_wiki_get_upload_guide`; it is the runtime source of truth for imports
