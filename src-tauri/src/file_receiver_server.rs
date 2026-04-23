use std::{
    collections::{BTreeSet, HashMap},
    fs, io,
    net::TcpListener as StdTcpListener,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use axum::{body::Body, http::Request};
#[cfg(test)]
use tower::util::ServiceExt;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::GetLastError,
    Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS},
};

use crate::commands::project::is_valid_wiki_project_path;

pub const DEFAULT_FILE_RECEIVER_HOST: &str = "127.0.0.1";
pub const DEFAULT_FILE_RECEIVER_PORT: u16 = 18766;
const DEFAULT_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_HOURS: u64 = 24 * 7;
const UPLOADS_RELATIVE_DIR: &str = ".llm-wiki/uploads";
const UPLOAD_HISTORY_RELATIVE_PATH: &str = ".llm-wiki/upload-history.json";
const UPLOAD_METADATA_FILE_NAME: &str = "metadata.json";
const UPLOAD_PAYLOAD_FILE_NAME: &str = "payload.bin";
const INGEST_QUEUE_RELATIVE_PATH: &str = ".llm-wiki/ingest-queue.json";
const UPLOAD_PROGRESS_PERSIST_INTERVAL_BYTES: u64 = 4 * 1024 * 1024;
static UPLOAD_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileReceiverStatus {
    Stopped,
    Starting,
    Running,
    PortConflict,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct FileReceiverConfig {
    pub enabled: bool,
    pub auto_start: bool,
    pub host: String,
    pub port: u16,
    pub static_token: String,
    pub max_file_size_bytes: u64,
    pub upload_ttl_hours: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileReceiverRuntimeState {
    pub status: FileReceiverStatus,
    pub host: String,
    pub port: u16,
    pub known_projects: Vec<String>,
    pub last_error: Option<String>,
    pub max_file_size_bytes: u64,
    pub upload_ttl_hours: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadStatus {
    #[serde(alias = "pending", alias = "receiving")]
    Uploading,
    Completed,
    Failed,
    Expired,
}

impl Default for UploadStatus {
    fn default() -> Self {
        Self::Uploading
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct UploadRecord {
    pub upload_id: String,
    pub project_path: String,
    pub file_name: String,
    pub mime_type: Option<String>,
    pub folder_context: String,
    pub status: UploadStatus,
    pub received_bytes: u64,
    pub total_size: Option<u64>,
    pub stored_source_path: Option<String>,
    pub task_id: Option<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadListResponse {
    pub uploads: Vec<UploadRecord>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadResponse {
    pub upload_id: String,
    pub status: String,
    pub project_path: String,
    pub stored_source_path: String,
    pub task_id: String,
    pub received_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadListQuery {
    project_path: Option<String>,
    status: Option<UploadStatus>,
    limit: Option<usize>,
}

pub struct FileReceiverRuntimeManager {
    inner: Arc<Mutex<FileReceiverRuntimeCore>>,
}

struct FileReceiverRuntimeCore {
    config: FileReceiverConfig,
    status: FileReceiverStatus,
    known_projects: Vec<String>,
    last_error: Option<String>,
    server_state: FileReceiverSharedState,
    server: Option<FileReceiverServerHandle>,
}

struct FileReceiverServerHandle {
    host: String,
    port: u16,
    cancellation_token: CancellationToken,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct FileReceiverSharedState {
    config: Arc<Mutex<FileReceiverConfig>>,
    known_projects: Arc<Mutex<Vec<String>>>,
    project_locks: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl Default for FileReceiverSharedState {
    fn default() -> Self {
        Self {
            config: Arc::new(Mutex::new(FileReceiverConfig::default())),
            known_projects: Arc::new(Mutex::new(Vec::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl FileReceiverSharedState {
    fn set_config(&self, config: FileReceiverConfig) {
        *lock_or_recover(&self.config) = config;
    }

    fn config(&self) -> FileReceiverConfig {
        lock_or_recover(&self.config).clone()
    }

    fn set_known_projects(&self, project_paths: Vec<String>) {
        *lock_or_recover(&self.known_projects) = project_paths;
    }

    fn known_projects(&self) -> Vec<String> {
        lock_or_recover(&self.known_projects).clone()
    }

    fn project_lock(&self, project_path: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = lock_or_recover(&self.project_locks);
        locks
            .entry(project_path.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

impl Default for UploadRecord {
    fn default() -> Self {
        Self {
            upload_id: String::new(),
            project_path: String::new(),
            file_name: String::new(),
            mime_type: None,
            folder_context: String::new(),
            status: UploadStatus::Uploading,
            received_bytes: 0,
            total_size: None,
            stored_source_path: None,
            task_id: None,
            error: None,
            started_at: 0,
            updated_at: 0,
        }
    }
}

impl Default for FileReceiverConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_start: false,
            host: DEFAULT_FILE_RECEIVER_HOST.to_string(),
            port: DEFAULT_FILE_RECEIVER_PORT,
            static_token: String::new(),
            max_file_size_bytes: DEFAULT_MAX_FILE_SIZE_BYTES,
            upload_ttl_hours: DEFAULT_UPLOAD_TTL_HOURS,
        }
    }
}

impl Default for FileReceiverRuntimeState {
    fn default() -> Self {
        Self {
            status: FileReceiverStatus::Stopped,
            host: DEFAULT_FILE_RECEIVER_HOST.to_string(),
            port: DEFAULT_FILE_RECEIVER_PORT,
            known_projects: Vec::new(),
            last_error: None,
            max_file_size_bytes: DEFAULT_MAX_FILE_SIZE_BYTES,
            upload_ttl_hours: DEFAULT_UPLOAD_TTL_HOURS,
        }
    }
}

impl Default for FileReceiverRuntimeManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FileReceiverRuntimeCore::default())),
        }
    }
}

impl Default for FileReceiverRuntimeCore {
    fn default() -> Self {
        Self {
            config: FileReceiverConfig::default(),
            status: FileReceiverStatus::Stopped,
            known_projects: Vec::new(),
            last_error: None,
            server_state: FileReceiverSharedState::default(),
            server: None,
        }
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub fn validate_file_receiver_config(config: &FileReceiverConfig) -> Result<(), String> {
    if config.host.trim().is_empty() {
        return Err("File receiver host cannot be empty".to_string());
    }

    if config.port == 0 {
        return Err("File receiver port cannot be 0".to_string());
    }

    if config.enabled && config.static_token.trim().is_empty() {
        return Err("File receiver token cannot be empty when service is enabled".to_string());
    }

    if config.max_file_size_bytes == 0 {
        return Err("File receiver max file size must be greater than 0".to_string());
    }

    if config.upload_ttl_hours == 0 {
        return Err("File receiver upload TTL must be greater than 0".to_string());
    }

    Ok(())
}

fn upload_history_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(UPLOAD_HISTORY_RELATIVE_PATH)
}

fn temp_upload_dir_path(project_path: &str, upload_id: &str) -> PathBuf {
    Path::new(project_path)
        .join(UPLOADS_RELATIVE_DIR)
        .join(upload_id)
}

fn temp_upload_metadata_path(project_path: &str, upload_id: &str) -> PathBuf {
    temp_upload_dir_path(project_path, upload_id).join(UPLOAD_METADATA_FILE_NAME)
}

fn temp_upload_payload_path(project_path: &str, upload_id: &str) -> PathBuf {
    temp_upload_dir_path(project_path, upload_id).join(UPLOAD_PAYLOAD_FILE_NAME)
}

pub(crate) fn load_upload_history(project_path: &str) -> Result<Vec<UploadRecord>, String> {
    let path = upload_history_path(project_path);
    match fs::read_to_string(&path) {
        Ok(contents) => {
            if contents.trim().is_empty() {
                return Ok(Vec::new());
            }
            serde_json::from_str(&contents).map_err(|err| {
                format!(
                    "Failed to parse upload history '{}': {}",
                    path.display(),
                    err
                )
            })
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!(
            "Failed to read upload history '{}': {}",
            path.display(),
            err
        )),
    }
}

fn validate_upload_id(upload_id: &str) -> Result<(), String> {
    let path = Path::new(upload_id);
    if upload_id.trim().is_empty()
        || path.components().count() != 1
        || !matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(format!("Invalid upload id '{}'", upload_id));
    }
    Ok(())
}

fn replace_file(path: &Path, temp_path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !path.exists() {
            return fs::rename(temp_path, path).map_err(|err| {
                format!(
                    "Failed to replace '{}' with temp file '{}': {}",
                    path.display(),
                    temp_path.display(),
                    err
                )
            });
        }

        let path_wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();
        let temp_wide = temp_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>();

        let result = unsafe {
            ReplaceFileW(
                path_wide.as_ptr(),
                temp_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_IGNORE_MERGE_ERRORS,
                0,
                0,
            )
        };
        if result == 0 {
            let err = io::Error::from_raw_os_error(unsafe { GetLastError() } as i32);
            return Err(format!(
                "Failed to replace '{}' with temp file '{}': {}",
                path.display(),
                temp_path.display(),
                err
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        fs::rename(temp_path, path).map_err(|err| {
            format!(
                "Failed to replace '{}' with temp file '{}': {}",
                path.display(),
                temp_path.display(),
                err
            )
        })
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create parent directory '{}': {}",
                parent.display(),
                err
            )
        })?;
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp_path = path.with_extension(format!("tmp-{}-{}", std::process::id(), nanos));
    fs::write(&temp_path, contents).map_err(|err| {
        format!(
            "Failed to write temp file '{}': {}",
            temp_path.display(),
            err
        )
    })?;
    replace_file(path, &temp_path).map_err(|err| {
        let _ = fs::remove_file(&temp_path);
        err
    })
}

pub(crate) fn persist_upload_history(
    project_path: &str,
    records: &[UploadRecord],
) -> Result<(), String> {
    let path = upload_history_path(project_path);
    let contents = serde_json::to_string_pretty(records)
        .map_err(|err| format!("Failed to serialize upload history: {}", err))?;
    atomic_write(&path, &contents)
}

pub(crate) fn persist_temp_upload_metadata(
    project_path: &str,
    record: &UploadRecord,
) -> Result<(), String> {
    let path = temp_upload_metadata_path(project_path, &record.upload_id);
    let contents = serde_json::to_string_pretty(record)
        .map_err(|err| format!("Failed to serialize upload metadata: {}", err))?;
    atomic_write(&path, &contents)
}

pub(crate) fn cleanup_temp_upload_payload(
    project_path: &str,
    upload_id: &str,
) -> Result<(), String> {
    validate_upload_id(upload_id)?;
    let path = temp_upload_payload_path(project_path, upload_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Failed to remove temp upload payload '{}': {}",
            path.display(),
            err
        )),
    }
}

pub(crate) fn cleanup_temp_upload_dir(project_path: &str, upload_id: &str) -> Result<(), String> {
    validate_upload_id(upload_id)?;
    let path = temp_upload_dir_path(project_path, upload_id);
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "Failed to remove temp upload directory '{}': {}",
            path.display(),
            err
        )),
    }
}

pub(crate) fn expire_temp_upload(
    project_path: &str,
    upload_id: &str,
    updated_at: u64,
) -> Result<(), String> {
    let mut records = load_upload_history(project_path)?;
    if let Some(record) = records
        .iter_mut()
        .find(|record| record.upload_id == upload_id)
    {
        record.status = UploadStatus::Expired;
        record.updated_at = updated_at;
    }
    persist_upload_history(project_path, &records)?;
    cleanup_temp_upload_dir(project_path, upload_id)
}

pub(crate) fn prune_upload_history(
    project_path: &str,
    updated_at_cutoff: u64,
) -> Result<(), String> {
    let records = load_upload_history(project_path)?;
    let mut retained = Vec::new();
    let mut expired_upload_ids = Vec::new();

    for mut record in records {
        if record.updated_at < updated_at_cutoff {
            record.status = UploadStatus::Expired;
            expired_upload_ids.push(record.upload_id.clone());
        } else {
            retained.push(record);
        }
    }

    for upload_id in &expired_upload_ids {
        cleanup_temp_upload_dir(project_path, upload_id)?;
    }

    persist_upload_history(project_path, &retained)?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn generate_upload_id() -> String {
    format!(
        "upload-{}-{}",
        now_millis(),
        UPLOAD_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn upsert_upload_record(project_path: &str, record: &UploadRecord) -> Result<(), String> {
    let mut records = load_upload_history(project_path)?;
    if let Some(existing) = records
        .iter_mut()
        .find(|item| item.upload_id == record.upload_id)
    {
        *existing = record.clone();
    } else {
        records.push(record.clone());
    }
    persist_upload_history(project_path, &records)
}

async fn mark_upload_failed(
    project_lock: Arc<AsyncMutex<()>>,
    project_path: &str,
    record: &UploadRecord,
    error: impl Into<String>,
) {
    let _guard = project_lock.lock().await;
    let mut failed = record.clone();
    failed.status = UploadStatus::Failed;
    failed.error = Some(error.into());
    failed.updated_at = now_millis();
    let _ = upsert_upload_record(project_path, &failed);
}

async fn persist_upload_state(
    project_lock: Arc<AsyncMutex<()>>,
    project_path: &str,
    record: &UploadRecord,
) -> Result<(), String> {
    let _guard = project_lock.lock().await;
    upsert_upload_record(project_path, record)?;
    persist_temp_upload_metadata(project_path, record)
}

async fn cleanup_failed_upload(
    project_lock: Option<Arc<AsyncMutex<()>>>,
    project_path: &str,
    record: Option<&UploadRecord>,
    error: &str,
) {
    if let (Some(project_lock), Some(record)) = (project_lock, record) {
        mark_upload_failed(project_lock, project_path, record, error).await;
        let _ = cleanup_temp_upload_dir(project_path, &record.upload_id);
    }
}

fn validate_project_path(project_path: &str, known_projects: &[String]) -> Result<String, String> {
    let project = non_empty_trimmed(project_path)
        .ok_or_else(|| "projectPath must not be empty".to_string())?
        .to_string();
    if !known_projects.iter().any(|item| item == &project) {
        return Err(format!("Unknown projectPath '{}'", project));
    }
    if !is_valid_wiki_project_path(Path::new(&project)) {
        return Err(format!(
            "Invalid wiki project '{}': missing schema.md or wiki/index.md",
            project
        ));
    }
    Ok(project)
}

fn resolve_requested_project_paths(
    requested_project_path: Option<&str>,
    known_projects: &[String],
) -> Result<(Vec<String>, bool), String> {
    if let Some(project_path) = requested_project_path.and_then(non_empty_trimmed) {
        if !known_projects.iter().any(|known| known == project_path) {
            return Err(format!("Unknown projectPath '{}'", project_path));
        }
        return Ok((vec![project_path.to_string()], true));
    }

    Ok((known_projects.to_vec(), false))
}

fn validate_safe_path_component(value: &str, field_name: &str) -> Result<(), String> {
    if value.is_empty() || value.trim().is_empty() {
        return Err(format!("{} must not be empty", field_name));
    }
    if matches!(value, "." | "..") {
        return Err(format!("{} must not be '.' or '..'", field_name));
    }
    if value.contains('/') || value.contains('\\') {
        return Err(format!("{} must not contain path separators", field_name));
    }
    if value.ends_with('.') || value.ends_with(' ') {
        return Err(format!("{} must not end with '.' or space", field_name));
    }
    if value.chars().any(|ch| ch == '\0' || ch.is_control()) {
        return Err(format!(
            "{} contains unsupported control characters",
            field_name
        ));
    }
    if value
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(format!(
            "{} contains unsupported characters: <>:\"|?*",
            field_name
        ));
    }
    if is_windows_reserved_device_name(value) {
        return Err(format!("{} uses a reserved device name", field_name));
    }
    Ok(())
}

fn is_windows_reserved_device_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(value);
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let com_or_lpt = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"));
    if let Some(rest) = com_or_lpt {
        return rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9');
    }
    false
}

fn sanitize_file_name(file_name: &str) -> Result<String, String> {
    let file_name =
        non_empty_trimmed(file_name).ok_or_else(|| "fileName must not be empty".to_string())?;
    validate_safe_path_component(file_name, "fileName")?;
    Ok(file_name.to_string())
}

fn parse_folder_context_segments(folder_context: Option<&str>) -> Result<Vec<String>, String> {
    let context = match folder_context.and_then(non_empty_trimmed) {
        Some(value) => value,
        None => return Ok(Vec::new()),
    };

    let mut segments = Vec::new();
    for segment in context
        .replace('\\', "/")
        .split('/')
        .flat_map(|segment| segment.split('>'))
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
    {
        validate_safe_path_component(segment, "folderContext segment")?;
        segments.push(segment.to_string());
    }
    Ok(segments)
}

fn build_unique_source_path(
    project_path: &str,
    file_name: &str,
    folder_context: Option<&str>,
) -> Result<(PathBuf, String), String> {
    let project_root = Path::new(project_path);
    let mut relative_dir = PathBuf::from("raw/sources");
    if let Some(folder) = folder_context {
        relative_dir.push(folder);
    }

    let target_dir = project_root.join(&relative_dir);
    fs::create_dir_all(&target_dir).map_err(|err| {
        format!(
            "Failed to create source directory '{}': {}",
            target_dir.display(),
            err
        )
    })?;

    let preferred_path = target_dir.join(file_name);
    let absolute = if !preferred_path.exists() {
        preferred_path
    } else {
        let date = Local::now().format("%Y%m%d").to_string();
        let with_date = target_dir.join(build_conflict_file_name(file_name, &date, None));
        if !with_date.exists() {
            with_date
        } else {
            let unique_seed = format!(
                "{}-{:x}",
                now_millis(),
                UPLOAD_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            target_dir.join(build_conflict_file_name(file_name, &unique_seed, None))
        }
    };

    let relative = absolute
        .strip_prefix(project_root)
        .map_err(|_| {
            format!(
                "Stored source path '{}' escaped project root '{}'",
                absolute.display(),
                project_root.display()
            )
        })?
        .to_string_lossy()
        .replace('\\', "/");

    Ok((absolute, relative))
}

fn build_conflict_file_name(file_name: &str, suffix: &str, counter: Option<u32>) -> String {
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name);
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(|value| format!(".{}", value))
        .unwrap_or_default();
    match counter {
        Some(counter) => format!("{}-{}-{}{}", stem, suffix, counter, ext),
        None => format!("{}-{}{}", stem, suffix, ext),
    }
}

fn ingest_queue_path(project_path: &str) -> PathBuf {
    Path::new(project_path).join(INGEST_QUEUE_RELATIVE_PATH)
}

fn read_ingest_queue_values(project_path: &str) -> Result<Vec<Value>, String> {
    let queue_path = ingest_queue_path(project_path);
    match fs::read_to_string(&queue_path) {
        Ok(raw) => {
            if raw.trim().is_empty() {
                return Ok(Vec::new());
            }
            let parsed: Value = serde_json::from_str(&raw).map_err(|err| {
                format!(
                    "Invalid ingest queue JSON '{}': {}",
                    queue_path.display(),
                    err
                )
            })?;
            let values = parsed.as_array().ok_or_else(|| {
                format!(
                    "Invalid ingest queue JSON '{}': expected an array",
                    queue_path.display()
                )
            })?;
            Ok(values.clone())
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(format!(
            "Failed to read ingest queue '{}': {}",
            queue_path.display(),
            err
        )),
    }
}

fn write_ingest_queue_values(project_path: &str, queue: &[Value]) -> Result<(), String> {
    let queue_path = ingest_queue_path(project_path);
    let serialized = serde_json::to_string_pretty(queue)
        .map_err(|err| format!("Failed to serialize ingest queue: {}", err))?;
    atomic_write(&queue_path, &serialized)
}

fn build_upload_service_queue_task_value(
    task_id: &str,
    source_path: &str,
    folder_context: &str,
    mime_type: Option<&str>,
) -> Value {
    json!({
        "id": task_id,
        "sourcePath": source_path,
        "folderContext": folder_context,
        "status": "pending",
        "addedAt": now_millis(),
        "error": Value::Null,
        "retryCount": 0,
        "origin": "upload_service",
        "mimeType": mime_type,
    })
}

fn build_file_receiver_router(state: FileReceiverSharedState) -> Router {
    Router::new()
        .route("/uploads", post(post_upload).get(http_list_uploads))
        .route("/uploads/:upload_id", get(http_get_upload))
        .layer(DefaultBodyLimit::disable())
        .with_state(state)
}

async fn run_file_receiver_http_server(
    shared: Arc<Mutex<FileReceiverRuntimeCore>>,
    listener: StdTcpListener,
    host: String,
    port: u16,
    cancellation_token: CancellationToken,
    state: FileReceiverSharedState,
) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(err) => {
            record_background_failure(
                &shared,
                &host,
                port,
                format!("Failed to adopt file receiver listener: {}", err),
            );
            return;
        }
    };

    let router = build_file_receiver_router(state);
    let serve_result = axum::serve(listener, router)
        .with_graceful_shutdown(async move { cancellation_token.cancelled_owned().await })
        .await;

    if let Err(err) = serve_result {
        record_background_failure(
            &shared,
            &host,
            port,
            format!("File receiver server stopped unexpectedly: {}", err),
        );
    }
}

fn record_background_failure(
    shared: &Arc<Mutex<FileReceiverRuntimeCore>>,
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
        core.status = FileReceiverStatus::Error;
        core.last_error = Some(message);
    }
}

fn authorize(
    headers: &HeaderMap,
    shared_state: &FileReceiverSharedState,
) -> Result<(), StatusCode> {
    let config = shared_state.config();
    let expected = format!("Bearer {}", config.static_token);
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if provided == expected {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn post_upload(
    AxumState(shared_state): AxumState<FileReceiverSharedState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &shared_state)?;
    let config = shared_state.config();
    let known_projects = shared_state.known_projects();

    let mut project_path: Option<String> = None;
    let mut file_name: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut folder_context: Option<String> = None;
    let mut received_bytes = 0_u64;
    let mut file_seen = false;
    let mut upload_record: Option<UploadRecord> = None;
    let mut temp_payload_path: Option<PathBuf> = None;
    let mut temp_file: Option<tokio::fs::File> = None;
    let mut normalized_project_path = String::new();
    let mut normalized_folder_context = String::new();
    let mut folder_directory: Option<String> = None;
    let mut project_lock: Option<Arc<AsyncMutex<()>>> = None;
    let mut last_persisted_progress_bytes = 0_u64;

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(_) => {
                cleanup_failed_upload(
                    project_lock.clone(),
                    &normalized_project_path,
                    upload_record.as_ref(),
                    "Malformed multipart payload",
                )
                .await;
                return Err(StatusCode::BAD_REQUEST);
            }
        };
        let name = field.name().unwrap_or("").to_string();
        if file_seen {
            cleanup_failed_upload(
                project_lock.clone(),
                &normalized_project_path,
                upload_record.as_ref(),
                if name == "file" {
                    "Only one file part is allowed per request"
                } else {
                    "Metadata fields must precede the file part"
                },
            )
            .await;
            return Err(StatusCode::BAD_REQUEST);
        }

        if name == "projectPath" {
            let validated = validate_project_path(
                &field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?,
                &known_projects,
            )
            .map_err(|_| StatusCode::BAD_REQUEST)?;
            project_lock = Some(shared_state.project_lock(&validated));
            project_path = Some(validated);
            continue;
        }

        if name == "fileName" {
            file_name = Some(
                sanitize_file_name(&field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?)
                    .map_err(|_| StatusCode::BAD_REQUEST)?,
            );
            continue;
        }

        if name == "mimeType" {
            mime_type =
                non_empty_trimmed(&field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?)
                    .map(str::to_string);
            continue;
        }

        if name == "folderContext" {
            folder_context =
                non_empty_trimmed(&field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?)
                    .map(str::to_string);
            continue;
        }

        if name != "file" {
            continue;
        }

        file_seen = true;
        normalized_project_path = project_path.clone().ok_or(StatusCode::BAD_REQUEST)?;
        let upload_file_name = file_name
            .clone()
            .or_else(|| field.file_name().map(|value| value.to_string()))
            .ok_or(StatusCode::BAD_REQUEST)?;
        let sanitized_file_name =
            sanitize_file_name(&upload_file_name).map_err(|_| StatusCode::BAD_REQUEST)?;
        let folder_segments = parse_folder_context_segments(folder_context.as_deref())
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        normalized_folder_context = if folder_segments.is_empty() {
            String::new()
        } else {
            folder_segments.join(" > ")
        };
        folder_directory = if folder_segments.is_empty() {
            None
        } else {
            Some(folder_segments.join("/"))
        };

        let upload_id = generate_upload_id();
        let record = UploadRecord {
            upload_id: upload_id.clone(),
            project_path: normalized_project_path.clone(),
            file_name: sanitized_file_name.clone(),
            mime_type: mime_type.clone(),
            folder_context: normalized_folder_context.clone(),
            status: UploadStatus::Uploading,
            received_bytes: 0,
            total_size: None,
            stored_source_path: None,
            task_id: None,
            error: None,
            started_at: now_millis(),
            updated_at: now_millis(),
        };
        let current_project_lock = project_lock
            .clone()
            .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
        if persist_upload_state(
            current_project_lock.clone(),
            &normalized_project_path,
            &record,
        )
        .await
        .is_err()
        {
            cleanup_failed_upload(
                Some(current_project_lock),
                &normalized_project_path,
                Some(&record),
                "Failed to persist upload metadata",
            )
            .await;
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }

        let payload_path = temp_upload_payload_path(&normalized_project_path, &upload_id);
        if let Some(parent) = payload_path.parent() {
            if tokio::fs::create_dir_all(parent).await.is_err() {
                mark_upload_failed(
                    current_project_lock.clone(),
                    &normalized_project_path,
                    &record,
                    "Failed to create temp upload directory",
                )
                .await;
                let _ = cleanup_temp_upload_dir(&normalized_project_path, &upload_id);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
        let mut output = match tokio::fs::File::create(&payload_path).await {
            Ok(file) => file,
            Err(_) => {
                mark_upload_failed(
                    current_project_lock.clone(),
                    &normalized_project_path,
                    &record,
                    "Failed to create temp upload payload",
                )
                .await;
                let _ = cleanup_temp_upload_dir(&normalized_project_path, &upload_id);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };

        let mut field = field;
        while let Some(chunk) = match field.chunk().await {
            Ok(chunk) => chunk,
            Err(_) => {
                let mut failed = record.clone();
                failed.received_bytes = received_bytes;
                cleanup_failed_upload(
                    Some(current_project_lock.clone()),
                    &normalized_project_path,
                    Some(&failed),
                    "Malformed multipart file stream",
                )
                .await;
                return Err(StatusCode::BAD_REQUEST);
            }
        } {
            received_bytes += chunk.len() as u64;
            if received_bytes > config.max_file_size_bytes {
                let mut failed = record.clone();
                failed.received_bytes = received_bytes;
                mark_upload_failed(
                    current_project_lock.clone(),
                    &normalized_project_path,
                    &failed,
                    "Upload exceeded max file size",
                )
                .await;
                let _ = cleanup_temp_upload_dir(&normalized_project_path, &upload_id);
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            if tokio::io::AsyncWriteExt::write_all(&mut output, &chunk)
                .await
                .is_err()
            {
                let mut failed = record.clone();
                failed.received_bytes = received_bytes;
                mark_upload_failed(
                    current_project_lock.clone(),
                    &normalized_project_path,
                    &failed,
                    "Failed to write upload payload chunk",
                )
                .await;
                let _ = cleanup_temp_upload_dir(&normalized_project_path, &upload_id);
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
            if received_bytes - last_persisted_progress_bytes
                >= UPLOAD_PROGRESS_PERSIST_INTERVAL_BYTES
            {
                let in_progress = UploadRecord {
                    received_bytes,
                    updated_at: now_millis(),
                    ..record.clone()
                };
                if persist_upload_state(
                    current_project_lock.clone(),
                    &normalized_project_path,
                    &in_progress,
                )
                .await
                .is_err()
                {
                    cleanup_failed_upload(
                        Some(current_project_lock.clone()),
                        &normalized_project_path,
                        Some(&in_progress),
                        "Failed to persist upload progress",
                    )
                    .await;
                    return Err(StatusCode::INTERNAL_SERVER_ERROR);
                }
                last_persisted_progress_bytes = received_bytes;
            }
        }
        temp_payload_path = Some(payload_path);
        temp_file = Some(output);
        upload_record = Some(UploadRecord {
            received_bytes,
            updated_at: now_millis(),
            ..record
        });
    }

    let mut record = upload_record.ok_or(StatusCode::BAD_REQUEST)?;
    let current_project_lock = project_lock
        .clone()
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(mut file) = temp_file {
        if tokio::io::AsyncWriteExt::flush(&mut file).await.is_err() {
            mark_upload_failed(
                current_project_lock.clone(),
                &normalized_project_path,
                &record,
                "Failed to flush upload payload",
            )
            .await;
            let _ = cleanup_temp_upload_dir(&normalized_project_path, &record.upload_id);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    if persist_upload_state(
        current_project_lock.clone(),
        &normalized_project_path,
        &record,
    )
    .await
    .is_err()
    {
        cleanup_failed_upload(
            Some(current_project_lock.clone()),
            &normalized_project_path,
            Some(&record),
            "Failed to persist upload metadata",
        )
        .await;
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let payload_path = temp_payload_path.ok_or(StatusCode::BAD_REQUEST)?;
    let task_id = format!(
        "ingest-{}-{}",
        now_millis(),
        UPLOAD_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let commit_result: Result<String, String> = 'commit: {
        let _guard = current_project_lock.lock().await;
        let mut queue = match read_ingest_queue_values(&normalized_project_path) {
            Ok(queue) => queue,
            Err(err) => break 'commit Err(err),
        };
        let (stored_abs_path, stored_relative_path) = match build_unique_source_path(
            &normalized_project_path,
            &record.file_name,
            folder_directory.as_deref(),
        ) {
            Ok(paths) => paths,
            Err(err) => break 'commit Err(err),
        };

        if let Some(parent) = stored_abs_path.parent() {
            if let Err(err) = tokio::fs::create_dir_all(parent).await {
                break 'commit Err(err.to_string());
            }
        }
        if let Err(err) = tokio::fs::rename(&payload_path, &stored_abs_path).await {
            break 'commit Err(err.to_string());
        }

        queue.push(build_upload_service_queue_task_value(
            &task_id,
            &stored_relative_path,
            &normalized_folder_context,
            record.mime_type.as_deref(),
        ));
        if let Err(err) = write_ingest_queue_values(&normalized_project_path, &queue) {
            if let Err(rollback_err) = tokio::fs::rename(&stored_abs_path, &payload_path).await {
                break 'commit Err(format!("{}; source rollback failed: {}", err, rollback_err));
            }
            break 'commit Err(err);
        }

        let mut completed = record.clone();
        completed.status = UploadStatus::Completed;
        completed.task_id = Some(task_id.clone());
        completed.stored_source_path = Some(stored_relative_path.clone());
        completed.updated_at = now_millis();
        if let Err(err) = upsert_upload_record(&normalized_project_path, &completed) {
            queue.pop();
            if let Err(queue_rollback_err) =
                write_ingest_queue_values(&normalized_project_path, &queue)
            {
                break 'commit Err(format!(
                    "{}; queue rollback failed: {}",
                    err, queue_rollback_err
                ));
            }
            if let Err(file_rollback_err) = tokio::fs::rename(&stored_abs_path, &payload_path).await
            {
                break 'commit Err(format!(
                    "{}; source rollback failed: {}",
                    err, file_rollback_err
                ));
            }
            break 'commit Err(err);
        }

        record = completed;
        Ok(stored_relative_path)
    };

    let stored_relative_path = match commit_result {
        Ok(path) => path,
        Err(err) => {
            mark_upload_failed(
                current_project_lock.clone(),
                &normalized_project_path,
                &record,
                format!("Failed to finalize upload: {}", err),
            )
            .await;
            let _ = cleanup_temp_upload_dir(&normalized_project_path, &record.upload_id);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let _ = cleanup_temp_upload_dir(&normalized_project_path, &record.upload_id);

    Ok((
        StatusCode::OK,
        Json(UploadResponse {
            upload_id: record.upload_id.clone(),
            status: "pending".to_string(),
            project_path: normalized_project_path,
            stored_source_path: stored_relative_path,
            task_id,
            received_bytes,
        }),
    ))
}

async fn http_list_uploads(
    AxumState(shared_state): AxumState<FileReceiverSharedState>,
    headers: HeaderMap,
    Query(query): Query<UploadListQuery>,
) -> Result<Json<UploadListResponse>, StatusCode> {
    authorize(&headers, &shared_state)?;
    let known_projects = shared_state.known_projects();
    let (project_paths, scoped_project) =
        resolve_requested_project_paths(query.project_path.as_deref(), &known_projects)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
    let response =
        collect_uploads_for_projects(project_paths, query.status, query.limit, scoped_project)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

async fn http_get_upload(
    AxumState(shared_state): AxumState<FileReceiverSharedState>,
    headers: HeaderMap,
    AxumPath(upload_id): AxumPath<String>,
) -> Result<Json<Option<UploadRecord>>, StatusCode> {
    authorize(&headers, &shared_state)?;
    let response = find_upload_for_projects(shared_state.known_projects(), &upload_id, false)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(response))
}

fn collect_uploads_for_projects(
    project_paths: Vec<String>,
    status: Option<UploadStatus>,
    limit: Option<usize>,
    scoped_project: bool,
) -> Result<UploadListResponse, String> {
    let mut uploads = Vec::new();

    for project_path in project_paths {
        match load_upload_history(&project_path) {
            Ok(history) => uploads.extend(history),
            Err(err) if scoped_project => return Err(err),
            Err(_) => continue,
        }
    }

    if let Some(status) = status {
        uploads.retain(|record| record.status == status);
    }
    uploads.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let total = uploads.len();
    if let Some(limit) = limit {
        uploads.truncate(limit);
    }

    Ok(UploadListResponse { uploads, total })
}

fn find_upload_for_projects(
    project_paths: Vec<String>,
    upload_id: &str,
    scoped_project: bool,
) -> Result<Option<UploadRecord>, String> {
    for project_path in project_paths {
        match load_upload_history(&project_path) {
            Ok(history) => {
                if let Some(record) = history
                    .into_iter()
                    .find(|record| record.upload_id == upload_id)
                {
                    return Ok(Some(record));
                }
            }
            Err(err) if scoped_project => return Err(err),
            Err(_) => continue,
        }
    }
    Ok(None)
}

impl FileReceiverRuntimeCore {
    fn snapshot(&self) -> FileReceiverRuntimeState {
        FileReceiverRuntimeState {
            status: self.status.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            known_projects: self.known_projects.clone(),
            last_error: self.last_error.clone(),
            max_file_size_bytes: self.config.max_file_size_bytes,
            upload_ttl_hours: self.config.upload_ttl_hours,
        }
    }

    fn stop(&mut self) {
        self.stop_server();
        self.status = FileReceiverStatus::Stopped;
        self.last_error = None;
    }

    fn stop_server(&mut self) {
        if let Some(server) = self.server.take() {
            server.cancellation_token.cancel();
        }
    }

    fn start_server(&mut self, shared: Arc<Mutex<FileReceiverRuntimeCore>>) -> Result<(), String> {
        validate_file_receiver_config(&self.config)?;

        self.server_state.set_config(self.config.clone());
        self.server_state
            .set_known_projects(self.known_projects.clone());

        if !self.config.enabled || !self.config.auto_start {
            self.stop_server();
            self.status = FileReceiverStatus::Stopped;
            self.last_error = None;
            return Ok(());
        }

        let desired_host = self.config.host.clone();
        let desired_port = self.config.port;
        if let Some(server) = &self.server {
            if server.host == desired_host && server.port == desired_port {
                self.status = FileReceiverStatus::Running;
                self.last_error = None;
                return Ok(());
            }
        }

        self.stop_server();
        self.status = FileReceiverStatus::Starting;
        self.last_error = None;

        let bind_address = format!("{}:{}", desired_host, desired_port);
        let listener = StdTcpListener::bind(&bind_address).map_err(|err| {
            self.status = if err.kind() == io::ErrorKind::AddrInUse {
                FileReceiverStatus::PortConflict
            } else {
                FileReceiverStatus::Error
            };
            let message = format!("Failed to bind file receiver on {}: {}", bind_address, err);
            self.last_error = Some(message.clone());
            message
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("Failed to configure file receiver listener: {}", err))?;

        let cancellation_token = CancellationToken::new();
        let task_token = cancellation_token.child_token();
        let task_host = desired_host.clone();
        let task_shared = shared.clone();
        let task_state = self.server_state.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_file_receiver_http_server(
                task_shared,
                listener,
                task_host,
                desired_port,
                task_token,
                task_state,
            )
            .await;
        });

        self.server = Some(FileReceiverServerHandle {
            host: desired_host,
            port: desired_port,
            cancellation_token,
            task: Some(task),
        });
        self.status = FileReceiverStatus::Running;
        self.last_error = None;
        Ok(())
    }

    fn update_config(&mut self, config: FileReceiverConfig) -> Result<(), String> {
        validate_file_receiver_config(&config)?;
        self.config = config;
        self.server_state.set_config(self.config.clone());
        Ok(())
    }

    fn update_known_projects(&mut self, project_paths: Vec<String>) {
        let mut paths = BTreeSet::new();
        for path in project_paths {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                paths.insert(trimmed.to_string());
            }
        }
        self.known_projects = paths.into_iter().collect();
        self.server_state
            .set_known_projects(self.known_projects.clone());
    }
}

impl FileReceiverRuntimeManager {
    fn shared(&self) -> Arc<Mutex<FileReceiverRuntimeCore>> {
        self.inner.clone()
    }

    pub(crate) fn snapshot(&self) -> FileReceiverRuntimeState {
        lock_or_recover(&self.inner).snapshot()
    }

    pub(crate) fn stop(&self) {
        lock_or_recover(&self.inner).stop();
    }

    pub(crate) fn update_config(&self, config: FileReceiverConfig) -> Result<(), String> {
        let shared = self.shared();
        {
            lock_or_recover(&self.inner).update_config(config)?;
        }
        lock_or_recover(&self.inner).start_server(shared)
    }

    pub(crate) fn update_known_projects(&self, project_paths: Vec<String>) {
        lock_or_recover(&self.inner).update_known_projects(project_paths);
    }

    fn known_project_paths(&self) -> Vec<String> {
        lock_or_recover(&self.inner).known_projects.clone()
    }
}

#[tauri::command]
pub fn file_receiver_status(
    manager: State<'_, FileReceiverRuntimeManager>,
) -> FileReceiverRuntimeState {
    manager.snapshot()
}

#[tauri::command]
pub fn file_receiver_update_config(
    config: FileReceiverConfig,
    manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<(), String> {
    manager.update_config(config)
}

#[tauri::command]
pub fn file_receiver_update_known_projects(
    project_paths: Vec<String>,
    manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<(), String> {
    manager.update_known_projects(project_paths);
    Ok(())
}

#[tauri::command]
pub fn list_uploads(
    project_path: Option<String>,
    status: Option<UploadStatus>,
    limit: Option<usize>,
    manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<UploadListResponse, String> {
    let known_projects = manager.known_project_paths();
    let (project_paths, scoped_project) =
        resolve_requested_project_paths(project_path.as_deref(), &known_projects)?;
    collect_uploads_for_projects(project_paths, status, limit, scoped_project)
}

#[tauri::command]
pub fn get_upload(
    upload_id: String,
    project_path: Option<String>,
    manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<Option<UploadRecord>, String> {
    let known_projects = manager.known_project_paths();
    let (project_paths, scoped_project) =
        resolve_requested_project_paths(project_path.as_deref(), &known_projects)?;
    find_upload_for_projects(project_paths, &upload_id, scoped_project)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_receiver_runtime_defaults_to_stopped() {
        let state = FileReceiverRuntimeState::default();
        assert_eq!(state.status, FileReceiverStatus::Stopped);
        assert_eq!(state.host, "127.0.0.1");
        assert_eq!(state.port, DEFAULT_FILE_RECEIVER_PORT);
        assert!(state.known_projects.is_empty());
    }

    #[test]
    fn validate_file_receiver_config_rejects_empty_token_and_zero_port() {
        let bad = FileReceiverConfig {
            enabled: true,
            auto_start: true,
            host: "127.0.0.1".into(),
            port: 0,
            static_token: "".into(),
            max_file_size_bytes: 2 * 1024 * 1024 * 1024,
            upload_ttl_hours: 24,
        };

        assert!(validate_file_receiver_config(&bad).is_err());
    }

    #[test]
    fn invalid_config_update_does_not_mark_runtime_error() {
        let manager = FileReceiverRuntimeManager::default();
        let bad = FileReceiverConfig {
            enabled: true,
            auto_start: true,
            host: "127.0.0.1".into(),
            port: DEFAULT_FILE_RECEIVER_PORT,
            static_token: "".into(),
            max_file_size_bytes: 2 * 1024 * 1024,
            upload_ttl_hours: 24,
        };

        assert!(manager.update_config(bad).is_err());

        let state = manager.snapshot();
        assert_eq!(state.status, FileReceiverStatus::Stopped);
        assert!(state.last_error.is_none());
    }

    #[test]
    fn file_receiver_config_deserializes_missing_fields_from_defaults() {
        let config: FileReceiverConfig = serde_json::from_value(serde_json::json!({
            "enabled": false,
            "host": "0.0.0.0"
        }))
        .unwrap();

        assert!(!config.enabled);
        assert!(!config.auto_start);
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, DEFAULT_FILE_RECEIVER_PORT);
        assert_eq!(config.max_file_size_bytes, DEFAULT_MAX_FILE_SIZE_BYTES);
        assert_eq!(config.upload_ttl_hours, DEFAULT_UPLOAD_TTL_HOURS);
    }

    #[test]
    fn completed_upload_history_survives_temp_payload_cleanup() {
        let project = TempWikiProject::new("upload-history-success");
        let record =
            sample_upload_record(&project.path_string(), "done.pdf", UploadStatus::Completed);

        persist_upload_history(&project.path_string(), std::slice::from_ref(&record)).unwrap();
        std::fs::create_dir_all(temp_upload_dir_path(
            &project.path_string(),
            &record.upload_id,
        ))
        .unwrap();
        std::fs::write(
            temp_upload_payload_path(&project.path_string(), &record.upload_id),
            b"payload",
        )
        .unwrap();
        cleanup_temp_upload_payload(&project.path_string(), &record.upload_id).unwrap();

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history[0].upload_id, record.upload_id);
        assert!(!temp_upload_payload_path(&project.path_string(), &record.upload_id).exists());
    }

    #[test]
    fn failed_upload_history_remains_queryable_until_retention_cutoff() {
        let project = TempWikiProject::new("upload-history-failed");
        let mut record =
            sample_upload_record(&project.path_string(), "failed.pdf", UploadStatus::Failed);
        record.error = Some("disk full".into());

        persist_upload_history(&project.path_string(), std::slice::from_ref(&record)).unwrap();

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history[0].error.as_deref(), Some("disk full"));
    }

    #[test]
    fn runtime_refreshes_known_projects_while_running() {
        let manager = FileReceiverRuntimeManager::default();
        {
            let mut core = lock_or_recover(&manager.inner);
            core.server = Some(FileReceiverServerHandle {
                host: DEFAULT_FILE_RECEIVER_HOST.to_string(),
                port: DEFAULT_FILE_RECEIVER_PORT,
                cancellation_token: CancellationToken::new(),
                task: None,
            });
        }
        manager.update_known_projects(vec![
            " /tmp/wiki-b ".into(),
            "/tmp/wiki-a".into(),
            "/tmp/wiki-a".into(),
        ]);

        let state = manager.snapshot();
        assert_eq!(
            state.known_projects,
            vec!["/tmp/wiki-a".to_string(), "/tmp/wiki-b".to_string()]
        );
        let live_paths = {
            let core = lock_or_recover(&manager.inner);
            core.server_state.known_projects()
        };
        assert_eq!(
            live_paths,
            vec!["/tmp/wiki-a".to_string(), "/tmp/wiki-b".to_string()]
        );
    }

    #[test]
    fn upload_history_prunes_records_older_than_retention_cutoff() {
        let project = TempWikiProject::new("upload-history-prune");
        let mut expired =
            sample_upload_record(&project.path_string(), "old.pdf", UploadStatus::Completed);
        expired.updated_at = 10;
        let mut fresh =
            sample_upload_record(&project.path_string(), "fresh.pdf", UploadStatus::Completed);
        fresh.updated_at = 100;

        persist_upload_history(&project.path_string(), &[expired.clone(), fresh.clone()]).unwrap();

        prune_upload_history(&project.path_string(), 50).unwrap();

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history, vec![fresh]);
    }

    #[test]
    fn load_upload_history_accepts_legacy_records() {
        let project = TempWikiProject::new("upload-history-legacy");
        std::fs::write(
            upload_history_path(&project.path_string()),
            serde_json::json!([
                {
                    "uploadId": "legacy-1",
                    "projectPath": project.path_string(),
                    "fileName": "legacy.pdf",
                    "status": "receiving",
                    "receivedBytes": 42
                }
            ])
            .to_string(),
        )
        .unwrap();

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, UploadStatus::Uploading);
        assert_eq!(history[0].folder_context, "");
        assert_eq!(history[0].updated_at, 0);
    }

    #[test]
    fn prune_upload_history_removes_expired_temp_upload_directories() {
        let project = TempWikiProject::new("upload-history-prune-dirs");
        let mut expired = sample_upload_record(
            &project.path_string(),
            "old-dir.pdf",
            UploadStatus::Uploading,
        );
        expired.updated_at = 10;
        persist_upload_history(&project.path_string(), std::slice::from_ref(&expired)).unwrap();
        std::fs::create_dir_all(temp_upload_dir_path(
            &project.path_string(),
            &expired.upload_id,
        ))
        .unwrap();
        std::fs::write(
            temp_upload_payload_path(&project.path_string(), &expired.upload_id),
            b"payload",
        )
        .unwrap();

        prune_upload_history(&project.path_string(), 50).unwrap();

        assert!(!temp_upload_dir_path(&project.path_string(), &expired.upload_id).exists());
    }

    #[test]
    fn cleanup_temp_upload_dir_rejects_dangerous_upload_id() {
        let project = TempWikiProject::new("upload-history-dangerous-id");
        assert!(cleanup_temp_upload_dir(&project.path_string(), "../../escape").is_err());
    }

    #[test]
    fn prune_upload_history_keeps_record_when_cleanup_fails() {
        let project = TempWikiProject::new("upload-history-prune-fail");
        let mut expired = sample_upload_record(
            &project.path_string(),
            "bad-id.pdf",
            UploadStatus::Uploading,
        );
        expired.upload_id = "../../escape".to_string();
        expired.updated_at = 10;
        persist_upload_history(&project.path_string(), std::slice::from_ref(&expired)).unwrap();

        assert!(prune_upload_history(&project.path_string(), 50).is_err());

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history, vec![expired]);
    }

    #[test]
    fn expire_temp_upload_marks_history_expired_before_cleanup() {
        let project = TempWikiProject::new("upload-history-expire");
        let record =
            sample_upload_record(&project.path_string(), "stale.pdf", UploadStatus::Uploading);

        persist_upload_history(&project.path_string(), std::slice::from_ref(&record)).unwrap();
        std::fs::create_dir_all(temp_upload_dir_path(
            &project.path_string(),
            &record.upload_id,
        ))
        .unwrap();
        std::fs::write(
            temp_upload_payload_path(&project.path_string(), &record.upload_id),
            b"payload",
        )
        .unwrap();

        expire_temp_upload(&project.path_string(), &record.upload_id, 200).unwrap();

        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history[0].status, UploadStatus::Expired);
        assert_eq!(history[0].updated_at, 200);
        assert!(!temp_upload_dir_path(&project.path_string(), &record.upload_id).exists());
    }

    #[tokio::test]
    async fn rejects_multipart_when_file_part_precedes_required_metadata() {
        let response = post_test_upload(
            test_app_with_config(test_file_receiver_config(), Vec::new()),
            raw_multipart_with_file_first(),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn aborts_stream_when_bytes_exceed_max_file_size() {
        let project = TempWikiProject::new("upload-over-limit");
        let mut config = test_file_receiver_config();
        config.max_file_size_bytes = 8;
        let response = post_test_upload(
            test_app_with_config(config, vec![project.path_string()]),
            multipart_over_limit(&project.path_string(), "limit.pdf", 16),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, UploadStatus::Failed);
        assert_eq!(
            history[0].error.as_deref(),
            Some("Upload exceeded max file size")
        );
        assert!(!temp_upload_dir_path(&project.path_string(), &history[0].upload_id).exists());
    }

    #[tokio::test]
    async fn successful_upload_moves_file_and_appends_pending_queue_record() {
        let project = TempWikiProject::new("upload-success");
        let response = post_test_upload(
            test_app_with_config(test_file_receiver_config(), vec![project.path_string()]),
            valid_upload_body(&project.path_string(), "report.pdf", b"hello"),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(Path::new(&project.path_string())
            .join("raw/sources/report.pdf")
            .exists());

        let queue = load_test_ingest_queue(&project.path_string());
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0]["status"], "pending");
        assert_eq!(queue[0]["origin"], "upload_service");
        assert_eq!(queue[0]["sourcePath"], "raw/sources/report.pdf");
    }

    #[tokio::test]
    async fn accepts_upload_larger_than_axum_default_when_within_config_limit() {
        let project = TempWikiProject::new("upload-over-default-body-limit");
        let mut config = test_file_receiver_config();
        config.max_file_size_bytes = 5 * 1024 * 1024;
        let response = post_test_upload(
            test_app_with_config(config, vec![project.path_string()]),
            valid_upload_body(
                &project.path_string(),
                "large.bin",
                &vec![b'a'; 3 * 1024 * 1024],
            ),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(Path::new(&project.path_string())
            .join("raw/sources/large.bin")
            .exists());
    }

    #[tokio::test]
    async fn rejects_metadata_after_file_and_marks_upload_failed() {
        let project = TempWikiProject::new("upload-metadata-after-file");
        let response = post_test_upload(
            test_app_with_config(test_file_receiver_config(), vec![project.path_string()]),
            multipart_with_metadata_after_file(&project.path_string(), "late.txt", b"hello"),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, UploadStatus::Failed);
        assert_eq!(
            history[0].error.as_deref(),
            Some("Metadata fields must precede the file part")
        );
        assert!(!temp_upload_dir_path(&project.path_string(), &history[0].upload_id).exists());
    }

    #[tokio::test]
    async fn rejects_second_file_part_and_marks_first_upload_failed() {
        let project = TempWikiProject::new("upload-two-files");
        let response = post_test_upload(
            test_app_with_config(test_file_receiver_config(), vec![project.path_string()]),
            multipart_with_two_files(&project.path_string()),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let history = load_upload_history(&project.path_string()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].status, UploadStatus::Failed);
        assert_eq!(
            history[0].error.as_deref(),
            Some("Only one file part is allowed per request")
        );
        assert!(!temp_upload_dir_path(&project.path_string(), &history[0].upload_id).exists());
    }

    #[tokio::test]
    async fn http_list_uploads_filters_by_whitelisted_project() {
        let project_a = TempWikiProject::new("upload-list-project-a");
        let project_b = TempWikiProject::new("upload-list-project-b");
        let record_a =
            sample_upload_record(&project_a.path_string(), "a.pdf", UploadStatus::Completed);
        let record_b =
            sample_upload_record(&project_b.path_string(), "b.pdf", UploadStatus::Failed);
        persist_upload_history(&project_a.path_string(), std::slice::from_ref(&record_a)).unwrap();
        persist_upload_history(&project_b.path_string(), std::slice::from_ref(&record_b)).unwrap();

        let response = get_test_request(
            test_app_with_config(
                test_file_receiver_config(),
                vec![project_a.path_string(), project_b.path_string()],
            ),
            &format!("/uploads?projectPath={}", &project_a.path_string()),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_body_json::<UploadListResponse>(response).await;
        assert_eq!(body.total, 1);
        assert_eq!(body.uploads, vec![record_a]);
    }

    #[tokio::test]
    async fn http_list_uploads_rejects_unknown_project_scope() {
        let project = TempWikiProject::new("upload-list-unknown-project");
        let response = get_test_request(
            test_app_with_config(test_file_receiver_config(), vec![project.path_string()]),
            "/uploads?projectPath=/tmp/not-allowed",
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn http_get_upload_returns_matching_record() {
        let project = TempWikiProject::new("upload-get-record");
        let record = sample_upload_record(
            &project.path_string(),
            "details.pdf",
            UploadStatus::Completed,
        );
        persist_upload_history(&project.path_string(), std::slice::from_ref(&record)).unwrap();

        let response = get_test_request(
            test_app_with_config(test_file_receiver_config(), vec![project.path_string()]),
            &format!("/uploads/{}", record.upload_id),
        )
        .await;

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = response_body_json::<Option<UploadRecord>>(response).await;
        assert_eq!(body, Some(record));
    }

    fn sample_upload_record(
        project_path: &str,
        file_name: &str,
        status: UploadStatus,
    ) -> UploadRecord {
        UploadRecord {
            upload_id: format!("upload-{}", file_name),
            project_path: project_path.to_string(),
            file_name: file_name.to_string(),
            mime_type: Some("application/octet-stream".to_string()),
            folder_context: "Inbox".to_string(),
            status,
            received_bytes: 128,
            total_size: Some(128),
            stored_source_path: None,
            task_id: None,
            error: None,
            started_at: 100,
            updated_at: 100,
        }
    }

    struct TempWikiProject {
        path: std::path::PathBuf,
    }

    impl TempWikiProject {
        fn new(name: &str) -> Self {
            let mut path = std::env::temp_dir();
            path.push(format!(
                "llm-wiki-file-receiver-{}-{}",
                name,
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(path.join(".llm-wiki")).unwrap();
            std::fs::create_dir_all(path.join("wiki")).unwrap();
            std::fs::write(path.join("schema.md"), "# schema").unwrap();
            std::fs::write(path.join("wiki/index.md"), "# index").unwrap();
            Self { path }
        }

        fn path_string(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempWikiProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn test_file_receiver_config() -> FileReceiverConfig {
        FileReceiverConfig {
            enabled: true,
            auto_start: true,
            host: DEFAULT_FILE_RECEIVER_HOST.to_string(),
            port: DEFAULT_FILE_RECEIVER_PORT,
            static_token: "secret".to_string(),
            max_file_size_bytes: 1024 * 1024,
            upload_ttl_hours: 24,
        }
    }

    fn test_app_with_config(config: FileReceiverConfig, known_projects: Vec<String>) -> Router {
        let state = FileReceiverSharedState::default();
        state.set_config(config);
        state.set_known_projects(known_projects);
        build_file_receiver_router(state)
    }

    async fn post_test_upload(
        app: Router,
        multipart: TestMultipartRequest,
    ) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/uploads")
                .header("authorization", "Bearer secret")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={}", multipart.boundary),
                )
                .body(Body::from(multipart.body))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn get_test_request(app: Router, uri: &str) -> axum::response::Response {
        app.oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("authorization", "Bearer secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn response_body_json<T>(response: axum::response::Response) -> T
    where
        T: serde::de::DeserializeOwned,
    {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn valid_upload_body(
        project_path: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> TestMultipartRequest {
        build_multipart_request(vec![
            text_part("projectPath", project_path),
            file_part("file", file_name, "application/octet-stream", bytes),
        ])
    }

    fn multipart_over_limit(
        project_path: &str,
        file_name: &str,
        bytes_len: usize,
    ) -> TestMultipartRequest {
        build_multipart_request(vec![
            text_part("projectPath", project_path),
            file_part(
                "file",
                file_name,
                "application/octet-stream",
                &vec![b'a'; bytes_len],
            ),
        ])
    }

    fn multipart_with_metadata_after_file(
        project_path: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> TestMultipartRequest {
        build_multipart_request(vec![
            text_part("projectPath", project_path),
            file_part("file", file_name, "application/octet-stream", bytes),
            text_part("folderContext", "Late > Metadata"),
        ])
    }

    fn multipart_with_two_files(project_path: &str) -> TestMultipartRequest {
        build_multipart_request(vec![
            text_part("projectPath", project_path),
            file_part("file", "first.txt", "text/plain", b"first"),
            file_part("file", "second.txt", "text/plain", b"second"),
        ])
    }

    fn raw_multipart_with_file_first() -> TestMultipartRequest {
        build_multipart_request(vec![
            file_part("file", "first.txt", "text/plain", b"hello"),
            text_part("projectPath", "/tmp/wiki-a"),
        ])
    }

    fn load_test_ingest_queue(project_path: &str) -> Vec<Value> {
        let raw = std::fs::read_to_string(Path::new(project_path).join(INGEST_QUEUE_RELATIVE_PATH))
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[derive(Clone)]
    struct TestMultipartRequest {
        boundary: String,
        body: Vec<u8>,
    }

    enum TestMultipartPart {
        Text {
            name: String,
            value: String,
        },
        File {
            name: String,
            file_name: String,
            content_type: String,
            bytes: Vec<u8>,
        },
    }

    fn text_part(name: &str, value: &str) -> TestMultipartPart {
        TestMultipartPart::Text {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    fn file_part(
        name: &str,
        file_name: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> TestMultipartPart {
        TestMultipartPart::File {
            name: name.to_string(),
            file_name: file_name.to_string(),
            content_type: content_type.to_string(),
            bytes: bytes.to_vec(),
        }
    }

    fn build_multipart_request(parts: Vec<TestMultipartPart>) -> TestMultipartRequest {
        let boundary = format!("boundary-{}", now_millis());
        let mut body = Vec::new();

        for part in parts {
            body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
            match part {
                TestMultipartPart::Text { name, value } => {
                    body.extend_from_slice(
                        format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", name)
                            .as_bytes(),
                    );
                    body.extend_from_slice(value.as_bytes());
                    body.extend_from_slice(b"\r\n");
                }
                TestMultipartPart::File {
                    name,
                    file_name,
                    content_type,
                    bytes,
                } => {
                    body.extend_from_slice(
                        format!(
                            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
                            name, file_name
                        )
                        .as_bytes(),
                    );
                    body.extend_from_slice(
                        format!("Content-Type: {}\r\n\r\n", content_type).as_bytes(),
                    );
                    body.extend_from_slice(&bytes);
                    body.extend_from_slice(b"\r\n");
                }
            }
        }
        body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

        TestMultipartRequest { boundary, body }
    }
}
