use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::sync::Arc;
use text_splitter::TextSplitter;
use tokio::sync::{Mutex, mpsc::UnboundedSender};
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Document {
    pub id: String,
    pub path: String,
    pub content: String,
    pub vector: Vec<f32>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IngestMode {
    Overwrite,
    Incremental,
}

impl Default for IngestMode {
    fn default() -> Self {
        Self::Overwrite
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IngestProgress {
    pub stage: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

impl IngestProgress {
    pub fn new(stage: &str, current: usize, total: usize, message: impl Into<String>) -> Self {
        Self {
            stage: stage.to_string(),
            current,
            total,
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub struct RagState {
    pub documents: Arc<Mutex<Vec<Document>>>,
}

fn emit_progress(tx: &Option<UnboundedSender<IngestProgress>>, progress: IngestProgress) {
    if let Some(sender) = tx {
        let _ = sender.send(progress);
    }
}

fn read_pdf_text(path: &std::path::Path) -> std::io::Result<String> {
    let doc = lopdf::Document::load(path).map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut text = String::new();

    for (_, page_id) in doc.get_pages() {
        if let Ok(content) = doc.get_page_content(page_id) {
            if let Ok(content_obj) = lopdf::content::Content::decode(&content) {
                for operation in &content_obj.operations {
                    if let Some(s) = RagState::extract_text_from_operation(operation) {
                        text.push_str(&s);
                        text.push(' ');
                    }
                }
            }
        }
    }

    Ok(text)
}

impl RagState {
    pub fn new() -> Self {
        Self {
            documents: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn load(&self, path: &str) -> Result<()> {
        if let Ok(content) = fs::read_to_string(path) {
            let docs: Vec<Document> = serde_json::from_str(&content)?;
            let mut store = self.documents.lock().await;
            *store = docs;
        }
        Ok(())
    }

    pub async fn save(&self, path: &str) -> Result<()> {
        let store = self.documents.lock().await;
        let content = serde_json::to_string(&*store)?;
        fs::write(path, content)?;
        Ok(())
    }

    async fn get_embedding(text: &str) -> Result<Vec<f32>> {
        let client = reqwest::Client::new();
        let res = client
            .post("http://localhost:11434/api/embeddings")
            .json(&serde_json::json!({
                "model": "nomic-embed-text",
                "prompt": text
            }))
            .send()
            .await?;

        if !res.status().is_success() {
            return Err(anyhow!(
                "Ollama embedding failed: {}. Make sure 'nomic-embed-text' is available.",
                res.status()
            ));
        }

        let json: serde_json::Value = res.json().await?;
        let embedding = json["embedding"]
            .as_array()
            .ok_or(anyhow!("No embedding found in response"))?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as f32)
            .collect();

        Ok(embedding)
    }

    async fn summarize(text: &str, model: &str) -> Result<String> {
        let client = reqwest::Client::new();
        let prompt = format!(
            "Summarize the following academic text concisely. Focus on key methods, findings, and conclusions.\n\nText:\n{}",
            text
        );

        let res = client
            .post("http://localhost:11434/api/generate")
            .json(&serde_json::json!({
                "model": model,
                "prompt": prompt,
                "stream": false
            }))
            .send()
            .await?;

        if !res.status().is_success() {
            return Err(anyhow!("Ollama summarization failed: {}", res.status()));
        }

        let json: serde_json::Value = res.json().await?;
        let summary = json["response"]
            .as_str()
            .ok_or(anyhow!("No summarization response found"))?
            .trim()
            .to_string();
        Ok(summary)
    }

    pub async fn ingest_directory(
        &self,
        path: &str,
        model_name: &str,
        mode: IngestMode,
        progress_tx: Option<UnboundedSender<IngestProgress>>,
    ) -> Result<usize> {
        let path_owned = path.to_string();
        emit_progress(
            &progress_tx,
            IngestProgress::new("scan", 0, 0, "正在扫描文件..."),
        );

        let raw_files: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
            let mut files = Vec::new();
            let walker = WalkDir::new(path_owned).into_iter();

            for entry in walker.filter_map(|e| e.ok()) {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }

                let ext = match p.extension().map(|s| s.to_string_lossy().to_lowercase()) {
                    Some(e) => e,
                    None => continue,
                };

                let content_res = match ext.as_str() {
                    "md" | "txt" => fs::read_to_string(p),
                    "pdf" => read_pdf_text(p),
                    _ => continue,
                };

                if let Ok(content) = content_res {
                    if content.trim().is_empty() {
                        continue;
                    }
                    files.push((p.to_string_lossy().to_string(), content));
                }
            }

            files
        })
        .await?;

        emit_progress(
            &progress_tx,
            IngestProgress::new(
                "scan",
                raw_files.len(),
                raw_files.len(),
                format!("已扫描 {} 个可读文件", raw_files.len()),
            ),
        );

        emit_progress(
            &progress_tx,
            IngestProgress::new("chunk", 0, raw_files.len(), "正在切分文件内容..."),
        );
        let splitter = TextSplitter::new(6000);
        let mut file_chunks: Vec<(String, Vec<String>)> = Vec::new();
        for (index, (file_path, content)) in raw_files.iter().enumerate() {
            let chunks: Vec<String> = splitter.chunks(content).map(|s| s.to_string()).collect();
            if !chunks.is_empty() {
                file_chunks.push((file_path.clone(), chunks));
            }

            emit_progress(
                &progress_tx,
                IngestProgress::new(
                    "chunk",
                    index + 1,
                    raw_files.len(),
                    format!("已切分文件 {}/{}", index + 1, raw_files.len()),
                ),
            );
        }

        let total_chunks: usize = file_chunks.iter().map(|(_, chunks)| chunks.len()).sum();
        emit_progress(
            &progress_tx,
            IngestProgress::new("summarize", 0, total_chunks, "正在生成摘要..."),
        );

        let mut final_docs = Vec::new();
        let mut summarized = 0usize;

        for (file_path, chunks) in file_chunks {
            let mut local_summaries = Vec::new();

            for (i, chunk) in chunks.iter().enumerate() {
                if let Ok(summary) = Self::summarize(chunk, model_name).await {
                    local_summaries.push(summary.clone());
                    final_docs.push(Document {
                        id: format!("{}-local-{}", file_path, i),
                        path: file_path.clone(),
                        content: format!("Local summary (chunk {}):\n{}", i + 1, summary),
                        vector: Vec::new(),
                    });
                }

                summarized += 1;
                emit_progress(
                    &progress_tx,
                    IngestProgress::new(
                        "summarize",
                        summarized,
                        total_chunks,
                        format!("已摘要分块 {}/{}", summarized, total_chunks),
                    ),
                );
            }

            if local_summaries.len() > 1 {
                let combined_text = local_summaries.join("\n\n");
                if let Ok(global_summary) = Self::summarize(&combined_text, model_name).await {
                    final_docs.push(Document {
                        id: format!("{}-global", file_path),
                        path: file_path.clone(),
                        content: format!("Global summary:\n{}", global_summary),
                        vector: Vec::new(),
                    });
                }
            }
        }

        let embed_total = final_docs.len();
        emit_progress(
            &progress_tx,
            IngestProgress::new("embed", 0, embed_total, "正在生成向量..."),
        );

        for (index, doc) in final_docs.iter_mut().enumerate() {
            if let Ok(vec) = Self::get_embedding(&doc.content).await {
                doc.vector = vec;
            }

            emit_progress(
                &progress_tx,
                IngestProgress::new(
                    "embed",
                    index + 1,
                    embed_total,
                    format!("已向量化文档 {}/{}", index + 1, embed_total),
                ),
            );
        }

        final_docs.retain(|d| !d.vector.is_empty());

        let mut store = self.documents.lock().await;
        let mut added = 0usize;
        match mode {
            IngestMode::Overwrite => {
                store.clear();
                added = final_docs.len();
                store.extend(final_docs);
            }
            IngestMode::Incremental => {
                let mut existing: HashSet<String> = store.iter().map(|d| d.id.clone()).collect();
                for doc in final_docs {
                    if existing.insert(doc.id.clone()) {
                        store.push(doc);
                        added += 1;
                    }
                }
            }
        }

        emit_progress(
            &progress_tx,
            IngestProgress::new(
                "finalize",
                store.len(),
                store.len(),
                format!("导入完成。本次新增 {} 条，总计 {} 条", added, store.len()),
            ),
        );

        Ok(store.len())
    }

    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<Document>> {
        let query_embedding = Self::get_embedding(query).await?;
        let store = self.documents.lock().await;

        let mut scored_docs: Vec<(f32, &Document)> = store
            .iter()
            .map(|doc| {
                let score = cosine_similarity(&query_embedding, &doc.vector);
                (score, doc)
            })
            .collect();

        scored_docs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored_docs
            .into_iter()
            .take(limit)
            .map(|(_, doc)| doc.clone())
            .collect())
    }

    fn extract_text_from_operation(op: &lopdf::content::Operation) -> Option<String> {
        if op.operator == "Tj" || op.operator == "TJ" {
            let mut text = String::new();
            for operand in &op.operands {
                match operand {
                    lopdf::Object::String(bytes, _) => {
                        text.push_str(&String::from_utf8_lossy(bytes));
                    }
                    lopdf::Object::Array(arr) => {
                        for item in arr {
                            if let lopdf::Object::String(bytes, _) = item {
                                text.push_str(&String::from_utf8_lossy(bytes));
                            }
                        }
                    }
                    _ => {}
                }
            }
            return Some(text);
        }

        if op.operator == "ET" || op.operator == "TX" {
            return Some("\n".to_string());
        }
        None
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot_product: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot_product / (norm_a * norm_b)
    }
}
