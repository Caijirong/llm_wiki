---
name: using-llm-wiki
description: "Use when the user asks about a knowledge base, wiki, internal docs, saved materials, existing notes, project memory, documented knowledge, source-grounded answers, or importing materials into a knowledge base. Triggers include: 知识库, wiki, 文档库, 资料库, 项目记忆, 已有资料, 历史资料, 沉淀内容, 根据资料回答, 基于知识回答, 查一下有没有, 总结资料, 上传资料, 导入资料, 加入知识库."
---

# Using LLM Wiki

Use this skill for knowledge-base workflows backed by an `llm-wiki` MCP server. The user does not need to mention `llm-wiki`; if the request is about existing knowledge, wiki content, saved materials, or importing sources, use this skill and route the work through `llm-wiki`.

## What this skill covers

- Query an `llm-wiki` knowledge base
- Answer questions grounded in knowledge base content
- Import files into the knowledge base through the upload/ingest flow
- Route knowledge-base-oriented tasks through the `llm-wiki` MCP tools

## What this skill does NOT cover

- Direct page editing inside the wiki through MCP
- Generic web search as a substitute for knowledge base retrieval
- Pretending the knowledge base is unavailable before checking exposed MCP tools or the configured MCP server

## Trigger rules

Activate this skill when the user intent matches any of these:

1. **Knowledge base query intent**
   - “根据知识库…”
   - “查一下知识库里有没有…”
   - “wiki 里有没有…”
   - “已有资料里有没有…”
   - “根据项目记忆…”
   - “基于现有知识库内容总结…”
   - “什么是 X（要求按已有资料回答）”

2. **Knowledge base import intent**
   - “把这个文件导入知识库”
   - “上传到知识库”
   - “写入知识库” when the real operation is file import
   - “把资料加入 wiki”
   - “把资料沉淀下来”
   - “导入这些文档”

3. **Usage/process intent**
   - “怎么查知识库”
   - “怎么把资料入库”
   - “agent 怎么基于 wiki 回答”
   - “如何让已有资料参与回答”

## Decision rules

- If the user asks for a grounded answer from the knowledge base, use `llm-wiki` first.
- If the user asks to add material to the knowledge base, treat that as **file upload/import** only.
- If the task needs current KB evidence, do not answer from memory or generic web results before checking `llm-wiki`.
- For imports, call `llm_wiki_get_upload_guide` first and follow the returned upload contract.
- If the upload service is stopped, unavailable, or unauthorized, report that runtime state directly.
- If no first-class MCP tool exists, inspect the configured MCP server through the host client or use the HTTP MCP fallback.

## Capability detection

Use the best available access path in this order:

1. First-class MCP tools exposed in the current agent session, such as `llm_wiki_get_context`, `llm_wiki_search`, or `llm_wiki_get_upload_guide`.
2. The agent host's MCP registry or diagnostics. In OpenClaw, `openclaw mcp list` and `openclaw mcp show llm-wiki` are useful checks.
3. A configured MCP HTTP endpoint. Use the Streamable HTTP flow only when direct MCP tools are unavailable.

Do not require OpenClaw commands in non-OpenClaw clients.

## Query workflow

For query tasks, read `references/query-flow.md` and follow it.

Default answering format:

1. Short grounded summary
2. Related references / entries / page titles
3. If confidence is limited, say the KB evidence is limited

## Import workflow

For file-import tasks, read `references/import-flow.md` and follow it.

Key boundary:

- Writing is supported through **file upload + ingest**
- Writing is **not** direct wiki page mutation over MCP
- Import starts with `llm_wiki_get_upload_guide`, then `/uploads`, then ingest queue tracking

## Failure handling

- If no `llm-wiki` MCP tools or endpoint are available, say so directly
- If initialization fails, report MCP connection failure directly
- If tools are unavailable, surface that exact limitation
- If ingest is still processing, do not poll aggressively; tell the user it is queued/processing and use the recommended poll interval

## Output standard

### For queries

Return:
- A direct answer in plain language
- Supporting references or entries from the KB
- Clear wording when evidence is partial

### For imports

Return:
- Whether the upload request was sent
- The ingest task status if available
- Whether the task is pending / processing / done / failed

## Client-specific note

When OpenClaw has an MCP server registered as `llm-wiki`, use that server for knowledge-base-oriented tasks. Do not bypass it with unrelated wiki, document, or web-search flows unless `llm-wiki` cannot do the job.
