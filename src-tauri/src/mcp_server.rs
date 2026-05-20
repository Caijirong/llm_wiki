use std::{
    collections::{BTreeSet, HashMap},
    fs, io,
    net::TcpListener as StdTcpListener,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    http::{header::AUTHORIZATION, header::HOST, request::Parts, HeaderMap},
    Router,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, tool::Extension, wrapper::Parameters},
    model::{CallToolResult, ServerCapabilities, ServerInfo},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    Json, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{async_runtime::JoinHandle, AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::commands::{fs::collect_markdown_files, project::is_valid_wiki_project_path};
use crate::file_receiver_server::{
    FileReceiverRuntimeManager, FileReceiverRuntimeState, FileReceiverStatus,
    UPLOAD_TOKEN_HEADER_DISPLAY_NAME, UPLOAD_TOKEN_HEADER_NAME,
};

const DEFAULT_MCP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_PORT: u16 = 18765;
const DEFAULT_SEARCH_LIMIT: usize = 10;
const DEFAULT_INGEST_POLL_INTERVAL_SECONDS: u64 = 60;
const MCP_ENDPOINT_PATH: &str = "/mcp";
const UPLOADS_ENDPOINT_PATH: &str = "/uploads";
const UPLOADS_ITEM_PATH_TEMPLATE: &str = "/uploads/{upload_id}";
const NO_PROJECT_MESSAGE: &str =
    "No active project configured. Open a project in LLM Wiki or pass a known project_id.";
const INGEST_QUEUE_RELATIVE_PATH: &str = ".llm-wiki/ingest-queue.json";
const INGEST_STATUS_HINT: &str =
    "Ingest runs asynchronously inside the desktop app and can take a while for large or complex sources. A task in processing is usually still working, not stuck. Ask the user to check again later instead of polling aggressively.";
const MCP_RETRIEVAL_REQUEST_EVENT: &str = "llm-wiki-mcp-retrieval-request";
const MCP_RETRIEVAL_TIMEOUT_SECONDS: u64 = 20;
static INGEST_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    file_receiver: FileReceiverRuntimeManager,
}

struct McpRuntimeCore {
    config: McpConfig,
    status: McpStatus,
    current_project: Option<String>,
    known_projects: Vec<String>,
    last_error: Option<String>,
    server: Option<EmbeddedMcpServerHandle>,
    retrieval_bridge: RendererRetrievalBridge,
}

struct EmbeddedMcpServerHandle {
    host: String,
    port: u16,
    mcp_route_enabled: bool,
    cancellation_token: CancellationToken,
    task: JoinHandle<()>,
}

type PendingRetrievalSender = oneshot::Sender<Result<McpRendererRetrievalResponse, String>>;

#[derive(Clone, Default)]
struct RendererRetrievalBridge {
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    pending: Arc<Mutex<HashMap<String, PendingRetrievalSender>>>,
}

impl RendererRetrievalBridge {
    fn attach_app_handle(&self, app_handle: AppHandle) {
        *lock_or_recover(&self.app_handle) = Some(app_handle);
    }

    async fn request(
        &self,
        request: McpRendererRetrievalRequest,
    ) -> Result<McpRendererRetrievalResponse, String> {
        let app_handle = lock_or_recover(&self.app_handle)
            .clone()
            .ok_or_else(|| "renderer retrieval bridge is not connected".to_string())?;
        let request_id = request.request_id.clone();
        let (tx, rx) = oneshot::channel();

        {
            let mut pending = lock_or_recover(&self.pending);
            pending.insert(request_id.clone(), tx);
        }

        if let Err(err) = app_handle.emit(MCP_RETRIEVAL_REQUEST_EVENT, request) {
            lock_or_recover(&self.pending).remove(&request_id);
            return Err(format!(
                "failed to dispatch renderer retrieval request: {}",
                err
            ));
        }

        match tokio::time::timeout(Duration::from_secs(MCP_RETRIEVAL_TIMEOUT_SECONDS), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("renderer retrieval response channel closed".to_string()),
            Err(_) => {
                lock_or_recover(&self.pending).remove(&request_id);
                Err("renderer retrieval timed out".to_string())
            }
        }
    }

    fn complete(&self, completion: McpRendererRetrievalCompletion) -> Result<(), String> {
        let sender = lock_or_recover(&self.pending)
            .remove(&completion.request_id)
            .ok_or_else(|| format!("unknown MCP retrieval request '{}'", completion.request_id))?;
        let result = if completion.ok {
            completion
                .response
                .ok_or_else(|| "renderer retrieval completed without a response".to_string())
        } else {
            Err(completion
                .error
                .unwrap_or_else(|| "renderer retrieval failed".to_string()))
        };

        sender
            .send(result)
            .map_err(|_| "MCP retrieval waiter dropped before completion".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpToolErrorCode {
    NoProject,
    InvalidProject,
    InvalidInput,
    QueueFormat,
    Internal,
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

    fn invalid_project(project_id: &str, known_projects: &[String]) -> Self {
        let mut message = format!("Invalid project_id: {}", project_id);
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

    fn invalid_input(message: impl Into<String>) -> Self {
        Self {
            code: McpToolErrorCode::InvalidInput,
            message: message.into(),
        }
    }

    fn queue_format(message: impl Into<String>) -> Self {
        Self {
            code: McpToolErrorCode::QueueFormat,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: McpToolErrorCode::Internal,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpProjectInfo {
    pub name: String,
    pub id: String,
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
    pub project_id: String,
    pub query: String,
    pub warning: Option<String>,
    pub results: Vec<McpSearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpPage {
    pub exists: bool,
    pub title: String,
    pub relative_path: String,
    pub total_chars: usize,
    pub start_offset: usize,
    pub end_offset: usize,
    pub content: String,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub next_start_offset: Option<usize>,
    pub resources: Vec<McpPageResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpPageResource {
    pub id: usize,
    pub kind: String,
    pub raw_ref: String,
    pub url: String,
    pub source_path: String,
    pub title: Option<String>,
    pub alt: Option<String>,
    pub syntax: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct McpRendererRetrievalRequest {
    request_id: String,
    project_id: String,
    project_path: String,
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpRendererRetrievalResponse {
    pub project_id: String,
    pub query: String,
    pub warning: Option<String>,
    pub results: Vec<McpSearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpReadPageResponse {
    pub project_id: String,
    pub page: McpPage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpRendererRetrievalCompletion {
    pub request_id: String,
    pub ok: bool,
    pub response: Option<McpRendererRetrievalResponse>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpIngestTask {
    pub id: String,
    pub source_name: String,
    pub folder_context: String,
    pub status: String,
    pub added_at: u64,
    pub error: Option<String>,
    pub retry_count: u64,
    pub origin: Option<String>,
    pub mime_type: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub files_written: Option<Vec<String>>,
    pub review_item_count: Option<u64>,
    pub cache_hit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpIngestQueueSummary {
    pub pending: usize,
    pub processing: usize,
    pub failed: usize,
    pub done: usize,
    pub active: usize,
    pub history: usize,
    pub records_total: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpUploadGuideResponse {
    pub upload_mode: String,
    pub summary: String,
    pub current_project_id: Option<String>,
    pub service_status: String,
    pub endpoint_path: String,
    pub default_endpoint: String,
    pub resolved_endpoint: String,
    pub upload_host: String,
    pub upload_port: u16,
    pub scheme: String,
    pub authorization_scheme: String,
    pub header_auth_name: String,
    pub forward_headers: Vec<McpHttpHeader>,
    pub required_fields: Vec<String>,
    pub optional_fields: Vec<String>,
    pub list_uploads_path: String,
    pub get_upload_path_template: String,
    pub curl_example: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpGetIngestTaskResponse {
    pub project_id: String,
    pub task_id: String,
    pub found: bool,
    pub task: Option<McpIngestTask>,
    pub status_hint: String,
    pub recommended_poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpGetIngestQueueResponse {
    pub project_id: String,
    pub summary: McpIngestQueueSummary,
    pub recent_tasks: Vec<McpIngestTask>,
    pub current_task: Option<McpIngestTask>,
    pub limit: usize,
    pub queue: Vec<McpIngestTask>,
    pub status_hint: String,
    pub recommended_poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddedMcpTools;

#[derive(Clone)]
struct EmbeddedMcpServer {
    runtime: Arc<Mutex<McpRuntimeCore>>,
    file_receiver: FileReceiverRuntimeManager,
    retrieval_bridge: RendererRetrievalBridge,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedUploadEndpoint {
    scheme: String,
    host: String,
    port: u16,
    url: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchRequest {
    query: String,
    project_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReadPageRequest {
    path_or_id: String,
    project_id: Option<String>,
    start_offset: Option<usize>,
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetIngestTaskRequest {
    task_id: String,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetIngestQueueRequest {
    project_id: Option<String>,
    limit: Option<usize>,
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
        let file_receiver = FileReceiverRuntimeManager::default();
        Self {
            inner: Arc::new(Mutex::new(McpRuntimeCore::default())),
            file_receiver,
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
            retrieval_bridge: RendererRetrievalBridge::default(),
        }
    }
}

impl EmbeddedMcpServer {
    fn new(runtime: Arc<Mutex<McpRuntimeCore>>, file_receiver: FileReceiverRuntimeManager) -> Self {
        let retrieval_bridge = lock_or_recover(&runtime).retrieval_bridge.clone();
        Self {
            runtime,
            file_receiver,
            retrieval_bridge,
            tool_router: Self::tool_router(),
        }
    }

    fn runtime_snapshot(&self) -> McpRuntimeState {
        lock_or_recover(&self.runtime).snapshot()
    }

    fn file_receiver_snapshot(&self) -> FileReceiverRuntimeState {
        self.file_receiver.snapshot()
    }

    async fn llm_wiki_search(
        &self,
        state: &McpRuntimeState,
        query: &str,
        project_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<McpSearchResponse, McpToolError> {
        let (resolved_project_id, project_path) = resolve_retrieval_project(state, project_id)?;
        let search_limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 20);
        let request = McpRendererRetrievalRequest {
            request_id: new_retrieval_request_id(),
            project_id: resolved_project_id.clone(),
            project_path,
            query: query.to_string(),
            limit: Some(search_limit),
        };

        match self.retrieval_bridge.request(request).await {
            Ok(renderer) => Ok(McpSearchResponse {
                project_id: resolved_project_id,
                query: query.to_string(),
                warning: renderer.warning,
                results: renderer.results.into_iter().take(search_limit).collect(),
            }),
            Err(_) => {
                let mut fallback =
                    EmbeddedMcpTools.llm_wiki_search(state, query, project_id, limit)?;
                fallback.warning = Some(renderer_fallback_warning());
                Ok(fallback)
            }
        }
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
        description = "Search the active LLM Wiki project using the same retrieval path as the in-app chat."
    )]
    async fn search(
        &self,
        Parameters(SearchRequest {
            query,
            project_id,
            limit,
        }): Parameters<SearchRequest>,
    ) -> Result<Json<McpSearchResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        self.llm_wiki_search(&state, &query, project_id.as_deref(), limit)
            .await
            .map(Json)
            .map_err(tool_error_result)
    }

    #[tool(
        name = "llm_wiki_read_page",
        description = "Read a single wiki page by relative path like entities/openai.md or by page id like openai. Omit pagination fields to return the full original wiki markdown, or pass start_offset/max_chars to read a specific original-markdown window. The response includes page.resources, a mapping of resource references found in the returned content window to directly accessible HTTP URLs."
    )]
    async fn read_page(
        &self,
        Parameters(ReadPageRequest {
            path_or_id,
            project_id,
            start_offset,
            max_chars,
        }): Parameters<ReadPageRequest>,
    ) -> Result<Json<McpReadPageResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_read_page(
                &state,
                &path_or_id,
                project_id.as_deref(),
                start_offset,
                max_chars,
            )
            .map(Json)
            .map_err(tool_error_result)
    }

    #[tool(
        name = "llm_wiki_get_upload_guide",
        description = "Return the current upload contract for importing source files through the shared /uploads endpoint."
    )]
    async fn get_upload_guide(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Json<McpUploadGuideResponse> {
        let state = self.runtime_snapshot();
        let upload_state = self.file_receiver_snapshot();
        Json(EmbeddedMcpTools.llm_wiki_get_upload_guide(&state, &upload_state, Some(&parts)))
    }

    #[tool(
        name = "llm_wiki_get_ingest_task",
        description = "Return one ingest task by task id from the shared ingest queue."
    )]
    async fn get_ingest_task(
        &self,
        Parameters(GetIngestTaskRequest {
            task_id,
            project_id,
        }): Parameters<GetIngestTaskRequest>,
    ) -> Result<Json<McpGetIngestTaskResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_get_ingest_task(&state, &task_id, project_id.as_deref())
            .map(Json)
            .map_err(tool_error_result)
    }

    #[tool(
        name = "llm_wiki_get_ingest_queue",
        description = "Return the persisted ingest queue, current task, recent tasks, and queue summary."
    )]
    async fn get_ingest_queue(
        &self,
        Parameters(GetIngestQueueRequest { project_id, limit }): Parameters<GetIngestQueueRequest>,
    ) -> Result<Json<McpGetIngestQueueResponse>, CallToolResult> {
        let state = self.runtime_snapshot();
        EmbeddedMcpTools
            .llm_wiki_get_ingest_queue(&state, project_id.as_deref(), limit)
            .map(Json)
            .map_err(tool_error_result)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for EmbeddedMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "LLM Wiki MCP server embedded in the desktop app. Query wiki content with the read tools. Import source files by first calling llm_wiki_get_upload_guide and then uploading to the returned /uploads contract.",
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
    fn sync_file_receiver_runtime(&self, file_receiver: &FileReceiverRuntimeManager) {
        let upload_config = file_receiver.config();
        let mcp_listener_running = self
            .server
            .as_ref()
            .map(|server| server.mcp_route_enabled)
            .unwrap_or(false);
        let status = if upload_config.enabled {
            if mcp_listener_running {
                FileReceiverStatus::Running
            } else {
                match self.status {
                    McpStatus::PortConflict => FileReceiverStatus::PortConflict,
                    McpStatus::Error => FileReceiverStatus::Error,
                    _ => FileReceiverStatus::Stopped,
                }
            }
        } else {
            FileReceiverStatus::Stopped
        };

        let last_error = match status {
            FileReceiverStatus::PortConflict | FileReceiverStatus::Error => self.last_error.clone(),
            _ => None,
        };

        file_receiver.sync_shared_listener(
            self.config.host.clone(),
            self.config.port,
            status,
            last_error,
        );
    }

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
        file_receiver: FileReceiverRuntimeManager,
        respect_auto_start: bool,
    ) -> Result<(), String> {
        let upload_config = file_receiver.config();
        let mcp_requested = self.config.enabled && (!respect_auto_start || self.config.auto_start);

        if !mcp_requested {
            self.stop_server();
            self.status = McpStatus::Stopped;
            self.last_error = None;
            self.sync_file_receiver_runtime(&file_receiver);
            return Ok(());
        }

        validate_config(&self.config).map_err(|err| {
            self.set_error(err.clone());
            self.sync_file_receiver_runtime(&file_receiver);
            err
        })?;

        let mut mcp_route_enabled = false;
        let mut startup_error: Option<String> = None;

        if mcp_requested {
            match self.current_project.as_deref().and_then(non_empty_trimmed) {
                Some(current_project) => {
                    let normalized_project = normalize_project_path(current_project);
                    if is_valid_wiki_project_path(Path::new(&normalized_project)) {
                        mcp_route_enabled = true;
                        self.status = McpStatus::Running;
                        self.last_error = None;
                    } else {
                        let message = format!(
                            "Invalid current project '{}': missing schema.md or wiki/index.md",
                            normalized_project
                        );
                        self.status = McpStatus::Error;
                        self.last_error = Some(message.clone());
                        startup_error = Some(message);
                    }
                }
                None => {
                    let message = NO_PROJECT_MESSAGE.to_string();
                    self.status = McpStatus::NoProject;
                    self.last_error = Some(message.clone());
                    startup_error = Some(message);
                }
            }
        } else {
            self.status = McpStatus::Stopped;
            self.last_error = None;
        }

        let uploads_enabled = mcp_route_enabled && upload_config.enabled;

        if !mcp_route_enabled {
            self.stop_server();
            self.sync_file_receiver_runtime(&file_receiver);
            return Err(startup_error.unwrap_or_else(|| NO_PROJECT_MESSAGE.to_string()));
        }

        let desired_host = self.config.host.clone();
        let desired_port = self.config.port;

        if let Some(server) = &self.server {
            if server.host == desired_host
                && server.port == desired_port
                && server.mcp_route_enabled == mcp_route_enabled
            {
                self.sync_file_receiver_runtime(&file_receiver);
                return startup_error.map_or(Ok(()), Err);
            }
        }

        self.stop_server();
        if uploads_enabled || mcp_route_enabled {
            self.status = McpStatus::Starting;
        }

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
                self.sync_file_receiver_runtime(&file_receiver);
                return Err(message);
            }
        };

        if let Err(err) = listener.set_nonblocking(true) {
            let message = format!(
                "Failed to configure MCP listener on {}: {}",
                bind_address, err
            );
            self.set_error(message.clone());
            self.sync_file_receiver_runtime(&file_receiver);
            return Err(message);
        }

        let cancellation_token = CancellationToken::new();
        let task_token = cancellation_token.child_token();
        let task_host = desired_host.clone();
        let task_shared = shared.clone();
        let task_file_receiver = file_receiver.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_mcp_http_server(
                task_shared,
                task_file_receiver,
                listener,
                task_host,
                desired_port,
                mcp_route_enabled,
                task_token,
            )
            .await;
        });

        self.server = Some(EmbeddedMcpServerHandle {
            host: desired_host,
            port: desired_port,
            mcp_route_enabled,
            cancellation_token,
            task,
        });
        if mcp_route_enabled {
            self.status = McpStatus::Running;
            self.last_error = None;
        }
        self.sync_file_receiver_runtime(&file_receiver);
        startup_error.map_or(Ok(()), Err)
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
        file_receiver: FileReceiverRuntimeManager,
        project_path: Option<String>,
    ) -> Result<(), String> {
        let had_server = self.server.is_some();
        self.current_project = project_path
            .as_deref()
            .and_then(non_empty_trimmed)
            .map(normalize_project_path);

        if self.current_project.is_none() {
            if had_server || (self.config.enabled && self.config.auto_start) {
                self.status = McpStatus::NoProject;
                self.last_error = Some(NO_PROJECT_MESSAGE.to_string());
            } else {
                self.status = McpStatus::Stopped;
                self.last_error = None;
            }
            self.stop_server();
            self.sync_file_receiver_runtime(&file_receiver);
            return Ok(());
        }

        self.start_server(shared, file_receiver, true)
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
        file_receiver: FileReceiverRuntimeManager,
        config: McpConfig,
    ) -> Result<(), String> {
        validate_config(&config).map_err(|err| {
            self.set_error(err.clone());
            err
        })?;

        self.config = config;
        if self.current_project.is_none() && self.config.enabled && self.config.auto_start {
            self.stop_server();
            self.status = McpStatus::NoProject;
            self.last_error = Some(NO_PROJECT_MESSAGE.to_string());
            self.sync_file_receiver_runtime(&file_receiver);
            return Ok(());
        }
        self.start_server(shared, file_receiver, true)
    }
}

impl McpRuntimeManager {
    pub(crate) fn with_file_receiver(file_receiver: FileReceiverRuntimeManager) -> Self {
        Self {
            inner: Arc::new(Mutex::new(McpRuntimeCore::default())),
            file_receiver,
        }
    }

    fn shared(&self) -> Arc<Mutex<McpRuntimeCore>> {
        self.inner.clone()
    }

    fn snapshot(&self) -> McpRuntimeState {
        lock_or_recover(&self.inner).snapshot()
    }

    fn start(&self) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).start_server(shared, self.file_receiver.clone(), false)
    }

    pub(crate) fn stop(&self) {
        {
            lock_or_recover(&self.inner).stop();
        }
        let snapshot = self.snapshot();
        self.file_receiver.sync_shared_listener(
            snapshot.host,
            snapshot.port,
            FileReceiverStatus::Stopped,
            None,
        );
    }

    fn update_project(&self, project_path: Option<String>) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).update_project(
            shared,
            self.file_receiver.clone(),
            project_path,
        )
    }

    fn update_known_projects(&self, project_paths: Vec<String>) {
        lock_or_recover(&self.inner).update_known_projects(project_paths);
    }

    fn update_config(&self, config: McpConfig) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).update_config(shared, self.file_receiver.clone(), config)
    }

    pub(crate) fn attach_app_handle(&self, app_handle: AppHandle) {
        lock_or_recover(&self.inner)
            .retrieval_bridge
            .attach_app_handle(app_handle);
    }

    fn complete_retrieval(&self, completion: McpRendererRetrievalCompletion) -> Result<(), String> {
        lock_or_recover(&self.inner)
            .retrieval_bridge
            .complete(completion)
    }

    pub(crate) fn refresh_external_service(&self) -> Result<(), String> {
        let shared = self.shared();
        lock_or_recover(&self.inner).start_server(shared, self.file_receiver.clone(), true)
    }
}

async fn run_mcp_http_server(
    shared: Arc<Mutex<McpRuntimeCore>>,
    file_receiver: FileReceiverRuntimeManager,
    listener: StdTcpListener,
    host: String,
    port: u16,
    mcp_route_enabled: bool,
    cancellation_token: CancellationToken,
) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            record_background_failure(
                &shared,
                &file_receiver,
                &host,
                port,
                format!("Failed to adopt MCP listener into Tokio runtime: {}", err),
            );
            return;
        }
    };

    let mut router = Router::new().merge(file_receiver.router());
    if mcp_route_enabled {
        let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let shared = shared.clone();
                    let file_receiver = file_receiver.clone();
                    move || {
                        Ok(EmbeddedMcpServer::new(
                            shared.clone(),
                            file_receiver.clone(),
                        ))
                    }
                },
                Default::default(),
                streamable_http_config(&host, cancellation_token.clone()),
            );
        router = router.nest_service(MCP_ENDPOINT_PATH, service);
    }
    let serve_result = axum::serve(listener, router)
        .with_graceful_shutdown(async move { cancellation_token.cancelled_owned().await })
        .await;

    if let Err(err) = serve_result {
        record_background_failure(
            &shared,
            &file_receiver,
            &host,
            port,
            format!("Embedded MCP HTTP server stopped unexpectedly: {}", err),
        );
    }
}

fn streamable_http_config(
    host: &str,
    cancellation_token: CancellationToken,
) -> StreamableHttpServerConfig {
    let config = StreamableHttpServerConfig::default().with_cancellation_token(cancellation_token);

    if host == DEFAULT_MCP_HOST {
        config.with_allowed_hosts(["127.0.0.1", "localhost", "::1"])
    } else {
        // LAN mode needs to accept requests addressed by the machine's actual IP or hostname.
        config.disable_allowed_hosts()
    }
}

fn record_background_failure(
    shared: &Arc<Mutex<McpRuntimeCore>>,
    file_receiver: &FileReceiverRuntimeManager,
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
        core.sync_file_receiver_runtime(file_receiver);
    }
}

fn first_header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn trim_forwarded_value(value: &str) -> &str {
    value.trim().trim_matches('"')
}

fn parse_forwarded_header(headers: &HeaderMap) -> (Option<String>, Option<String>) {
    let Some(value) = first_header_value(headers, "forwarded") else {
        return (None, None);
    };

    let mut proto = None;
    let mut host = None;

    for segment in value.split(';') {
        let Some((key, raw_value)) = segment.split_once('=') else {
            continue;
        };
        let value = trim_forwarded_value(raw_value);
        if value.is_empty() {
            continue;
        }

        if key.trim().eq_ignore_ascii_case("proto") {
            proto = Some(value.to_ascii_lowercase());
        } else if key.trim().eq_ignore_ascii_case("host") {
            host = Some(value.to_string());
        }
    }

    (proto, host)
}

fn normalize_scheme(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_ascii_lowercase())
    }
}

fn parse_host_and_port(candidate: &str) -> Option<(String, Option<u16>)> {
    let trimmed = trim_forwarded_value(candidate);
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(authority) = axum::http::uri::Authority::try_from(trimmed) {
        return Some((authority.host().to_string(), authority.port_u16()));
    }

    Some((trimmed.trim_matches(['[', ']']).to_string(), None))
}

fn default_port_for_scheme(scheme: &str) -> Option<u16> {
    match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    }
}

fn format_url_authority(host: &str, port: u16, scheme: &str) -> String {
    let formatted_host = format_url_host(host);
    if default_port_for_scheme(scheme) == Some(port) {
        formatted_host
    } else {
        format!("{}:{}", formatted_host, port)
    }
}

fn format_url_host(host: &str) -> String {
    if host.contains(':') {
        format!("[{}]", host.trim_matches(['[', ']']))
    } else {
        host.to_string()
    }
}

fn resolve_upload_endpoint(
    upload_state: &FileReceiverRuntimeState,
    request_parts: Option<&Parts>,
) -> ResolvedUploadEndpoint {
    let mut scheme = None;
    let mut authority = None;

    if let Some(parts) = request_parts {
        let (forwarded_proto, forwarded_host) = parse_forwarded_header(&parts.headers);
        scheme = forwarded_proto
            .or_else(|| first_header_value(&parts.headers, "x-forwarded-proto"))
            .or_else(|| parts.uri.scheme_str().map(ToOwned::to_owned))
            .and_then(|value| normalize_scheme(&value));
        authority = forwarded_host
            .or_else(|| first_header_value(&parts.headers, "x-forwarded-host"))
            .or_else(|| first_header_value(&parts.headers, HOST.as_str()))
            .or_else(|| {
                parts
                    .uri
                    .authority()
                    .map(|authority| authority.as_str().to_string())
            })
            .and_then(|value| parse_host_and_port(&value));
    }

    let scheme = scheme.unwrap_or_else(|| "http".to_string());
    let (host, port) = authority
        .map(|(host, port)| {
            (
                host,
                port.or_else(|| default_port_for_scheme(&scheme))
                    .unwrap_or(upload_state.port),
            )
        })
        .unwrap_or_else(|| (upload_state.host.clone(), upload_state.port));
    let url = format!(
        "{}://{}{}",
        scheme,
        format_url_authority(&host, port, &scheme),
        UPLOADS_ENDPOINT_PATH
    );

    ResolvedUploadEndpoint {
        scheme,
        host,
        port,
        url,
    }
}

fn upload_forward_headers(request_parts: Option<&Parts>) -> Vec<McpHttpHeader> {
    let Some(parts) = request_parts else {
        return Vec::new();
    };

    if let Some(value) = parts
        .headers
        .get(UPLOAD_TOKEN_HEADER_NAME)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
    {
        return vec![McpHttpHeader {
            name: UPLOAD_TOKEN_HEADER_DISPLAY_NAME.to_string(),
            value: value.to_string(),
        }];
    }

    parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.trim().starts_with("Bearer "))
        .map(|value| {
            vec![McpHttpHeader {
                name: "Authorization".to_string(),
                value: value.to_string(),
            }]
        })
        .unwrap_or_default()
}

fn upload_auth_header_line(forward_headers: &[McpHttpHeader]) -> String {
    if let Some(header) = forward_headers.first() {
        format!("-H '{}: {}'", header.name, header.value)
    } else {
        "-H 'Authorization: Bearer <token>'".to_string()
    }
}

fn file_receiver_status_label(status: &FileReceiverStatus) -> &'static str {
    match status {
        FileReceiverStatus::Stopped => "stopped",
        FileReceiverStatus::Starting => "starting",
        FileReceiverStatus::Running => "running",
        FileReceiverStatus::PortConflict => "port_conflict",
        FileReceiverStatus::Error => "error",
    }
}

pub fn resolve_project(
    state: &McpRuntimeState,
    project_id: Option<&str>,
) -> Result<String, McpToolError> {
    let known_projects = known_project_paths(state);
    let known_ids = known_projects
        .iter()
        .map(|path| project_public_id(path))
        .collect::<Vec<_>>();

    if let Some(override_id) = project_id.and_then(non_empty_trimmed) {
        for path in &known_projects {
            if project_public_id(path) == override_id {
                return Ok(path.clone());
            }
        }
        return Err(McpToolError::invalid_project(override_id, &known_ids));
    }

    if let Some(current) = state.current_project.as_deref().and_then(non_empty_trimmed) {
        return Ok(normalize_project_path(current));
    }

    Err(McpToolError::no_project())
}

fn resolve_retrieval_project(
    state: &McpRuntimeState,
    project_id: Option<&str>,
) -> Result<(String, String), McpToolError> {
    let project_path = resolve_project(state, project_id)?;
    ensure_valid_wiki_project(&project_path)?;
    let project_id = project_public_id(&project_path);
    Ok((project_id, project_path))
}

fn new_retrieval_request_id() -> String {
    format!("mcp-retrieval-{}", uuid::Uuid::new_v4())
}

fn renderer_fallback_warning() -> String {
    "Renderer retrieval is unavailable; fell back to embedded keyword retrieval.".to_string()
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
        project_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<McpSearchResponse, McpToolError> {
        let project_path = resolve_project(state, project_id)?;
        ensure_valid_wiki_project(&project_path)?;
        let project_id = project_public_id(&project_path);

        let search_limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT).clamp(1, 20);
        let results = keyword_search(&project_path, query, search_limit)?;

        Ok(McpSearchResponse {
            project_id,
            query: query.to_string(),
            warning: None,
            results,
        })
    }

    pub fn llm_wiki_read_page(
        &self,
        state: &McpRuntimeState,
        path_or_id: &str,
        project_id: Option<&str>,
        start_offset: Option<usize>,
        max_chars: Option<usize>,
    ) -> Result<McpReadPageResponse, McpToolError> {
        let project_path = resolve_project(state, project_id)?;
        ensure_valid_wiki_project(&project_path)?;
        let project_id = project_public_id(&project_path);

        let document = read_wiki_page(&project_path, path_or_id)?;
        let mut page = paginate_wiki_page(document, start_offset, max_chars)?;
        page.resources = collect_mcp_page_resources(
            &project_id,
            &page.title,
            &page.relative_path,
            &page.content,
        );

        Ok(McpReadPageResponse { project_id, page })
    }

    pub fn llm_wiki_get_upload_guide(
        &self,
        state: &McpRuntimeState,
        upload_state: &FileReceiverRuntimeState,
        request_parts: Option<&Parts>,
    ) -> McpUploadGuideResponse {
        let resolved_endpoint = resolve_upload_endpoint(upload_state, request_parts);
        let forward_headers = upload_forward_headers(request_parts);
        let current_project_id = state
            .current_project
            .as_deref()
            .and_then(non_empty_trimmed)
            .map(normalize_project_path)
            .map(|path| project_public_id(&path));
        let default_endpoint = format!(
            "http://{}:{}{}",
            format_url_host(&upload_state.host),
            upload_state.port,
            UPLOADS_ENDPOINT_PATH
        );
        let curl_example = format!(
            "curl -X POST {} \\\n  {} \\\n  -F 'projectId={}' \\\n  -F 'fileName=source.pdf' \\\n  -F 'mimeType=application/pdf' \\\n  -F 'folderContext=docs/reference' \\\n  -F 'file=@/absolute/path/to/source.pdf'",
            resolved_endpoint.url,
            upload_auth_header_line(&forward_headers),
            current_project_id.as_deref().unwrap_or("<project-id>")
        );

        McpUploadGuideResponse {
            upload_mode: "uploads_only".to_string(),
            summary: "Import sources by sending multipart/form-data to the shared /uploads endpoint, then monitor processing with ingest queue tools.".to_string(),
            current_project_id,
            service_status: file_receiver_status_label(&upload_state.status).to_string(),
            endpoint_path: UPLOADS_ENDPOINT_PATH.to_string(),
            default_endpoint,
            resolved_endpoint: resolved_endpoint.url,
            upload_host: resolved_endpoint.host,
            upload_port: resolved_endpoint.port,
            scheme: resolved_endpoint.scheme,
            authorization_scheme: "Bearer".to_string(),
            header_auth_name: UPLOAD_TOKEN_HEADER_DISPLAY_NAME.to_string(),
            forward_headers,
            required_fields: vec!["projectId".to_string(), "file".to_string()],
            optional_fields: vec![
                "fileName".to_string(),
                "mimeType".to_string(),
                "folderContext".to_string(),
            ],
            list_uploads_path: UPLOADS_ENDPOINT_PATH.to_string(),
            get_upload_path_template: UPLOADS_ITEM_PATH_TEMPLATE.to_string(),
            curl_example,
            notes: vec![
                "resolvedEndpoint is inferred from the current MCP request and points at the externally reachable upload endpoint.".to_string(),
                "Use currentProjectId or a project id from llm_wiki_list_projects as projectId.".to_string(),
                "Metadata fields must be sent before the file part in the multipart payload.".to_string(),
                "Use ingest queue tools to monitor downstream processing after upload.".to_string(),
            ],
        }
    }

    pub fn llm_wiki_get_ingest_task(
        &self,
        state: &McpRuntimeState,
        task_id: &str,
        project_id: Option<&str>,
    ) -> Result<McpGetIngestTaskResponse, McpToolError> {
        let project_path = resolve_project(state, project_id)?;
        ensure_valid_wiki_project(&project_path)?;
        let project_id = project_public_id(&project_path);

        let trimmed_task_id = non_empty_trimmed(task_id)
            .ok_or_else(|| McpToolError::invalid_input("task_id must not be empty"))?;
        let queue_values = read_ingest_queue_values(&project_path)?;
        let queue = normalized_ingest_tasks_from_values(&project_path, &queue_values);
        let task = queue.into_iter().find(|entry| entry.id == trimmed_task_id);

        Ok(McpGetIngestTaskResponse {
            project_id,
            task_id: trimmed_task_id.to_string(),
            found: task.is_some(),
            task,
            status_hint: INGEST_STATUS_HINT.to_string(),
            recommended_poll_interval_seconds: DEFAULT_INGEST_POLL_INTERVAL_SECONDS,
        })
    }

    pub fn llm_wiki_get_ingest_queue(
        &self,
        state: &McpRuntimeState,
        project_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<McpGetIngestQueueResponse, McpToolError> {
        let project_path = resolve_project(state, project_id)?;
        ensure_valid_wiki_project(&project_path)?;
        let project_id = project_public_id(&project_path);

        let queue_values = read_ingest_queue_values(&project_path)?;
        let queue = normalized_ingest_tasks_from_values(&project_path, &queue_values);
        let summary = summarize_ingest_queue(&queue);
        let limit = limit.unwrap_or(50).clamp(1, 500);
        let recent_tasks = recent_ingest_tasks(&queue, limit);
        let current_task = current_ingest_task(&queue);

        Ok(McpGetIngestQueueResponse {
            project_id,
            summary,
            recent_tasks: recent_tasks.clone(),
            current_task,
            limit,
            queue: recent_tasks,
            status_hint: INGEST_STATUS_HINT.to_string(),
            recommended_poll_interval_seconds: DEFAULT_INGEST_POLL_INTERVAL_SECONDS,
        })
    }
}

fn tool_error_result(error: McpToolError) -> CallToolResult {
    CallToolResult::structured_error(json!(error))
}

fn ensure_valid_wiki_project(project_path: &str) -> Result<(), McpToolError> {
    let normalized = normalize_project_path(project_path);
    if is_valid_wiki_project_path(Path::new(&normalized)) {
        Ok(())
    } else {
        Err(McpToolError::invalid_input(
            "Current project is not a valid LLM Wiki project.",
        ))
    }
}

fn ingest_queue_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(INGEST_QUEUE_RELATIVE_PATH)
}

fn read_ingest_queue_values(project_path: &str) -> Result<Vec<Value>, McpToolError> {
    let queue_path = ingest_queue_path(project_path);
    if !queue_path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&queue_path).map_err(|err| {
        McpToolError::internal(format!(
            "Failed to read ingest queue '{}': {}",
            INGEST_QUEUE_RELATIVE_PATH, err
        ))
    })?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed: Value = serde_json::from_str(&raw).map_err(|err| {
        McpToolError::queue_format(format!(
            "Invalid ingest queue JSON '{}': {}",
            INGEST_QUEUE_RELATIVE_PATH, err
        ))
    })?;
    let values = parsed.as_array().ok_or_else(|| {
        McpToolError::queue_format(format!(
            "Invalid ingest queue JSON '{}': expected an array",
            INGEST_QUEUE_RELATIVE_PATH
        ))
    })?;

    Ok(values.clone())
}

fn normalized_ingest_tasks_from_values(project_path: &str, values: &[Value]) -> Vec<McpIngestTask> {
    values
        .iter()
        .filter_map(|value| normalize_ingest_task(project_path, value))
        .collect()
}

fn normalize_ingest_task(project_path: &str, raw: &Value) -> Option<McpIngestTask> {
    let source_path = raw.get("sourcePath")?.as_str()?.trim().to_string();
    if source_path.is_empty() {
        return None;
    }
    let source_name = public_path_basename(&source_path);

    let status = raw
        .get("status")
        .and_then(Value::as_str)
        .map(normalize_ingest_status)
        .unwrap_or_else(|| "pending".to_string());

    let id = raw
        .get("id")
        .and_then(Value::as_str)
        .and_then(non_empty_trimmed)
        .map(ToOwned::to_owned)
        .unwrap_or_else(generate_ingest_task_id);

    let folder_context = raw
        .get("folderContext")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let error = match raw.get("error") {
        Some(Value::String(message)) => Some(redact_ingest_task_error(
            message,
            project_path,
            &source_path,
        )),
        _ => None,
    };

    let files_written = raw.get("filesWritten").and_then(|value| {
        let items = value
            .as_array()?
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()?;
        Some(
            items
                .into_iter()
                .map(|item| sanitize_public_task_path(project_path, item))
                .collect::<Vec<_>>(),
        )
    });

    Some(McpIngestTask {
        id,
        source_name,
        folder_context,
        status,
        added_at: raw
            .get("addedAt")
            .and_then(Value::as_u64)
            .unwrap_or_else(now_millis),
        error,
        retry_count: raw.get("retryCount").and_then(Value::as_u64).unwrap_or(0),
        origin: raw
            .get("origin")
            .and_then(Value::as_str)
            .and_then(non_empty_trimmed)
            .map(ToOwned::to_owned),
        mime_type: raw
            .get("mimeType")
            .and_then(Value::as_str)
            .and_then(non_empty_trimmed)
            .map(ToOwned::to_owned),
        started_at: raw.get("startedAt").and_then(Value::as_u64),
        finished_at: raw.get("finishedAt").and_then(Value::as_u64),
        files_written,
        review_item_count: raw.get("reviewItemCount").and_then(Value::as_u64),
        cache_hit: raw.get("cacheHit").and_then(Value::as_bool),
    })
}

fn redact_ingest_task_error(message: &str, project_path: &str, source_path: &str) -> String {
    let mut redacted = redact_project_path_text(message, project_path);
    let normalized_source = source_path.trim().replace('\\', "/");
    if is_absolute_like_path(&normalized_source) {
        redacted = redacted.replace(&normalized_source, "<source>");
    }
    redacted
}

fn sanitize_public_task_path(project_path: &str, value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return normalized;
    }
    if let Some(relative) = strip_project_path_prefix(project_path, &normalized) {
        return relative;
    }
    if is_absolute_like_path(&normalized) {
        return public_path_basename(&normalized);
    }
    normalized
}

fn strip_project_path_prefix(project_path: &str, value: &str) -> Option<String> {
    let candidates = [
        normalize_project_path(project_path),
        project_path.trim().replace('\\', "/"),
    ];
    for candidate in candidates {
        let root = candidate.trim_end_matches('/');
        if root.is_empty() {
            continue;
        }
        if value == root {
            return Some(String::new());
        }
        if let Some(relative) = value.strip_prefix(&format!("{}/", root)) {
            return Some(relative.to_string());
        }
    }
    None
}

fn is_absolute_like_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'/')
}

fn public_path_basename(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("source")
        .to_string()
}

fn normalize_ingest_status(status: &str) -> String {
    match status {
        "pending" | "processing" | "done" | "failed" => status.to_string(),
        _ => "pending".to_string(),
    }
}

fn summarize_ingest_queue(queue: &[McpIngestTask]) -> McpIngestQueueSummary {
    let visible = queue
        .iter()
        .filter(|task| task.status != "done")
        .collect::<Vec<_>>();

    let pending = visible
        .iter()
        .filter(|task| task.status == "pending")
        .count();
    let processing = visible
        .iter()
        .filter(|task| task.status == "processing")
        .count();
    let failed = visible
        .iter()
        .filter(|task| task.status == "failed")
        .count();
    let done = queue.iter().filter(|task| task.status == "done").count();
    let active = pending + processing;
    let records_total = queue.len();
    let total = visible.len();

    McpIngestQueueSummary {
        pending,
        processing,
        failed,
        done,
        active,
        history: done + failed,
        records_total,
        total,
    }
}

fn recent_ingest_tasks(queue: &[McpIngestTask], limit: usize) -> Vec<McpIngestTask> {
    let mut indexed = queue
        .iter()
        .cloned()
        .enumerate()
        .collect::<Vec<(usize, McpIngestTask)>>();
    indexed.sort_by(|(left_idx, left), (right_idx, right)| {
        right
            .added_at
            .cmp(&left.added_at)
            .then_with(|| right_idx.cmp(left_idx))
    });
    indexed
        .into_iter()
        .take(limit)
        .map(|(_, task)| task)
        .collect()
}

fn current_ingest_task(queue: &[McpIngestTask]) -> Option<McpIngestTask> {
    queue
        .iter()
        .find(|task| task.status == "processing")
        .cloned()
        .or_else(|| queue.iter().find(|task| task.status == "pending").cloned())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_ingest_task_id() -> String {
    format!(
        "ingest-{}-{:x}",
        now_millis(),
        INGEST_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
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
        message: redact_project_path_text(&err, project_path),
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct WikiPageDocument {
    exists: bool,
    title: String,
    relative_path: String,
    content: String,
}

fn read_wiki_page(project_path: &str, path_or_id: &str) -> Result<WikiPageDocument, McpToolError> {
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
            let relative_path = candidate
                .strip_prefix(&wiki_root)
                .unwrap_or(&candidate)
                .to_string_lossy()
                .replace('\\', "/");
            let content = fs::read_to_string(&candidate).map_err(|err| McpToolError {
                code: McpToolErrorCode::InvalidProject,
                message: format!("Failed reading page '{}': {}", relative_path, err),
            })?;
            let title = extract_title(
                &content,
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(path_or_id),
            );
            return Ok(WikiPageDocument {
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
        message: redact_project_path_text(&err, project_path),
    })?;
    for file_path in files {
        let file_id = file_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if file_id != bare_id {
            continue;
        }
        let relative_path = file_path
            .strip_prefix(&wiki_root)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .replace('\\', "/");
        let content = fs::read_to_string(&file_path).map_err(|err| McpToolError {
            code: McpToolErrorCode::InvalidProject,
            message: format!("Failed reading page '{}': {}", relative_path, err),
        })?;
        let title = extract_title(
            &content,
            file_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(path_or_id),
        );
        return Ok(WikiPageDocument {
            exists: true,
            title,
            relative_path,
            content,
        });
    }

    Ok(WikiPageDocument {
        exists: false,
        title: path_or_id.to_string(),
        relative_path: normalized,
        content: String::new(),
    })
}

fn paginate_wiki_page(
    page: WikiPageDocument,
    start_offset: Option<usize>,
    max_chars: Option<usize>,
) -> Result<McpPage, McpToolError> {
    if matches!(max_chars, Some(0)) {
        return Err(McpToolError::invalid_input(
            "max_chars must be greater than 0 when provided",
        ));
    }

    let total_chars = page.content.chars().count();
    let start_offset = start_offset.unwrap_or(0).min(total_chars);
    let end_offset = match max_chars {
        Some(limit) => start_offset.saturating_add(limit).min(total_chars),
        None => total_chars,
    };

    Ok(McpPage {
        exists: page.exists,
        title: page.title,
        relative_path: page.relative_path,
        total_chars,
        start_offset,
        end_offset,
        content: slice_chars(&page.content, start_offset, end_offset),
        has_more_before: start_offset > 0,
        has_more_after: end_offset < total_chars,
        next_start_offset: (end_offset < total_chars).then_some(end_offset),
        resources: Vec::new(),
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

fn collect_mcp_page_resources(
    project_id: &str,
    page_title: &str,
    relative_path: &str,
    content: &str,
) -> Vec<McpPageResource> {
    let mut seen = std::collections::BTreeSet::new();
    extract_page_resource_refs(content)
        .into_iter()
        .filter(|resource| seen.insert((resource.raw_ref.clone(), resource.syntax.clone())))
        .enumerate()
        .map(|(index, resource)| McpPageResource {
            id: index + 1,
            kind: "image".to_string(),
            raw_ref: resource.raw_ref.clone(),
            url: resolve_mcp_page_image_url(project_id, &resource.raw_ref),
            source_path: format!("wiki/{}", relative_path),
            title: resource
                .alt
                .as_deref()
                .map(|alt| extract_mcp_page_image_title(alt, page_title, index)),
            alt: resource.alt,
            syntax: resource.syntax,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct McpPageResourceRef {
    raw_ref: String,
    alt: Option<String>,
    syntax: String,
}

fn extract_page_resource_refs(content: &str) -> Vec<McpPageResourceRef> {
    let mut out = Vec::new();
    out.extend(
        extract_markdown_images(content)
            .into_iter()
            .map(|(raw_ref, alt)| McpPageResourceRef {
                raw_ref,
                alt: Some(alt),
                syntax: "markdown_image".to_string(),
            }),
    );
    out.extend(
        extract_visual_group_image_refs(content)
            .into_iter()
            .map(|raw_ref| McpPageResourceRef {
                raw_ref,
                alt: None,
                syntax: "visual_group_image_field".to_string(),
            }),
    );
    out
}

fn extract_markdown_images(content: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("![") {
        let after_bang = &rest[start + 2..];
        let Some(alt_end) = after_bang.find(']') else {
            break;
        };
        let alt = after_bang[..alt_end].trim().to_string();
        let after_alt = &after_bang[alt_end + 1..];
        if !after_alt.starts_with('(') {
            rest = after_alt;
            continue;
        }
        let Some(url_end) = after_alt[1..].find(')') else {
            break;
        };
        let url = after_alt[1..1 + url_end].trim().to_string();
        if !url.is_empty() {
            out.push((url, alt));
        }
        rest = &after_alt[1 + url_end + 1..];
    }
    out
}

fn extract_visual_group_image_refs(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_visual_group = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```llm-wiki-visual-group") {
            in_visual_group = true;
            continue;
        }
        if in_visual_group && trimmed == "```" {
            in_visual_group = false;
            continue;
        }
        if !in_visual_group {
            continue;
        }
        let Some(raw_ref) = trimmed.strip_prefix("image:") else {
            continue;
        };
        let raw_ref = raw_ref.trim();
        if !raw_ref.is_empty() {
            out.push(raw_ref.to_string());
        }
    }
    out
}

fn extract_mcp_page_image_title(alt: &str, page_title: &str, index: usize) -> String {
    let normalized = alt.replace(['\r', '\n'], " ").trim().to_string();
    if normalized.is_empty() {
        return format!("Image {} from {}", index + 1, page_title);
    }
    let sentence_end = normalized
        .find(['。', '！', '？'])
        .or_else(|| normalized.find(". "))
        .or_else(|| normalized.find("! "))
        .or_else(|| normalized.find("? "));
    let title = sentence_end
        .map(|end| normalized[..end].trim().to_string())
        .unwrap_or(normalized);
    title.chars().take(80).collect()
}

fn resolve_mcp_page_image_url(project_id: &str, raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("data:")
    {
        return trimmed.to_string();
    }
    build_clip_server_image_url(project_id, trimmed)
}

fn build_clip_server_image_url(project_id: &str, raw_url: &str) -> String {
    let encoded_project_id = percent_encode_path_segment(project_id);
    let encoded_path = raw_url
        .trim_start_matches("./")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| percent_encode_path_segment(&decode_percent_component(segment)))
        .collect::<Vec<_>>()
        .join("/");
    format!(
        "http://127.0.0.1:19827/wiki-media/{}/{}",
        encoded_project_id, encoded_path
    )
}

fn percent_encode_path_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", byte));
        }
    }
    out
}

fn decode_percent_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = match std::str::from_utf8(&bytes[index + 1..index + 3]) {
                    Ok(hex) => hex,
                    Err(_) => return value.to_string(),
                };
                let byte = match u8::from_str_radix(hex, 16) {
                    Ok(byte) => byte,
                    Err(_) => return value.to_string(),
                };
                out.push(byte);
                index += 3;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8(out).unwrap_or_else(|_| value.to_string())
}

fn tokenize_query(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();

    for token in query.split(|ch: char| !ch.is_alphanumeric()) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        add_query_token(&mut tokens, &token.to_lowercase());
    }

    tokens
}

fn add_query_token(tokens: &mut Vec<String>, token: &str) {
    if token.chars().any(is_cjk_char) {
        add_cjk_query_tokens(tokens, token);
    } else {
        push_unique_token(tokens, token.to_string());
    }
}

fn add_cjk_query_tokens(tokens: &mut Vec<String>, token: &str) {
    let chars = token.chars().collect::<Vec<_>>();
    if chars.len() <= 1 {
        push_unique_token(tokens, token.to_string());
        return;
    }

    let max_window = chars.len().min(8);
    for window_size in (2..=max_window).rev() {
        for window in chars.windows(window_size) {
            push_unique_token(tokens, window.iter().collect());
        }
    }
}

fn push_unique_token(tokens: &mut Vec<String>, token: String) {
    if !tokens.iter().any(|existing| existing == &token) {
        tokens.push(token);
    }
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{20000}'..='\u{2A6DF}'
            | '\u{2A700}'..='\u{2B73F}'
            | '\u{2B740}'..='\u{2B81F}'
            | '\u{2B820}'..='\u{2CEAF}'
    )
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

fn slice_chars(content: &str, start_offset: usize, end_offset: usize) -> String {
    if start_offset >= end_offset {
        return String::new();
    }

    content
        .chars()
        .skip(start_offset)
        .take(end_offset - start_offset)
        .collect()
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
        id: project_public_id(path),
    }
}

fn project_public_id(path: &str) -> String {
    let normalized = fs::canonicalize(path)
        .map(|resolved| resolved.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| normalize_project_path(path));
    format!("wiki-{:016x}", stable_hash_hex(&normalized))
}

fn redact_project_path_text(message: &str, project_path: &str) -> String {
    let raw_project = project_path.trim().replace('\\', "/");
    let normalized_project = normalize_project_path(project_path);
    let mut normalized_message = message.replace('\\', "/");
    for candidate in [&normalized_project, &raw_project] {
        if !candidate.is_empty() {
            normalized_message = normalized_message.replace(candidate, "<project>");
        }
    }
    normalized_message
}

fn stable_hash_hex(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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

#[tauri::command]
pub fn mcp_complete_retrieval(
    completion: McpRendererRetrievalCompletion,
    manager: State<'_, McpRuntimeManager>,
) -> Result<(), String> {
    manager.complete_retrieval(completion)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::file_receiver_server::FileReceiverConfig;
    use rmcp::{
        model::CallToolRequestParams, transport::StreamableHttpClientTransport, ServiceExt,
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
            let path =
                std::env::temp_dir().join(format!("llm-wiki-embedded-mcp-{}-{}", name, unique));

            fs::create_dir_all(path.join("wiki/entities"))
                .expect("test wiki dir should be created");
            fs::write(path.join("schema.md"), "# Schema\n").expect("schema should be written");
            fs::write(
                path.join("purpose.md"),
                "# Purpose\nAnswer questions about OpenAI.\n",
            )
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

        fn write_page(&self, relative_path: &str, content: &str) {
            let full_path = self.path.join("wiki").join(relative_path);
            fs::create_dir_all(
                full_path
                    .parent()
                    .expect("page path should have parent directory"),
            )
            .expect("page directory should be created");
            fs::write(full_path, content).expect("page should be written");
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
        assert!(resolve_project(&state, Some("wiki-missing")).is_err());
    }

    #[test]
    fn rejects_out_of_range_port() {
        assert!(validate_port(0).is_err());
    }

    #[test]
    fn embedded_server_registers_expected_tools() {
        fn assert_server_handler<T: ServerHandler>(_: &T) {}

        let manager = McpRuntimeManager::default();
        let server = EmbeddedMcpServer::new(manager.shared(), manager.file_receiver.clone());
        assert_server_handler(&server);

        let tools = server.tool_router.list_all();
        let mut names = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            vec![
                "llm_wiki_get_ingest_queue",
                "llm_wiki_get_ingest_task",
                "llm_wiki_get_upload_guide",
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
        manager
            .start()
            .expect("start should succeed with a valid project");

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

    #[test]
    fn upload_runtime_cannot_start_when_mcp_is_disabled() {
        let uploads = FileReceiverRuntimeManager::default();
        uploads
            .update_config(FileReceiverConfig {
                enabled: true,
                auto_start: true,
                static_token: "secret".to_string(),
                max_file_size_bytes: 1024 * 1024,
                upload_ttl_hours: 24,
            })
            .expect("upload config should apply");
        let manager = McpRuntimeManager::with_file_receiver(uploads.clone());

        manager
            .update_config(McpConfig {
                enabled: false,
                auto_start: true,
                host: "127.0.0.1".to_string(),
                port: available_port(),
            })
            .expect("mcp config update should succeed");

        assert_eq!(manager.snapshot().status, McpStatus::Stopped);
        assert_eq!(uploads.snapshot().status, FileReceiverStatus::Stopped);
    }

    #[test]
    fn manual_mcp_start_marks_upload_runtime_running_even_with_legacy_auto_start_disabled() {
        let project = TempWikiProject::new("manual-mcp-upload");
        let uploads = FileReceiverRuntimeManager::default();
        uploads
            .update_config(FileReceiverConfig {
                enabled: true,
                auto_start: false,
                static_token: "secret".to_string(),
                max_file_size_bytes: 1024 * 1024,
                upload_ttl_hours: 24,
            })
            .expect("upload config should apply");
        let manager = McpRuntimeManager::with_file_receiver(uploads.clone());
        manager.update_known_projects(vec![project.path_string()]);
        manager
            .update_project(Some(project.path_string()))
            .expect("project should update");
        manager
            .update_config(McpConfig {
                enabled: true,
                auto_start: false,
                host: "127.0.0.1".to_string(),
                port: available_port(),
            })
            .expect("mcp config update should succeed");

        manager.start().expect("manual MCP start should succeed");

        assert_eq!(manager.snapshot().status, McpStatus::Running);
        assert_eq!(uploads.snapshot().status, FileReceiverStatus::Running);
    }

    #[test]
    fn upload_guide_explains_uploads_as_the_only_import_path() {
        let upload_state = FileReceiverRuntimeState {
            status: FileReceiverStatus::Running,
            host: "127.0.0.1".to_string(),
            port: 28766,
            ..FileReceiverRuntimeState::default()
        };
        let state = state_with_current_project("/tmp/wiki-a");
        let guide = EmbeddedMcpTools.llm_wiki_get_upload_guide(&state, &upload_state, None);

        assert_eq!(guide.upload_mode, "uploads_only");
        assert_eq!(guide.endpoint_path, "/uploads");
        assert_eq!(
            guide.current_project_id,
            Some(project_public_id("/tmp/wiki-a"))
        );
        assert_eq!(guide.service_status, "running");
        assert_eq!(guide.upload_port, 28766);
        assert_eq!(guide.upload_host, "127.0.0.1");
        assert_eq!(guide.scheme, "http");
        assert_eq!(guide.default_endpoint, "http://127.0.0.1:28766/uploads");
        assert_eq!(guide.resolved_endpoint, "http://127.0.0.1:28766/uploads");
        assert_eq!(guide.authorization_scheme, "Bearer");
        assert_eq!(guide.header_auth_name, "X-LLM-Wiki-Upload-Token");
        assert!(guide.forward_headers.is_empty());
        assert!(guide.summary.contains("multipart/form-data"));
        assert!(guide
            .notes
            .iter()
            .any(|note| note.contains("resolvedEndpoint is inferred")));
        assert!(guide.curl_example.contains("Authorization: Bearer <token>"));
        assert!(guide.curl_example.contains("-F 'projectId=wiki-"));
        assert!(guide
            .curl_example
            .contains("-F 'file=@/absolute/path/to/source.pdf'"));
        assert_eq!(guide.required_fields, vec!["projectId", "file"]);
        assert!(guide.optional_fields.contains(&"fileName".to_string()));
    }

    #[test]
    fn upload_guide_reuses_forwarded_host_and_proto() {
        let upload_state = FileReceiverRuntimeState {
            status: FileReceiverStatus::Running,
            host: "127.0.0.1".to_string(),
            port: 39001,
            ..FileReceiverRuntimeState::default()
        };

        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.headers.insert(
            "forwarded",
            "proto=https;host=wiki.example.com:18443"
                .parse()
                .expect("forwarded header should parse"),
        );
        parts.headers.insert(
            HOST,
            "127.0.0.1:18765".parse().expect("host header should parse"),
        );
        parts.headers.insert(
            UPLOAD_TOKEN_HEADER_NAME,
            "secret-token"
                .parse()
                .expect("custom token header should parse"),
        );

        let state = state_with_current_project("/tmp/wiki-a");
        let guide = EmbeddedMcpTools.llm_wiki_get_upload_guide(&state, &upload_state, Some(&parts));

        assert_eq!(guide.scheme, "https");
        assert_eq!(guide.upload_host, "wiki.example.com");
        assert_eq!(guide.upload_port, 18443);
        assert_eq!(guide.default_endpoint, "http://127.0.0.1:39001/uploads");
        assert_eq!(
            guide.forward_headers,
            vec![McpHttpHeader {
                name: "X-LLM-Wiki-Upload-Token".to_string(),
                value: "secret-token".to_string(),
            }]
        );
        assert_eq!(
            guide.resolved_endpoint,
            "https://wiki.example.com:18443/uploads"
        );
        assert!(guide
            .curl_example
            .contains("https://wiki.example.com:18443/uploads"));
        assert!(guide
            .curl_example
            .contains("X-LLM-Wiki-Upload-Token: secret-token"));
    }

    #[test]
    fn upload_guide_can_forward_bearer_authorization_header() {
        let upload_state = FileReceiverRuntimeState {
            status: FileReceiverStatus::Running,
            host: "127.0.0.1".to_string(),
            port: 39001,
            ..FileReceiverRuntimeState::default()
        };

        let (mut parts, _) = axum::http::Request::new(()).into_parts();
        parts.headers.insert(
            AUTHORIZATION,
            "Bearer secret-token"
                .parse()
                .expect("authorization header should parse"),
        );

        let state = state_with_current_project("/tmp/wiki-a");
        let guide = EmbeddedMcpTools.llm_wiki_get_upload_guide(&state, &upload_state, Some(&parts));

        assert_eq!(
            guide.forward_headers,
            vec![McpHttpHeader {
                name: "Authorization".to_string(),
                value: "Bearer secret-token".to_string(),
            }]
        );
        assert!(guide
            .curl_example
            .contains("Authorization: Bearer secret-token"));
    }

    #[test]
    fn ingest_queue_and_task_queries_return_structured_shapes() {
        let project = TempWikiProject::new("ingest-queries");
        let project_path = project.path_string();
        let state = state_with_current_project(&project_path);

        let queue_path = Path::new(&project_path).join(INGEST_QUEUE_RELATIVE_PATH);
        fs::create_dir_all(
            queue_path
                .parent()
                .expect("queue path should have parent directory"),
        )
        .expect("queue dir should be created");
        let mut queue_values: Vec<Value> = vec![json!({
            "id": "task-pending-1",
            "sourcePath": "raw/sources/Inbox/notes.txt",
            "folderContext": "Inbox",
            "status": "pending",
            "addedAt": 1000_u64,
            "error": null,
            "retryCount": 0,
            "origin": "upload_service",
            "mimeType": "text/plain"
        })];
        queue_values.push(json!({
            "id": "task-done-1",
            "sourcePath": "raw/sources/done.md",
            "folderContext": "",
            "status": "done",
            "addedAt": 2000_u64,
            "error": null,
            "retryCount": 0,
            "origin": "desktop",
            "mimeType": "text/markdown",
            "startedAt": 2010_u64,
            "finishedAt": 2020_u64,
            "filesWritten": ["wiki/entities/done.md"],
            "reviewItemCount": 2,
            "cacheHit": true
        }));
        queue_values.push(json!({
            "id": "task-processing-1",
            "sourcePath": "raw/sources/processing.md",
            "folderContext": "Ops",
            "status": "processing",
            "addedAt": 3000_u64,
            "error": null,
            "retryCount": 0,
            "origin": "mcp"
        }));
        fs::write(
            &queue_path,
            serde_json::to_string_pretty(&queue_values).expect("queue json should serialize"),
        )
        .expect("queue file should be written");

        let queue_response = EmbeddedMcpTools
            .llm_wiki_get_ingest_queue(&state, None, Some(2))
            .expect("queue query should succeed");
        assert_eq!(queue_response.project_id, project_public_id(&project_path));
        assert_eq!(queue_response.summary.records_total, 3);
        assert_eq!(queue_response.summary.pending, 1);
        assert_eq!(queue_response.summary.processing, 1);
        assert_eq!(queue_response.summary.done, 1);
        assert_eq!(queue_response.summary.total, 2);
        assert_eq!(queue_response.summary.history, 1);
        assert_eq!(queue_response.limit, 2);
        assert_eq!(queue_response.recent_tasks.len(), 2);
        assert_eq!(queue_response.queue.len(), 2);
        assert_eq!(queue_response.recommended_poll_interval_seconds, 60);
        assert!(queue_response.status_hint.contains("check again later"));
        assert_eq!(queue_response.recent_tasks[0].id, "task-processing-1");
        assert_eq!(queue_response.recent_tasks[1].id, "task-done-1");
        assert_eq!(queue_response.recent_tasks[1].source_name, "done.md");
        assert_eq!(
            queue_response
                .current_task
                .as_ref()
                .map(|task| task.id.as_str()),
            Some("task-processing-1")
        );

        let done_task = queue_response
            .recent_tasks
            .iter()
            .find(|task| task.id == "task-done-1")
            .expect("done task should be present");
        let done_task_value =
            serde_json::to_value(done_task).expect("done task should serialize to json");
        assert!(done_task_value.get("sourcePath").is_none());
        assert_eq!(done_task_value["sourceName"], "done.md");
        assert_eq!(done_task.status, "done");
        assert_eq!(
            done_task.files_written,
            Some(vec!["wiki/entities/done.md".to_string()])
        );
        assert_eq!(done_task.review_item_count, Some(2));
        assert_eq!(done_task.cache_hit, Some(true));

        let task_response = EmbeddedMcpTools
            .llm_wiki_get_ingest_task(&state, "task-pending-1", None)
            .expect("task query should succeed");
        assert!(task_response.found);
        assert!(task_response.task.is_some());
        assert_eq!(
            task_response
                .task
                .as_ref()
                .expect("task should exist")
                .status,
            "pending"
        );
        assert_eq!(task_response.recommended_poll_interval_seconds, 60);
        assert!(task_response.status_hint.contains("processing"));

        let missing_task = EmbeddedMcpTools
            .llm_wiki_get_ingest_task(&state, "missing-task-id", None)
            .expect("missing task query should still succeed");
        assert!(!missing_task.found);
        assert!(missing_task.task.is_none());
        assert_eq!(missing_task.recommended_poll_interval_seconds, 60);
        assert!(missing_task.status_hint.contains("check again later"));
    }

    #[test]
    fn ingest_queue_task_responses_do_not_expose_local_paths() {
        let project = TempWikiProject::new("ingest-queue-local-paths");
        let project_path = project.path_string();
        let state = state_with_current_project(&project_path);
        let queue_path = Path::new(&project_path).join(INGEST_QUEUE_RELATIVE_PATH);
        let external_source = "/Users/alice/Documents/private.docx";

        fs::create_dir_all(
            queue_path
                .parent()
                .expect("queue path should have parent directory"),
        )
        .expect("queue dir should be created");
        fs::write(
            &queue_path,
            serde_json::to_string_pretty(&vec![json!({
                "id": "task-private",
                "sourcePath": external_source,
                "folderContext": "",
                "status": "failed",
                "addedAt": 1000_u64,
                "error": format!("Failed to read '{}': permission denied", external_source),
                "retryCount": 1,
                "origin": "upload_service",
                "filesWritten": [
                    format!("{}/wiki/entities/private.md", project_path),
                    "/Users/alice/Documents/leaked.md",
                    "wiki/entities/kept.md"
                ]
            })])
            .expect("queue json should serialize"),
        )
        .expect("queue file should be written");

        let response = EmbeddedMcpTools
            .llm_wiki_get_ingest_task(&state, "task-private", None)
            .expect("task query should succeed");
        let task = response.task.expect("task should be returned");
        let serialized = serde_json::to_string(&task).expect("task should serialize");

        assert_eq!(task.source_name, "private.docx");
        assert_eq!(
            task.files_written,
            Some(vec![
                "wiki/entities/private.md".to_string(),
                "leaked.md".to_string(),
                "wiki/entities/kept.md".to_string(),
            ])
        );
        assert!(task.error.as_deref().unwrap_or("").contains("<source>"));
        assert!(!serialized.contains("sourcePath"));
        assert!(!serialized.contains(&project_path));
        assert!(!serialized.contains("/Users/alice"));
    }

    #[test]
    fn ingest_queue_errors_do_not_expose_project_path() {
        let project = TempWikiProject::new("ingest-queue-error");
        let project_path = project.path_string();
        let state = state_with_current_project(&project_path);
        let queue_path = Path::new(&project_path).join(INGEST_QUEUE_RELATIVE_PATH);

        fs::create_dir_all(
            queue_path
                .parent()
                .expect("queue path should have parent directory"),
        )
        .expect("queue dir should be created");
        fs::write(&queue_path, "{not-json").expect("broken queue should be written");

        let err = EmbeddedMcpTools
            .llm_wiki_get_ingest_queue(&state, None, None)
            .expect_err("broken queue should surface an error");

        assert_eq!(err.code, McpToolErrorCode::QueueFormat);
        assert!(err.message.contains(INGEST_QUEUE_RELATIVE_PATH));
        assert!(!err.message.contains(&project_path));
    }

    #[test]
    fn invalid_current_project_errors_do_not_expose_project_path() {
        let path = "/tmp/not-a-valid-wiki-project";
        let state = state_with_current_project(path);

        let err = EmbeddedMcpTools
            .llm_wiki_search(&state, "OpenAI", None, None)
            .expect_err("invalid current project should fail");

        assert_eq!(err.code, McpToolErrorCode::InvalidInput);
        assert!(err
            .message
            .contains("Current project is not a valid LLM Wiki project."));
        assert!(!err.message.contains(path));
    }

    #[test]
    fn read_page_without_pagination_returns_full_page_content() {
        let project = TempWikiProject::new("read-page-full");
        let content = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        project.write_page("concepts/windowed.md", content);
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "concepts/windowed.md", None, None, None)
            .expect("full-page read should succeed");

        assert_eq!(response.page.relative_path, "concepts/windowed.md");
        assert_eq!(response.page.total_chars, content.chars().count());
        assert_eq!(response.page.start_offset, 0);
        assert_eq!(response.page.end_offset, content.chars().count());
        assert_eq!(response.page.content, content);
        assert!(!response.page.has_more_before);
        assert!(!response.page.has_more_after);
        assert_eq!(response.page.next_start_offset, None);
    }

    #[test]
    fn read_page_with_max_chars_returns_first_slice() {
        let project = TempWikiProject::new("read-page-first-slice");
        project.write_page(
            "concepts/windowed.md",
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        );
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "concepts/windowed.md", None, None, Some(10))
            .expect("windowed read should succeed");

        assert_eq!(response.page.content, "0123456789");
        assert_eq!(response.page.start_offset, 0);
        assert_eq!(response.page.end_offset, 10);
        assert!(!response.page.has_more_before);
        assert!(response.page.has_more_after);
        assert_eq!(response.page.next_start_offset, Some(10));
    }

    #[test]
    fn read_page_with_start_offset_and_max_chars_returns_mid_page_window() {
        let project = TempWikiProject::new("read-page-mid-window");
        project.write_page(
            "concepts/windowed.md",
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        );
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "concepts/windowed.md", None, Some(10), Some(8))
            .expect("mid-page window should succeed");

        assert_eq!(response.page.content, "ABCDEFGH");
        assert_eq!(response.page.start_offset, 10);
        assert_eq!(response.page.end_offset, 18);
        assert!(response.page.has_more_before);
        assert!(response.page.has_more_after);
        assert_eq!(response.page.next_start_offset, Some(18));
    }

    #[test]
    fn read_page_with_start_offset_and_no_limit_reads_to_eof() {
        let project = TempWikiProject::new("read-page-tail");
        project.write_page(
            "concepts/windowed.md",
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        );
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "concepts/windowed.md", None, Some(30), None)
            .expect("tail read should succeed");

        assert_eq!(response.page.content, "UVWXYZ");
        assert_eq!(response.page.start_offset, 30);
        assert_eq!(response.page.end_offset, 36);
        assert!(response.page.has_more_before);
        assert!(!response.page.has_more_after);
        assert_eq!(response.page.next_start_offset, None);
    }

    #[test]
    fn read_page_continuation_metadata_handles_eof_boundary() {
        let project = TempWikiProject::new("read-page-boundary");
        project.write_page(
            "concepts/windowed.md",
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        );
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "concepts/windowed.md", None, Some(36), Some(6))
            .expect("boundary read should succeed");

        assert_eq!(response.page.content, "");
        assert_eq!(response.page.start_offset, 36);
        assert_eq!(response.page.end_offset, 36);
        assert!(response.page.has_more_before);
        assert!(!response.page.has_more_after);
        assert_eq!(response.page.next_start_offset, None);
    }

    #[test]
    fn search_results_relative_path_chains_into_read_page() {
        let project = TempWikiProject::new("search-read-chain");
        let content = "Chainable search result content.";
        project.write_page("concepts/search-chain.md", content);
        let state = state_with_current_project(&project.path_string());

        let search = EmbeddedMcpTools
            .llm_wiki_search(&state, "Chainable search result content", None, Some(5))
            .expect("search should succeed");
        let first_hit = search
            .results
            .first()
            .expect("search should return one hit");

        assert_eq!(first_hit.relative_path, "concepts/search-chain.md");

        let read = EmbeddedMcpTools
            .llm_wiki_read_page(&state, &first_hit.relative_path, None, None, None)
            .expect("read_page should accept llm_wiki_search.relative_path");

        assert!(read.page.exists);
        assert_eq!(read.page.relative_path, first_hit.relative_path);
        assert_eq!(read.page.content, content);
    }

    #[test]
    fn read_page_exposes_resource_urls_for_returned_content_window() {
        let project = TempWikiProject::new("read-page-resources");
        let media_dir = project.path.join("wiki/media/project-plan");
        fs::create_dir_all(&media_dir).expect("media dir should be created");
        fs::write(media_dir.join("img-2.png"), b"png").expect("image should be written");
        fs::write(media_dir.join("icon-1.png"), b"png").expect("icon should be written");
        project.write_page(
            "sources/project-plan.md",
            r#"---
title: Project Plan
---

# Project Plan

![图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。](media/project-plan/img-2.png)

## UI Visual Elements

```llm-wiki-visual-group
id: status-icons
source: project-plan.docx
heading-path: 21区 > 设备状态
title: 设备状态图标
summary: 设备状态的小图标。
table-context: 状态说明表
item:
  image: media/project-plan/icon-1.png
  description: 故障状态图标
  row-text: 故障
  cell-text: 故障
  header-text: 状态
```
"#,
        );
        let state = state_with_current_project(&project.path_string());

        let response = EmbeddedMcpTools
            .llm_wiki_read_page(&state, "sources/project-plan.md", None, None, None)
            .expect("read_page should succeed");
        let serialized = serde_json::to_value(&response).expect("response should serialize");

        assert_eq!(serialized["page"]["resources"][0]["id"], 1);
        assert_eq!(serialized["page"]["resources"][0]["kind"], "image");
        assert_eq!(
            serialized["page"]["resources"][0]["rawRef"],
            "media/project-plan/img-2.png"
        );
        assert_eq!(
            serialized["page"]["resources"][0]["title"],
            "图 3.2-5 无人机采集作业流程图"
        );
        assert_eq!(
            serialized["page"]["resources"][0]["syntax"],
            "markdown_image"
        );
        assert_eq!(
            serialized["page"]["resources"][0]["url"],
            format!(
                "http://127.0.0.1:19827/wiki-media/{}/media/project-plan/img-2.png",
                project_public_id(&project.path_string())
            )
        );
        assert_eq!(
            serialized["page"]["resources"][0]["sourcePath"],
            "wiki/sources/project-plan.md"
        );
        assert_eq!(serialized["page"]["resources"][1]["id"], 2);
        assert_eq!(
            serialized["page"]["resources"][1]["rawRef"],
            "media/project-plan/icon-1.png"
        );
        assert_eq!(
            serialized["page"]["resources"][1]["syntax"],
            "visual_group_image_field"
        );
        assert_eq!(
            serialized["page"]["resources"][1]["url"],
            format!(
                "http://127.0.0.1:19827/wiki-media/{}/media/project-plan/icon-1.png",
                project_public_id(&project.path_string())
            )
        );
    }

    #[test]
    fn project_public_id_canonicalizes_dot_segments() {
        let project = TempWikiProject::new("project-id-canonical");
        let dotted_path = format!("{}/.", project.path_string());

        assert_eq!(
            project_public_id(&dotted_path),
            project_public_id(&project.path_string())
        );
    }

    #[test]
    fn background_failure_marks_file_receiver_error_when_shared_listener_dies() {
        let uploads = FileReceiverRuntimeManager::default();
        uploads
            .update_config(FileReceiverConfig {
                enabled: true,
                auto_start: true,
                static_token: "secret".to_string(),
                max_file_size_bytes: 1024 * 1024,
                upload_ttl_hours: 24,
            })
            .expect("upload config should apply");

        let shared = Arc::new(Mutex::new(McpRuntimeCore::default()));
        {
            let mut core = lock_or_recover(&shared);
            core.config = McpConfig {
                enabled: true,
                auto_start: true,
                host: "127.0.0.1".to_string(),
                port: 18765,
            };
            core.server = Some(EmbeddedMcpServerHandle {
                host: "127.0.0.1".to_string(),
                port: 18765,
                mcp_route_enabled: true,
                cancellation_token: CancellationToken::new(),
                task: tauri::async_runtime::spawn(async {}),
            });
            core.sync_file_receiver_runtime(&uploads);
        }

        assert_eq!(uploads.snapshot().status, FileReceiverStatus::Running);

        record_background_failure(
            &shared,
            &uploads,
            "127.0.0.1",
            18765,
            "listener crashed".to_string(),
        );

        let state = uploads.snapshot();
        assert_eq!(state.status, FileReceiverStatus::Error);
        assert_eq!(state.last_error.as_deref(), Some("listener crashed"));
    }

    #[tokio::test]
    async fn streamable_http_service_calls_embedded_tools() {
        let project = TempWikiProject::new("streamable-http");
        let media_dir = project.path.join("wiki/media/project-plan");
        fs::create_dir_all(&media_dir).expect("media dir should be created");
        fs::write(media_dir.join("img-2.png"), b"png").expect("image should be written");
        project.write_page(
            "sources/project-plan.md",
            r#"---
title: Project Plan
---

# Project Plan

![图 3.2-5 无人机采集作业流程图。该流程图展示无人机数据采集的完整步骤。](media/project-plan/img-2.png)
"#,
        );
        let uploads = FileReceiverRuntimeManager::default();
        uploads
            .update_config(FileReceiverConfig::default())
            .expect("upload config should apply");
        let manager = McpRuntimeManager::with_file_receiver(uploads.clone());
        let project_path = project.path_string();

        manager.update_known_projects(vec![project_path.clone()]);
        manager
            .update_project(Some(project_path.clone()))
            .expect("project update should succeed");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("listener should have local addr");
        let token = CancellationToken::new();

        let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let shared = manager.shared();
                    let uploads = uploads.clone();
                    move || Ok(EmbeddedMcpServer::new(shared.clone(), uploads.clone()))
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
        let client = ().serve(transport).await.expect("client should connect");

        let tools = client
            .list_all_tools()
            .await
            .expect("tool listing should succeed");
        assert_eq!(tools.len(), 6);
        let tool_names = tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>();
        assert!(tool_names.contains(&"llm_wiki_get_upload_guide"));
        assert!(!tool_names.contains(&"llm_wiki_ingest_source"));
        let search_tool = tools
            .iter()
            .find(|tool| tool.name.as_ref() == "llm_wiki_search")
            .expect("search tool should be listed");
        let search_schema =
            serde_json::to_value(&search_tool.input_schema).expect("schema should serialize");
        assert!(search_schema["properties"].get("mode").is_none());
        assert!(search_schema["properties"].get("project_path").is_none());
        assert!(search_schema["properties"].get("project_id").is_some());
        let read_tool = tools
            .iter()
            .find(|tool| tool.name.as_ref() == "llm_wiki_read_page")
            .expect("read_page tool should be listed");
        let read_schema =
            serde_json::to_value(&read_tool.input_schema).expect("schema should serialize");
        assert!(read_schema["properties"].get("start_offset").is_some());
        assert!(read_schema["properties"].get("max_chars").is_some());

        let guide_result = client
            .call_tool(CallToolRequestParams::new("llm_wiki_get_upload_guide"))
            .await
            .expect("upload guide tool call should succeed");

        assert_eq!(guide_result.is_error, Some(false));
        let guide_structured = guide_result
            .structured_content
            .expect("upload guide should include structured content");
        assert_eq!(guide_structured["uploadMode"], "uploads_only");
        assert_eq!(guide_structured["endpointPath"], "/uploads");
        assert_eq!(
            guide_structured["currentProjectId"],
            project_public_id(&project_path)
        );
        assert_eq!(guide_structured["authorizationScheme"], "Bearer");
        assert_eq!(
            guide_structured["headerAuthName"],
            "X-LLM-Wiki-Upload-Token"
        );
        assert_eq!(guide_structured["uploadPort"], addr.port());
        assert_eq!(
            guide_structured["resolvedEndpoint"],
            format!("http://127.0.0.1:{}/uploads", addr.port())
        );

        let search_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "query": "OpenAI"
        }))
        .expect("search args should deserialize");
        let search_result = client
            .call_tool(
                CallToolRequestParams::new("llm_wiki_search").with_arguments(search_arguments),
            )
            .await
            .expect("search tool call should succeed");

        assert_eq!(search_result.is_error, Some(false));
        let structured = search_result
            .structured_content
            .expect("search should include structured content");
        assert_eq!(structured["projectId"], project_public_id(&project_path));
        assert!(structured.get("mode").is_none());
        assert_eq!(structured["results"][0]["title"], "OpenAI");
        let relative_path = structured["results"][0]["relativePath"]
            .as_str()
            .expect("search results should include relativePath");

        let read_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "path_or_id": relative_path
        }))
        .expect("read args should deserialize");
        let read_result = client
            .call_tool(
                CallToolRequestParams::new("llm_wiki_read_page").with_arguments(read_arguments),
            )
            .await
            .expect("read tool call should succeed");

        assert_eq!(read_result.is_error, Some(false));
        let read_structured = read_result
            .structured_content
            .expect("read should include structured content");
        assert_eq!(
            read_structured["page"]["relativePath"],
            "entities/openai.md"
        );
        assert_eq!(read_structured["page"]["startOffset"], 0);
        assert_eq!(
            read_structured["page"]["endOffset"],
            read_structured["page"]["totalChars"]
        );
        assert_eq!(read_structured["page"]["hasMoreAfter"], false);
        assert!(read_structured["page"]["nextStartOffset"].is_null());
        assert!(read_structured["page"]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("OpenAI builds GPT models and AI systems."));

        let image_read_arguments =
            serde_json::from_value::<serde_json::Map<String, Value>>(json!({
                "path_or_id": "sources/project-plan.md"
            }))
            .expect("image read args should deserialize");
        let image_read_result = client
            .call_tool(
                CallToolRequestParams::new("llm_wiki_read_page")
                    .with_arguments(image_read_arguments),
            )
            .await
            .expect("image read tool call should succeed");

        assert_eq!(image_read_result.is_error, Some(false));
        let image_read_structured = image_read_result
            .structured_content
            .expect("image read should include structured content");
        assert_eq!(image_read_structured["page"]["resources"][0]["id"], 1);
        assert_eq!(
            image_read_structured["page"]["resources"][0]["url"],
            format!(
                "http://127.0.0.1:19827/wiki-media/{}/media/project-plan/img-2.png",
                project_public_id(&project_path)
            )
        );

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
        let addr = listener
            .local_addr()
            .expect("listener should have local addr");
        let token = CancellationToken::new();

        let service: StreamableHttpService<EmbeddedMcpServer, LocalSessionManager> =
            StreamableHttpService::new(
                {
                    let shared = manager.shared();
                    let uploads = manager.file_receiver.clone();
                    move || Ok(EmbeddedMcpServer::new(shared.clone(), uploads.clone()))
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
        let client = ().serve(transport).await.expect("client should connect");

        let search_arguments = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
            "query": "OpenAI"
        }))
        .expect("search args should deserialize");
        let search_result = client
            .call_tool(
                CallToolRequestParams::new("llm_wiki_search").with_arguments(search_arguments),
            )
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
