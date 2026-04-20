# @haowan36/llm-wiki-mcp

Read-only MCP server for browsing and querying LLM Wiki projects.

## Usage

Run from a published npm package:

```bash
npx -y @haowan36/llm-wiki-mcp --project /absolute/path/to/wiki
```

Or expose all wiki projects under a workspace root:

```bash
npx -y @haowan36/llm-wiki-mcp --workspace /absolute/path/to/workspace
```

Enable semantic or hybrid retrieval with an OpenAI-compatible embeddings endpoint:

```bash
LLM_WIKI_EMBEDDING_ENDPOINT=http://127.0.0.1:11434/v1/embeddings \
LLM_WIKI_EMBEDDING_MODEL=text-embedding-3-small \
LLM_WIKI_EMBEDDING_API_KEY=optional-key \
  npx -y @haowan36/llm-wiki-mcp \
    --workspace /absolute/path/to/workspace \
    --host 0.0.0.0 \
    --port 18765
```

The server listens on `http://<host>:<port>/mcp`.

The server exposes four read-only tools:

- `llm_wiki_list_projects`
- `llm_wiki_search`
- `llm_wiki_read_page`
- `llm_wiki_get_context`
