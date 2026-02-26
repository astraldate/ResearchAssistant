use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Arc;
use tokio::sync::Mutex;
use text_splitter::TextSplitter;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Document {
    pub id: String,
    pub path: String,
    pub content: String,
    pub vector: Vec<f32>,
}

#[derive(Clone)]
pub struct RagState {
    pub documents: Arc<Mutex<Vec<Document>>>,
}

impl RagState {
    pub fn new() -> Self {
        Self {
            documents: Arc::new(Mutex::new(Vec::new())),
        }
    }

    async fn get_embedding(text: &str) -> Result<Vec<f32>> {
        let client = reqwest::Client::new();
        // Using nomic-embed-text which is a good default for Ollama
        let res = client.post("http://localhost:11434/api/embeddings")
            .json(&serde_json::json!({
                "model": "nomic-embed-text",
                "prompt": text
            }))
            .send()
            .await?;
        
        if !res.status().is_success() {
            return Err(anyhow::anyhow!("Ollama embedding failed: {}. Make sure 'nomic-embed-text' model is pulled.", res.status()));
        }

        let json: serde_json::Value = res.json().await?;
        let embedding = json["embedding"]
            .as_array()
            .ok_or(anyhow::anyhow!("No embedding found in response"))?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0) as f32)
            .collect();
        
        Ok(embedding)
    }

    pub async fn ingest_directory(&self, path: &str) -> Result<usize> {
        let path_owned = path.to_string();
        
        // Scan files in a blocking task
        let mut docs = tokio::task::spawn_blocking(move || {
            let mut local_docs = Vec::new();
            let walker = WalkDir::new(path_owned).into_iter();
            let splitter = TextSplitter::new(500);

            for entry in walker.filter_map(|e| e.ok()) {
                let p = entry.path();
                if p.is_file() {
                    if let Some(ext) = p.extension() {
                        if ext == "md" || ext == "txt" {
                            if let Ok(content) = fs::read_to_string(p) {
                                let chunks = splitter.chunks(&content);
                                for (i, chunk) in chunks.enumerate() {
                                    local_docs.push(Document {
                                        id: format!("{}-{}", p.display(), i),
                                        path: p.to_string_lossy().to_string(),
                                        content: chunk.to_string(),
                                        vector: Vec::new(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            local_docs
        }).await?;

        // Generate embeddings sequentially to avoid overloading Ollama
        for doc in docs.iter_mut() {
            match Self::get_embedding(&doc.content).await {
                Ok(vec) => doc.vector = vec,
                Err(e) => {
                    println!("Failed to embed {}: {}", doc.id, e);
                    // We will filter these out
                }
            }
        }
        
        docs.retain(|d| !d.vector.is_empty());

        let mut store = self.documents.lock().await;
        store.clear();
        store.extend(docs);

        Ok(store.len())
    }

    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<Document>> {
        let query_embedding = Self::get_embedding(query).await?;

        let store = self.documents.lock().await;
        let mut scored_docs: Vec<(f32, &Document)> = store.iter().map(|doc| {
            let score = cosine_similarity(&query_embedding, &doc.vector);
            (score, doc)
        }).collect();

        // Sort by score descending
        scored_docs.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        Ok(scored_docs.into_iter().take(limit).map(|(_score, doc)| doc.clone()).collect())
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
