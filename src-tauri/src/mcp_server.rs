use std::{
    collections::BTreeSet,
    fs,
    io,
    net::TcpListener as StdTcpListener,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use axum::Router;
use rmcp::{
    Json, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ServerCapabilities, ServerInfo},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{State, async_runtime::JoinHandle};
use tokio_util::sync::CancellationToken;

use crate::commands::{fs::collect_markdown_files, project::is_valid_wiki_project_path};

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 18765;
const DEFAULT_SEARCH_LIMIT: usize = 10;
const DEFAULT_CONTEXT_PAGE_LIMIT: usize = 5;
const DEFAULT_PAGE_CHAR_LIMIT: usize = 4000;
const MCP_ENDPOINT_PATH: &str = "/mcp";
const NO_PROJECT_MESSAGE: &str =
    "No active project configured. Open a project in LLM Wiki or pass a known project_path.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpStatus {
    Stopped,
    Starting,
    Running,
    PortConflict,
    NoProject,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub enabled: bool,
    pub auto_start: bool,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpRuntimeState {
    pub status: McpStatus,
    pub host: String,
    pub port: u16,
    pub current_project: Option<String>,
    pub known_projects: Vec<String>,
    pub last_error: Option<String>,
}

pub struct McpRuntimeManager {
    inner: Arc<Mutex<McpRuntimeCore>>,
}

struct McpRuntimeCore {
    config: McpConfig,
    status: McpStatus,
    current_project: Option<String>,
    known_projects: Vec<String>,
    last_error: Option<String>,
    server: Option<EmbeddedMcpServerHandle>,
}

struct EmbeddedMcpServerHandle {
    host: String,
    port: u16,
    cancellation_token: CancellationToken,
    task: JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Keyword,
    Semantic,
    Hybrid,
}

impl SearchMode {
    fn as_str(&self) -> &'static str {
        match self {
            SearchMode::Keyword => "keyword",
            SearchMode::Semantic => "semantic",
            SearchMode::Hybrid => "hybrid",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpToolErrorCode {
    NoProject,
    InvalidProject,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpToolError {
    pub code: McpToolErrorCode,
    pub message: String,
}

impl McpToolError {
    fn no_project() -> Self {
        Self {
            code: McpToolErrorCode::NoProject,
            message: NO_PROJECT_MESSAGE.to_string(),
        }
    }

    fn invalid_project(project_path: &str, known_projects: &[String]) -> Self {
        let mut message = format!("Invalid project_path: {}", project_path);
        if !known_projects.is_empty() {
            message.push_str(". Available projects:\n");
            for project in known_projects {
                message.push_str(&format!("- {}\n", project));
            }
            message = message.trim_end().to_string();
        }
        Self {
            code: McpToolErrorCode::InvalidProject,
            message,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpListProjectsResponse {
    pub current_project: Option<McpProjectInfo>,
    pub projects: Vec<McpProjectInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSearchHit {
    pub title: String,
    pub relative_path: String,
    pub score: f64,
    pub snippet: String,
    pub title_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSearchResponse {
    pub project_path: String,
    pub query: String,
    pub mode: SearchMode,
    pub warning: Option<String>,
    pub results: Vec<McpSearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpPage {
    pub exists: bool,
    pub title: String,
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReadPageResponse {
    pub project_path: String,
    pub page: McpPage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpContextResponse {
    pub project_path: String,
    pub mode: SearchMode,
    pub warning: Option<String>,
    pub purpose: String,
    pub schema: String,
    pub index: String,
    pub pages: Vec<McpPage>,
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddedMcpTools;

#[derive(Clone)]
struct EmbeddedMcpServer {
    runtime: Arc<Mutex<McpRuntimeCore>>,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchRequest {
    query: String,
    project_path: Option<String>,
    limit: Option<usize>,
    mode: Option<SearchMode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReadPageRequest {
    path_or_id: String,
    project_path: Option<String>,
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetContextRequest {
    query: String,
    project_path: Option<String>,
    max_pages: Option<usize>,
    page_char_limit: Option<usize>,
    mode: Option<SearchMode>,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_start: false,
            host: DEFAULT_MCP_HOST.to_string(),
            port: DEFAULT_MCP_PORT,
        }
    }
}

impl Default for McpRuntimeState {
    fn default() -> Self {
        Self {
            status: McpStatus::Stopped,
            host: DEFAULT_MCP_HOST.to_string(),
            port: DEFAULT_MCP_PORT,
            current_project: None,
            known_projects: Vec::new(),
            last_error: None,
        }
    }
}

impl Default for McpRuntimeManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(McpRuntimeCore::default())),
        }
    }
}

impl Default for McpRuntimeCore {
    fn default() -> Self {
        Self {
            config: McpConfig::default(),
            status: McpStatus::Stopped,
            current_project: None,
            known_projects: Vec::new(),
            last_error: None,
            server: None,
        }
    }
}

impl EmbeddedMcpServer {
    fn new(runtime: Arc<Mutex<McpRuntimeCore>>) -> Self {
        Self {
            runtime,
            tool_router: Self::tool_router(),
        }
    }

    fn runtime_snapshot(&self) -> McpRuntimeState {
        lock_or_recover(&self.runtime).snapshot()
    }
}

#[tool_router(router = tool_router)]
impl EmbeddedMcpServer {
    #[tool(
        name = "llm_wiki_list_projects",
        description = "List the current and known LLM Wiki projects exposed by the running desktop app."
    )]
    async fn list_projects(&self) -> Json<McpListProjectsResponse> {
        let state = self.runtime_snapshot();
        Json(EmbeddedMcpTools.llm_wiki_list_projects(&state))
    }

    #[tool(
        name = "llm_wiki_search",
        description = "Search the active LLM Wiki project by keyword relevance. Semantic and hybrid requests fall back to keyword mode in the embedded runtime."
    )]
    async fn search(
        &self,
        Parameters(SearchRequest {
            query,
            project_path,
            limit,
            mode,
        }): Parameters<SearchRequest>,
    ) -> Result<Json<McpSearchResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_search(&state, &query, project_path.as_deref(), limit, mode)
            .map(Json)
            .map_err(tool_error_result)
    }

    #[tool(
        name = "llm_wiki_read_page",
        description = "Read a single wiki page by relative path like entities/openai.md or by page id like openai."
    )]
    async fn read_page(
        &self,
        Parameters(ReadPageRequest {
            path_or_id,
            project_path,
            max_chars,
        }): Parameters<ReadPageRequest>,
    ) -> Result<Json<McpReadPageResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_read_page(&state, &path_or_id, project_path.as_deref(), max_chars)
            .map(Json)
            .map_err(tool_error_result)
    }

    #[tool(
        name = "llm_wiki_get_context",
        description = "Return a compact answering bundle: purpose.md, schema.md, wiki/index.md, and the most relevant wiki pages for a query."
    )]
    async fn get_context(
        &self,
        Parameters(GetContextRequest {
            query,
            project_path,
            max_pages,
            page_char_limit,
            mode,
        }): Parameters<GetContextRequest>,
    ) -> Result<Json<McpContextResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_get_context(
                &state,
                &query,
                project_path.as_deref(),
                max_pages,
                page_char_limit,
                mode,
            )
            .map(Json)
            .map_err(tool_error_result)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EmbeddedMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Read-only LLM Wiki MCP server embedded in the desktop app. It only exposes projects known to the app.",
        )
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl McpRuntimeCore {
    fn snapshot(&self) -> McpRuntimeState {
        McpRuntimeState {
            status: self.status.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            current_project: self.current_project.clone(),
            known_projects: self.known_projects.clone(),
            last_error: self.last_error.clone(),
        }
    }

    fn set_error(&mut self, message: String) {
        self.stop_server();
        self.status = McpStatus::Error;
        self.last_error = Some(message);
    }

    fn start_server(
        &mut self,
        shared: Arc<Mutex<McpRuntimeCore>>,
        respect_auto_start: bool,
    ) -> Result<(), String> {
        validate_config(&self.config).map_err(|err| {
            self.set_error(err.clone());
            err
        })?;

        if !self.config.enabled {
            self.stop_server();
            self.status = McpStatus::Stopped;
            self.last_error = None;
            return Ok(());
        }

        if respect_auto_start && !self.config.auto_start {
            self.stop_server();
            self.status = McpStatus::Stopped;
            self.last_error = None;
            return Ok(());
        }

        let Some(current_project) = self.current_project.as_deref().and_then(non_empty_trimmed) else {
            self.stop_server();
            let message = NO_PROJECT_MESSAGE.to_string();
            self.status = McpStatus::NoProject;
            self.last_error = Some(message.clone());
            return Err(message);
        };

        let normalized_project = normalize_project_path(current_project);
        if !is_valid_wiki_project_path(Path::new(&normalized_project)) {
            let message = format!(
                "Invalid current project '{}': missing schema.md or wiki/index.md",
                normalized_project
            );
            self.set_error(message.clone());
            return Err(message);
        }

        let desired_host = self.config.host.clone();
        let desired_port = self.config.port;

        if let Some(server) = &self.server {
            if server.host == desired_host && server.port == desired_port {
                self.status = McpStatus::Running;
                self.last_error = None;
                return Ok(());
            }
        }

        self.stop_server();
        self.status = McpStatus::Starting;
        self.last_error = None;

        let bind_address = format!("{}:{}", desired_host, desired_port);
        let listener = match StdTcpListener::bind(&bind_address) {
            Ok(listener) => listener,
            Err(err) => {
                let message = format!("Failed to bind MCP server on {}: {}", bind_address, err);
                self.status = if err.kind() == io::ErrorKind::AddrInUse {
                    McpStatus::PortConflict
                } else {
                    McpStatus::Error
                };
                self.last_error = Some(message.clone());
                return Err(message);
            }
        };

        if let Err(err) = listener.set_nonblocking(true) {
            let message = format!("Failed to configure MCP listener on {}: {}", bind_address, err);
            self.set_error(message.clone());
            return Err(message);
        }

        let cancellation_token = CancellationToken::new();
        let task_token = cancellation_token.child_token();
        let task_host = desired_host.clone();
        let task_shared = shared.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_mcp_http_server(task_shared, listener, task_host, desired_port, task_token).await;
        });

        self.server = Some(EmbeddedMcpServerHandle {
            host: desired_host,
            port: desired_port,
            cancellation_token,
            task,
        });
        self.status = McpStatus::Running;
        self.last_error = None;
        Ok(())
    }

    fn stop_server(&mut self) {
        if let Some(server) = self.server.take() {
            server.cancellation_token.cancel();
            server.task.abort();
        }
    }

    fn stop(&mut self) {
        self.stop_server();
        self.status = McpStatus::Stopped;
        self.last_error = None;
    }

    fn update_project(
        &mut self,
        shared: Arc<Mutex<McpRuntimeCore>>,
        project_path: Option<String>,
    ) -> Result<(), String> {
        let had_server = self.server.is_some();
        self.current_project = project_path
            .as_deref()
            .and_then(non_empty_trimmed)
            .map(normalize_project_path);

        if self.current_project.is_none() {
            self.stop_server();
            if had_server || (self.config.enabled && self.config.auto_start) {
                self.status = McpStatus::NoProject;
                self.last_error = Some(NO_PROJECT_MESSAGE.to_string());
            } else {
                self.status = McpStatus::Stopped;
                self.last_error = None;
            }
            return Ok(());
        }

        if self.config.enabled && self.config.auto_start {
            self.start_server(shared, true)
        } else if matches!(self.status, McpStatus::NoProject) {
            self.status = McpStatus::Stopped;
            self.last_error = None;
            Ok(())
        } else {
            Ok(())
        }
    }

    fn update_known_projects(&mut self, project_paths: Vec<String>) {
        let mut set = BTreeSet::new();
        for path in project_paths {
            if let Some(trimmed) = non_empty_trimmed(&path) {
                set.insert(normalize_project_path(trimmed));
            }
        }
        self.known_projects = set.into_iter().collect();
    }

    fn update_config(
        &mut self,
        shared: Arc<Mutex<McpRuntimeCore>>,
        config: McpConfig,
    ) -> Result<(), String> {
        validate_config(&config).map_err(|err| {
            self.set_error(err.clone());
            err
        })?;

        let host_changed = self.config.host != config.host;
        let port_changed = self.config.port != config.port;
        let enabled_changed = self.config.enabled != config.enabled;
        let auto_start_changed = self.config.auto_start != config.auto_start;
        self.config = config;

        if !self.config.enabled {
            self.stop_server();
            self.status = McpStatus::Stopped;
            self.last_error = None;
            return Ok(());
        }

        if !self.config.auto_start {
            self.stop_server();
            self.status = McpStatus::Stopped;
            self.last_error = None;
            return Ok(());
        }

        if self.current_project.is_none() {
            self.stop_server();
            self.status = McpStatus::NoProject;
            self.last_error = Some(NO_PROJECT_MESSAGE.to_string());
            return Ok(());
        }

        if host_changed
            || port_changed
            || enabled_changed
            || auto_start_changed
            || self.server.is_none()
            || matches!(
                self.status,
                McpStatus::Stopped | McpStatus::NoProject | McpStatus::PortConflict | McpStatus::Error
            )
        {
            return self.start_server(shared, true);
        }

        Ok(())
    }
}

impl McpRuntimeManager {
    fn shared(&self) -> Arc<Mutex<McpRuntimeCore>> {
        self.inner.clone()
    }

    fn snapshot(&self) -> McpRuntimeState {
        lock_or_recover(&self.inner).snapshot()
    }

    fn start(&self) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).start_server(shared, false)
    }

    pub(crate) fn stop(&self) {
        lock_or_recover(&self.inner).stop();
    }

    fn update_project(&self, project_path: Option<String>) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).update_project(shared, project_path)
    }

    fn update_known_projects(&self, project_paths: Vec<String>) {
        lock_or_recover(&self.inner).update_known_projects(project_paths);
    }

    fn update_config(&self, config: McpConfig) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).update_config(shared, config)
    }
}

async fn run_mcp_http_server(
    shared: Arc<Mutex<McpRuntimeCore>>,
    listener: StdTcpListener,
    host: String,
    port: u16,
    cancellation_token: CancellationToken,
) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            record_background_failure(
                &shared,
                &host,
                port,
                format!("Failed to adopt MCP listener into Tokio runtime: {}", err),
            );
            return;
        }
    };

    let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
        StreamableHttpService::new(
            {
                let shared = shared.clone();
                move || Ok(EmbeddedMcpServer::new(shared.clone()))
            },
            Default::default(),
            streamable_http_config(&host, cancellation_token.clone()),
        );

    let router = Router::new().nest_service(MCP_ENDPOINT_PATH, service);
    let serve_result = axum::serve(listener, router)
        .with_graceful_shutdown(async move { cancellation_token.cancelled_owned().await })
        .await;

    if let Err(err) = serve_result {
        record_background_failure(
            &shared,
            &host,
            port,
            format!("Embedded MCP HTTP server stopped unexpectedly: {}", err),
        );
    }
}

fn streamable_http_config(host: &str, cancellation_token: CancellationToken) -> StreamableHttpServerConfig {
    let config = StreamableHttpServerConfig::default()
        .with_cancellation_token(cancellation_token);

    if host == DEFAULT_MCP_HOST {
        config.with_allowed_hosts(["127.0.0.1", "localhost", "::1"])
    } else {
        // LAN mode needs to accept requests addressed by the machine's actual IP or hostname.
        config.disable_allowed_hosts()
    }
}

fn record_background_failure(
    shared: &Arc<Mutex<McpRuntimeCore>>,
    host: &str,
    port: u16,
    message: String,
) {
    let mut core = lock_or_recover(shared);
    let matches_current_server = core
        .server
        .as_ref()
        .map(|server| server.host == host && server.port == port)
        .unwrap_or(false);

    if matches_current_server {
        core.server = None;
        core.status = McpStatus::Error;
        core.last_error = Some(message);
    }
}

pub fn resolve_project(
    state: &McpRuntimeState,
    project_path: Option<&str>,
) -> Result<String, McpToolError> {
    if let Some(override_path) = project_path.and_then(non_empty_trimmed) {
        let normalized = normalize_project_path(override_path);
        let known = known_project_paths(state);
        if known.iter().any(|path| path == &normalized) {
            return Ok(normalized);
        }
        return Err(McpToolError::invalid_project(&normalized, &known));
    }

    if let Some(current) = state.current_project.as_deref().and_then(non_empty_trimmed) {
        return Ok(normalize_project_path(current));
    }

    Err(McpToolError::no_project())
}

impl EmbeddedMcpTools {
    pub fn llm_wiki_list_projects(&self, state: &McpRuntimeState) -> McpListProjectsResponse {
        let projects = known_project_paths(state)
            .into_iter()
            .map(|path| project_info(&path))
            .collect::<Vec<_>>();

        let current_project = state
            .current_project
            .as_deref()
            .and_then(non_empty_trimmed)
            .map(normalize_project_path)
            .map(|path| project_info(&path));

        McpListProjectsResponse {
            current_project,
            projects,
        }
    }

    pub fn llm_wiki_search(
        &self,
        state: &McpRuntimeState,
        query: &str,
        project_path: Option<&str>,
        limit: Option<usize>,
        mode: Option<SearchMode>,
    ) -> Result<McpSearchResponse, McpToolError> {
        let project_path = resolve_project(state, project_path)?;
        ensure_valid_wiki_project(&project_path)?;

        let requested_mode = mode.unwrap_or(SearchMode::Hybrid);
        let (effective_mode, warning) = effective_mode_with_warning(requested_mode);
        let search_limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 20);
        let results = keyword_search(&project_path, query, search_limit)?;

        Ok(McpSearchResponse {
            project_path,
            query: query.to_string(),
            mode: effective_mode,
            warning,
            results,
        })
    }

    pub fn llm_wiki_read_page(
        &self,
        state: &McpRuntimeState,
        path_or_id: &str,
        project_path: Option<&str>,
        max_chars: Option<usize>,
    ) -> Result<McpReadPageResponse, McpToolError> {
        let project_path = resolve_project(state, project_path)?;
        ensure_valid_wiki_project(&project_path)?;

        let mut page = read_wiki_page(&project_path, path_or_id)?;
        page.content = truncate_chars(&page.content, max_chars.unwrap_or(12_000));

        Ok(McpReadPageResponse { project_path, page })
    }

    pub fn llm_wiki_get_context(
        &self,
        state: &McpRuntimeState,
        query: &str,
        project_path: Option<&str>,
        max_pages: Option<usize>,
        page_char_limit: Option<usize>,
        mode: Option<SearchMode>,
    ) -> Result<McpContextResponse, McpToolError> {
        let project_path = resolve_project(state, project_path)?;
        ensure_valid_wiki_project(&project_path)?;

        let requested_mode = mode.unwrap_or(SearchMode::Hybrid);
        let (effective_mode, warning) = effective_mode_with_warning(requested_mode);
        let page_limit = max_pages.unwrap_or(DEFAULT_CONTEXT_PAGE_LIMIT).clamp(1, 10);
        let chars_limit = page_char_limit
            .unwrap_or(DEFAULT_PAGE_CHAR_LIMIT)
            .clamp(200, 20_000);

        let search_results = keyword_search(&project_path, query, page_limit)?;
        let project_root = Path::new(&project_path);

        let purpose = fs::read_to_string(project_root.join("purpose.md")).unwrap_or_default();
        let schema = fs::read_to_string(project_root.join("schema.md")).unwrap_or_default();
        let index = fs::read_to_string(project_root.join("wiki/index.md")).unwrap_or_default();

        let mut pages = Vec::new();
        for hit in search_results {
            if let Ok(mut page) = read_wiki_page(&project_path, &hit.relative_path) {
                page.content = truncate_chars(&page.content, chars_limit);
                pages.push(page);
            }
        }

        Ok(McpContextResponse {
            project_path,
            mode: effective_mode,
            warning,
            purpose,
            schema,
            index,
            pages,
        })
    }
}

fn tool_error_result(error: McpToolError) -> CallToolResult {
    CallToolResult::structured_error(json!(error))
}

fn effective_mode_with_warning(mode: SearchMode) -> (SearchMode, Option<String>) {
    if matches!(mode, SearchMode::Keyword) {
        return (SearchMode::Keyword, None);
    }

    (
        SearchMode::Keyword,
        Some(format!(
            "{} retrieval fell back to keyword mode because semantic search is unavailable in the embedded runtime.",
            mode.as_str()
        )),
    )
}

fn ensure_valid_wiki_project(project_path: &str) -> Result<(), McpToolError> {
    let normalized = normalize_project_path(project_path);
    if is_valid_wiki_project_path(Path::new(&normalized)) {
        Ok(())
    } else {
        Err(McpToolError::invalid_project(&normalized, &[]))
    }
}

fn keyword_search(
    project_path: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<McpSearchHit>, McpToolError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let wiki_root = Path::new(project_path).join("wiki");
    let files = collect_markdown_files(&wiki_root).map_err(|err| McpToolError {
        code: McpToolErrorCode::InvalidProject,
        message: err,
    })?;
    let query_tokens = tokenize_query(query);
    let query_lower = query.to_lowercase();
    let mut hits = Vec::new();

    for file_path in files {
        let content = match fs::read_to_string(&file_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let fallback_title = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled");
        let title = extract_title(&content, fallback_title);
        let (score, title_match) = score_page(&title, &content, &query_lower, &query_tokens);
        if score <= 0.0 {
            continue;
        }

        let relative_path = file_path
            .strip_prefix(&wiki_root)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .replace('\\', "/");

        hits.push(McpSearchHit {
            title,
            relative_path,
            score,
            snippet: build_snippet(&content, &query_tokens),
            title_match,
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    hits.truncate(limit);

    Ok(hits)
}

fn read_wiki_page(project_path: &str, path_or_id: &str) -> Result<McpPage, McpToolError> {
    let wiki_root = Path::new(project_path).join("wiki");
    let normalized = normalize_relative_page_path(path_or_id);
    let mut candidates = Vec::new();

    if let Some(candidate) = safe_wiki_join(&wiki_root, &normalized) {
        candidates.push(candidate);
    }
    if !normalized.ends_with(".md") {
        let with_ext = format!("{}.md", normalized);
        if let Some(candidate) = safe_wiki_join(&wiki_root, &with_ext) {
            candidates.push(candidate);
        }
    }

    for candidate in candidates {
        if candidate.is_file() {
            let content = fs::read_to_string(&candidate).map_err(|err| McpToolError {
                code: McpToolErrorCode::InvalidProject,
                message: format!("Failed reading page '{}': {}", candidate.display(), err),
            })?;
            let title = extract_title(
                &content,
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path_or_id),
            );
            let relative_path = candidate
                .strip_prefix(&wiki_root)
                .unwrap_or(&candidate)
                .to_string_lossy()
                .replace('\\', "/");
            return Ok(McpPage {
                exists: true,
                title,
                relative_path,
                content,
            });
        }
    }

    let bare_id = Path::new(&normalized)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(&normalized);
    let files = collect_markdown_files(&wiki_root).map_err(|err| McpToolError {
        code: McpToolErrorCode::InvalidProject,
        message: err,
    })?;
    for file_path in files {
        let file_id = file_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if file_id != bare_id {
            continue;
        }
        let content = fs::read_to_string(&file_path).map_err(|err| McpToolError {
            code: McpToolErrorCode::InvalidProject,
            message: format!("Failed reading page '{}': {}", file_path.display(), err),
        })?;
        let title = extract_title(
            &content,
            file_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path_or_id),
        );
        let relative_path = file_path
            .strip_prefix(&wiki_root)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .replace('\\', "/");
        return Ok(McpPage {
            exists: true,
            title,
            relative_path,
            content,
        });
    }

    Ok(McpPage {
        exists: false,
        title: path_or_id.to_string(),
        relative_path: normalized,
        content: String::new(),
    })
}

fn score_page(
    title: &str,
    content: &str,
    query_lower: &str,
    query_tokens: &[String],
) -> (f64, bool) {
    let title_lower = title.to_lowercase();
    let content_lower = content.to_lowercase();

    let title_match = !query_lower.is_empty() && title_lower.contains(query_lower);
    let title_hits = query_tokens
        .iter()
        .filter(|token| title_lower.contains(token.as_str()))
        .count() as f64;
    let body_hits = query_tokens
        .iter()
        .map(|token| content_lower.matches(token).count())
        .sum::<usize>() as f64;
    let phrase_bonus = if !query_lower.is_empty() && content_lower.contains(query_lower) {
        8.0
    } else {
        0.0
    };

    let mut score = title_hits * 10.0 + body_hits * 2.0 + phrase_bonus;
    if title_match {
        score += 20.0;
    }
    (score, title_match)
}

fn extract_title(content: &str, fallback: &str) -> String {
    if let Some(frontmatter_title) = extract_frontmatter_title(content) {
        return frontmatter_title;
    }

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let title = trimmed.trim_start_matches('#').trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }

    fallback.trim_end_matches(".md").to_string()
}

fn extract_frontmatter_title(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("title:") {
            let title = value.trim().trim_matches('"').trim_matches('\'');
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }

    None
}

fn build_snippet(content: &str, tokens: &[String]) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if tokens.iter().any(|token| lower.contains(token)) {
            return truncate_chars(trimmed, 220);
        }
    }

    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| truncate_chars(line, 220))
        .unwrap_or_default()
}

fn tokenize_query(query: &str) -> Vec<String> {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| token.to_lowercase())
        .collect()
}

fn normalize_relative_page_path(path_or_id: &str) -> String {
    path_or_id
        .trim()
        .replace('\\', "/")
        .trim_start_matches("wiki/")
        .trim_start_matches('/')
        .to_string()
}

fn safe_wiki_join(wiki_root: &Path, relative: &str) -> Option<PathBuf> {
    let mut path = PathBuf::from(wiki_root);
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(path)
}

fn truncate_chars(content: &str, max_chars: usize) -> String {
    let chars = content.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return content.to_string();
    }
    let mut truncated = chars.into_iter().take(max_chars).collect::<String>();
    truncated.push_str("\n\n...[truncated]");
    truncated
}

fn known_project_paths(state: &McpRuntimeState) -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Some(current) = state.current_project.as_deref().and_then(non_empty_trimmed) {
        set.insert(normalize_project_path(current));
    }
    for path in &state.known_projects {
        if let Some(trimmed) = non_empty_trimmed(path) {
            set.insert(normalize_project_path(trimmed));
        }
    }
    set.into_iter().collect()
}

fn project_info(path: &str) -> McpProjectInfo {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string();
    McpProjectInfo {
        name,
        path: path.to_string(),
    }
}

fn normalize_project_path(path: &str) -> String {
    PathBuf::from(path.trim())
        .to_string_lossy()
        .replace('\\', "/")
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn validate_port(port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("MCP port must be between 1 and 65535".to_string());
    }
    Ok(())
}

pub fn validate_host(host: &str) -> Result<(), String> {
    if matches!(host, "127.0.0.1" | "0.0.0.0") {
        return Ok(());
    }
    Err(format!(
        "Unsupported MCP host '{}'; expected 127.0.0.1 or 0.0.0.0",
        host
    ))
}

pub fn validate_config(config: &McpConfig) -> Result<(), String> {
    validate_host(&config.host)?;
    validate_port(config.port)?;
    Ok(())
}

#[tauri::command]
pub fn mcp_status(manager: State<'_, McpRuntimeManager>) -> McpRuntimeState {
    manager.snapshot()
}

#[tauri::command]
pub fn mcp_start(manager: State<'_, McpRuntimeManager>) -> Result<(), String> {
    manager.start()
}

#[tauri::command]
pub fn mcp_stop(manager: State<'_, McpRuntimeManager>) -> Result<(), String> {
    manager.stop();
    Ok(())
}

#[tauri::command]
pub fn mcp_update_project(
    project_path: Option<String>,
    manager: State<'_, McpRuntimeManager>,
) -> Result<(), String> {
    manager.update_project(project_path)
}

#[tauri::command]
pub fn mcp_update_known_projects(
    project_paths: Vec<String>,
    manager: State<'_, McpRuntimeManager>,
) -> Result<(), String> {
    manager.update_known_projects(project_paths);
    Ok(())
}

#[tauri::command]
pub fn mcp_update_config(
    config: McpConfig,
    manager: State<'_, McpRuntimeManager>,
) -> Result<(), String> {
    manager.update_config(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    use rmcp::{
        ServiceExt,
        model::CallToolRequestParams,
        transport::StreamableHttpClientTransport,
    };
    use serde_json::Value;

    struct TempWikiProject {
        path: PathBuf,
    }

    impl TempWikiProject {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("llm-wiki-mcp-{}-{}", name, unique));

            fs::create_dir_all(path.join("wiki/entities")).expect("test wiki dir should be created");
            fs::write(path.join("schema.md"), "# Schema\n").expect("schema should be written");
            fs::write(path.join("purpose.md"), "# Purpose\nAnswer questions about OpenAI.\n")
                .expect("purpose should be written");
            fs::write(path.join("wiki/index.md"), "# Index\n- [[openai]]\n")
                .expect("index should be written");
            fs::write(
                path.join("wiki/entities/openai.md"),
                r#"---
title: OpenAI
---

# OpenAI

OpenAI builds GPT models and AI systems.
"#,
            )
            .expect("page should be written");

            Self { path }
        }

        fn path_string(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempWikiProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn state_with_current_project(path: &str) -> McpRuntimeState {
        McpRuntimeState {
            current_project: Some(path.to_string()),
            ..McpRuntimeState::default()
        }
    }

    fn state_with_known_projects(paths: Vec<&str>) -> McpRuntimeState {
        McpRuntimeState {
            known_projects: paths.into_iter().map(|path| path.to_string()).collect(),
            ..McpRuntimeState::default()
        }
    }

    fn available_port() -> u16 {
        StdTcpListener::bind("127.0.0.1:0")
            .expect("ephemeral listener should bind")
            .local_addr()
            .expect("listener should have local addr")
            .port()
    }

    #[test]
    fn runtime_defaults_to_stopped() {
        let state = McpRuntimeState::default();
        assert_eq!(state.status, McpStatus::Stopped);
    }

    #[test]
    fn resolve_project_resolves_current_project_when_request_has_no_project_path() {
        let state = state_with_current_project("/tmp/wiki-a");
        assert_eq!(resolve_project(&state, None).unwrap(), "/tmp/wiki-a");
    }

    #[test]
    fn resolve_project_rejects_unknown_project_override() {
        let state = state_with_known_projects(vec!["/tmp/wiki-a"]);
        assert!(resolve_project(&state, Some("/tmp/wiki-b")).is_err());
    }

    #[test]
    fn rejects_out_of_range_port() {
        assert!(validate_port(0).is_err());
    }

    #[test]
    fn embedded_server_registers_expected_tools() {
        fn assert_server_handler<T: ServerHandler>(_: &T) {}

        let manager = McpRuntimeManager::default();
        let server = EmbeddedMcpServer::new(manager.shared());
        assert_server_handler(&server);

        let tools = server.tool_router.list_all();
        let mut names = tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "llm_wiki_get_context",
                "llm_wiki_list_projects",
                "llm_wiki_read_page",
                "llm_wiki_search",
            ]
        );
    }

    #[test]
    fn start_without_project_sets_no_project() {
        let manager = McpRuntimeManager::default();
        manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: false,
                host: "127.0.0.1".to_string(),
                port: 18765,
            })
            .expect("valid config should apply");

        let err = manager
            .start()
            .expect_err("start should fail when no project is configured");
        assert_eq!(err, NO_PROJECT_MESSAGE);

        let state = manager.snapshot();
        assert_eq!(state.status, McpStatus::NoProject);
    }

    #[test]
    fn invalid_config_update_sets_error_without_replacing_runtime_config() {
        let manager = McpRuntimeManager::default();

        manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: false,
                host: "127.0.0.1".to_string(),
                port: 18765,
            })
            .expect("initial valid config should apply");

        let before = manager.snapshot();
        let err = manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: false,
                host: "invalid-host".to_string(),
                port: 18766,
            })
            .expect_err("invalid host should be rejected");

        assert!(err.contains("Unsupported MCP host"));

        let after = manager.snapshot();
        assert_eq!(after.host, before.host);
        assert_eq!(after.port, before.port);
        assert_eq!(after.status, McpStatus::Error);
    }

    #[test]
    fn clearing_project_while_running_does_not_leave_running_without_project() {
        let project = TempWikiProject::new("clear-project");
        let manager = McpRuntimeManager::default();
        manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: false,
                host: "127.0.0.1".to_string(),
                port: available_port(),
            })
            .expect("valid config should apply");
        manager.update_known_projects(vec![project.path_string()]);
        manager
            .update_project(Some(project.path_string()))
            .expect("project should update");
        manager.start().expect("start should succeed with a valid project");

        manager
            .update_project(None)
            .expect("clearing project should not panic");
        let state = manager.snapshot();
        assert_eq!(state.status, McpStatus::NoProject);
        assert!(state.current_project.is_none());
    }

    #[test]
    fn auto_start_config_without_project_sets_no_project() {
        let manager = McpRuntimeManager::default();
        manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: true,
                host: "127.0.0.1".to_string(),
                port: 18765,
            })
            .expect("config update should succeed");

        let state = manager.snapshot();
        assert_eq!(state.status, McpStatus::NoProject);
    }

    #[tokio::test]
    async fn streamable_http_service_calls_embedded_tools() {
        let project = TempWikiProject::new("streamable-http");
        let manager = McpRuntimeManager::default();
        let project_path = project.path_string();

        manager.update_known_projects(vec![project_path.clone()]);
        manager
            .update_project(Some(project_path.clone()))
            .expect("project update should succeed");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener.local_addr().expect("listener should have local addr");
        let token = CancellationToken::new();

        let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let shared = manager.shared();
                    move || Ok(EmbeddedMcpServer::new(shared.clone()))
                },
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_cancellation_token(token.child_token())
                    .with_allowed_hosts([addr.to_string()]),
            );

        let router = Router::new().nest_service(MCP_ENDPOINT_PATH, service);
        let handle = tokio::spawn({
            let token = token.clone();
            async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move { token.cancelled_owned().await })
                    .await;
            }
        });

        let transport = StreamableHttpClientTransport::from_uri(format!(
            "http://{}{}",
            addr, MCP_ENDPOINT_PATH
        ));
        let client = ()
            .serve(transport)
            .await
            .expect("client should connect");

        let tools = client
            .list_all_tools()
            .await
            .expect("tool listing should succeed");
        assert_eq!(tools.len(), 4);

        let search_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "query": "OpenAI",
            "mode": "keyword"
        }))
        .expect("search args should deserialize");
        let search_result = client
            .call_tool(CallToolRequestParams::new("llm_wiki_search").with_arguments(search_arguments))
            .await
            .expect("search tool call should succeed");

        assert_eq!(search_result.is_error, Some(false));
        let structured = search_result
            .structured_content
            .expect("search should include structured content");
        assert_eq!(structured["projectPath"], project_path);
        assert_eq!(structured["results"][0]["title"], "OpenAI");

        let read_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "path_or_id": "openai",
            "max_chars": 500
        }))
        .expect("read args should deserialize");
        let read_result = client
            .call_tool(CallToolRequestParams::new("llm_wiki_read_page").with_arguments(read_arguments))
            .await
            .expect("read tool call should succeed");

        assert_eq!(read_result.is_error, Some(false));
        let read_structured = read_result
            .structured_content
            .expect("read should include structured content");
        assert_eq!(read_structured["page"]["relativePath"], "entities/openai.md");

        client.cancel().await.expect("client should cancel cleanly");
        token.cancel();
        handle.await.expect("server task should join");
    }

    #[tokio::test]
    async fn streamable_http_service_returns_structured_no_project_error() {
        let manager = McpRuntimeManager::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener.local_addr().expect("listener should have local addr");
        let token = CancellationToken::new();

        let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let shared = manager.shared();
                    move || Ok(EmbeddedMcpServer::new(shared.clone()))
                },
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_cancellation_token(token.child_token())
                    .with_allowed_hosts([addr.to_string()]),
            );

        let router = Router::new().nest_service(MCP_ENDPOINT_PATH, service);
        let handle = tokio::spawn({
            let token = token.clone();
            async move {
                let _ = axum::serve(listener, router)
                    .with_graceful_shutdown(async move { token.cancelled_owned().await })
                    .await;
            }
        });

        let transport = StreamableHttpClientTransport::from_uri(format!(
            "http://{}{}",
            addr, MCP_ENDPOINT_PATH
        ));
        let client = ()
            .serve(transport)
            .await
            .expect("client should connect");

        let search_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "query": "OpenAI"
        }))
        .expect("search args should deserialize");
        let search_result = client
            .call_tool(CallToolRequestParams::new("llm_wiki_search").with_arguments(search_arguments))
            .await
            .expect("search tool call should succeed");

        assert_eq!(search_result.is_error, Some(true));
        let structured = search_result
            .structured_content
            .expect("search should include structured error");
        assert_eq!(structured["code"], "no_project");

        client.cancel().await.expect("client should cancel cleanly");
        token.cancel();
        handle.await.expect("server task should join");
    }
}
