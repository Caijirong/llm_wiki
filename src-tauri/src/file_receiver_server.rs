use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::GetLastError,
    Storage::FileSystem::{ReplaceFileW, REPLACEFILE_IGNORE_MERGE_ERRORS},
};

pub const DEFAULT_FILE_RECEIVER_HOST: &str = "127.0.0.1";
pub const DEFAULT_FILE_RECEIVER_PORT: u16 = 18766;
const DEFAULT_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_HOURS: u64 = 24 * 7;
const UPLOADS_RELATIVE_DIR: &str = ".llm-wiki/uploads";
const UPLOAD_HISTORY_RELATIVE_PATH: &str = ".llm-wiki/upload-history.json";
const UPLOAD_METADATA_FILE_NAME: &str = "metadata.json";
const UPLOAD_PAYLOAD_FILE_NAME: &str = "payload.bin";

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
    cancellation_token: CancellationToken,
    task: Option<JoinHandle<()>>,
}

#[derive(Clone)]
struct FileReceiverSharedState {
    known_projects: Arc<Mutex<Vec<String>>>,
}

impl Default for FileReceiverSharedState {
    fn default() -> Self {
        Self {
            known_projects: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl FileReceiverSharedState {
    fn set_known_projects(&self, project_paths: Vec<String>) {
        *lock_or_recover(&self.known_projects) = project_paths;
    }

    fn known_projects(&self) -> Vec<String> {
        lock_or_recover(&self.known_projects).clone()
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
            if let Some(task) = server.task {
                task.abort();
            }
        }
    }

    fn update_config(&mut self, config: FileReceiverConfig) -> Result<(), String> {
        validate_file_receiver_config(&config)?;

        self.config = config;
        self.stop_server();
        self.status = FileReceiverStatus::Stopped;
        self.last_error = None;
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
    pub(crate) fn snapshot(&self) -> FileReceiverRuntimeState {
        lock_or_recover(&self.inner).snapshot()
    }

    pub(crate) fn stop(&self) {
        lock_or_recover(&self.inner).stop();
    }

    pub(crate) fn update_config(&self, config: FileReceiverConfig) -> Result<(), String> {
        lock_or_recover(&self.inner).update_config(config)
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
    let scoped_project = project_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty());
    let project_paths = match project_path {
        Some(path) if !path.trim().is_empty() => vec![path],
        _ => manager.known_project_paths(),
    };
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

#[tauri::command]
pub fn get_upload(
    upload_id: String,
    project_path: Option<String>,
    manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<Option<UploadRecord>, String> {
    let scoped_project = project_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty());
    let project_paths = match project_path {
        Some(path) if !path.trim().is_empty() => vec![path],
        _ => manager.known_project_paths(),
    };

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
}
