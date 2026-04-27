# Query Flow

Use this flow when the user wants answers based on existing `llm-wiki` knowledge base content.

## 1. Confirm server registration

Prefer already exposed MCP tools. If tools such as `llm_wiki_get_context`, `llm_wiki_search`, `llm_wiki_read_page`, or `llm_wiki_list_projects` are available in the current agent session, use them directly.

If no first-class MCP tools are exposed, inspect the host client's MCP configuration. For OpenClaw, useful checks are:

```bash
openclaw mcp list
openclaw mcp show llm-wiki
```

For other clients, use their equivalent MCP diagnostics. Do not require OpenClaw commands outside OpenClaw.

## 2. Establish MCP session

When no first-class MCP tool is exposed, use the registered MCP HTTP endpoint.

Minimum sequence:

1. `initialize`
2. `notifications/initialized`
3. `tools/list`
4. `tools/call`

Important:
- Send `Accept: application/json, text/event-stream`
- Parse SSE `data:` lines
- Reuse `Mcp-Session-Id` from initialize response
- Reuse authentication that the client already uses for the MCP endpoint

## 3. Choose the right llm-wiki tool

Prefer tools by intent, not by memorized assumptions.

### Use `llm_wiki_get_context` when:
- the user asks “什么是 X”
- the answer needs a compact bundle of relevant pages
- you want summary-friendly grounding with related pages

### Use `llm_wiki_search` when:
- the user is exploring whether the KB contains something
- you need a relevance-ranked hit list first
- keyword lookup is enough

### Use `llm_wiki_read_page` when:
- you already know the page path or id
- search/context results point to a specific page that should be read directly

### Use `llm_wiki_list_projects` when:
- project scope is unclear
- the user asks about available knowledge-base projects

## 4. Query strategy

Recommended order for broad question answering:

1. `llm_wiki_get_context` with the user query
2. inspect returned pages and warning/mode
3. if needed, `llm_wiki_read_page` for the strongest matching page
4. synthesize the answer

If `semantic` or `hybrid` falls back to keyword mode, say so only when it materially affects the answer.

## 5. Response format

Default response structure:

1. **结论/总结** — answer the user directly
2. **依据条目** — list related page titles or paths
3. **补充说明** — only if evidence is weak, ambiguous, or partial

Example structure:

- `subagents`：定义是……
- 相关条目：`entities/subagents.md`, `sources/sub-agents.md`, `index.md`
- 补充：当前项目中该术语主要出现在 Claude Code 语境下

## 6. Guardrails

- Do not claim the KB is unavailable before checking registration and MCP reachability
- Do not answer “based on the KB” unless `llm-wiki` was actually queried
- Do not replace KB retrieval with generic web search when the user explicitly asked for KB grounding
- Do not invent page titles, paths, or KB evidence
- If evidence is limited, say exactly that
