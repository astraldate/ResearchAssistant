// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use tauri::{State, Emitter, Window};
use serde::{Deserialize, Serialize};
use futures_util::StreamExt;

mod rag;
use rag::{RagState, Document};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub type_name: String, // "file" or "folder"
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaModel {
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub details: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OllamaModelList {
    pub models: Vec<OllamaModel>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PullProgress {
    pub status: String,
    pub digest: Option<String>,
    pub total: Option<u64>,
    pub completed: Option<u64>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn scan_directory(path: String) -> Result<FileNode, String> {
    use std::path::Path;

    let root_path = Path::new(&path);
    if !root_path.exists() {
        return Err("Path does not exist".to_string());
    }

    // Simple recursive function to build tree
    fn build_tree(path: &Path) -> FileNode {
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        
        let mut children = if is_dir {
            Some(Vec::new())
        } else {
            None
        };

        if is_dir {
            if let Ok(entries) = std::fs::read_dir(path) {
                let mut nodes = Vec::new();
                for entry in entries.filter_map(|e| e.ok()) {
                    let p = entry.path();
                    // Skip hidden files
                    if p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) {
                        continue;
                    }
                    nodes.push(build_tree(&p));
                }
                // Sort folders first, then files
                nodes.sort_by(|a, b| {
                    match (a.type_name.as_str(), b.type_name.as_str()) {
                        ("folder", "file") => std::cmp::Ordering::Less,
                        ("file", "folder") => std::cmp::Ordering::Greater,
                        _ => a.name.cmp(&b.name),
                    }
                });
                children = Some(nodes);
            }
        }

        FileNode {
            id: path.to_string_lossy().to_string(),
            name: if name.is_empty() { path.to_string_lossy().to_string() } else { name },
            path: path.to_string_lossy().to_string(),
            type_name: if is_dir { "folder".to_string() } else { "file".to_string() },
            children,
        }
    }

    Ok(build_tree(root_path))
}

#[tauri::command]
async fn ingest_knowledge_base(path: String, state: State<'_, RagState>) -> Result<usize, String> {
    state.ingest_directory(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn query_knowledge_base(query: String, state: State<'_, RagState>) -> Result<Vec<Document>, String> {
    state.search(&query, 5).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_ollama_models() -> Result<Vec<OllamaModel>, String> {
    let client = reqwest::Client::new();
    let res = client.get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if res.status().is_success() {
        let list: OllamaModelList = res.json().await.map_err(|e| e.to_string())?;
        Ok(list.models)
    } else {
        Err(format!("Ollama API error: {}", res.status()))
    }
}

#[tauri::command]
async fn pull_ollama_model(name: String, window: Window) -> Result<(), String> {
    let client = reqwest::Client::new();
    let res = client.post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ "name": name, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Ollama API error: {}", res.status()));
    }

    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                // Ollama can send multiple JSON objects in one chunk
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    for line in text.lines() {
                        if !line.trim().is_empty() {
                            if let Ok(progress) = serde_json::from_str::<PullProgress>(line) {
                                let _ = window.emit("pull-progress", &progress);
                            }
                        }
                    }
                }
            }
            Err(e) => return Err(format!("Stream error: {}", e)),
        }
    }

    Ok(())
}

#[tauri::command]
async fn chat_with_llm(query: String, context: String, model: String) -> Result<String, String> {
    // Call local LLM via OpenAI compatible API
    // Supports Ollama (v0.1.24+) and vLLM
    // Default to localhost:11434/v1 (Ollama default)
    
    let client = reqwest::Client::new();
    let prompt = format!(
        "Use the following context to answer the question. If the answer is not in the context, say so.\n\nContext:\n{}\n\nQuestion: {}",
        context, query
    );

    let messages = serde_json::json!([
        { "role": "system", "content": "You are a helpful research assistant." },
        { "role": "user", "content": prompt }
    ]);

    let body = serde_json::json!({
        "model": model, 
        "messages": messages,
        "stream": false
    });

    // Try Ollama default port
    let url = "http://localhost:11434/v1/chat/completions";
    
    let res = client.post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to LLM at {}: {}", url, e))?;

    if res.status().is_success() {
        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(choices) = json.get("choices") {
            if let Some(choice) = choices.get(0) {
                if let Some(message) = choice.get("message") {
                    if let Some(content) = message.get("content") {
                         if let Some(text) = content.as_str() {
                             return Ok(text.to_string());
                         }
                    }
                }
            }
        }
    } else {
         return Err(format!("LLM returned error: {}", res.status()));
    }

    // Fallback or error
    Err("Failed to get valid response from LLM".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let rag_state = RagState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(rag_state)
        .invoke_handler(tauri::generate_handler![
            greet, 
            scan_directory, 
            ingest_knowledge_base, 
            query_knowledge_base,
            get_ollama_models,
            pull_ollama_model,
            chat_with_llm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
