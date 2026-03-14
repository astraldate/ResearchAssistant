use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

use crate::cards::{self, KnowledgeCardDetail};
use crate::encyclopedia::TermLookupMode;

const MOBILE_API_VERSION: &str = "2026-03-13.v1";
const MOBILE_SERVICE_NAME: &str = "Research Assistant Desktop";
const MOBILE_STATE_FILE_NAME: &str = "mobile_companion.json";
const REVIEW_STATE_DIR_NAME: &str = "review_state";
const REVIEW_STATE_FILE_NAME: &str = "reviews.json";
const MOBILE_INBOX_DIR_NAME: &str = "mobile_inbox";
const MOBILE_INBOX_ASSET_DIR_NAME: &str = "assets";
const HTTP_MAX_HEADER_BYTES: usize = 16 * 1024;
const HTTP_MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MOBILE_PORT_CANDIDATES: [u16; 5] = [38465, 38466, 38467, 38468, 38469];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceSummary {
    pub device_id: String,
    pub device_name: String,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCompanionStatus {
    pub api_version: String,
    pub service_name: String,
    pub pair_code: String,
    pub listener_port: u16,
    pub base_urls: Vec<String>,
    pub paired_devices: Vec<PairedDeviceSummary>,
    pub inbox_count: usize,
    pub review_record_count: usize,
    pub card_count: usize,
    pub running: bool,
    pub last_error: Option<String>,
    pub inbox_dir: String,
    pub review_state_dir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileHealthResponse {
    pub api_version: String,
    pub service_name: String,
    pub running: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairRequest {
    pub pair_code: String,
    pub device_name: String,
    pub app_version: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairResponse {
    pub api_version: String,
    pub service_name: String,
    pub device_id: String,
    pub device_token: String,
    pub paired_at: String,
    pub base_urls: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileCardRecord {
    pub id: String,
    pub term: String,
    pub title: String,
    pub created_at: String,
    pub preview: String,
    pub markdown: String,
    pub source_provider: Option<String>,
    pub source_status: String,
    pub lookup_mode: String,
    pub pdf_path: Option<String>,
    pub pdf_page: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewRating {
    Again,
    Hard,
    Good,
    Easy,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewHistoryEntry {
    pub event_id: String,
    pub rating: ReviewRating,
    pub reviewed_at: String,
    pub device_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub card_id: String,
    pub due_at: String,
    pub interval_days: f32,
    pub ease_factor: f32,
    pub lapses: u32,
    pub consecutive_successes: u32,
    pub total_reviews: u32,
    pub last_rating: Option<ReviewRating>,
    pub last_reviewed_at: Option<String>,
    pub history: Vec<ReviewHistoryEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileReviewEvent {
    pub event_id: String,
    pub card_id: String,
    pub rating: ReviewRating,
    pub reviewed_at: String,
    pub device_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSyncRequest {
    pub events: Vec<MobileReviewEvent>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSyncResponse {
    pub accepted_event_ids: Vec<String>,
    pub review_records: Vec<ReviewRecord>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileCaptureKind {
    Image,
    Url,
    Note,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MobileInboxStatus {
    Received,
    Processed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInboxItemInput {
    pub capture_kind: MobileCaptureKind,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub asset_base64: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileInboxItem {
    pub id: String,
    pub capture_kind: MobileCaptureKind,
    pub status: MobileInboxStatus,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub stored_asset_path: Option<String>,
    pub device_id: String,
    pub created_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMobileInboxItem {
    pub id: String,
    pub capture_kind: MobileCaptureKind,
    pub status: MobileInboxStatus,
    pub title: Option<String>,
    pub note: Option<String>,
    pub url: Option<String>,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
    pub stored_asset_path: Option<String>,
    pub device_id: String,
    pub created_at: String,
    pub record_path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MobileBootstrapResponse {
    pub service: MobileCompanionStatus,
    pub cards: Vec<MobileCardRecord>,
    pub review_records: Vec<ReviewRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StoredMobileCompanionState {
    pair_code: String,
    paired_devices: Vec<PairedDeviceRecord>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PairedDeviceRecord {
    device_id: String,
    device_name: String,
    token: String,
    paired_at: String,
    last_seen_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StoredReviewState {
    records: HashMap<String, ReviewRecord>,
    applied_event_ids: HashSet<String>,
}

#[derive(Clone, Debug, Default)]
struct MobileCompanionRuntime {
    pair_code: String,
    paired_devices: Vec<PairedDeviceRecord>,
    listener_port: u16,
    base_urls: Vec<String>,
    running: bool,
    last_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct MobileCompanionState {
    inner: Arc<Mutex<MobileCompanionRuntime>>,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl MobileCompanionState {
    pub fn new() -> Self {
        Self::default()
    }

    fn snapshot(&self) -> Result<MobileCompanionRuntime, String> {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .map_err(|error| format!("Failed to lock mobile companion state: {}", error))
    }
}

impl HttpResponse {
    fn json<T: Serialize>(status: u16, value: &T) -> Self {
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body,
        }
    }

    fn text(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: message.into().into_bytes(),
        }
    }
}

pub fn initialize_mobile_companion(
    app: AppHandle,
    state: MobileCompanionState,
) -> Result<(), String> {
    ensure_mobile_dirs(&app)?;

    let mut stored = read_stored_mobile_state(&app)?;
    if stored.pair_code.trim().is_empty() {
        stored.pair_code = generate_pair_code();
        write_stored_mobile_state(&app, &stored)?;
    }

    {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        runtime.pair_code = stored.pair_code.clone();
        runtime.paired_devices = stored.paired_devices.clone();
        runtime.listener_port = 0;
        runtime.base_urls.clear();
        runtime.running = false;
        runtime.last_error = None;
    }

    match bind_mobile_listener() {
        Ok((listener, port)) => {
            let base_urls = detect_base_urls(port);
            {
                let mut runtime = state.inner.lock().map_err(|error| {
                    format!("Failed to lock mobile companion runtime: {}", error)
                })?;
                runtime.listener_port = port;
                runtime.base_urls = base_urls;
                runtime.running = true;
                runtime.last_error = None;
            }

            let app_handle = app.clone();
            let state_handle = state.clone();
            tauri::async_runtime::spawn(async move {
                let listener = match TcpListener::from_std(listener) {
                    Ok(value) => value,
                    Err(error) => {
                        if let Ok(mut runtime) = state_handle.inner.lock() {
                            runtime.running = false;
                            runtime.last_error = Some(format!(
                                "Failed to attach mobile companion listener to Tokio runtime: {}",
                                error
                            ));
                        }
                        return;
                    }
                };
                serve_mobile_requests(listener, app_handle, state_handle).await;
            });
        }
        Err(error) => {
            let mut runtime = state.inner.lock().map_err(|lock_error| {
                format!("Failed to lock mobile companion runtime: {}", lock_error)
            })?;
            runtime.running = false;
            runtime.last_error = Some(error);
        }
    }

    Ok(())
}

pub fn get_mobile_companion_status(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    build_mobile_status(app, state)
}

pub fn refresh_mobile_pair_code(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        runtime.pair_code = generate_pair_code();
    }
    persist_runtime_state(app, state)?;
    build_mobile_status(app, state)
}

pub fn list_mobile_inbox_items(app: &AppHandle) -> Result<Vec<DesktopMobileInboxItem>, String> {
    ensure_mobile_dirs(app)?;
    let mut items = Vec::new();

    for path in mobile_inbox_record_paths(app)? {
        let item = match read_mobile_inbox_item_file(&path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "Failed to load mobile inbox item '{}': {}",
                    path.display(),
                    error
                );
                continue;
            }
        };
        items.push(map_desktop_mobile_inbox_item(item, path));
    }

    items.sort_by(|left, right| {
        mobile_inbox_status_rank(left.status)
            .cmp(&mobile_inbox_status_rank(right.status))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    Ok(items)
}

pub fn set_mobile_inbox_item_status(
    app: &AppHandle,
    item_id: &str,
    processed: bool,
) -> Result<DesktopMobileInboxItem, String> {
    ensure_mobile_dirs(app)?;
    let normalized_id = item_id.trim();
    if normalized_id.is_empty() {
        return Err("Inbox item id must not be empty.".to_string());
    }

    let (mut item, path) = find_mobile_inbox_item_by_id(app, normalized_id)?;
    item.status = if processed {
        MobileInboxStatus::Processed
    } else {
        MobileInboxStatus::Received
    };
    write_mobile_inbox_item_file(&path, &item)?;
    Ok(map_desktop_mobile_inbox_item(item, path))
}

async fn serve_mobile_requests(listener: TcpListener, app: AppHandle, state: MobileCompanionState) {
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                let app_handle = app.clone();
                let state_handle = state.clone();
                tauri::async_runtime::spawn(async move {
                    handle_mobile_socket(socket, app_handle, state_handle).await;
                });
            }
            Err(error) => {
                if let Ok(mut runtime) = state.inner.lock() {
                    runtime.running = false;
                    runtime.last_error =
                        Some(format!("Mobile companion listener stopped: {}", error));
                }
                break;
            }
        }
    }
}

async fn handle_mobile_socket(mut socket: TcpStream, app: AppHandle, state: MobileCompanionState) {
    let response = match read_http_request(&mut socket).await {
        Ok(request) => route_http_request(&app, &state, request).await,
        Err(error) => HttpResponse::text(400, error),
    };
    let _ = write_http_response(&mut socket, response).await;
}

async fn route_http_request(
    app: &AppHandle,
    state: &MobileCompanionState,
    request: HttpRequest,
) -> HttpResponse {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/mobile/v1/health") => {
            let snapshot = match state.snapshot() {
                Ok(value) => value,
                Err(error) => return HttpResponse::text(500, error),
            };
            HttpResponse::json(
                200,
                &MobileHealthResponse {
                    api_version: MOBILE_API_VERSION.to_string(),
                    service_name: MOBILE_SERVICE_NAME.to_string(),
                    running: snapshot.running,
                },
            )
        }
        ("POST", "/api/mobile/v1/pair") => {
            let payload = match serde_json::from_slice::<MobilePairRequest>(&request.body) {
                Ok(value) => value,
                Err(error) => {
                    return HttpResponse::text(400, format!("Invalid pair payload: {}", error))
                }
            };
            match pair_device(app, state, payload) {
                Ok(response) => HttpResponse::json(200, &response),
                Err(error) => HttpResponse::text(403, error),
            }
        }
        ("GET", "/api/mobile/v1/bootstrap") => {
            let _device = match authorize_request(app, state, &request.headers) {
                Ok(device) => device,
                Err(error) => return HttpResponse::text(401, error),
            };
            match load_bootstrap_payload(app, state) {
                Ok(response) => HttpResponse::json(200, &response),
                Err(error) => HttpResponse::text(500, error),
            }
        }
        ("POST", "/api/mobile/v1/review-events") => {
            let _device = match authorize_request(app, state, &request.headers) {
                Ok(device) => device,
                Err(error) => return HttpResponse::text(401, error),
            };
            let payload = match serde_json::from_slice::<ReviewSyncRequest>(&request.body) {
                Ok(value) => value,
                Err(error) => {
                    return HttpResponse::text(400, format!("Invalid review payload: {}", error))
                }
            };
            match apply_review_events(app, payload) {
                Ok(response) => HttpResponse::json(200, &response),
                Err(error) => HttpResponse::text(500, error),
            }
        }
        ("POST", "/api/mobile/v1/inbox/items") => {
            let device = match authorize_request(app, state, &request.headers) {
                Ok(value) => value,
                Err(error) => return HttpResponse::text(401, error),
            };
            let payload = match serde_json::from_slice::<MobileInboxItemInput>(&request.body) {
                Ok(value) => value,
                Err(error) => {
                    return HttpResponse::text(400, format!("Invalid inbox payload: {}", error))
                }
            };
            match store_inbox_item(app, &device.device_id, payload) {
                Ok(item) => HttpResponse::json(200, &item),
                Err(error) => HttpResponse::text(500, error),
            }
        }
        _ => HttpResponse::json(404, &json!({ "error": "Not Found" })),
    }
}

async fn read_http_request(socket: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::new();
    let header_end;

    loop {
        let mut chunk = [0u8; 4096];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Connection closed before request headers were received.".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > HTTP_MAX_HEADER_BYTES {
            return Err("HTTP headers exceeded the maximum supported size.".to_string());
        }
        if let Some(index) = find_subsequence(&buffer, b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n").filter(|line| !line.is_empty());
    let request_line = lines
        .next()
        .ok_or_else(|| "Missing HTTP request line.".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP method.".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Missing HTTP path.".to_string())?
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > HTTP_MAX_BODY_BYTES {
        return Err("HTTP body exceeded the maximum supported size.".to_string());
    }

    while buffer.len().saturating_sub(header_end) < content_length {
        let mut chunk = [0u8; 4096];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Connection closed before request body was fully received.".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len().saturating_sub(header_end) > HTTP_MAX_BODY_BYTES {
            return Err("HTTP body exceeded the maximum supported size.".to_string());
        }
    }

    let body = buffer[header_end..header_end + content_length].to_vec();
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(socket: &mut TcpStream, response: HttpResponse) -> Result<(), String> {
    let status_text = match response.status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };

    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        status_text,
        response.content_type,
        response.body.len()
    );
    socket
        .write_all(header.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    socket
        .write_all(&response.body)
        .await
        .map_err(|error| error.to_string())?;
    socket.flush().await.map_err(|error| error.to_string())
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn bind_mobile_listener() -> Result<(std::net::TcpListener, u16), String> {
    for port in MOBILE_PORT_CANDIDATES {
        match std::net::TcpListener::bind(("0.0.0.0", port)) {
            Ok(listener) => {
                listener
                    .set_nonblocking(true)
                    .map_err(|error| error.to_string())?;
                return Ok((listener, port));
            }
            Err(_) => continue,
        }
    }

    Err("No available mobile companion port was found in the configured range.".to_string())
}

fn detect_base_urls(port: u16) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(ip) = infer_lan_ip() {
        urls.push(format!("http://{}:{}", ip, port));
    }
    urls.push(format!("http://127.0.0.1:{}", port));
    urls
}

fn infer_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn build_mobile_status(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileCompanionStatus, String> {
    ensure_mobile_dirs(app)?;
    let snapshot = state.snapshot()?;
    let cards = cards::list_knowledge_cards(app)?;
    let review_state = read_review_state(app)?;
    let inbox_dir = mobile_inbox_dir(app)?;
    let review_dir = review_state_dir(app)?;

    Ok(MobileCompanionStatus {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        pair_code: snapshot.pair_code,
        listener_port: snapshot.listener_port,
        base_urls: snapshot.base_urls,
        paired_devices: snapshot
            .paired_devices
            .into_iter()
            .map(|device| PairedDeviceSummary {
                device_id: device.device_id,
                device_name: device.device_name,
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
            })
            .collect(),
        inbox_count: count_inbox_items(&inbox_dir)?,
        review_record_count: review_state.records.len(),
        card_count: cards.len(),
        running: snapshot.running,
        last_error: snapshot.last_error,
        inbox_dir: inbox_dir.to_string_lossy().to_string(),
        review_state_dir: review_dir.to_string_lossy().to_string(),
    })
}

fn pair_device(
    app: &AppHandle,
    state: &MobileCompanionState,
    request: MobilePairRequest,
) -> Result<MobilePairResponse, String> {
    let trimmed_code = request.pair_code.trim();
    let trimmed_name = request.device_name.trim();
    if trimmed_name.is_empty() {
        return Err("Device name must not be empty.".to_string());
    }

    let paired_at = cards::current_timestamp_iso_utc();
    let (device_id, token, base_urls) = {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        if runtime.pair_code.trim() != trimmed_code {
            return Err("Pair code is invalid.".to_string());
        }

        let device_id = Uuid::new_v4().simple().to_string();
        let token = Uuid::new_v4().simple().to_string();
        runtime.paired_devices.push(PairedDeviceRecord {
            device_id: device_id.clone(),
            device_name: trimmed_name.to_string(),
            token: token.clone(),
            paired_at: paired_at.clone(),
            last_seen_at: Some(paired_at.clone()),
        });
        (device_id, token, runtime.base_urls.clone())
    };

    persist_runtime_state(app, state)?;
    Ok(MobilePairResponse {
        api_version: MOBILE_API_VERSION.to_string(),
        service_name: MOBILE_SERVICE_NAME.to_string(),
        device_id,
        device_token: token,
        paired_at,
        base_urls,
    })
}

fn authorize_request(
    app: &AppHandle,
    state: &MobileCompanionState,
    headers: &HashMap<String, String>,
) -> Result<PairedDeviceRecord, String> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing bearer token.".to_string())?;

    let current_timestamp = cards::current_timestamp_iso_utc();
    let device = {
        let mut runtime = state
            .inner
            .lock()
            .map_err(|error| format!("Failed to lock mobile companion runtime: {}", error))?;
        let device = runtime
            .paired_devices
            .iter_mut()
            .find(|device| device.token == token)
            .ok_or_else(|| "Bearer token is invalid.".to_string())?;
        device.last_seen_at = Some(current_timestamp.clone());
        device.clone()
    };

    persist_runtime_state(app, state)?;
    Ok(device)
}

fn load_bootstrap_payload(
    app: &AppHandle,
    state: &MobileCompanionState,
) -> Result<MobileBootstrapResponse, String> {
    Ok(MobileBootstrapResponse {
        service: build_mobile_status(app, state)?,
        cards: load_mobile_cards(app)?,
        review_records: sorted_review_records(
            read_review_state(app)?.records.into_values().collect(),
        ),
    })
}

fn load_mobile_cards(app: &AppHandle) -> Result<Vec<MobileCardRecord>, String> {
    let summaries = cards::list_knowledge_cards(app)?;
    let mut result = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let detail = cards::read_knowledge_card(summary.path.clone())?;
        result.push(map_card_detail(detail));
    }
    Ok(result)
}

fn map_card_detail(detail: KnowledgeCardDetail) -> MobileCardRecord {
    MobileCardRecord {
        id: detail.meta.id,
        term: detail.meta.term,
        title: detail.meta.title,
        created_at: detail.meta.created_at,
        preview: detail.meta.preview,
        markdown: detail.markdown,
        source_provider: detail.meta.source_provider,
        source_status: detail.meta.source_status,
        lookup_mode: lookup_mode_key(detail.meta.lookup_mode).to_string(),
        pdf_path: detail.meta.pdf_path,
        pdf_page: detail.meta.pdf_page,
    }
}

fn lookup_mode_key(mode: TermLookupMode) -> &'static str {
    match mode {
        TermLookupMode::PopularCn => "popular_cn",
        TermLookupMode::CsEncyclopedia => "cs_encyclopedia",
        TermLookupMode::Bioinformatics => "bioinformatics",
    }
}

fn apply_review_events(
    app: &AppHandle,
    payload: ReviewSyncRequest,
) -> Result<ReviewSyncResponse, String> {
    let mut store = read_review_state(app)?;
    let mut accepted_event_ids = Vec::new();

    for event in payload.events {
        if event.event_id.trim().is_empty() || event.card_id.trim().is_empty() {
            continue;
        }
        if !store.applied_event_ids.insert(event.event_id.clone()) {
            accepted_event_ids.push(event.event_id.clone());
            continue;
        }

        let current = store.records.get(&event.card_id).cloned();
        let next = apply_review_event(current, &event);
        store.records.insert(event.card_id.clone(), next);
        accepted_event_ids.push(event.event_id);
    }

    write_review_state(app, &store)?;
    Ok(ReviewSyncResponse {
        accepted_event_ids,
        review_records: sorted_review_records(store.records.into_values().collect()),
    })
}

fn apply_review_event(current: Option<ReviewRecord>, event: &MobileReviewEvent) -> ReviewRecord {
    let mut record = current.unwrap_or_else(|| ReviewRecord {
        card_id: event.card_id.clone(),
        due_at: event.reviewed_at.clone(),
        interval_days: 0.0,
        ease_factor: 2.5,
        lapses: 0,
        consecutive_successes: 0,
        total_reviews: 0,
        last_rating: None,
        last_reviewed_at: None,
        history: Vec::new(),
    });

    let mut ease_factor = record.ease_factor.max(1.3);
    let mut interval_days = record.interval_days.max(0.0);

    match event.rating {
        ReviewRating::Again => {
            ease_factor = (ease_factor - 0.2).max(1.3);
            interval_days = 1.0;
            record.lapses += 1;
            record.consecutive_successes = 0;
        }
        ReviewRating::Hard => {
            ease_factor = (ease_factor - 0.15).max(1.3);
            interval_days = if record.total_reviews == 0 {
                1.0
            } else {
                (interval_days.max(1.0) * 1.2).round().max(1.0)
            };
            record.consecutive_successes += 1;
        }
        ReviewRating::Good => {
            interval_days = if record.total_reviews == 0 {
                1.0
            } else {
                (interval_days.max(1.0) * ease_factor).round().max(2.0)
            };
            record.consecutive_successes += 1;
        }
        ReviewRating::Easy => {
            ease_factor += 0.15;
            interval_days = if record.total_reviews == 0 {
                3.0
            } else {
                (interval_days.max(1.0) * ease_factor * 1.3)
                    .round()
                    .max(4.0)
            };
            record.consecutive_successes += 1;
        }
    }

    record.interval_days = interval_days;
    record.ease_factor = (ease_factor * 100.0).round() / 100.0;
    record.total_reviews += 1;
    record.last_rating = Some(event.rating);
    record.last_reviewed_at = Some(event.reviewed_at.clone());
    record.due_at = add_days_to_iso(&event.reviewed_at, interval_days);
    record.history.push(ReviewHistoryEntry {
        event_id: event.event_id.clone(),
        rating: event.rating,
        reviewed_at: event.reviewed_at.clone(),
        device_id: event.device_id.clone(),
    });
    if record.history.len() > 60 {
        let drain = record.history.len() - 60;
        record.history.drain(0..drain);
    }

    record
}

fn sorted_review_records(mut records: Vec<ReviewRecord>) -> Vec<ReviewRecord> {
    records.sort_by(|left, right| left.due_at.cmp(&right.due_at));
    records
}

fn store_inbox_item(
    app: &AppHandle,
    device_id: &str,
    input: MobileInboxItemInput,
) -> Result<MobileInboxItem, String> {
    ensure_mobile_dirs(app)?;
    let inbox_dir = mobile_inbox_dir(app)?;
    let asset_dir = inbox_asset_dir(app)?;
    let item_id = Uuid::new_v4().simple().to_string();
    let created_at = input
        .created_at
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(cards::current_timestamp_iso_utc);

    let stored_asset_path = if let Some(raw_base64) = input.asset_base64.as_deref() {
        let file_name = input
            .file_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(sanitize_file_name)
            .unwrap_or_else(|| default_asset_file_name(&item_id, input.mime_type.as_deref()));
        let asset_path = asset_dir.join(file_name);
        let bytes = STANDARD
            .decode(raw_base64.trim())
            .map_err(|error| format!("Failed to decode image payload: {}", error))?;
        fs::write(&asset_path, bytes).map_err(|error| error.to_string())?;
        Some(asset_path.to_string_lossy().to_string())
    } else {
        None
    };

    let item = MobileInboxItem {
        id: item_id.clone(),
        capture_kind: input.capture_kind,
        status: MobileInboxStatus::Received,
        title: input.title.clone().filter(|value| !value.trim().is_empty()),
        note: input.note.clone().filter(|value| !value.trim().is_empty()),
        url: input.url.clone().filter(|value| !value.trim().is_empty()),
        file_name: input
            .file_name
            .clone()
            .filter(|value| !value.trim().is_empty()),
        mime_type: input
            .mime_type
            .clone()
            .filter(|value| !value.trim().is_empty()),
        stored_asset_path,
        device_id: device_id.to_string(),
        created_at: created_at.clone(),
    };

    let json_path = inbox_dir.join(format!("{}-{}.json", current_file_tag(), item_id));
    let content = serde_json::to_string_pretty(&item).map_err(|error| error.to_string())?;
    fs::write(json_path, content).map_err(|error| error.to_string())?;
    Ok(item)
}

fn map_desktop_mobile_inbox_item(
    item: MobileInboxItem,
    record_path: PathBuf,
) -> DesktopMobileInboxItem {
    DesktopMobileInboxItem {
        id: item.id,
        capture_kind: item.capture_kind,
        status: item.status,
        title: item.title,
        note: item.note,
        url: item.url,
        file_name: item.file_name,
        mime_type: item.mime_type,
        stored_asset_path: item.stored_asset_path,
        device_id: item.device_id,
        created_at: item.created_at,
        record_path: record_path.to_string_lossy().to_string(),
    }
}

fn mobile_inbox_status_rank(status: MobileInboxStatus) -> u8 {
    match status {
        MobileInboxStatus::Received => 0,
        MobileInboxStatus::Processed => 1,
    }
}

fn mobile_inbox_record_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(mobile_inbox_dir(app)?).map_err(|error| error.to_string())?;
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() && is_json_file(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn find_mobile_inbox_item_by_id(
    app: &AppHandle,
    item_id: &str,
) -> Result<(MobileInboxItem, PathBuf), String> {
    for path in mobile_inbox_record_paths(app)? {
        let item = match read_mobile_inbox_item_file(&path) {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "Failed to load mobile inbox item '{}': {}",
                    path.display(),
                    error
                );
                continue;
            }
        };
        if item.id == item_id {
            return Ok((item, path));
        }
    }

    Err(format!("Mobile inbox item '{}' was not found.", item_id))
}

fn read_mobile_inbox_item_file(path: &Path) -> Result<MobileInboxItem, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_mobile_inbox_item_file(path: &Path, item: &MobileInboxItem) -> Result<(), String> {
    let content = serde_json::to_string_pretty(item).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn default_asset_file_name(item_id: &str, mime_type: Option<&str>) -> String {
    let extension = match mime_type.unwrap_or_default() {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    format!("{}-capture.{}", item_id, extension)
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect::<String>();
    if sanitized.trim_matches('_').is_empty() {
        "capture.jpg".to_string()
    } else {
        sanitized
    }
}

fn persist_runtime_state(app: &AppHandle, state: &MobileCompanionState) -> Result<(), String> {
    let snapshot = state.snapshot()?;
    write_stored_mobile_state(
        app,
        &StoredMobileCompanionState {
            pair_code: snapshot.pair_code,
            paired_devices: snapshot.paired_devices,
        },
    )
}

fn read_stored_mobile_state(app: &AppHandle) -> Result<StoredMobileCompanionState, String> {
    let path = mobile_state_file(app)?;
    if !path.exists() {
        return Ok(StoredMobileCompanionState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_stored_mobile_state(
    app: &AppHandle,
    state: &StoredMobileCompanionState,
) -> Result<(), String> {
    let path = mobile_state_file(app)?;
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn read_review_state(app: &AppHandle) -> Result<StoredReviewState, String> {
    let path = review_state_file(app)?;
    if !path.exists() {
        return Ok(StoredReviewState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content).map_err(|error| error.to_string())
}

fn write_review_state(app: &AppHandle, state: &StoredReviewState) -> Result<(), String> {
    let path = review_state_file(app)?;
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn ensure_mobile_dirs(app: &AppHandle) -> Result<(), String> {
    fs::create_dir_all(mobile_inbox_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(inbox_asset_dir(app)?).map_err(|error| error.to_string())?;
    fs::create_dir_all(review_state_dir(app)?).map_err(|error| error.to_string())?;
    Ok(())
}

fn mobile_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_STATE_FILE_NAME))
}

fn review_state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(REVIEW_STATE_DIR_NAME))
}

fn review_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(review_state_dir(app)?.join(REVIEW_STATE_FILE_NAME))
}

fn mobile_inbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(MOBILE_INBOX_DIR_NAME))
}

fn inbox_asset_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(mobile_inbox_dir(app)?.join(MOBILE_INBOX_ASSET_DIR_NAME))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn count_inbox_items(dir: &Path) -> Result<usize, String> {
    let entries = fs::read_dir(dir).map_err(|error| error.to_string())?;
    Ok(entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter(|entry| is_json_file(&entry.path()))
        .count())
}

fn is_json_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

fn generate_pair_code() -> String {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    format!("{:06}", seed % 1_000_000)
}

fn current_file_tag() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

fn add_days_to_iso(iso: &str, interval_days: f32) -> String {
    let base = parse_iso_utc(iso).unwrap_or_else(current_unix_seconds);
    unix_seconds_to_iso(base + (interval_days.round() as i64 * 86_400))
}

fn parse_iso_utc(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    let date_time = trimmed.strip_suffix('Z')?;
    let (date, time) = date_time.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let time_part = time.split('.').next().unwrap_or(time);
    let mut time_parts = time_part.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let second = time_parts.next()?.parse::<u32>().ok()?;
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64)
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn unix_seconds_to_iso(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let yoe = adjusted_year - era * 400;
    let month_index = month as i32;
    let doy = (153 * (month_index + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) as i64
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}
