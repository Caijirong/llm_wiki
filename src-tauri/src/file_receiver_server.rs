use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::async_runtime::JoinHandle;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_FILE_RECEIVER_HOST: &str = "127.0.0.1";
pub const DEFAULT_FILE_RECEIVER_PORT: u16 = 18766;
const DEFAULT_MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_TTL_HOURS: u64 = 24 * 7;

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
    Pending,
    Receiving,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadRecord {
    pub upload_id: String,
    pub status: UploadStatus,
    pub project_path: String,
    pub file_name: String,
    pub received_bytes: u64,
    pub stored_source_path: Option<String>,
    pub task_id: Option<String>,
    pub error: Option<String>,
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
    server: Option<FileReceiverServerHandle>,
}

struct FileReceiverServerHandle {
    cancellation_token: CancellationToken,
    task: JoinHandle<()>,
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
            server.task.abort();
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
    _manager: State<'_, FileReceiverRuntimeManager>,
) -> UploadListResponse {
    let _ = (project_path, status, limit);
    UploadListResponse {
        uploads: Vec::new(),
        total: 0,
    }
}

#[tauri::command]
pub fn get_upload(
    upload_id: String,
    project_path: Option<String>,
    _manager: State<'_, FileReceiverRuntimeManager>,
) -> Result<Option<UploadRecord>, String> {
    let _ = (upload_id, project_path);
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
}
