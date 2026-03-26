use anyhow::{anyhow, Context, Result};
use arrow_array::types::Float32Type;
use arrow_array::{
    FixedSizeListArray, Float32Array, Int32Array, RecordBatch, RecordBatchIterator,
    RecordBatchReader, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures_util::{stream, StreamExt, TryStreamExt};
use lancedb::{connect, Connection};
use lancedb::query::{ExecutableQuery, QueryBase};
use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Window};
use text_splitter::TextSplitter;
use tokio::task::spawn_blocking;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::cards;
use crate::text_decode::read_text_file_auto;

const SCHEMA_VERSION: &str = "research_memory_v1";
const SQLITE_FILE: &str = "research_memory.sqlite3";
const LANCEDB_DIR: &str = "research_memory_lancedb";
const CHUNK_VECTOR_TABLE: &str = "chunk_vectors";
const PAGE_VECTOR_TABLE: &str = "page_vectors";
const CONCEPT_VECTOR_TABLE: &str = "concept_vectors";
const MAP_UNIT_CHAR_LIMIT: usize = 5000;
const MAP_UNIT_OVERLAP: usize = 120;
const MAP_PROMPT_CHAR_LIMIT: usize = 3600;
const MAP_MAX_ITEMS_PER_KIND: usize = 4;
const MAP_EXTRACT_CONCURRENCY: usize = 2;
const OLLAMA_REQUEST_TIMEOUT_SECS: u64 = 90;
const READY_STATUS: &str = "ready";
const PENDING_STATUS: &str = "pending";
const APPROVED_STATUS: &str = "approved";
const REJECTED_STATUS: &str = "rejected";
const REVIEW_PENDING_STATUS: &str = "pending";
const REVIEW_DONE_STATUS: &str = "done";
const MAP_MIN_CONFIDENCE: f32 = 0.62;
const REDUCE_MIN_CONFIDENCE: f32 = 0.6;
const VISUAL_TEXT_FALLBACK_LIMIT: usize = 2200;
const RULE3_CHALLENGE_LIMIT: usize = 8;
const RULE3_MODULE_SEARCH_LIMIT: usize = 8;
const PAPER_TYPE_METHOD: &str = "method";
const PAPER_TYPE_APPLICATION: &str = "application";
const PAPER_TYPE_REVIEW: &str = "review";

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
    pub no_candidate_count: Option<usize>,
    pub fallback_success_count: Option<usize>,
    pub double_failure_count: Option<usize>,
}

impl IngestProgress {
    pub fn new(stage: &str, current: usize, total: usize, message: impl Into<String>) -> Self {
        Self {
            stage: stage.to_string(),
            current,
            total,
            message: message.into(),
            no_candidate_count: None,
            fallback_success_count: None,
            double_failure_count: None,
        }
    }

    pub fn with_candidate_stats(
        mut self,
        no_candidate_count: usize,
        fallback_success_count: usize,
        double_failure_count: usize,
    ) -> Self {
        self.no_candidate_count = Some(no_candidate_count);
        self.fallback_success_count = Some(fallback_success_count);
        self.double_failure_count = Some(double_failure_count);
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchIngestOptions {
    pub extract_model: Option<String>,
    pub extract_fast_model: Option<String>,
    pub extract_fallback_model: Option<String>,
    pub allow_auto_pull_extract_model: Option<bool>,
    pub extraction_mode: Option<String>,
    pub embedding_model: Option<String>,
    pub vision_model: Option<String>,
    pub mode: Option<IngestMode>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceRef {
    pub paper_id: String,
    pub paper_title: String,
    pub paper_path: String,
    pub page_start: i64,
    pub page_end: i64,
    pub chunk_id: Option<String>,
    pub snippet: String,
    pub source_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResult {
    pub id: String,
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSearchHit {
    pub id: String,
    pub paper_id: String,
    pub path: String,
    pub title: String,
    pub page_start: i64,
    pub page_end: i64,
    pub snippet: String,
    pub score: f32,
    pub related_graph_nodes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchGraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub aliases: Vec<String>,
    pub paper_count: usize,
    pub support_count: usize,
    pub in_degree: usize,
    pub out_degree: usize,
    pub is_orphan: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchGraphEdge {
    pub id: String,
    pub edge_type: String,
    pub from: String,
    pub to: String,
    pub support_count: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchGraph {
    pub view: String,
    pub nodes: Vec<ResearchGraphNode>,
    pub edges: Vec<ResearchGraphEdge>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RelatedPaperRef {
    pub paper_id: String,
    pub title: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphAdjacentNode {
    pub node_id: String,
    pub kind: String,
    pub label: String,
    pub edge_type: String,
    pub direction: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchGraphNodeDetail {
    pub node_id: String,
    pub kind: String,
    pub label: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub support_count: usize,
    pub evidence: Vec<EvidenceRef>,
    pub related_papers: Vec<RelatedPaperRef>,
    pub adjacent_nodes: Vec<GraphAdjacentNode>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchGraphEdgeDetail {
    pub edge_id: String,
    pub edge_type: String,
    pub from_node_id: String,
    pub from_label: String,
    pub to_node_id: String,
    pub to_label: String,
    pub support_count: usize,
    pub evidence: Vec<EvidenceRef>,
    pub related_papers: Vec<RelatedPaperRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPaperRecord {
    pub paper_id: String,
    pub title: String,
    pub path: String,
    pub paper_type: String,
    pub parse_status: String,
    pub index_status: String,
    pub extraction_status: String,
    pub chunk_count: usize,
    pub candidate_count: usize,
    pub pending_review_count: usize,
    pub approved_candidate_count: usize,
    pub is_in_graph: bool,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub review_id: String,
    pub candidate_id: String,
    pub paper_id: String,
    pub paper_title: String,
    pub paper_path: String,
    pub candidate_kind: String,
    pub entity_kind: Option<String>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub confidence: f32,
    pub from_kind: Option<String>,
    pub from_label: Option<String>,
    pub to_kind: Option<String>,
    pub to_label: Option<String>,
    pub evidence: Vec<EvidenceRef>,
    pub suggested_canonical_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReviewDecision {
    pub candidate_id: String,
    pub decision: String,
    pub override_label: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReviewRequest {
    pub decisions: Vec<ApplyReviewDecision>,
    pub embedding_model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IdeaCandidate {
    pub id: String,
    pub rule_type: String,
    pub title: String,
    pub summary: String,
    pub confidence: f32,
    pub challenge_node_id: Option<String>,
    pub module_node_id: Option<String>,
    pub task_node_id: Option<String>,
    pub pipeline_node_id: Option<String>,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ComparePapersResult {
    pub left_paper_id: String,
    pub right_paper_id: String,
    pub similarities: Vec<String>,
    pub left_only: Vec<String>,
    pub right_only: Vec<String>,
    pub evidence: Vec<EvidenceRef>,
    pub markdown: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageVisualNoteResult {
    pub pdf_path: String,
    pub page: u32,
    pub source_mode: String,
    pub note: String,
    pub generated_at: String,
    pub model_used: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalExtractionItem {
    pub label: String,
    pub summary: Option<String>,
    pub confidence: Option<f32>,
    pub evidence_snippet: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalExtractionEdge {
    pub from_label: String,
    pub to_label: String,
    pub confidence: Option<f32>,
    pub evidence_snippet: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CandidateExtraction {
    pub tasks: Vec<LocalExtractionItem>,
    pub modules: Vec<LocalExtractionItem>,
    pub challenges: Vec<LocalExtractionItem>,
    pub insights: Vec<LocalExtractionItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RelationExtraction {
    pub pipelines: Vec<LocalExtractionItem>,
    pub task_pipeline_pairs: Vec<LocalExtractionEdge>,
    pub pipeline_module_pairs: Vec<LocalExtractionEdge>,
    pub challenge_insight_pairs: Vec<LocalExtractionEdge>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalExtraction {
    pub tasks: Vec<LocalExtractionItem>,
    pub pipelines: Vec<LocalExtractionItem>,
    pub modules: Vec<LocalExtractionItem>,
    pub challenges: Vec<LocalExtractionItem>,
    pub insights: Vec<LocalExtractionItem>,
    pub task_pipeline_pairs: Vec<LocalExtractionEdge>,
    pub pipeline_module_pairs: Vec<LocalExtractionEdge>,
    pub challenge_insight_pairs: Vec<LocalExtractionEdge>,
}

impl CandidateExtraction {
    fn item_count(&self) -> usize {
        self.tasks.len() + self.modules.len() + self.challenges.len() + self.insights.len()
    }
}

impl LocalExtraction {
    fn node_count(&self) -> usize {
        self.tasks.len()
            + self.pipelines.len()
            + self.modules.len()
            + self.challenges.len()
            + self.insights.len()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CandidatePhaseStatus {
    FastHit,
    NoCandidate,
    FallbackSuccess,
    DoubleFailure,
}

#[derive(Clone, Debug)]
struct FileDocument {
    paper_id: String,
    path: String,
    title: String,
    pages: Vec<PageRecord>,
    full_text: String,
    content_hash: String,
}

#[derive(Clone, Debug)]
struct PageRecord {
    page_number: i64,
    content: String,
}

#[derive(Clone, Debug)]
struct SectionRecord {
    section_id: String,
    heading: String,
    start_page: i64,
    end_page: i64,
    content: String,
}

#[derive(Clone, Debug)]
struct MapUnit {
    unit_id: String,
    section_id: Option<String>,
    unit_kind: String,
    heading: String,
    page_start: i64,
    page_end: i64,
    content: String,
}

#[derive(Clone, Debug)]
struct ReducedNodeCandidate {
    paper_id: String,
    kind: String,
    label: String,
    normalized_label: String,
    aliases: Vec<String>,
    description: String,
    confidence: f32,
    evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug)]
struct ReducedEdgeCandidate {
    paper_id: String,
    edge_type: String,
    from_kind: String,
    from_label: String,
    normalized_from_label: String,
    to_kind: String,
    to_label: String,
    normalized_to_label: String,
    confidence: f32,
    evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug)]
struct AggregatedNodeCandidate {
    kind: String,
    normalized_label: String,
    labels: Vec<String>,
    descriptions: Vec<String>,
    aliases: Vec<String>,
    confidence_sum: f32,
    confidence_count: usize,
    paper_ids: HashSet<String>,
    evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug)]
struct AggregatedEdgeCandidate {
    edge_type: String,
    from_kind: String,
    from_label: String,
    normalized_from_label: String,
    to_kind: String,
    to_label: String,
    normalized_to_label: String,
    confidence_sum: f32,
    confidence_count: usize,
    paper_ids: HashSet<String>,
    evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug)]
struct ChunkRow {
    chunk_id: String,
    paper_id: String,
    paper_path: String,
    paper_title: String,
    page_start: i64,
    page_end: i64,
    content: String,
}

#[derive(Clone, Debug)]
struct ConceptRow {
    node_id: String,
    kind: String,
    label: String,
    text: String,
}

#[derive(Clone, Debug)]
struct Rule3ChallengeSeed {
    node_id: String,
    label: String,
    text: String,
    paper_count: usize,
}

#[derive(Clone, Debug)]
struct ConceptVectorHit {
    node_id: String,
    kind: String,
    label: String,
    score: f32,
}

#[derive(Clone, Debug)]
struct Rule3ModulePath {
    task_node_id: String,
    task_label: String,
    pipeline_node_id: String,
    pipeline_label: String,
}

pub async fn initialize(app: &AppHandle) -> Result<()> {
    let root = research_root(app)?;
    if !root.exists() {
        fs::create_dir_all(&root)?;
    }
    let mut conn = open_sqlite(app)?;
    create_schema(&mut conn)?;
    Ok(())
}

pub async fn ingest_research_corpus(
    app: &AppHandle,
    window: &Window,
    path: &str,
    options: ResearchIngestOptions,
) -> Result<usize> {
    initialize(app).await?;
    emit_progress(
        window,
        IngestProgress::new(
            "prepare_ingest",
            0,
            1,
            format!("正在准备导入任务：{}", path),
        ),
    );
    let mode = options.mode.unwrap_or_default();
    let extract_fast_model = options
        .extract_fast_model
        .or(options.extract_model.clone())
        .unwrap_or_else(|| "qwen3:8b".to_string());
    let extract_fallback_model = options
        .extract_fallback_model
        .or(options.extract_model.clone())
        .unwrap_or_else(|| "qwen3.5:9b".to_string());
    emit_progress(
        window,
        IngestProgress::new(
            "prepare_models",
            0,
            1,
            format!(
                "正在检查索引模型与 embedding：候选 {} / 回退 {}",
                extract_fast_model, extract_fallback_model
            ),
        ),
    );
    let embedding_model = resolve_embedding_model(options.embedding_model.as_deref()).await?;
    emit_progress(
        window,
        IngestProgress::new("scan", 0, 1, "正在扫描可处理文献文件..."),
    );
    let documents = collect_documents(path).await?;
    if documents.is_empty() {
        emit_progress(
            window,
            IngestProgress::new(
                "finalize",
                0,
                0,
                "未发现可处理文献，当前只支持 pdf、md、txt。",
            ),
        );
        return Ok(0);
    }

    if mode == IngestMode::Overwrite {
        let mut conn = open_sqlite(app)?;
        create_schema(&mut conn)?;
        clear_research_memory(&conn)?;
    }

    emit_progress(
        window,
        IngestProgress::new(
                "parse_pages",
                0,
                documents.len(),
            format!(
                "已发现 {} 篇待处理论文，候选模型 {}，回退模型 {}",
                documents.len(),
                extract_fast_model,
                extract_fallback_model
            ),
        ),
    );

    let mut processed = 0usize;
    for (index, document) in documents.iter().enumerate() {
        emit_progress(
            window,
            IngestProgress::new(
                "candidate_extract",
                index + 1,
                documents.len(),
                format!(
                    "正在解析与候选抽取（{}/{}）：{}",
                    index + 1,
                    documents.len(),
                    document.title
                ),
            ),
        );
        ingest_single_document(
            app,
            window,
            document,
            &extract_fast_model,
            &extract_fallback_model,
        )
        .await?;
        processed += 1;
    }

    let conn = open_sqlite(app)?;
    materialize_graph_from_approved_candidates(&conn)?;
    materialize_stats(&conn)?;

    emit_progress(
        window,
        IngestProgress::new("index_vectors", 0, 1, "正在重建派生向量索引..."),
    );
    rebuild_vector_indexes(app, Some(window), &embedding_model).await?;
    refresh_idea_candidates(app, &embedding_model).await?;

    emit_progress(
        window,
        IngestProgress::new(
            "finalize",
            processed,
            processed,
            format!("论文记忆索引完成，本次处理 {} 篇论文", processed),
        ),
    );
    Ok(processed)
}

pub async fn unindex_research_path(
    app: &AppHandle,
    path: &str,
    embedding_model: Option<&str>,
) -> Result<usize> {
    initialize(app).await?;
    let target = Path::new(path);
    let is_dir = target.is_dir();
    let matched_paths = {
        let conn = open_sqlite(app)?;
        let mut paths: Vec<String> = Vec::new();
        if is_dir {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT path
                 FROM papers
                 WHERE path = ?1 OR path LIKE ?2
                 ORDER BY path",
            )?;
            let rows = stmt.query_map(
                params![path, format!("{}%", ensure_trailing_separator(path))],
                |row| row.get::<_, String>(0),
            )?;
            for row in rows {
                paths.push(row?);
            }
        } else {
            let mut stmt =
                conn.prepare("SELECT DISTINCT path FROM papers WHERE path = ?1 ORDER BY path")?;
            let rows = stmt.query_map([path], |row| row.get::<_, String>(0))?;
            for row in rows {
                paths.push(row?);
            }
        }
        paths
    };

    if matched_paths.is_empty() {
        return Ok(0);
    }

    {
        let conn = open_sqlite(app)?;
        for paper_path in &matched_paths {
            let paper_id = stable_id("paper", paper_path);
            delete_paper(&conn, &paper_id, paper_path).ok();
        }
        materialize_graph_from_approved_candidates(&conn)?;
        materialize_stats(&conn)?;
    }

    let embedding_model = resolve_embedding_model(embedding_model).await?;
    rebuild_vector_indexes(app, None, &embedding_model).await?;
    refresh_idea_candidates(app, &embedding_model).await?;
    Ok(matched_paths.len())
}

pub async fn search_research_memory(
    app: &AppHandle,
    query: &str,
    limit: usize,
    embedding_model: Option<&str>,
) -> Result<Vec<ResearchSearchHit>> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let mut merged: HashMap<String, ResearchSearchHit> = HashMap::new();
    for hit in search_chunks_keyword(&conn, query, limit * 2)? {
        merged.insert(hit.id.clone(), hit);
    }

    let embedding_model = resolve_embedding_model(embedding_model).await?;
    if let Ok(vector) = embed_text(query, &embedding_model).await {
        for hit in search_chunks_vector(app, &vector, limit * 3).await? {
            merged
                .entry(hit.id.clone())
                .and_modify(|existing| existing.score = existing.score.max(hit.score))
                .or_insert(hit);
        }
    }

    let mut hits = merged.into_values().collect::<Vec<_>>();
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
    });
    hits.truncate(limit.max(1));
    Ok(hits)
}

pub async fn query_knowledge_base(
    app: &AppHandle,
    query: &str,
    limit: usize,
    embedding_model: Option<&str>,
) -> Result<Vec<DocumentResult>> {
    let hits = search_research_memory(app, query, limit, embedding_model).await?;
    Ok(hits
        .into_iter()
        .map(|hit| DocumentResult {
            id: hit.id,
            path: hit.path,
            content: format!(
                "[{} p.{}-{}]\n{}",
                hit.title, hit.page_start, hit.page_end, hit.snippet
            ),
        })
        .collect())
}

pub async fn get_research_graph(app: &AppHandle, view: &str) -> Result<ResearchGraph> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let (allowed_kinds, allowed_edges): (&[&str], &[&str]) = match view {
        "problem" => (&["challenge", "insight"], &["challenge_insight"]),
        _ => (&["task", "pipeline", "module"], &["task_pipeline", "pipeline_module"]),
    };

    let node_placeholders = allowed_kinds.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let node_sql = format!(
        "SELECT g.node_id, g.kind, g.label, COALESCE(g.aliases_json, '[]'),
                COALESCE(s.paper_count, 0), COALESCE(g.support_count, 0),
                COALESCE(s.in_degree, 0), COALESCE(s.out_degree, 0), COALESCE(s.is_orphan, 0)
         FROM graph_nodes g
         LEFT JOIN node_stats s ON s.node_id = g.node_id
         WHERE g.kind IN ({})
         ORDER BY g.kind, g.label",
        node_placeholders
    );
    let mut node_stmt = conn.prepare(&node_sql)?;
    let node_rows = node_stmt.query_map(rusqlite::params_from_iter(allowed_kinds.iter()), |row| {
        let aliases_json: String = row.get(3)?;
        Ok(ResearchGraphNode {
            id: row.get(0)?,
            kind: row.get(1)?,
            label: row.get(2)?,
            aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
            paper_count: row.get::<_, i64>(4).unwrap_or(0).max(0) as usize,
            support_count: row.get::<_, i64>(5).unwrap_or(0).max(0) as usize,
            in_degree: row.get::<_, i64>(6).unwrap_or(0).max(0) as usize,
            out_degree: row.get::<_, i64>(7).unwrap_or(0).max(0) as usize,
            is_orphan: row.get::<_, i64>(8).unwrap_or(0) > 0,
        })
    })?;
    let mut nodes = Vec::new();
    for row in node_rows {
        nodes.push(row?);
    }

    let edge_placeholders = allowed_edges.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let edge_sql = format!(
        "SELECT edge_id, edge_type, from_node_id, to_node_id, support_count
         FROM graph_edges
         WHERE edge_type IN ({})
         ORDER BY edge_type, support_count DESC, edge_id",
        edge_placeholders
    );
    let mut edge_stmt = conn.prepare(&edge_sql)?;
    let edge_rows = edge_stmt.query_map(rusqlite::params_from_iter(allowed_edges.iter()), |row| {
        Ok(ResearchGraphEdge {
            id: row.get(0)?,
            edge_type: row.get(1)?,
            from: row.get(2)?,
            to: row.get(3)?,
            support_count: row.get::<_, i64>(4).unwrap_or(0).max(0) as usize,
        })
    })?;
    let mut edges = Vec::new();
    for row in edge_rows {
        edges.push(row?);
    }

    Ok(ResearchGraph {
        view: view.to_string(),
        nodes,
        edges,
    })
}

pub async fn list_extraction_reviews(app: &AppHandle) -> Result<Vec<ReviewRecord>> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let mut stmt = conn.prepare(
        "SELECT r.review_id, r.candidate_id, c.paper_id, p.title, p.path, c.candidate_kind, c.entity_kind,
                c.label, c.description, c.confidence, c.from_kind, c.from_label, c.to_kind, c.to_label,
                COALESCE(c.evidence_json, '[]')
         FROM review_queue r
         JOIN extraction_candidates c ON c.candidate_id = r.candidate_id
         JOIN papers p ON p.paper_id = c.paper_id
         WHERE r.status = ?1 AND c.review_status = ?2
         ORDER BY c.confidence DESC, p.updated_at DESC, c.paper_id, r.review_id",
    )?;
    let rows = stmt.query_map(params![REVIEW_PENDING_STATUS, REVIEW_PENDING_STATUS], |row| {
        let evidence_json: String = row.get(14)?;
        Ok(ReviewRecord {
            review_id: row.get(0)?,
            candidate_id: row.get(1)?,
            paper_id: row.get(2)?,
            paper_title: row.get(3)?,
            paper_path: row.get(4)?,
            candidate_kind: row.get(5)?,
            entity_kind: row.get(6)?,
            label: row.get(7)?,
            description: row.get(8)?,
            confidence: row.get(9)?,
            from_kind: row.get(10)?,
            from_label: row.get(11)?,
            to_kind: row.get(12)?,
            to_label: row.get(13)?,
            evidence: serde_json::from_str(&evidence_json).unwrap_or_default(),
            suggested_canonical_label: row.get(7).ok(),
        })
    })?;
    let mut reviews = Vec::new();
    for row in rows {
        reviews.push(row?);
    }
    Ok(reviews)
}

pub async fn get_research_graph_node_detail(
    app: &AppHandle,
    node_id: &str,
) -> Result<ResearchGraphNodeDetail> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let (kind, label, aliases_json, description, support_count) = conn.query_row(
        "SELECT kind, label, aliases_json, description, support_count
         FROM graph_nodes
         WHERE node_id = ?1",
        [node_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?.max(0) as usize,
            ))
        },
    )?;
    let evidence = load_node_evidence(&conn, node_id, 8)?;
    let related_papers = related_papers_for_owner(&conn, "node", node_id, 8)?;
    let adjacent_nodes = load_adjacent_nodes(&conn, node_id, 24)?;
    Ok(ResearchGraphNodeDetail {
        node_id: node_id.to_string(),
        kind,
        label,
        aliases: serde_json::from_str(&aliases_json).unwrap_or_default(),
        description,
        support_count,
        evidence,
        related_papers,
        adjacent_nodes,
    })
}

pub async fn get_research_graph_edge_detail(
    app: &AppHandle,
    edge_id: &str,
) -> Result<ResearchGraphEdgeDetail> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let (edge_type, from_node_id, from_label, to_node_id, to_label, support_count) = conn.query_row(
        "SELECT e.edge_type,
                e.from_node_id,
                fn.label,
                e.to_node_id,
                tn.label,
                e.support_count
         FROM graph_edges e
         JOIN graph_nodes fn ON fn.node_id = e.from_node_id
         JOIN graph_nodes tn ON tn.node_id = e.to_node_id
         WHERE e.edge_id = ?1",
        [edge_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?.max(0) as usize,
            ))
        },
    )?;
    let evidence = load_edge_evidence(&conn, edge_id, 8)?;
    let related_papers = related_papers_for_owner(&conn, "edge", edge_id, 8)?;
    Ok(ResearchGraphEdgeDetail {
        edge_id: edge_id.to_string(),
        edge_type,
        from_node_id,
        from_label,
        to_node_id,
        to_label,
        support_count,
        evidence,
        related_papers,
    })
}

pub async fn list_research_papers(app: &AppHandle) -> Result<Vec<ResearchPaperRecord>> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let mut stmt = conn.prepare(
        "SELECT p.paper_id,
                p.title,
                p.path,
                COALESCE(p.paper_type, ?1),
                p.index_status,
                p.extraction_status,
                p.updated_at,
                COALESCE(ch.chunk_count, 0),
                COALESCE(ca.candidate_count, 0),
                COALESCE(ca.pending_review_count, 0),
                COALESCE(ca.approved_candidate_count, 0)
         FROM papers p
         LEFT JOIN (
             SELECT paper_id, COUNT(*) AS chunk_count
             FROM chunks
             GROUP BY paper_id
         ) ch ON ch.paper_id = p.paper_id
         LEFT JOIN (
             SELECT paper_id,
                    COUNT(*) AS candidate_count,
                    SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pending_review_count,
                    SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) AS approved_candidate_count
             FROM extraction_candidates
             GROUP BY paper_id
         ) ca ON ca.paper_id = p.paper_id
         ORDER BY p.updated_at DESC, p.title COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map(params![PAPER_TYPE_APPLICATION], |row| {
        let index_status: String = row.get(4)?;
        let extraction_status: String = row.get(5)?;
        let chunk_count = row.get::<_, i64>(7).unwrap_or(0).max(0) as usize;
        let candidate_count = row.get::<_, i64>(8).unwrap_or(0).max(0) as usize;
        let pending_review_count = row.get::<_, i64>(9).unwrap_or(0).max(0) as usize;
        let approved_candidate_count = row.get::<_, i64>(10).unwrap_or(0).max(0) as usize;
        let parse_status = derive_paper_parse_status(
            &index_status,
            &extraction_status,
            chunk_count,
            candidate_count,
            pending_review_count,
            approved_candidate_count,
        );
        Ok(ResearchPaperRecord {
            paper_id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
            paper_type: row.get(3)?,
            parse_status,
            index_status,
            extraction_status,
            chunk_count,
            candidate_count,
            pending_review_count,
            approved_candidate_count,
            is_in_graph: approved_candidate_count > 0,
            updated_at: row.get(6)?,
        })
    })?;
    let mut papers = Vec::new();
    for row in rows {
        papers.push(row?);
    }
    Ok(papers)
}

#[derive(Clone, Copy, Debug)]
struct CandidateBudget {
    tasks: usize,
    pipelines: usize,
    modules: usize,
    challenges: usize,
    insights: usize,
}

fn budget_for_paper_type(paper_type: &str) -> CandidateBudget {
    match paper_type {
        PAPER_TYPE_REVIEW => CandidateBudget {
            tasks: 8,
            pipelines: 8,
            modules: 14,
            challenges: 12,
            insights: 12,
        },
        PAPER_TYPE_METHOD => CandidateBudget {
            tasks: 5,
            pipelines: 6,
            modules: 10,
            challenges: 6,
            insights: 6,
        },
        _ => CandidateBudget {
            tasks: 6,
            pipelines: 5,
            modules: 7,
            challenges: 8,
            insights: 7,
        },
    }
}

fn classify_paper_type(document: &FileDocument, sections: &[SectionRecord]) -> String {
    let title = document.title.to_lowercase();
    let headings = sections
        .iter()
        .map(|section| section.heading.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let summary_text = document
        .pages
        .iter()
        .take(2)
        .map(|page| page.content.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();

    let review_markers = [
        "review",
        "survey",
        "overview",
        "benchmark",
        "perspective",
        "roadmap",
        "meta-analysis",
        "systematic review",
    ];
    if review_markers.iter().any(|marker| title.contains(marker))
        || (review_markers.iter().filter(|marker| headings.contains(**marker)).count() >= 1
            && summary_text.contains("we review"))
    {
        return PAPER_TYPE_REVIEW.to_string();
    }

    let method_score = count_matches(
        &format!("{}\n{}\n{}", title, headings, summary_text),
        &[
            "method",
            "framework",
            "model",
            "algorithm",
            "architecture",
            "we propose",
            "we present",
            "our method",
            "approach",
        ],
    );
    let application_score = count_matches(
        &format!("{}\n{}\n{}", title, headings, summary_text),
        &[
            "application",
            "applied",
            "using",
            "case study",
            "analysis of",
            "dataset",
            "experimental results",
            "biological insights",
        ],
    );

    if method_score >= application_score {
        PAPER_TYPE_METHOD.to_string()
    } else {
        PAPER_TYPE_APPLICATION.to_string()
    }
}

fn count_matches(text: &str, needles: &[&str]) -> usize {
    needles.iter().filter(|needle| text.contains(**needle)).count()
}

fn apply_candidate_budget(
    paper_type: &str,
    mut node_candidates: Vec<ReducedNodeCandidate>,
    edge_candidates: Vec<ReducedEdgeCandidate>,
) -> (Vec<ReducedNodeCandidate>, Vec<ReducedEdgeCandidate>) {
    node_candidates = filter_paper_level_candidates(paper_type, node_candidates);
    let budget = budget_for_paper_type(paper_type);
    node_candidates.sort_by(|left, right| compare_node_candidates(left, right));

    let mut kept = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for candidate in node_candidates {
        let limit = match candidate.kind.as_str() {
            "task" => budget.tasks,
            "pipeline" => budget.pipelines,
            "module" => budget.modules,
            "challenge" => budget.challenges,
            "insight" => budget.insights,
            _ => usize::MAX,
        };
        let current = counts.entry(candidate.kind.clone()).or_insert(0);
        if *current >= limit {
            continue;
        }
        *current += 1;
        kept.push(candidate);
    }

    let kept_labels = kept
        .iter()
        .map(|candidate| (candidate.kind.clone(), candidate.normalized_label.clone()))
        .collect::<HashSet<_>>();

    let mut kept_edges = edge_candidates
        .into_iter()
        .filter(|edge| {
            kept_labels.contains(&(edge.from_kind.clone(), edge.normalized_from_label.clone()))
                && kept_labels.contains(&(edge.to_kind.clone(), edge.normalized_to_label.clone()))
        })
        .collect::<Vec<_>>();
    kept_edges.sort_by(|left, right| compare_edge_candidates(left, right));

    (kept, kept_edges)
}

fn filter_paper_level_candidates(
    paper_type: &str,
    node_candidates: Vec<ReducedNodeCandidate>,
) -> Vec<ReducedNodeCandidate> {
    node_candidates
        .into_iter()
        .filter(|candidate| {
            if candidate.evidence.is_empty() {
                return false;
            }
            if is_overly_generic_label(&candidate.kind, &candidate.label)
                || is_overlong_problem_label(&candidate.kind, &candidate.label)
            {
                return false;
            }
            let description = candidate.description.trim().to_lowercase();
            if is_review_style_summary(&description) {
                return false;
            }
            if matches!(candidate.kind.as_str(), "challenge" | "insight") {
                let snippet = candidate
                    .evidence
                    .first()
                    .map(|evidence| evidence.snippet.as_str())
                    .unwrap_or_default();
                if is_generic_background_evidence(snippet) {
                    return false;
                }
                if paper_type != PAPER_TYPE_REVIEW
                    && !is_method_connected_problem_candidate(&candidate.label, &description, snippet)
                {
                    return false;
                }
            }
            true
        })
        .collect()
}

fn is_method_connected_problem_candidate(label: &str, description: &str, snippet: &str) -> bool {
    let text = format!("{}\n{}\n{}", label, description, snippet).to_lowercase();
    let method_markers = [
        "we propose",
        "our method",
        "our model",
        "our approach",
        "this method",
        "this model",
        "framework",
        "pipeline",
        "module",
        "intervention",
        "estimate",
        "infer",
        "prediction",
        "learn",
        "address",
        "mitigate",
        "resolve",
        "capture",
    ];
    method_markers.iter().any(|marker| text.contains(marker))
}

fn compare_node_candidates(left: &ReducedNodeCandidate, right: &ReducedNodeCandidate) -> Ordering {
    right
        .confidence
        .partial_cmp(&left.confidence)
        .unwrap_or(Ordering::Equal)
        .then_with(|| right.evidence.len().cmp(&left.evidence.len()))
        .then_with(|| left.label.len().cmp(&right.label.len()))
        .then_with(|| left.label.cmp(&right.label))
}

fn compare_edge_candidates(left: &ReducedEdgeCandidate, right: &ReducedEdgeCandidate) -> Ordering {
    right
        .confidence
        .partial_cmp(&left.confidence)
        .unwrap_or(Ordering::Equal)
        .then_with(|| right.evidence.len().cmp(&left.evidence.len()))
        .then_with(|| left.from_label.cmp(&right.from_label))
        .then_with(|| left.to_label.cmp(&right.to_label))
}

fn derive_paper_parse_status(
    index_status: &str,
    extraction_status: &str,
    chunk_count: usize,
    candidate_count: usize,
    pending_review_count: usize,
    approved_candidate_count: usize,
) -> String {
    if index_status != READY_STATUS {
        return "indexing".to_string();
    }
    if extraction_status == PENDING_STATUS {
        return "extracting".to_string();
    }
    if chunk_count == 0 {
        return "empty".to_string();
    }
    if candidate_count == 0 {
        return "parsed_no_candidates".to_string();
    }
    if approved_candidate_count > 0 {
        return "in_graph".to_string();
    }
    if pending_review_count > 0 || extraction_status == REVIEW_PENDING_STATUS {
        return "awaiting_review".to_string();
    }
    "parsed".to_string()
}

pub async fn apply_extraction_review(
    app: &AppHandle,
    request: ApplyReviewRequest,
) -> Result<usize> {
    initialize(app).await?;
    let embedding_model = resolve_embedding_model(request.embedding_model.as_deref()).await?;
    let affected = {
        let mut conn = open_sqlite(app)?;
        let tx = conn.transaction()?;
        let mut affected = 0usize;
        for decision in &request.decisions {
            let normalized_decision = decision.decision.trim().to_lowercase();
            let next_status = if normalized_decision == "approve" {
                APPROVED_STATUS
            } else {
                REJECTED_STATUS
            };
            if let Some(override_label) = decision.override_label.as_deref() {
                if !override_label.trim().is_empty() {
                    tx.execute(
                        "UPDATE extraction_candidates
                         SET label = ?2, normalized_label = ?3
                         WHERE candidate_id = ?1 AND candidate_kind = 'node'",
                        params![
                            decision.candidate_id,
                            override_label,
                            normalize_label(override_label),
                        ],
                    )?;
                }
            }
            tx.execute(
                "UPDATE extraction_candidates SET review_status = ?2 WHERE candidate_id = ?1",
                params![decision.candidate_id, next_status],
            )?;
            tx.execute(
                "UPDATE review_queue SET status = ?2 WHERE candidate_id = ?1",
                params![decision.candidate_id, REVIEW_DONE_STATUS],
            )?;
            affected += 1;
        }
        tx.commit()?;
        materialize_graph_from_approved_candidates(&conn)?;
        materialize_stats(&conn)?;
        affected
    };
    rebuild_vector_indexes(app, None, &embedding_model).await?;
    refresh_idea_candidates(app, &embedding_model).await?;
    Ok(affected)
}

pub async fn list_idea_candidates(app: &AppHandle) -> Result<Vec<IdeaCandidate>> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let mut stmt = conn.prepare(
        "SELECT idea_id, rule_type, title, summary, confidence, challenge_node_id, module_node_id, task_node_id, pipeline_node_id,
                COALESCE(evidence_json, '[]')
         FROM idea_candidates
         WHERE status = 'active'
         ORDER BY confidence DESC, created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let evidence_json: String = row.get(9)?;
        Ok(IdeaCandidate {
            id: row.get(0)?,
            rule_type: row.get(1)?,
            title: row.get(2)?,
            summary: row.get(3)?,
            confidence: row.get(4)?,
            challenge_node_id: row.get(5)?,
            module_node_id: row.get(6)?,
            task_node_id: row.get(7)?,
            pipeline_node_id: row.get(8)?,
            evidence: serde_json::from_str(&evidence_json).unwrap_or_default(),
        })
    })?;
    let mut ideas = Vec::new();
    for row in rows {
        ideas.push(row?);
    }
    Ok(ideas)
}

pub async fn compare_papers(
    app: &AppHandle,
    left_paper_id: &str,
    right_paper_id: &str,
    focus: Option<&str>,
) -> Result<ComparePapersResult> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let left = paper_concepts(&conn, left_paper_id)?;
    let right = paper_concepts(&conn, right_paper_id)?;
    let similarities = left.intersection(&right).take(6).cloned().collect::<Vec<_>>();
    let left_only = left.difference(&right).take(6).cloned().collect::<Vec<_>>();
    let right_only = right.difference(&left).take(6).cloned().collect::<Vec<_>>();
    let evidence = load_compare_evidence(&conn, left_paper_id, right_paper_id, 12)?;
    let markdown = format!(
        "## 论文对比：{}\n\n### 共同点\n{}\n\n### 左侧特有\n{}\n\n### 右侧特有\n{}",
        focus.unwrap_or("方法与问题"),
        render_markdown_list(&similarities),
        render_markdown_list(&left_only),
        render_markdown_list(&right_only)
    );
    Ok(ComparePapersResult {
        left_paper_id: left_paper_id.to_string(),
        right_paper_id: right_paper_id.to_string(),
        similarities,
        left_only,
        right_only,
        evidence,
        markdown,
    })
}

pub async fn analyze_pdf_page_visual(
    app: &AppHandle,
    pdf_path: &str,
    page: u32,
    model: &str,
) -> Result<PageVisualNoteResult> {
    initialize(app).await?;
    let page_text = read_pdf_page_text(Path::new(pdf_path), page as i64)
        .with_context(|| format!("Failed to extract PDF page {} from '{}'", page, pdf_path))?;
    let source_mode = if page_text.trim().is_empty() {
        "empty_page".to_string()
    } else {
        "page_text_fallback".to_string()
    };
    let note = if page_text.trim().is_empty() {
        "当前页未能提取出可分析文本，暂时无法生成视觉说明。".to_string()
    } else {
        let prompt = format!(
            "请基于下面这页学术 PDF 的页面文本，生成一个简洁的页面说明。重点描述页面主题、可能的图表含义、值得关注的模块或实验结果。只能输出中文。\n\n页面文本：\n{}",
            truncate_chars(&page_text, VISUAL_TEXT_FALLBACK_LIMIT)
        );
        run_ollama_chat(
            model,
            vec![
                json!({
                    "role": "system",
                    "content": "你是科研阅读助手。当前任务是基于 PDF 页面的文本抽取结果，生成保守、可追溯的页面说明。"
                }),
                json!({
                    "role": "user",
                    "content": prompt
                }),
            ],
        )
        .await
        .unwrap_or_else(|_| "页面说明生成失败，可稍后重试。".to_string())
    };

    let conn = open_sqlite(app)?;
    conn.execute(
        "UPDATE pages
         SET visual_note = ?3
         WHERE paper_id = (SELECT paper_id FROM papers WHERE path = ?1)
           AND page_number = ?2",
        params![pdf_path, page as i64, note],
    )
    .ok();

    Ok(PageVisualNoteResult {
        pdf_path: pdf_path.to_string(),
        page,
        source_mode,
        note,
        generated_at: cards::current_timestamp_iso_utc(),
        model_used: model.to_string(),
    })
}

pub async fn sync_index_state(app: &AppHandle, embedding_model: Option<&str>) -> Result<bool> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let expected_schema = get_meta(&conn, "schema_version")?.unwrap_or_default();
    let expected_model = get_meta(&conn, "embedding_model")?.unwrap_or_default();
    let effective_model =
        resolve_embedding_model(embedding_model.or(Some(expected_model.as_str()))).await?;
    let chunk_count = conn
        .query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as usize;
    let concept_count = conn
        .query_row("SELECT COUNT(*) FROM graph_nodes", [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as usize;

    if expected_schema != SCHEMA_VERSION || expected_model != effective_model {
        rebuild_vector_indexes(app, None, &effective_model).await?;
        refresh_idea_candidates(app, &effective_model).await?;
        return Ok(true);
    }

    let db = open_lancedb(app).await?;
    let chunk_rows = count_lance_rows(&db, CHUNK_VECTOR_TABLE).await.unwrap_or(0);
    let concept_rows = count_lance_rows(&db, CONCEPT_VECTOR_TABLE).await.unwrap_or(0);
    if chunk_rows != chunk_count || concept_rows != concept_count {
        rebuild_vector_indexes(app, None, &effective_model).await?;
        refresh_idea_candidates(app, &effective_model).await?;
        return Ok(true);
    }
    Ok(false)
}

fn create_schema(conn: &mut SqliteConnection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS runtime_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS papers (
            paper_id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            paper_type TEXT NOT NULL DEFAULT 'application',
            content_hash TEXT NOT NULL,
            index_status TEXT NOT NULL,
            extraction_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pages (
            page_id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            content TEXT NOT NULL,
            visual_note TEXT,
            FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS sections (
            section_id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL,
            heading TEXT NOT NULL,
            start_page INTEGER NOT NULL,
            end_page INTEGER NOT NULL,
            content TEXT NOT NULL,
            FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS chunks (
            chunk_id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL,
            section_id TEXT,
            unit_kind TEXT NOT NULL,
            page_start INTEGER NOT NULL,
            page_end INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
            chunk_id UNINDEXED,
            paper_id UNINDEXED,
            text
        );
        CREATE TABLE IF NOT EXISTS extraction_candidates (
            candidate_id TEXT PRIMARY KEY,
            paper_id TEXT NOT NULL,
            map_unit_id TEXT,
            candidate_kind TEXT NOT NULL,
            entity_kind TEXT,
            label TEXT,
            normalized_label TEXT,
            aliases_json TEXT,
            description TEXT,
            confidence REAL NOT NULL,
            from_kind TEXT,
            from_label TEXT,
            normalized_from_label TEXT,
            to_kind TEXT,
            to_label TEXT,
            normalized_to_label TEXT,
            evidence_json TEXT NOT NULL,
            review_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS review_queue (
            review_id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE,
            paper_id TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (candidate_id) REFERENCES extraction_candidates(candidate_id) ON DELETE CASCADE,
            FOREIGN KEY (paper_id) REFERENCES papers(paper_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS graph_nodes (
            node_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            label TEXT NOT NULL,
            normalized_label TEXT NOT NULL,
            aliases_json TEXT NOT NULL,
            description TEXT,
            support_count INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS graph_edges (
            edge_id TEXT PRIMARY KEY,
            edge_type TEXT NOT NULL,
            from_node_id TEXT NOT NULL,
            to_node_id TEXT NOT NULL,
            support_count INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(edge_type, from_node_id, to_node_id)
        );
        CREATE TABLE IF NOT EXISTS evidence_refs (
            evidence_id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            paper_id TEXT NOT NULL,
            page_start INTEGER NOT NULL,
            page_end INTEGER NOT NULL,
            chunk_id TEXT,
            snippet TEXT NOT NULL,
            source_type TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS node_stats (
            node_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            paper_count INTEGER NOT NULL,
            evidence_count INTEGER NOT NULL,
            support_count INTEGER NOT NULL,
            in_degree INTEGER NOT NULL,
            out_degree INTEGER NOT NULL,
            is_orphan INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS orphan_nodes (
            node_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            reason TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS challenge_method_links (
            challenge_node_id TEXT NOT NULL,
            task_node_id TEXT,
            pipeline_node_id TEXT,
            module_node_id TEXT,
            PRIMARY KEY (challenge_node_id, task_node_id, pipeline_node_id, module_node_id)
        );
        CREATE TABLE IF NOT EXISTS method_paths (
            task_node_id TEXT NOT NULL,
            pipeline_node_id TEXT NOT NULL,
            module_node_id TEXT NOT NULL,
            PRIMARY KEY (task_node_id, pipeline_node_id, module_node_id)
        );
        CREATE TABLE IF NOT EXISTS problem_paths (
            challenge_node_id TEXT NOT NULL,
            insight_node_id TEXT NOT NULL,
            PRIMARY KEY (challenge_node_id, insight_node_id)
        );
        CREATE TABLE IF NOT EXISTS idea_candidates (
            idea_id TEXT PRIMARY KEY,
            rule_type TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            confidence REAL NOT NULL,
            challenge_node_id TEXT,
            module_node_id TEXT,
            task_node_id TEXT,
            pipeline_node_id TEXT,
            evidence_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )?;
    conn.execute(
        "ALTER TABLE papers ADD COLUMN paper_type TEXT NOT NULL DEFAULT 'application'",
        [],
    )
    .ok();
    conn.execute(
        "UPDATE extraction_candidates
         SET entity_kind = CASE
             WHEN from_kind = 'task' AND to_kind = 'pipeline' THEN 'task_pipeline'
             WHEN from_kind = 'pipeline' AND to_kind = 'module' THEN 'pipeline_module'
             WHEN from_kind = 'challenge' AND to_kind = 'insight' THEN 'challenge_insight'
             ELSE entity_kind
         END
         WHERE candidate_kind = 'edge' AND (entity_kind IS NULL OR entity_kind = '')",
        [],
    )?;
    set_meta(conn, "schema_version", SCHEMA_VERSION)?;
    Ok(())
}

async fn ingest_single_document(
    app: &AppHandle,
    window: &Window,
    document: &FileDocument,
    extract_fast_model: &str,
    extract_fallback_model: &str,
) -> Result<()> {
    let conn = open_sqlite(app)?;
    delete_paper(&conn, &document.paper_id, &document.path)?;
    let sections = detect_sections(document);
    let paper_type = classify_paper_type(document, &sections);
    let now = cards::current_timestamp_iso_utc();
    conn.execute(
        "INSERT INTO papers (paper_id, path, title, paper_type, content_hash, index_status, extraction_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            document.paper_id,
            document.path,
            document.title,
            paper_type,
            document.content_hash,
            PENDING_STATUS,
            PENDING_STATUS,
            now,
        ],
    )?;

    for page in &document.pages {
        conn.execute(
            "INSERT INTO pages (page_id, paper_id, page_number, content, visual_note)
             VALUES (?1, ?2, ?3, ?4, NULL)",
            params![
                stable_id("page", format!("{}:{}", document.paper_id, page.page_number)),
                document.paper_id,
                page.page_number,
                page.content,
            ],
        )?;
    }

    for section in &sections {
        conn.execute(
            "INSERT INTO sections (section_id, paper_id, heading, start_page, end_page, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                section.section_id,
                document.paper_id,
                section.heading,
                section.start_page,
                section.end_page,
                section.content,
            ],
        )?;
    }

    drop(conn);

    let seed_units = build_seed_map_units(document, &sections)
        .into_iter()
        .filter(|unit| should_extract_map_unit(unit))
        .collect::<Vec<_>>();
    let map_units = build_map_units(document, &sections)
        .into_iter()
        .filter(|unit| should_extract_map_unit(unit))
        .collect::<Vec<_>>();
    let mut combined_units = Vec::with_capacity(seed_units.len() + map_units.len());
    combined_units.extend(seed_units);
    combined_units.extend(map_units);
    let map_unit_total = combined_units.len().max(1);
    let mut prepared_units = Vec::with_capacity(combined_units.len());
    for unit in &combined_units {
        let conn = open_sqlite(app)?;
        let chunk_id = stable_id("chunk", format!("{}:{}", document.paper_id, unit.unit_id));
        conn.execute(
            "INSERT INTO chunks (chunk_id, paper_id, section_id, unit_kind, page_start, page_end, content, embedding_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                chunk_id,
                document.paper_id,
                unit.section_id,
                unit.unit_kind,
                unit.page_start,
                unit.page_end,
                unit.content,
                PENDING_STATUS,
                cards::current_timestamp_iso_utc(),
            ],
        )?;
        conn.execute(
            "INSERT INTO chunk_fts (chunk_id, paper_id, text) VALUES (?1, ?2, ?3)",
            params![chunk_id, document.paper_id, unit.content],
        )?;
        prepared_units.push((unit.clone(), chunk_id));
    }

    let mut all_nodes = Vec::new();
    let mut all_edges = Vec::new();
    let mut candidate_completed_units = 0usize;
    let mut no_candidate_count = 0usize;
    let mut candidate_fallback_success_count = 0usize;
    let mut candidate_double_failure_count = 0usize;
    let mut relation_completed_units = 0usize;
    let mut relation_fallback_count = 0usize;
    let extraction_stream = stream::iter(prepared_units.into_iter().map(|(unit, chunk_id)| {
        let document = document.clone();
        let fast_model = extract_fast_model.to_string();
        let fallback_model = extract_fallback_model.to_string();
        async move {
            let (local, candidate_status, used_relation_fallback, did_relation_extract) =
                extract_map_unit(&unit, &document, &fast_model, &fallback_model)
                    .await
                    .unwrap_or((LocalExtraction::default(), CandidatePhaseStatus::DoubleFailure, false, false));
            (
                unit,
                chunk_id,
                local,
                candidate_status,
                used_relation_fallback,
                did_relation_extract,
            )
        }
    }))
    .buffer_unordered(MAP_EXTRACT_CONCURRENCY);
    tokio::pin!(extraction_stream);

    while let Some((
        unit,
        chunk_id,
        local,
        candidate_status,
        used_relation_fallback,
        did_relation_extract,
    )) = extraction_stream.next().await
    {
        candidate_completed_units += 1;
        match candidate_status {
            CandidatePhaseStatus::NoCandidate => {
                no_candidate_count += 1;
            }
            CandidatePhaseStatus::FallbackSuccess => {
                candidate_fallback_success_count += 1;
            }
            CandidatePhaseStatus::DoubleFailure => {
                candidate_double_failure_count += 1;
            }
            CandidatePhaseStatus::FastHit => {}
        }
        emit_progress(
            window,
            IngestProgress::new(
                "candidate_extract",
                candidate_completed_units,
                map_unit_total,
                format!(
                    "正在抽取候选概念（{}/{}，无候选 {}，回退成功 {}，双重失败 {}）：{}",
                    candidate_completed_units,
                    map_unit_total,
                    no_candidate_count,
                    candidate_fallback_success_count,
                    candidate_double_failure_count,
                    document.title
                ),
            )
            .with_candidate_stats(
                no_candidate_count,
                candidate_fallback_success_count,
                candidate_double_failure_count,
            ),
        );
        if did_relation_extract {
            relation_completed_units += 1;
            if used_relation_fallback {
                relation_fallback_count += 1;
            }
            emit_progress(
                window,
                IngestProgress::new(
                    "relation_extract",
                    relation_completed_units,
                    map_unit_total,
                    format!(
                        "正在补全关系与 Pipeline（{}/{}，回退 {} 次）：{}",
                        relation_completed_units,
                        map_unit_total,
                        relation_fallback_count,
                        document.title
                    ),
                ),
            );
        }
        let (nodes, edges) = reduce_local_extraction(document, &unit, &chunk_id, local);
        all_nodes.extend(nodes);
        all_edges.extend(edges);
    }

    emit_progress(
        window,
        IngestProgress::new(
            "canonicalize",
            1,
            1,
            format!("正在归并候选概念：{}", document.title),
        ),
    );
    let (canonical_nodes, canonical_edges) =
        canonicalize_candidates_small(
            extract_fallback_model,
            &document.title,
            all_nodes,
            all_edges,
        )
        .await
        .unwrap_or_else(|_| (Vec::new(), Vec::new()));
    let (canonical_nodes, canonical_edges) =
        apply_candidate_budget(&paper_type, canonical_nodes, canonical_edges);
    let conn = open_sqlite(app)?;
    persist_candidates(&conn, document, &canonical_nodes, &canonical_edges)?;
    conn.execute(
        "UPDATE papers SET extraction_status = ?2, updated_at = ?3 WHERE paper_id = ?1",
        params![
            document.paper_id,
            REVIEW_PENDING_STATUS,
            cards::current_timestamp_iso_utc()
        ],
    )?;
    Ok(())
}

fn reduce_local_extraction(
    document: &FileDocument,
    unit: &MapUnit,
    chunk_id: &str,
    local: LocalExtraction,
) -> (Vec<ReducedNodeCandidate>, Vec<ReducedEdgeCandidate>) {
    let mut nodes = Vec::new();
    let mut push_items = |kind: &str, items: Vec<LocalExtractionItem>| {
        for item in items {
            let label = item.label.trim();
            if label.is_empty() {
                continue;
            }
            if is_overly_generic_label(kind, label) || is_overlong_problem_label(kind, label) {
                continue;
            }
            let confidence = item.confidence.unwrap_or(0.0);
            if confidence < MAP_MIN_CONFIDENCE {
                continue;
            }
            let snippet = match item
                .evidence_snippet
                .filter(|value| !value.trim().is_empty())
                .or_else(|| try_build_evidence_snippet(&unit.content, label))
            {
                Some(value) if is_explicit_evidence_snippet(&value, label) => value,
                _ => continue,
            };
            if is_generic_background_evidence(&snippet) {
                continue;
            }
            nodes.push(ReducedNodeCandidate {
                paper_id: document.paper_id.clone(),
                kind: kind.to_string(),
                label: label.to_string(),
                normalized_label: normalize_label(label),
                aliases: vec![label.to_string()],
                description: item.summary.unwrap_or_default(),
                confidence,
                evidence: vec![EvidenceRef {
                    paper_id: document.paper_id.clone(),
                    paper_title: document.title.clone(),
                    paper_path: document.path.clone(),
                    page_start: unit.page_start,
                    page_end: unit.page_end,
                    chunk_id: Some(chunk_id.to_string()),
                    snippet,
                    source_type: "map_extract".to_string(),
                }],
            });
        }
    };
    push_items("task", local.tasks);
    push_items("pipeline", local.pipelines);
    push_items("module", local.modules);
    push_items("challenge", local.challenges);
    push_items("insight", local.insights);

    let mut edges = Vec::new();
    let mut push_edges =
        |edge_type: &str, from_kind: &str, to_kind: &str, pairs: Vec<LocalExtractionEdge>| {
            for pair in pairs {
                let from_label = pair.from_label.trim();
                let to_label = pair.to_label.trim();
                if from_label.is_empty() || to_label.is_empty() {
                    continue;
                }
                if is_overly_generic_label(from_kind, from_label)
                    || is_overly_generic_label(to_kind, to_label)
                    || is_overlong_problem_label(from_kind, from_label)
                    || is_overlong_problem_label(to_kind, to_label)
                {
                    continue;
                }
                let confidence = pair.confidence.unwrap_or(0.0);
                if confidence < MAP_MIN_CONFIDENCE {
                    continue;
                }
                let snippet = match pair
                    .evidence_snippet
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| try_build_evidence_snippet(&unit.content, from_label))
                {
                    Some(value) if is_explicit_evidence_snippet(&value, from_label) => value,
                    _ => continue,
                };
                if is_generic_background_evidence(&snippet) {
                    continue;
                }
                edges.push(ReducedEdgeCandidate {
                    paper_id: document.paper_id.clone(),
                    edge_type: edge_type.to_string(),
                    from_kind: from_kind.to_string(),
                    from_label: from_label.to_string(),
                    normalized_from_label: normalize_label(from_label),
                    to_kind: to_kind.to_string(),
                    to_label: to_label.to_string(),
                    normalized_to_label: normalize_label(to_label),
                    confidence,
                    evidence: vec![EvidenceRef {
                        paper_id: document.paper_id.clone(),
                        paper_title: document.title.clone(),
                        paper_path: document.path.clone(),
                        page_start: unit.page_start,
                        page_end: unit.page_end,
                        chunk_id: Some(chunk_id.to_string()),
                        snippet,
                        source_type: "map_extract".to_string(),
                    }],
                });
            }
        };
    push_edges("task_pipeline", "task", "pipeline", local.task_pipeline_pairs);
    push_edges(
        "pipeline_module",
        "pipeline",
        "module",
        local.pipeline_module_pairs,
    );
    push_edges(
        "challenge_insight",
        "challenge",
        "insight",
        local.challenge_insight_pairs,
    );
    (nodes, edges)
}

async fn canonicalize_candidates_small(
    model: &str,
    paper_title: &str,
    node_candidates: Vec<ReducedNodeCandidate>,
    edge_candidates: Vec<ReducedEdgeCandidate>,
) -> Result<(Vec<ReducedNodeCandidate>, Vec<ReducedEdgeCandidate>)> {
    let mut grouped_nodes: HashMap<(String, String), AggregatedNodeCandidate> = HashMap::new();
    for candidate in node_candidates {
        if candidate.normalized_label.is_empty() {
            continue;
        }
        let key = (candidate.kind.clone(), candidate.normalized_label.clone());
        let entry = grouped_nodes.entry(key).or_insert_with(|| AggregatedNodeCandidate {
            kind: candidate.kind.clone(),
            normalized_label: candidate.normalized_label.clone(),
            labels: Vec::new(),
            descriptions: Vec::new(),
            aliases: Vec::new(),
            confidence_sum: 0.0,
            confidence_count: 0,
            paper_ids: HashSet::new(),
            evidence: Vec::new(),
        });
        entry.labels.push(candidate.label.clone());
        if !candidate.description.trim().is_empty() {
            entry.descriptions.push(candidate.description.clone());
        }
        entry.aliases.extend(candidate.aliases.clone());
        entry.confidence_sum += candidate.confidence;
        entry.confidence_count += 1;
        entry.paper_ids.insert(candidate.paper_id.clone());
        entry.evidence.extend(candidate.evidence.clone());
    }

    let mut grouped_edges: HashMap<(String, String, String), AggregatedEdgeCandidate> = HashMap::new();
    for candidate in edge_candidates {
        if candidate.normalized_from_label.is_empty() || candidate.normalized_to_label.is_empty() {
            continue;
        }
        let key = (
            candidate.edge_type.clone(),
            candidate.normalized_from_label.clone(),
            candidate.normalized_to_label.clone(),
        );
        let entry = grouped_edges.entry(key).or_insert_with(|| AggregatedEdgeCandidate {
            edge_type: candidate.edge_type.clone(),
            from_kind: candidate.from_kind.clone(),
            from_label: candidate.from_label.clone(),
            normalized_from_label: candidate.normalized_from_label.clone(),
            to_kind: candidate.to_kind.clone(),
            to_label: candidate.to_label.clone(),
            normalized_to_label: candidate.normalized_to_label.clone(),
            confidence_sum: 0.0,
            confidence_count: 0,
            paper_ids: HashSet::new(),
            evidence: Vec::new(),
        });
        entry.confidence_sum += candidate.confidence;
        entry.confidence_count += 1;
        entry.paper_ids.insert(candidate.paper_id.clone());
        entry.evidence.extend(candidate.evidence.clone());
    }

    let mut node_list = grouped_nodes
        .into_values()
        .map(|entry| ReducedNodeCandidate {
            paper_id: entry.paper_ids.iter().next().cloned().unwrap_or_default(),
            kind: entry.kind,
            label: select_best_label(&entry.labels),
            normalized_label: entry.normalized_label,
            aliases: dedupe_strings(entry.aliases),
            description: entry.descriptions.into_iter().next().unwrap_or_default(),
            confidence: if entry.confidence_count == 0 {
                0.0
            } else {
                entry.confidence_sum / entry.confidence_count as f32
            },
            evidence: entry.evidence,
        })
        .filter(|candidate| candidate.confidence >= REDUCE_MIN_CONFIDENCE)
        .collect::<Vec<_>>();

    if node_list.len() > 8 {
        let canonical_payload = json!({
            "paperTitle": paper_title,
            "items": node_list.iter().map(|item| {
                json!({
                    "kind": item.kind,
                    "label": item.label,
                    "aliases": item.aliases,
                    "description": item.description,
                    "confidence": item.confidence,
                    "evidence": item.evidence.iter().take(2).map(|e| e.snippet.clone()).collect::<Vec<_>>(),
                })
            }).collect::<Vec<_>>()
        });
        if let Ok(value) = run_structured_json(
            model,
            "You are a careful research concept normalizer. Merge only obvious alias variants and preserve technical distinctions.",
            &format!(
                "请把下面来自同一篇论文的候选概念做轻量规范化。只能合并明显同义、缩写或大小写差异，不要强行合并不同技术路线。返回 JSON。\n\n{}",
                canonical_payload
            ),
            node_canonicalize_schema(),
        )
        .await
        {
            if let Some(items) = value.get("items").and_then(|value| value.as_array()) {
                let mut rewritten = Vec::new();
                for item in items {
                    let Some(kind) = item.get("kind").and_then(|value| value.as_str()) else {
                        continue;
                    };
                    let Some(label) = item.get("canonicalLabel").and_then(|value| value.as_str()) else {
                        continue;
                    };
                    let merged_labels = item
                        .get("mergedLabels")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|value| value.as_str())
                                .map(|value| value.to_string())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let merged_set = merged_labels
                        .iter()
                        .map(|value| normalize_label(value))
                        .collect::<HashSet<_>>();
                    let matched = node_list
                        .iter()
                        .filter(|candidate| {
                            candidate.kind == kind
                                && (merged_set.is_empty()
                                    || merged_set.contains(&candidate.normalized_label))
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if matched.is_empty() {
                        continue;
                    }
                    let mut aliases = vec![label.to_string()];
                    let mut evidence = Vec::new();
                    let mut confidence_sum = 0.0;
                    let mut description = String::new();
                    for candidate in matched {
                        aliases.extend(candidate.aliases);
                        evidence.extend(candidate.evidence);
                        confidence_sum += candidate.confidence;
                        if description.is_empty() && !candidate.description.trim().is_empty() {
                            description = candidate.description;
                        }
                    }
                    rewritten.push(ReducedNodeCandidate {
                        paper_id: String::new(),
                        kind: kind.to_string(),
                        label: label.to_string(),
                        normalized_label: normalize_label(label),
                        aliases: dedupe_strings(aliases),
                        description,
                        confidence: confidence_sum.max(0.1) / merged_labels.len().max(1) as f32,
                        evidence,
                    });
                }
                if !rewritten.is_empty() {
                    node_list = rewritten;
                }
            }
        }
    }

    let edge_list = grouped_edges
        .into_values()
        .map(|entry| ReducedEdgeCandidate {
            paper_id: entry.paper_ids.iter().next().cloned().unwrap_or_default(),
            edge_type: entry.edge_type,
            from_kind: entry.from_kind,
            from_label: entry.from_label,
            normalized_from_label: entry.normalized_from_label,
            to_kind: entry.to_kind,
            to_label: entry.to_label,
            normalized_to_label: entry.normalized_to_label,
            confidence: if entry.confidence_count == 0 {
                0.0
            } else {
                entry.confidence_sum / entry.confidence_count as f32
            },
            evidence: entry.evidence,
        })
        .filter(|candidate| candidate.confidence >= REDUCE_MIN_CONFIDENCE)
        .collect::<Vec<_>>();

    Ok((node_list, edge_list))
}

fn persist_candidates(
    conn: &SqliteConnection,
    document: &FileDocument,
    node_candidates: &[ReducedNodeCandidate],
    edge_candidates: &[ReducedEdgeCandidate],
) -> Result<()> {
    let now = cards::current_timestamp_iso_utc();
    for candidate in node_candidates {
        let candidate_id = stable_id(
            "candidate_node",
            format!(
                "{}:{}:{}",
                document.paper_id, candidate.kind, candidate.normalized_label
            ),
        );
        conn.execute(
            "INSERT INTO extraction_candidates
             (candidate_id, paper_id, map_unit_id, candidate_kind, entity_kind, label, normalized_label, aliases_json,
              description, confidence, from_kind, from_label, normalized_from_label, to_kind, to_label, normalized_to_label,
              evidence_json, review_status, created_at, updated_at)
             VALUES (?1, ?2, NULL, 'node', ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, NULL, NULL, ?9, ?10, ?11, ?11)",
            params![
                candidate_id,
                document.paper_id,
                candidate.kind,
                candidate.label,
                candidate.normalized_label,
                serde_json::to_string(&candidate.aliases)?,
                candidate.description,
                candidate.confidence,
                serde_json::to_string(&candidate.evidence)?,
                REVIEW_PENDING_STATUS,
                now,
            ],
        )?;
        conn.execute(
            "INSERT INTO review_queue (review_id, candidate_id, paper_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                stable_id("review", candidate_id.clone()),
                candidate_id,
                document.paper_id,
                REVIEW_PENDING_STATUS,
                now,
            ],
        )?;
    }

    for candidate in edge_candidates {
        let candidate_id = stable_id(
            "candidate_edge",
            format!(
                "{}:{}:{}:{}",
                document.paper_id,
                candidate.edge_type,
                candidate.normalized_from_label,
                candidate.normalized_to_label
            ),
        );
        conn.execute(
            "INSERT INTO extraction_candidates
             (candidate_id, paper_id, map_unit_id, candidate_kind, entity_kind, label, normalized_label, aliases_json,
              description, confidence, from_kind, from_label, normalized_from_label, to_kind, to_label, normalized_to_label,
              evidence_json, review_status, created_at, updated_at)
             VALUES (?1, ?2, NULL, 'edge', ?3, NULL, NULL, '[]', NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![
                candidate_id,
                document.paper_id,
                candidate.edge_type,
                candidate.confidence,
                candidate.from_kind,
                candidate.from_label,
                candidate.normalized_from_label,
                candidate.to_kind,
                candidate.to_label,
                candidate.normalized_to_label,
                serde_json::to_string(&candidate.evidence)?,
                REVIEW_PENDING_STATUS,
                now,
            ],
        )?;
        conn.execute(
            "INSERT INTO review_queue (review_id, candidate_id, paper_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                stable_id("review", candidate_id.clone()),
                candidate_id,
                document.paper_id,
                REVIEW_PENDING_STATUS,
                now,
            ],
        )?;
    }
    Ok(())
}

fn materialize_graph_from_approved_candidates(conn: &SqliteConnection) -> Result<()> {
    conn.execute("DELETE FROM graph_edges", [])?;
    conn.execute("DELETE FROM graph_nodes", [])?;
    conn.execute("DELETE FROM evidence_refs WHERE owner_type IN ('node', 'edge')", [])?;

    let mut stmt = conn.prepare(
        "SELECT entity_kind, label, normalized_label, COALESCE(aliases_json, '[]'), COALESCE(description, ''),
                confidence, paper_id, evidence_json
         FROM extraction_candidates
         WHERE candidate_kind = 'node' AND review_status = ?1
         ORDER BY entity_kind, normalized_label",
    )?;
    let rows = stmt.query_map([APPROVED_STATUS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f32>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;

    let mut grouped: HashMap<(String, String), AggregatedNodeCandidate> = HashMap::new();
    for row in rows {
        let (kind, label, normalized_label, aliases_json, description, confidence, paper_id, evidence_json) = row?;
        let entry = grouped
            .entry((kind.clone(), normalized_label.clone()))
            .or_insert_with(|| AggregatedNodeCandidate {
                kind: kind.clone(),
                normalized_label: normalized_label.clone(),
                labels: Vec::new(),
                descriptions: Vec::new(),
                aliases: Vec::new(),
                confidence_sum: 0.0,
                confidence_count: 0,
                paper_ids: HashSet::new(),
                evidence: Vec::new(),
            });
        entry.labels.push(label);
        if !description.trim().is_empty() {
            entry.descriptions.push(description);
        }
        entry.aliases.extend(serde_json::from_str::<Vec<String>>(&aliases_json).unwrap_or_default());
        entry.confidence_sum += confidence;
        entry.confidence_count += 1;
        entry.paper_ids.insert(paper_id);
        entry
            .evidence
            .extend(serde_json::from_str::<Vec<EvidenceRef>>(&evidence_json).unwrap_or_default());
    }

    let mut label_to_node_id: HashMap<(String, String), String> = HashMap::new();
    for ((kind, normalized_label), entry) in grouped {
        let node_id = stable_id("node", format!("{}:{}", kind, normalized_label));
        let now = cards::current_timestamp_iso_utc();
        conn.execute(
            "INSERT INTO graph_nodes (node_id, kind, label, normalized_label, aliases_json, description, support_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                node_id,
                kind,
                select_best_label(&entry.labels),
                normalized_label,
                serde_json::to_string(&dedupe_strings(entry.aliases))?,
                entry.descriptions.into_iter().next().unwrap_or_default(),
                entry.paper_ids.len() as i64,
                now,
            ],
        )?;
        for evidence in entry.evidence {
            conn.execute(
                "INSERT INTO evidence_refs (evidence_id, owner_type, owner_id, paper_id, page_start, page_end, chunk_id, snippet, source_type)
                 VALUES (?1, 'node', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    stable_id("evidence", format!("node:{}:{}:{}:{}", node_id, evidence.paper_id, evidence.page_start, evidence.snippet)),
                    node_id,
                    evidence.paper_id,
                    evidence.page_start,
                    evidence.page_end,
                    evidence.chunk_id,
                    evidence.snippet,
                    evidence.source_type,
                ],
            )
            .ok();
        }
        label_to_node_id.insert((kind, normalized_label), node_id);
    }

    let mut stmt = conn.prepare(
        "SELECT COALESCE(entity_kind, ''), from_kind, normalized_from_label, to_kind, normalized_to_label, evidence_json
         FROM extraction_candidates
         WHERE candidate_kind = 'edge' AND review_status = ?1
         ORDER BY COALESCE(entity_kind, ''), normalized_from_label, normalized_to_label",
    )?;
    let rows = stmt.query_map([APPROVED_STATUS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut edge_groups: HashMap<(String, String, String), (usize, Vec<EvidenceRef>)> = HashMap::new();
    for row in rows {
        let (edge_type, from_kind, normalized_from_label, to_kind, normalized_to_label, evidence_json) = row?;
        if !is_allowed_edge(&edge_type, &from_kind, &to_kind) {
            continue;
        }
        let Some(from_node_id) = label_to_node_id.get(&(from_kind.clone(), normalized_from_label.clone())) else {
            continue;
        };
        let Some(to_node_id) = label_to_node_id.get(&(to_kind.clone(), normalized_to_label.clone())) else {
            continue;
        };
        let entry = edge_groups
            .entry((edge_type.clone(), from_node_id.clone(), to_node_id.clone()))
            .or_insert((0usize, Vec::new()));
        entry.0 += 1;
        entry
            .1
            .extend(serde_json::from_str::<Vec<EvidenceRef>>(&evidence_json).unwrap_or_default());
    }

    for ((edge_type, from_node_id, to_node_id), (support_count, evidence)) in edge_groups {
        let edge_id = stable_id("edge", format!("{}:{}:{}", edge_type, from_node_id, to_node_id));
        let now = cards::current_timestamp_iso_utc();
        conn.execute(
            "INSERT INTO graph_edges (edge_id, edge_type, from_node_id, to_node_id, support_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![edge_id, edge_type, from_node_id, to_node_id, support_count as i64, now],
        )?;
        for evidence in evidence {
            conn.execute(
                "INSERT INTO evidence_refs (evidence_id, owner_type, owner_id, paper_id, page_start, page_end, chunk_id, snippet, source_type)
                 VALUES (?1, 'edge', ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    stable_id("evidence", format!("edge:{}:{}:{}:{}", edge_id, evidence.paper_id, evidence.page_start, evidence.snippet)),
                    edge_id,
                    evidence.paper_id,
                    evidence.page_start,
                    evidence.page_end,
                    evidence.chunk_id,
                    evidence.snippet,
                    evidence.source_type,
                ],
            )
            .ok();
        }
    }

    build_method_paths(conn)?;
    build_problem_paths(conn)?;
    build_challenge_method_links(conn)?;
    validate_graph_depth(conn)?;
    Ok(())
}

fn materialize_stats(conn: &SqliteConnection) -> Result<()> {
    conn.execute("DELETE FROM node_stats", [])?;
    conn.execute("DELETE FROM orphan_nodes", [])?;
    conn.execute(
        "INSERT INTO node_stats (node_id, kind, paper_count, evidence_count, support_count, in_degree, out_degree, is_orphan)
         SELECT
            g.node_id,
            g.kind,
            COUNT(DISTINCT e.paper_id) AS paper_count,
            COUNT(e.evidence_id) AS evidence_count,
            g.support_count,
            COALESCE(ind.in_degree, 0),
            COALESCE(outd.out_degree, 0),
            CASE
                WHEN g.kind IN ('task', 'pipeline', 'challenge') AND COALESCE(outd.out_degree, 0) = 0 THEN 1
                WHEN g.kind IN ('module', 'insight') AND COALESCE(ind.in_degree, 0) = 0 THEN 1
                ELSE 0
            END
         FROM graph_nodes g
         LEFT JOIN evidence_refs e ON e.owner_type = 'node' AND e.owner_id = g.node_id
         LEFT JOIN (SELECT to_node_id AS node_id, COUNT(*) AS in_degree FROM graph_edges GROUP BY to_node_id) ind ON ind.node_id = g.node_id
         LEFT JOIN (SELECT from_node_id AS node_id, COUNT(*) AS out_degree FROM graph_edges GROUP BY from_node_id) outd ON outd.node_id = g.node_id
         GROUP BY g.node_id, g.kind, g.support_count, ind.in_degree, outd.out_degree",
        [],
    )?;
    conn.execute(
        "INSERT INTO orphan_nodes (node_id, kind, reason)
         SELECT node_id, kind,
            CASE WHEN kind IN ('task', 'pipeline', 'challenge') THEN 'missing_outgoing_edge' ELSE 'missing_incoming_edge' END
         FROM node_stats WHERE is_orphan = 1",
        [],
    )?;
    Ok(())
}

fn materialize_ideas(conn: &SqliteConnection) {
    let _ = conn.execute("DELETE FROM idea_candidates", []);
    let _ = materialize_rule1_ideas(conn);
    let _ = materialize_rule2_ideas(conn);
}

async fn refresh_idea_candidates(app: &AppHandle, embedding_model: &str) -> Result<()> {
    {
        let conn = open_sqlite(app)?;
        materialize_ideas(&conn);
    }
    materialize_rule3_ideas(app, embedding_model).await?;
    Ok(())
}

async fn rebuild_vector_indexes(
    app: &AppHandle,
    window: Option<&Window>,
    embedding_model: &str,
) -> Result<()> {
    initialize(app).await?;
    let conn = open_sqlite(app)?;
    let chunk_rows = load_chunk_rows(&conn)?;
    let page_rows = load_page_rows(&conn)?;
    let concept_rows = load_concept_rows(&conn)?;

    let db = open_lancedb(app).await?;
    let _ = db.drop_table(CHUNK_VECTOR_TABLE, &[]).await;
    let _ = db.drop_table(PAGE_VECTOR_TABLE, &[]).await;
    let _ = db.drop_table(CONCEPT_VECTOR_TABLE, &[]).await;

    let total = chunk_rows.len() + page_rows.len() + concept_rows.len();
    if !chunk_rows.is_empty() {
        if let Some(window) = window {
            emit_progress(
                window,
                IngestProgress::new("index_vectors", 0, total.max(1), "正在写入 chunk 向量..."),
            );
        }
        create_vector_table_from_chunks(&db, CHUNK_VECTOR_TABLE, &chunk_rows, embedding_model).await?;
    }
    if !page_rows.is_empty() {
        create_vector_table_from_chunks(&db, PAGE_VECTOR_TABLE, &page_rows, embedding_model).await?;
    }
    if !concept_rows.is_empty() {
        create_vector_table_from_concepts(&db, CONCEPT_VECTOR_TABLE, &concept_rows, embedding_model).await?;
    }

    conn.execute("UPDATE chunks SET embedding_status = ?1", [READY_STATUS]).ok();
    conn.execute("UPDATE papers SET index_status = ?1", [READY_STATUS]).ok();
    set_meta(&conn, "schema_version", SCHEMA_VERSION).ok();
    set_meta(&conn, "embedding_model", embedding_model).ok();
    set_meta(&conn, "chunk_count", &chunk_rows.len().to_string()).ok();
    set_meta(&conn, "concept_count", &concept_rows.len().to_string()).ok();
    Ok(())
}

async fn open_lancedb(app: &AppHandle) -> Result<Connection> {
    let root = research_root(app)?.join(LANCEDB_DIR);
    if !root.exists() {
        fs::create_dir_all(&root)?;
    }
    Ok(connect(root.to_string_lossy().as_ref()).execute().await?)
}

async fn create_vector_table_from_chunks(
    db: &Connection,
    table_name: &str,
    rows: &[ChunkRow],
    embedding_model: &str,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut vectors = Vec::with_capacity(rows.len());
    for row in rows {
        vectors.push(embed_text(&row.content, embedding_model).await?);
    }
    let batch = build_chunk_record_batch(rows, &vectors)?;
    let schema = batch.schema();
    let batches: Box<dyn RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema));
    db.create_table(table_name, batches).execute().await?;
    Ok(())
}

async fn create_vector_table_from_concepts(
    db: &Connection,
    table_name: &str,
    rows: &[ConceptRow],
    embedding_model: &str,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut vectors = Vec::with_capacity(rows.len());
    for row in rows {
        vectors.push(embed_text(&row.text, embedding_model).await?);
    }
    let batch = build_concept_record_batch(rows, &vectors)?;
    let schema = batch.schema();
    let batches: Box<dyn RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema));
    db.create_table(table_name, batches).execute().await?;
    Ok(())
}

fn build_chunk_record_batch(rows: &[ChunkRow], vectors: &[Vec<f32>]) -> Result<RecordBatch> {
    let dim = vectors
        .first()
        .map(|vector| vector.len())
        .ok_or_else(|| anyhow!("No vectors available for chunk batch"))?;
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("paper_id", DataType::Utf8, false),
        Field::new("paper_path", DataType::Utf8, false),
        Field::new("paper_title", DataType::Utf8, false),
        Field::new("content", DataType::Utf8, false),
        Field::new("page_start", DataType::Int32, false),
        Field::new("page_end", DataType::Int32, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim as i32),
            true,
        ),
    ]));
    let vector_array = Arc::new(FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        vectors
            .iter()
            .map(|vector| Some(vector.iter().copied().map(Some).collect::<Vec<_>>())),
        dim as i32,
    ));
    Ok(RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(rows.iter().map(|row| row.chunk_id.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.paper_id.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.paper_path.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.paper_title.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.content.as_str()).collect::<Vec<_>>())),
            Arc::new(Int32Array::from(rows.iter().map(|row| row.page_start as i32).collect::<Vec<_>>())),
            Arc::new(Int32Array::from(rows.iter().map(|row| row.page_end as i32).collect::<Vec<_>>())),
            vector_array,
        ],
    )?)
}

fn build_concept_record_batch(rows: &[ConceptRow], vectors: &[Vec<f32>]) -> Result<RecordBatch> {
    let dim = vectors
        .first()
        .map(|vector| vector.len())
        .ok_or_else(|| anyhow!("No vectors available for concept batch"))?;
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("kind", DataType::Utf8, false),
        Field::new("label", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim as i32),
            true,
        ),
    ]));
    let vector_array = Arc::new(FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        vectors
            .iter()
            .map(|vector| Some(vector.iter().copied().map(Some).collect::<Vec<_>>())),
        dim as i32,
    ));
    Ok(RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from(rows.iter().map(|row| row.node_id.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.kind.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.label.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(rows.iter().map(|row| row.text.as_str()).collect::<Vec<_>>())),
            vector_array,
        ],
    )?)
}

async fn search_chunks_vector(
    app: &AppHandle,
    query_vector: &[f32],
    limit: usize,
) -> Result<Vec<ResearchSearchHit>> {
    let db = open_lancedb(app).await?;
    let table = match db.open_table(CHUNK_VECTOR_TABLE).execute().await {
        Ok(table) => table,
        Err(_) => return Ok(Vec::new()),
    };
    let batches = table
        .query()
        .nearest_to(query_vector)?
        .limit(limit)
        .execute()
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let conn = open_sqlite(app)?;
    let mut hits = Vec::new();
    for batch in batches {
        hits.extend(parse_chunk_search_batch(&batch, &conn)?);
    }
    Ok(hits)
}

async fn search_module_concepts_by_vector(
    app: &AppHandle,
    query_vector: &[f32],
    limit: usize,
) -> Result<Vec<ConceptVectorHit>> {
    let db = open_lancedb(app).await?;
    let table = match db.open_table(CONCEPT_VECTOR_TABLE).execute().await {
        Ok(table) => table,
        Err(_) => return Ok(Vec::new()),
    };
    let batches = table
        .query()
        .nearest_to(query_vector)?
        .limit(limit.max(1) * 3)
        .execute()
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let mut hits = Vec::new();
    for batch in batches {
        hits.extend(parse_concept_search_batch(&batch)?);
    }
    hits.retain(|hit| hit.kind == "module");
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
    });
    let mut seen = HashSet::new();
    hits.retain(|hit| seen.insert(hit.node_id.clone()));
    hits.truncate(limit.max(1));
    Ok(hits)
}

fn parse_chunk_search_batch(batch: &RecordBatch, conn: &SqliteConnection) -> Result<Vec<ResearchSearchHit>> {
    let ids = batch
        .column_by_name("id")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing id column"))?;
    let paper_ids = batch
        .column_by_name("paper_id")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing paper_id column"))?;
    let paths = batch
        .column_by_name("paper_path")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing paper_path column"))?;
    let titles = batch
        .column_by_name("paper_title")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing paper_title column"))?;
    let contents = batch
        .column_by_name("content")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing content column"))?;
    let page_starts = batch
        .column_by_name("page_start")
        .and_then(|array| array.as_any().downcast_ref::<Int32Array>())
        .ok_or_else(|| anyhow!("Missing page_start column"))?;
    let page_ends = batch
        .column_by_name("page_end")
        .and_then(|array| array.as_any().downcast_ref::<Int32Array>())
        .ok_or_else(|| anyhow!("Missing page_end column"))?;
    let distances = batch
        .column_by_name("_distance")
        .and_then(|array| array.as_any().downcast_ref::<Float32Array>());

    let mut hits = Vec::new();
    for index in 0..batch.num_rows() {
        let paper_id = paper_ids.value(index).to_string();
        hits.push(ResearchSearchHit {
            id: ids.value(index).to_string(),
            paper_id: paper_id.clone(),
            path: paths.value(index).to_string(),
            title: titles.value(index).to_string(),
            page_start: page_starts.value(index) as i64,
            page_end: page_ends.value(index) as i64,
            snippet: truncate_chars(contents.value(index), 420),
            score: distance_to_score(distances.map(|array| array.value(index)).unwrap_or(0.0)),
            related_graph_nodes: related_graph_nodes_for_paper(conn, &paper_id, 6)?,
        });
    }
    Ok(hits)
}

fn parse_concept_search_batch(batch: &RecordBatch) -> Result<Vec<ConceptVectorHit>> {
    let ids = batch
        .column_by_name("id")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing concept id column"))?;
    let kinds = batch
        .column_by_name("kind")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing concept kind column"))?;
    let labels = batch
        .column_by_name("label")
        .and_then(|array| array.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| anyhow!("Missing concept label column"))?;
    let distances = batch
        .column_by_name("_distance")
        .and_then(|array| array.as_any().downcast_ref::<Float32Array>());

    let mut hits = Vec::new();
    for index in 0..batch.num_rows() {
        hits.push(ConceptVectorHit {
            node_id: ids.value(index).to_string(),
            kind: kinds.value(index).to_string(),
            label: labels.value(index).to_string(),
            score: distance_to_score(distances.map(|array| array.value(index)).unwrap_or(0.0)),
        });
    }
    Ok(hits)
}

async fn count_lance_rows(db: &Connection, table_name: &str) -> Result<usize> {
    let table = db.open_table(table_name).execute().await?;
    Ok(table.count_rows(None).await?)
}

async fn extract_map_unit(
    unit: &MapUnit,
    document: &FileDocument,
    extract_fast_model: &str,
    extract_fallback_model: &str,
) -> Result<(LocalExtraction, CandidatePhaseStatus, bool, bool)> {
    let candidate_result = extract_candidate_items(unit, document, extract_fast_model).await;
    let (candidate, candidate_status) = match candidate_result {
        Ok(candidate) => {
            if candidate.item_count() > 0 {
                (candidate, CandidatePhaseStatus::FastHit)
            } else {
                (candidate, CandidatePhaseStatus::NoCandidate)
            }
        }
        Err(_) => match extract_candidate_items(unit, document, extract_fallback_model).await {
            Ok(candidate) => {
                if candidate.item_count() > 0 {
                    (candidate, CandidatePhaseStatus::FallbackSuccess)
                } else {
                    (candidate, CandidatePhaseStatus::NoCandidate)
                }
            }
            Err(_) => (CandidateExtraction::default(), CandidatePhaseStatus::DoubleFailure),
        },
    };

    let mut local = LocalExtraction {
        tasks: candidate.tasks,
        modules: candidate.modules,
        challenges: candidate.challenges,
        insights: candidate.insights,
        ..Default::default()
    };

    if local.node_count() == 0 {
        return Ok((local, candidate_status, false, false));
    }

    let relation_result =
        extract_relation_items(unit, document, &local, extract_fallback_model).await;
    let (relation, used_relation_fallback) = match relation_result {
        Ok(relation) => (relation, false),
        Err(_) if extract_fallback_model != "qwen3.5:9b" => (
            extract_relation_items(unit, document, &local, "qwen3.5:9b")
                .await
                .unwrap_or_default(),
            true,
        ),
        Err(_) => (RelationExtraction::default(), false),
    };

    local.pipelines = relation.pipelines;
    local.task_pipeline_pairs = relation.task_pipeline_pairs;
    local.pipeline_module_pairs = relation.pipeline_module_pairs;
    local.challenge_insight_pairs = relation.challenge_insight_pairs;
    Ok((local, candidate_status, used_relation_fallback, true))
}

fn candidate_extraction_schema() -> serde_json::Value {
    let item_schema = json!({
        "type": "object",
        "properties": {
            "label": { "type": "string" },
            "summary": { "type": ["string", "null"] },
            "confidence": { "type": ["number", "null"] },
            "evidenceSnippet": { "type": ["string", "null"] }
        },
        "required": ["label", "summary", "confidence", "evidenceSnippet"],
        "additionalProperties": false
    });
    json!({
        "type": "object",
        "properties": {
            "tasks": { "type": "array", "items": item_schema },
            "modules": { "type": "array", "items": item_schema },
            "challenges": { "type": "array", "items": item_schema },
            "insights": { "type": "array", "items": item_schema }
        },
        "required": ["tasks","modules","challenges","insights"],
        "additionalProperties": false
    })
}

fn relation_extraction_schema() -> serde_json::Value {
    let item_schema = json!({
        "type": "object",
        "properties": {
            "label": { "type": "string" },
            "summary": { "type": ["string", "null"] },
            "confidence": { "type": ["number", "null"] },
            "evidenceSnippet": { "type": ["string", "null"] }
        },
        "required": ["label", "summary", "confidence", "evidenceSnippet"],
        "additionalProperties": false
    });
    let edge_schema = json!({
        "type": "object",
        "properties": {
            "fromLabel": { "type": "string" },
            "toLabel": { "type": "string" },
            "confidence": { "type": ["number", "null"] },
            "evidenceSnippet": { "type": ["string", "null"] }
        },
        "required": ["fromLabel", "toLabel", "confidence", "evidenceSnippet"],
        "additionalProperties": false
    });
    json!({
        "type": "object",
        "properties": {
            "pipelines": { "type": "array", "items": item_schema },
            "taskPipelinePairs": { "type": "array", "items": edge_schema },
            "pipelineModulePairs": { "type": "array", "items": edge_schema },
            "challengeInsightPairs": { "type": "array", "items": edge_schema }
        },
        "required": ["pipelines","taskPipelinePairs","pipelineModulePairs","challengeInsightPairs"],
        "additionalProperties": false
    })
}

async fn extract_candidate_items(
    unit: &MapUnit,
    document: &FileDocument,
    model: &str,
) -> Result<CandidateExtraction> {
    let prompt_content = truncate_chars(&unit.content, MAP_PROMPT_CHAR_LIMIT);
    let prompt = format!(
        "你会收到一段学术论文片段。请提取该片段中有明确上下文支持的局部 Task、Module、Challenge、Insight，返回 JSON。\n\n规则：\n1. 每个数组最多返回 {max_items} 项。\n2. 不要求术语逐字出现，只要该片段能明确支持该局部概念即可。\n3. 允许从摘要、引言、方法段落中做保守抽象，但不要编造超出片段的信息。\n4. 每个条目都必须带简短 evidenceSnippet，优先直接引用或贴近原句改写。\n5. 如果该片段没有某类概念，就返回空数组。\n6. 不要输出数组以外的字段。\n\n论文标题：{title}\n片段标题：{heading}\n页码：{start_page}-{end_page}\n\n片段内容：\n{content}",
        max_items = MAP_MAX_ITEMS_PER_KIND,
        title = document.title,
        heading = unit.heading,
        start_page = unit.page_start,
        end_page = unit.page_end,
        content = prompt_content
    );
    let value = run_structured_json(
        model,
        "You extract evidence-backed local research concepts from paper excerpts. Be conservative but not overly literal; summary and intro sections may require brief abstraction grounded in the text.",
        &prompt,
        candidate_extraction_schema(),
    )
    .await?;
    Ok(serde_json::from_value(value)?)
}

async fn extract_relation_items(
    unit: &MapUnit,
    document: &FileDocument,
    candidate: &LocalExtraction,
    model: &str,
) -> Result<RelationExtraction> {
    let prompt_content = truncate_chars(&unit.content, MAP_PROMPT_CHAR_LIMIT);
    let prompt = format!(
        "你会收到一段论文片段，以及已经抽出的候选节点。请补全片段内部明确支持的 Pipeline，以及 task->pipeline、pipeline->module、challenge->insight 三种关系。\n\n规则：\n1. Pipeline 最多 {max_items} 项。\n2. 不要发明新 Task、Module、Challenge、Insight；优先使用候选列表中的标签。\n3. 关系必须有片段证据支持，每条都带 evidenceSnippet。\n4. 只返回 JSON。\n\n论文标题：{title}\n片段标题：{heading}\n页码：{start_page}-{end_page}\n\n候选 Task：{tasks}\n候选 Module：{modules}\n候选 Challenge：{challenges}\n候选 Insight：{insights}\n\n片段内容：\n{content}",
        max_items = MAP_MAX_ITEMS_PER_KIND,
        title = document.title,
        heading = unit.heading,
        start_page = unit.page_start,
        end_page = unit.page_end,
        tasks = candidate.tasks.iter().map(|item| item.label.clone()).collect::<Vec<_>>().join(", "),
        modules = candidate.modules.iter().map(|item| item.label.clone()).collect::<Vec<_>>().join(", "),
        challenges = candidate.challenges.iter().map(|item| item.label.clone()).collect::<Vec<_>>().join(", "),
        insights = candidate.insights.iter().map(|item| item.label.clone()).collect::<Vec<_>>().join(", "),
        content = prompt_content
    );
    let value = run_structured_json(
        model,
        "You extract only local pipeline nodes and bounded method/problem relations from a paper excerpt. Do not invent unsupported links.",
        &prompt,
        relation_extraction_schema(),
    )
    .await?;
    Ok(serde_json::from_value(value)?)
}

fn node_canonicalize_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": { "type": "string" },
                        "canonicalLabel": { "type": "string" },
                        "mergedLabels": { "type": "array", "items": { "type": "string" } }
                    },
                    "required": ["kind", "canonicalLabel", "mergedLabels"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["items"],
        "additionalProperties": false
    })
}

async fn run_structured_json(model: &str, system_prompt: &str, user_prompt: &str, schema: serde_json::Value) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OLLAMA_REQUEST_TIMEOUT_SECS))
        .build()?;
    let res = client
        .post("http://localhost:11434/api/chat")
        .json(&json!({
            "model": model,
            "stream": false,
            "format": schema,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_prompt }
            ],
            "options": { "temperature": 0.1 }
        }))
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("Ollama structured output failed: {}", res.status()));
    }
    let value: serde_json::Value = res.json().await?;
    let raw = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .or_else(|| value.get("response").and_then(|content| content.as_str()))
        .ok_or_else(|| anyhow!("Structured output missing message content"))?;
    Ok(serde_json::from_str(&strip_code_fences(raw))?)
}

async fn run_json_generate(model: &str, prompt: &str) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OLLAMA_REQUEST_TIMEOUT_SECS))
        .build()?;
    let res = client
        .post("http://localhost:11434/api/generate")
        .json(&json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "format": "json",
            "options": { "temperature": 0.0 }
        }))
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("Ollama generate failed: {}", res.status()));
    }
    let value: serde_json::Value = res.json().await?;
    let raw = value
        .get("response")
        .and_then(|content| content.as_str())
        .ok_or_else(|| anyhow!("Generate output missing response"))?;
    Ok(serde_json::from_str(&strip_code_fences(raw))?)
}

fn normalize_extraction_value(
    mut value: serde_json::Value,
    schema: serde_json::Value,
) -> Result<serde_json::Value> {
    let properties = schema
        .get("properties")
        .and_then(|value| value.as_object())
        .ok_or_else(|| anyhow!("Schema missing properties"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("Extraction output is not a JSON object"))?;
    for (key, _) in properties {
        if !object.contains_key(key) {
            object.insert(key.clone(), json!([]));
        }
    }
    Ok(value)
}

async fn run_ollama_chat(model: &str, messages: Vec<serde_json::Value>) -> Result<String> {
    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/api/chat")
        .json(&json!({ "model": model, "stream": false, "messages": messages }))
        .send()
        .await?;
    if !res.status().is_success() {
        return Err(anyhow!("Ollama chat failed: {}", res.status()));
    }
    let value: serde_json::Value = res.json().await?;
    Ok(value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .or_else(|| value.get("response").and_then(|content| content.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string())
}

async fn resolve_embedding_model(preferred: Option<&str>) -> Result<String> {
    let mut candidates = Vec::new();
    if let Some(preferred) = preferred {
        if !preferred.trim().is_empty() {
            candidates.push(preferred.trim().to_string());
        }
    }
    for candidate in ["qwen3-embedding", "embeddinggemma", "nomic-embed-text", "mxbai-embed-large"] {
        if !candidates.iter().any(|value| value == candidate) {
            candidates.push(candidate.to_string());
        }
    }
    for candidate in candidates {
        if embed_text("embedding probe", &candidate).await.is_ok() {
            return Ok(candidate);
        }
    }
    Err(anyhow!("No embedding model is available"))
}

async fn embed_text(text: &str, model: &str) -> Result<Vec<f32>> {
    let client = reqwest::Client::new();
    let res = client
        .post("http://localhost:11434/api/embed")
        .json(&json!({ "model": model, "input": text }))
        .send()
        .await?;
    if res.status().is_success() {
        return parse_embedding_json(&res.json().await?);
    }
    let fallback = client
        .post("http://localhost:11434/api/embeddings")
        .json(&json!({ "model": model, "prompt": text }))
        .send()
        .await?;
    if !fallback.status().is_success() {
        return Err(anyhow!("Embedding failed for '{}'", model));
    }
    parse_embedding_json(&fallback.json().await?)
}

fn parse_embedding_json(json: &serde_json::Value) -> Result<Vec<f32>> {
    if let Some(array) = json.get("embeddings").and_then(|value| value.as_array()) {
        if let Some(first) = array.first().and_then(|value| value.as_array()) {
            return Ok(first.iter().map(|value| value.as_f64().unwrap_or(0.0) as f32).collect());
        }
    }
    if let Some(array) = json.get("embedding").and_then(|value| value.as_array()) {
        return Ok(array.iter().map(|value| value.as_f64().unwrap_or(0.0) as f32).collect());
    }
    Err(anyhow!("Embedding response missing vector payload"))
}

fn load_chunk_rows(conn: &SqliteConnection) -> Result<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        "SELECT c.chunk_id, c.paper_id, p.path, p.title, c.page_start, c.page_end, c.content
         FROM chunks c JOIN papers p ON p.paper_id = c.paper_id
         ORDER BY p.updated_at DESC, c.page_start ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            paper_id: row.get(1)?,
            paper_path: row.get(2)?,
            paper_title: row.get(3)?,
            page_start: row.get(4)?,
            page_end: row.get(5)?,
            content: row.get(6)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn load_page_rows(conn: &SqliteConnection) -> Result<Vec<ChunkRow>> {
    let mut stmt = conn.prepare(
        "SELECT p.paper_id || ':' || pg.page_number AS stable_id, p.paper_id, p.path, p.title, pg.page_number, pg.page_number, COALESCE(pg.visual_note, pg.content)
         FROM pages pg JOIN papers p ON p.paper_id = pg.paper_id
         ORDER BY p.paper_id, pg.page_number",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ChunkRow {
            chunk_id: row.get(0)?,
            paper_id: row.get(1)?,
            paper_path: row.get(2)?,
            paper_title: row.get(3)?,
            page_start: row.get(4)?,
            page_end: row.get(5)?,
            content: row.get(6)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn load_concept_rows(conn: &SqliteConnection) -> Result<Vec<ConceptRow>> {
    let mut stmt = conn.prepare("SELECT node_id, kind, label, COALESCE(description, '') FROM graph_nodes ORDER BY kind, label")?;
    let rows = stmt.query_map([], |row| {
        let label: String = row.get(2)?;
        let description: String = row.get(3)?;
        Ok(ConceptRow {
            node_id: row.get(0)?,
            kind: row.get(1)?,
            label: label.clone(),
            text: if description.trim().is_empty() { label } else { format!("{}: {}", label, description) },
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn build_method_paths(conn: &SqliteConnection) -> Result<()> {
    conn.execute("DELETE FROM method_paths", [])?;
    conn.execute(
        "INSERT INTO method_paths (task_node_id, pipeline_node_id, module_node_id)
         SELECT tp.from_node_id, tp.to_node_id, pm.to_node_id
         FROM graph_edges tp
         JOIN graph_edges pm ON pm.from_node_id = tp.to_node_id
         WHERE tp.edge_type = 'task_pipeline' AND pm.edge_type = 'pipeline_module'",
        [],
    )?;
    Ok(())
}

fn build_problem_paths(conn: &SqliteConnection) -> Result<()> {
    conn.execute("DELETE FROM problem_paths", [])?;
    conn.execute(
        "INSERT INTO problem_paths (challenge_node_id, insight_node_id)
         SELECT from_node_id, to_node_id FROM graph_edges WHERE edge_type = 'challenge_insight'",
        [],
    )?;
    Ok(())
}

fn build_challenge_method_links(conn: &SqliteConnection) -> Result<()> {
    conn.execute("DELETE FROM challenge_method_links", [])?;
    conn.execute(
        "INSERT OR IGNORE INTO challenge_method_links (challenge_node_id, task_node_id, pipeline_node_id, module_node_id)
         SELECT DISTINCT
            ch.node_id,
            task_node.node_id,
            pipeline_node.node_id,
            module_node.node_id
         FROM extraction_candidates challenge_candidate
         JOIN extraction_candidates task_pipeline_edge
           ON task_pipeline_edge.paper_id = challenge_candidate.paper_id
          AND task_pipeline_edge.candidate_kind = 'edge'
          AND task_pipeline_edge.review_status = ?1
          AND task_pipeline_edge.from_kind = 'task'
          AND task_pipeline_edge.to_kind = 'pipeline'
         JOIN extraction_candidates pipeline_module_edge
           ON pipeline_module_edge.paper_id = challenge_candidate.paper_id
          AND pipeline_module_edge.candidate_kind = 'edge'
          AND pipeline_module_edge.review_status = ?1
          AND pipeline_module_edge.from_kind = 'pipeline'
          AND pipeline_module_edge.to_kind = 'module'
          AND pipeline_module_edge.normalized_from_label = task_pipeline_edge.normalized_to_label
         JOIN graph_nodes ch
           ON ch.kind = 'challenge'
          AND ch.normalized_label = challenge_candidate.normalized_label
         JOIN graph_nodes task_node
           ON task_node.kind = 'task'
          AND task_node.normalized_label = task_pipeline_edge.normalized_from_label
         JOIN graph_nodes pipeline_node
           ON pipeline_node.kind = 'pipeline'
          AND pipeline_node.normalized_label = task_pipeline_edge.normalized_to_label
         JOIN graph_nodes module_node
           ON module_node.kind = 'module'
          AND module_node.normalized_label = pipeline_module_edge.normalized_to_label
         WHERE challenge_candidate.candidate_kind = 'node'
           AND challenge_candidate.entity_kind = 'challenge'
           AND challenge_candidate.review_status = ?1",
        [APPROVED_STATUS],
    )?;
    Ok(())
}

fn materialize_rule1_ideas(conn: &SqliteConnection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT g.node_id, g.label, COALESCE(s.paper_count, 0), COALESCE(s.out_degree, 0)
         FROM graph_nodes g
         LEFT JOIN node_stats s ON s.node_id = g.node_id
         WHERE g.kind = 'challenge'
         ORDER BY s.paper_count DESC, g.label ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2).unwrap_or(0),
            row.get::<_, i64>(3).unwrap_or(0),
        ))
    })?;
    for row in rows {
        let (node_id, label, paper_count, out_degree) = row?;
        if out_degree > 0 || paper_count <= 0 {
            continue;
        }
        let evidence = load_node_evidence(conn, &node_id, 3)?;
        conn.execute(
            "INSERT OR REPLACE INTO idea_candidates
             (idea_id, rule_type, title, summary, confidence, challenge_node_id, module_node_id, task_node_id, pipeline_node_id, evidence_json, status, created_at, updated_at)
             VALUES (?1, 'rule1', ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, 'active', ?7, ?7)",
            params![
                stable_id("idea", format!("rule1:{}", node_id)),
                format!("缺少成熟 Insight：{}", label),
                format!("高热度 Challenge '{}' 当前还没有被图谱中的 Insight 边覆盖，适合优先补做机制解释、误差分析或新的解决思路。", label),
                (0.58f32 + (paper_count as f32 * 0.03)).min(0.92),
                node_id,
                serde_json::to_string(&evidence)?,
                cards::current_timestamp_iso_utc(),
            ],
        )?;
    }
    Ok(())
}

fn materialize_rule2_ideas(conn: &SqliteConnection) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT t.node_id, t.label
         FROM graph_nodes t
         JOIN graph_edges e ON e.from_node_id = t.node_id AND e.edge_type = 'task_pipeline'
         LEFT JOIN method_paths mp ON mp.task_node_id = t.node_id
         WHERE t.kind = 'task'
         GROUP BY t.node_id, t.label
         HAVING COUNT(DISTINCT e.to_node_id) > COUNT(DISTINCT mp.module_node_id)",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (task_node_id, task_label) = row?;
        let evidence = load_node_evidence(conn, &task_node_id, 3)?;
        conn.execute(
            "INSERT OR REPLACE INTO idea_candidates
             (idea_id, rule_type, title, summary, confidence, challenge_node_id, module_node_id, task_node_id, pipeline_node_id, evidence_json, status, created_at, updated_at)
             VALUES (?1, 'rule2', ?2, ?3, 0.54, NULL, NULL, ?4, NULL, ?5, 'active', ?6, ?6)",
            params![
                stable_id("idea", format!("rule2:{}", task_node_id)),
                format!("Task 仍有模块空缺：{}", task_label),
                format!("任务 '{}' 已出现多条 Pipeline，但模块覆盖仍不完整，适合继续补齐实现环节或做模块迁移。", task_label),
                task_node_id,
                serde_json::to_string(&evidence)?,
                cards::current_timestamp_iso_utc(),
            ],
        )?;
    }
    Ok(())
}

async fn materialize_rule3_ideas(app: &AppHandle, embedding_model: &str) -> Result<()> {
    let challenges = {
        let conn = open_sqlite(app)?;
        load_rule3_challenges(&conn, RULE3_CHALLENGE_LIMIT)?
    };
    if challenges.is_empty() {
        return Ok(());
    }

    for challenge in challenges {
        let vector = match embed_text(&challenge.text, embedding_model).await {
            Ok(vector) if !vector.is_empty() => vector,
            _ => continue,
        };
        let modules = search_module_concepts_by_vector(app, &vector, RULE3_MODULE_SEARCH_LIMIT).await?;
        if modules.is_empty() {
            continue;
        }

        let best_match = {
            let conn = open_sqlite(app)?;
            let mut selected: Option<(ConceptVectorHit, Rule3ModulePath)> = None;
            for module in modules {
                for path in load_rule3_module_paths(&conn, &module.node_id)? {
                    let already_linked = conn
                        .query_row(
                            "SELECT 1
                             FROM challenge_method_links
                             WHERE challenge_node_id = ?1
                               AND task_node_id = ?2
                               AND pipeline_node_id = ?3
                               AND module_node_id = ?4
                             LIMIT 1",
                            params![
                                challenge.node_id,
                                path.task_node_id,
                                path.pipeline_node_id,
                                module.node_id
                            ],
                            |_| Ok(()),
                        )
                        .optional()?
                        .is_some();
                    if !already_linked {
                        selected = Some((module.clone(), path));
                        break;
                    }
                }
                if selected.is_some() {
                    break;
                }
            }
            selected
        };

        let Some((module, path)) = best_match else {
            continue;
        };

        let evidence = {
            let conn = open_sqlite(app)?;
            let mut evidence = load_node_evidence(&conn, &challenge.node_id, 2)?;
            evidence.extend(load_node_evidence(&conn, &module.node_id, 2)?);
            evidence.truncate(4);
            evidence
        };
        let score_boost = (challenge.paper_count as f32 * 0.02).min(0.14);
        let confidence = (0.43 + module.score * 0.34 + score_boost).clamp(0.45, 0.93);
        let now = cards::current_timestamp_iso_utc();
        let conn = open_sqlite(app)?;
        conn.execute(
            "INSERT OR REPLACE INTO idea_candidates
             (idea_id, rule_type, title, summary, confidence, challenge_node_id, module_node_id, task_node_id, pipeline_node_id, evidence_json, status, created_at, updated_at)
             VALUES (?1, 'rule3', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?10)",
            params![
                stable_id("idea", format!("rule3:{}:{}", challenge.node_id, module.node_id)),
                format!("跨界模块迁移：{} -> {}", module.label, challenge.label),
                format!(
                    "Challenge '{}' 尚未与 Task '{}' / Pipeline '{}' 下的 Module '{}' 建立已知连接，但它们在概念向量空间里语义接近，值得作为新的跨域科研假设进一步验证。",
                    challenge.label, path.task_label, path.pipeline_label, module.label
                ),
                confidence,
                challenge.node_id,
                module.node_id,
                path.task_node_id,
                path.pipeline_node_id,
                serde_json::to_string(&evidence)?,
                now,
            ],
        )?;
    }
    Ok(())
}

fn load_rule3_challenges(conn: &SqliteConnection, limit: usize) -> Result<Vec<Rule3ChallengeSeed>> {
    let mut stmt = conn.prepare(
        "SELECT g.node_id, g.label, COALESCE(g.description, ''), COALESCE(s.paper_count, 0)
         FROM graph_nodes g
         LEFT JOIN node_stats s ON s.node_id = g.node_id
         WHERE g.kind = 'challenge'
         ORDER BY s.paper_count DESC, g.support_count DESC, g.label ASC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit as i64], |row| {
        let label: String = row.get(1)?;
        let description: String = row.get(2)?;
        Ok(Rule3ChallengeSeed {
            node_id: row.get(0)?,
            label: label.clone(),
            text: if description.trim().is_empty() {
                label
            } else {
                format!("{}: {}", label, description)
            },
            paper_count: row.get::<_, i64>(3).unwrap_or(0).max(0) as usize,
        })
    })?;
    let mut challenges = Vec::new();
    for row in rows {
        challenges.push(row?);
    }
    Ok(challenges)
}

fn load_rule3_module_paths(conn: &SqliteConnection, module_node_id: &str) -> Result<Vec<Rule3ModulePath>> {
    let mut stmt = conn.prepare(
        "SELECT mp.task_node_id, task_node.label, mp.pipeline_node_id, pipeline_node.label
         FROM method_paths mp
         JOIN graph_nodes task_node ON task_node.node_id = mp.task_node_id
         JOIN graph_nodes pipeline_node ON pipeline_node.node_id = mp.pipeline_node_id
         WHERE mp.module_node_id = ?1
         ORDER BY task_node.support_count DESC, pipeline_node.support_count DESC, pipeline_node.label ASC",
    )?;
    let rows = stmt.query_map([module_node_id], |row| {
        Ok(Rule3ModulePath {
            task_node_id: row.get(0)?,
            task_label: row.get(1)?,
            pipeline_node_id: row.get(2)?,
            pipeline_label: row.get(3)?,
        })
    })?;
    let mut paths = Vec::new();
    for row in rows {
        paths.push(row?);
    }
    Ok(paths)
}

fn paper_concepts(conn: &SqliteConnection, paper_id: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT COALESCE(label, from_label, to_label)
         FROM extraction_candidates
         WHERE paper_id = ?1 AND review_status = ?2",
    )?;
    let rows =
        stmt.query_map(params![paper_id, APPROVED_STATUS], |row| row.get::<_, Option<String>>(0))?;
    let mut set = HashSet::new();
    for row in rows {
        if let Some(value) = row? {
            if !value.trim().is_empty() {
                set.insert(value);
            }
        }
    }
    Ok(set)
}

fn load_compare_evidence(conn: &SqliteConnection, left_paper_id: &str, right_paper_id: &str, limit: usize) -> Result<Vec<EvidenceRef>> {
    let mut stmt = conn.prepare(
        "SELECT paper_id, page_start, page_end, chunk_id, snippet, source_type
         FROM evidence_refs
         WHERE paper_id IN (?1, ?2)
         ORDER BY page_start ASC
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![left_paper_id, right_paper_id, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut evidence = Vec::new();
    for row in rows {
        let (paper_id, page_start, page_end, chunk_id, snippet, source_type) = row?;
        let (paper_title, paper_path) = conn.query_row(
            "SELECT title, path FROM papers WHERE paper_id = ?1",
            [paper_id.clone()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        evidence.push(EvidenceRef {
            paper_id,
            paper_title,
            paper_path,
            page_start,
            page_end,
            chunk_id,
            snippet,
            source_type,
        });
    }
    Ok(evidence)
}

fn load_node_evidence(conn: &SqliteConnection, node_id: &str, limit: usize) -> Result<Vec<EvidenceRef>> {
    let mut stmt = conn.prepare(
        "SELECT paper_id, page_start, page_end, chunk_id, snippet, source_type
         FROM evidence_refs
         WHERE owner_type = 'node' AND owner_id = ?1
         ORDER BY page_start ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![node_id, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut evidence = Vec::new();
    for row in rows {
        let (paper_id, page_start, page_end, chunk_id, snippet, source_type) = row?;
        let (paper_title, paper_path) = conn.query_row(
            "SELECT title, path FROM papers WHERE paper_id = ?1",
            [paper_id.clone()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        evidence.push(EvidenceRef {
            paper_id,
            paper_title,
            paper_path,
            page_start,
            page_end,
            chunk_id,
            snippet,
            source_type,
        });
    }
    Ok(evidence)
}

fn load_edge_evidence(conn: &SqliteConnection, edge_id: &str, limit: usize) -> Result<Vec<EvidenceRef>> {
    let mut stmt = conn.prepare(
        "SELECT paper_id, page_start, page_end, chunk_id, snippet, source_type
         FROM evidence_refs
         WHERE owner_type = 'edge' AND owner_id = ?1
         ORDER BY page_start ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![edge_id, limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut evidence = Vec::new();
    for row in rows {
        let (paper_id, page_start, page_end, chunk_id, snippet, source_type) = row?;
        let (paper_title, paper_path) = conn.query_row(
            "SELECT title, path FROM papers WHERE paper_id = ?1",
            [paper_id.clone()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        evidence.push(EvidenceRef {
            paper_id,
            paper_title,
            paper_path,
            page_start,
            page_end,
            chunk_id,
            snippet,
            source_type,
        });
    }
    Ok(evidence)
}

fn related_papers_for_owner(
    conn: &SqliteConnection,
    owner_type: &str,
    owner_id: &str,
    limit: usize,
) -> Result<Vec<RelatedPaperRef>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT p.paper_id, p.title, p.path
         FROM evidence_refs e
         JOIN papers p ON p.paper_id = e.paper_id
         WHERE e.owner_type = ?1 AND e.owner_id = ?2
         ORDER BY p.updated_at DESC, p.title COLLATE NOCASE ASC
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![owner_type, owner_id, limit as i64], |row| {
        Ok(RelatedPaperRef {
            paper_id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
        })
    })?;
    let mut papers = Vec::new();
    for row in rows {
        papers.push(row?);
    }
    Ok(papers)
}

fn load_adjacent_nodes(
    conn: &SqliteConnection,
    node_id: &str,
    limit: usize,
) -> Result<Vec<GraphAdjacentNode>> {
    let mut stmt = conn.prepare(
        "SELECT other.node_id,
                other.kind,
                other.label,
                edge.edge_type,
                edge.direction
         FROM (
             SELECT to_node_id AS other_id, edge_type, 'outgoing' AS direction
             FROM graph_edges
             WHERE from_node_id = ?1
             UNION ALL
             SELECT from_node_id AS other_id, edge_type, 'incoming' AS direction
             FROM graph_edges
             WHERE to_node_id = ?1
         ) edge
         JOIN graph_nodes other ON other.node_id = edge.other_id
         ORDER BY edge.direction ASC, edge.edge_type ASC, other.label COLLATE NOCASE ASC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![node_id, limit as i64], |row| {
        Ok(GraphAdjacentNode {
            node_id: row.get(0)?,
            kind: row.get(1)?,
            label: row.get(2)?,
            edge_type: row.get(3)?,
            direction: row.get(4)?,
        })
    })?;
    let mut adjacent = Vec::new();
    for row in rows {
        adjacent.push(row?);
    }
    Ok(adjacent)
}

fn related_graph_nodes_for_paper(conn: &SqliteConnection, paper_id: &str, limit: usize) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT COALESCE(label, from_label, to_label)
         FROM extraction_candidates
         WHERE paper_id = ?1 AND review_status = ?2
         LIMIT ?3",
    )?;
    let rows = stmt.query_map(params![paper_id, APPROVED_STATUS, limit as i64], |row| {
        row.get::<_, Option<String>>(0)
    })?;
    let mut result = Vec::new();
    for row in rows {
        if let Some(value) = row? {
            if !value.trim().is_empty() {
                result.push(value);
            }
        }
    }
    Ok(result)
}

fn search_chunks_keyword(conn: &SqliteConnection, query: &str, limit: usize) -> Result<Vec<ResearchSearchHit>> {
    let tokens = sanitize_fts_query(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT c.chunk_id, c.paper_id, p.path, p.title, c.page_start, c.page_end, c.content
         FROM chunk_fts f
         JOIN chunks c ON c.chunk_id = f.chunk_id
         JOIN papers p ON p.paper_id = c.paper_id
         WHERE chunk_fts MATCH ?1
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![tokens, limit as i64], |row| {
        let paper_id: String = row.get(1)?;
        Ok(ResearchSearchHit {
            id: row.get(0)?,
            paper_id: paper_id.clone(),
            path: row.get(2)?,
            title: row.get(3)?,
            page_start: row.get(4)?,
            page_end: row.get(5)?,
            snippet: truncate_chars(&row.get::<_, String>(6)?, 420),
            score: 0.68,
            related_graph_nodes: related_graph_nodes_for_paper(conn, &paper_id, 6).unwrap_or_default(),
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

async fn collect_documents(path: &str) -> Result<Vec<FileDocument>> {
    let input = path.to_string();
    spawn_blocking(move || {
        let mut documents = Vec::new();
        for entry in WalkDir::new(input).into_iter().filter_map(|entry| entry.ok()) {
            let file_path = entry.path();
            if !file_path.is_file() {
                continue;
            }
            let Some(ext) = file_path.extension().map(|value| value.to_string_lossy().to_lowercase()) else {
                continue;
            };
            let pages = match ext.as_str() {
                "pdf" => read_pdf_pages(file_path),
                "md" | "txt" => Ok(vec![PageRecord {
                    page_number: 1,
                    content: read_text_file_auto(file_path)?,
                }]),
                _ => continue,
            }?;
            let full_text = pages.iter().map(|page| page.content.clone()).collect::<Vec<_>>().join("\n\n");
            if full_text.trim().is_empty() {
                continue;
            }
            let path_string = file_path.to_string_lossy().to_string();
            documents.push(FileDocument {
                paper_id: stable_id("paper", format!("{}:{}", path_string, full_text.len())),
                path: path_string,
                title: file_path.file_stem().and_then(|value| value.to_str()).unwrap_or("untitled").to_string(),
                pages,
                content_hash: stable_id("hash", &full_text),
                full_text,
            });
        }
        Ok::<_, anyhow::Error>(documents)
    })
    .await?
}

fn read_pdf_pages(path: &Path) -> Result<Vec<PageRecord>> {
    let doc = lopdf::Document::load(path).map_err(|error| anyhow!(error.to_string()))?;
    let mut result = Vec::new();
    for (index, page_number) in doc.get_pages().keys().enumerate() {
        let extracted = doc
            .extract_text(&[*page_number])
            .map_err(|error| anyhow!(error.to_string()))?;
        let normalized = normalize_pdf_text(&extracted);
        if !normalized.trim().is_empty() {
            result.push(PageRecord {
                page_number: (index + 1) as i64,
                content: normalized,
            });
        }
    }
    Ok(result)
}

fn read_pdf_page_text(path: &Path, page_number: i64) -> Result<String> {
    let doc = lopdf::Document::load(path).map_err(|error| anyhow!(error.to_string()))?;
    let pages = doc.get_pages();
    let Some((page_number_ref, _)) = pages.iter().nth((page_number.max(1) - 1) as usize) else {
        return Ok(String::new());
    };
    let extracted = doc
        .extract_text(&[*page_number_ref])
        .map_err(|error| anyhow!(error.to_string()))?;
    Ok(normalize_pdf_text(&extracted))
}

fn detect_sections(document: &FileDocument) -> Vec<SectionRecord> {
    let mut sections = Vec::new();
    let mut current_heading = String::from("Document");
    let mut current_start = document.pages.first().map(|page| page.page_number).unwrap_or(1);
    let mut current_pages = Vec::new();
    for page in &document.pages {
        if let Some(heading) = detect_heading_candidate(&page.content) {
            if !current_pages.is_empty() {
                sections.push(SectionRecord {
                    section_id: stable_id("section", format!("{}:{}:{}", document.paper_id, current_heading, current_start)),
                    heading: current_heading.clone(),
                    start_page: current_start,
                    end_page: page.page_number - 1,
                    content: current_pages.join("\n\n"),
                });
                current_pages.clear();
            }
            current_heading = heading;
            current_start = page.page_number;
        }
        current_pages.push(page.content.clone());
    }
    if !current_pages.is_empty() {
        sections.push(SectionRecord {
            section_id: stable_id("section", format!("{}:{}:{}", document.paper_id, current_heading, current_start)),
            heading: current_heading,
            start_page: current_start,
            end_page: document.pages.last().map(|page| page.page_number).unwrap_or(current_start),
            content: current_pages.join("\n\n"),
        });
    }
    if sections.len() <= 1 { Vec::new() } else { sections }
}

fn build_map_units(document: &FileDocument, sections: &[SectionRecord]) -> Vec<MapUnit> {
    if !sections.is_empty() {
        let mut units = Vec::new();
        for section in sections {
            let splitter = TextSplitter::new(MAP_UNIT_CHAR_LIMIT);
            for (index, chunk) in splitter.chunks(&section.content).enumerate() {
                units.push(MapUnit {
                    unit_id: format!("{}-{}", section.section_id, index),
                    section_id: Some(section.section_id.clone()),
                    unit_kind: "section".to_string(),
                    heading: section.heading.clone(),
                    page_start: section.start_page,
                    page_end: section.end_page,
                    content: chunk.to_string(),
                });
            }
        }
        if !units.is_empty() {
            return units;
        }
    }

    let mut units = Vec::new();
    let mut index = 0usize;
    while index < document.pages.len() {
        let page = &document.pages[index];
        let mut content = page.content.clone();
        let mut end_page = page.page_number;
        let mut consumed_pages = 1usize;
        if content.chars().count() < MAP_UNIT_CHAR_LIMIT / 2 {
            if let Some(next_page) = document.pages.get(index + 1) {
                content = format!("{}\n\n{}", content, next_page.content);
                end_page = next_page.page_number;
                consumed_pages = 2;
            }
        }
        for (chunk_index, chunk) in hard_split_with_overlap(&content, MAP_UNIT_CHAR_LIMIT, MAP_UNIT_OVERLAP)
            .into_iter()
            .enumerate()
        {
            units.push(MapUnit {
                unit_id: format!("page-window-{}-{}", page.page_number, chunk_index),
                section_id: None,
                unit_kind: "page_window".to_string(),
                heading: format!("Pages {}-{}", page.page_number, end_page),
                page_start: page.page_number,
                page_end: end_page,
                content: chunk,
            });
        }
        index += consumed_pages;
    }
    units
}

fn build_seed_map_units(_document: &FileDocument, sections: &[SectionRecord]) -> Vec<MapUnit> {
    sections
        .iter()
        .filter(|section| is_seed_section_heading(&section.heading))
        .map(|section| MapUnit {
            unit_id: format!("seed-{}", section.section_id),
            section_id: Some(section.section_id.clone()),
            unit_kind: "section_seed".to_string(),
            heading: format!("{} [seed]", section.heading),
            page_start: section.start_page,
            page_end: section.end_page,
            content: section.content.clone(),
        })
        .collect()
}

fn validate_graph_depth(conn: &SqliteConnection) -> Result<()> {
    conn.query_row(
        "WITH RECURSIVE method_walk(node_id, depth) AS (
            SELECT node_id, 0 FROM graph_nodes WHERE kind = 'task'
            UNION ALL
            SELECT e.to_node_id, method_walk.depth + 1
            FROM method_walk
            JOIN graph_edges e ON e.from_node_id = method_walk.node_id
            WHERE e.edge_type IN ('task_pipeline', 'pipeline_module') AND method_walk.depth < 6
        ) SELECT 1 LIMIT 1",
        [],
        |_| Ok(()),
    )
    .optional()?;
    conn.query_row(
        "WITH RECURSIVE problem_walk(node_id, depth) AS (
            SELECT node_id, 0 FROM graph_nodes WHERE kind = 'challenge'
            UNION ALL
            SELECT e.to_node_id, problem_walk.depth + 1
            FROM problem_walk
            JOIN graph_edges e ON e.from_node_id = problem_walk.node_id
            WHERE e.edge_type = 'challenge_insight' AND problem_walk.depth < 4
        ) SELECT 1 LIMIT 1",
        [],
        |_| Ok(()),
    )
    .optional()?;
    Ok(())
}

fn delete_paper(conn: &SqliteConnection, paper_id: &str, path: &str) -> Result<()> {
    conn.execute("DELETE FROM chunk_fts WHERE paper_id = ?1", [paper_id]).ok();
    conn.execute("DELETE FROM papers WHERE paper_id = ?1 OR path = ?2", params![paper_id, path])?;
    Ok(())
}

fn clear_research_memory(conn: &SqliteConnection) -> Result<()> {
    for table in [
        "idea_candidates",
        "challenge_method_links",
        "method_paths",
        "problem_paths",
        "orphan_nodes",
        "node_stats",
        "evidence_refs",
        "graph_edges",
        "graph_nodes",
        "review_queue",
        "extraction_candidates",
        "chunk_fts",
        "chunks",
        "sections",
        "pages",
        "papers",
    ] {
        conn.execute(&format!("DELETE FROM {}", table), []).ok();
    }
    Ok(())
}

fn render_markdown_list(values: &[String]) -> String {
    if values.is_empty() {
        "- 无明显项".to_string()
    } else {
        values.iter().map(|value| format!("- {}", value)).collect::<Vec<_>>().join("\n")
    }
}

fn select_best_label(labels: &[String]) -> String {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for label in labels {
        let trimmed = label.trim();
        if !trimmed.is_empty() {
            *counts.entry(trimmed.to_string()).or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| right.0.len().cmp(&left.0.len())))
        .map(|pair| pair.0)
        .unwrap_or_else(|| labels.first().cloned().unwrap_or_default())
}

fn dedupe_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let normalized = normalize_label(&value);
        if normalized.is_empty() || !seen.insert(normalized) {
            continue;
        }
        result.push(value);
    }
    result
}

fn ensure_trailing_separator(path: &str) -> String {
    if path.ends_with('\\') || path.ends_with('/') {
        path.to_string()
    } else {
        format!("{path}\\")
    }
}

fn hard_split_with_overlap(content: &str, max_chars: usize, overlap: usize) -> Vec<String> {
    let chars = content.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return vec![content.to_string()];
    }
    let mut result = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + max_chars).min(chars.len());
        result.push(chars[start..end].iter().collect::<String>());
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    result
}

fn try_build_evidence_snippet(content: &str, query: &str) -> Option<String> {
    if query.trim().is_empty() {
        return None;
    }
    let lower = content.to_lowercase();
    let needle = query.to_lowercase();
    if let Some(position) = lower.find(&needle) {
        let start = position.saturating_sub(80);
        let end = (position + query.len() + 80).min(content.len());
        return Some(content[start..end].replace('\n', " "));
    }
    None
}

fn build_evidence_snippet(content: &str, query: &str) -> String {
    try_build_evidence_snippet(content, query).unwrap_or_else(|| truncate_chars(content, 180))
}

fn detect_heading_candidate(page_text: &str) -> Option<String> {
    let keywords = ["abstract", "introduction", "related work", "method", "methods", "methodology", "experiments", "results", "discussion", "conclusion", "references"];
    for line in page_text.lines().take(8) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.len() > 90 {
            continue;
        }
        let normalized = trimmed.to_lowercase();
        if keywords.iter().any(|keyword| normalized == *keyword || normalized.starts_with(&format!("{} ", keyword))) {
            return Some(trimmed.to_string());
        }
        if trimmed.chars().next().map(|ch| ch.is_ascii_digit()).unwrap_or(false) && trimmed.split_whitespace().count() <= 12 {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn should_extract_map_unit(unit: &MapUnit) -> bool {
    let heading = unit.heading.to_lowercase();
    if heading.contains("reference")
        || heading.contains("bibliography")
        || heading.contains("acknowledg")
        || heading.contains("appendix")
    {
        return false;
    }
    let trimmed = unit.content.trim();
    if trimmed.chars().count() < 180 {
        return false;
    }
    let alpha_count = trimmed.chars().filter(|ch| ch.is_alphanumeric()).count();
    if alpha_count < 120 {
        return false;
    }
    true
}

fn is_seed_section_heading(heading: &str) -> bool {
    let normalized = heading.trim().to_lowercase();
    normalized == "abstract"
        || normalized.starts_with("abstract ")
        || normalized == "introduction"
        || normalized.starts_with("introduction ")
        || normalized == "method"
        || normalized == "methods"
        || normalized.starts_with("method ")
        || normalized.starts_with("methods ")
        || normalized == "methodology"
        || normalized.starts_with("methodology ")
}

fn is_explicit_evidence_snippet(snippet: &str, label: &str) -> bool {
    let trimmed = snippet.trim();
    if trimmed.chars().count() < 32 {
        return false;
    }
    let alnum_count = trimmed.chars().filter(|ch| ch.is_alphanumeric()).count();
    if alnum_count < 20 {
        return false;
    }
    let lower_snippet = trimmed.to_lowercase();
    let normalized_label = normalize_label(label);
    if normalized_label.is_empty() {
        return false;
    }
    let label_tokens = normalized_label.split_whitespace().collect::<Vec<_>>();
    let token_hits = label_tokens
        .iter()
        .filter(|token| token.len() >= 4 && lower_snippet.contains(**token))
        .count();
    token_hits >= 1 || lower_snippet.contains(&normalized_label)
}

fn is_overly_generic_label(kind: &str, label: &str) -> bool {
    let normalized = normalize_label(label);
    if normalized.is_empty() {
        return true;
    }
    let generic_by_kind: &[&str] = match kind {
        "challenge" => &[
            "technical challenge",
            "experimental challenge",
            "methodological challenge",
            "data limitation",
            "data limitations",
            "limited data",
            "technical limitation",
            "experimental limitation",
            "background problem",
            "open question",
            "future direction",
            "future work",
            "causal challenge",
            "single cell data limitations",
        ],
        "insight" => &[
            "biological insight",
            "potential application",
            "future direction",
            "future work",
            "general insight",
            "interventional trajectory generation potential",
        ],
        "task" => &["analysis", "prediction task", "modeling", "inference"],
        "module" => &["framework", "model", "algorithm", "pipeline", "module"],
        _ => &[],
    };
    if generic_by_kind.iter().any(|item| normalized == *item) {
        return true;
    }
    let word_count = normalized.split_whitespace().count();
    if word_count <= 1 {
        return matches!(kind, "challenge" | "insight" | "task" | "module");
    }
    matches!(kind, "challenge" | "insight") && word_count <= 2
}

fn is_overlong_problem_label(kind: &str, label: &str) -> bool {
    if !matches!(kind, "challenge" | "insight") {
        return false;
    }
    let normalized = normalize_label(label);
    let word_count = normalized.split_whitespace().count();
    word_count >= 10 || normalized.chars().count() > 80
}

fn is_review_style_summary(text: &str) -> bool {
    let normalized = text.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    [
        "this review",
        "we review",
        "this survey",
        "we survey",
        "this paper reviews",
        "overview of",
        "summarizes recent advances",
        "future directions",
        "open challenges",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn is_generic_background_evidence(snippet: &str) -> bool {
    let normalized = snippet.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    [
        "in this review",
        "we review",
        "this survey",
        "future work",
        "open challenges",
        "broadly speaking",
        "in general",
        "generally",
        "it remains challenging",
        "an important challenge",
        "many studies have shown",
        "has attracted considerable attention",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn normalize_label(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_pdf_text(text: &str) -> String {
    text.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_code_fences(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
            .to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        text.chars().take(limit).collect::<String>()
    }
}

fn sanitize_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|token| token.chars().filter(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '-').collect::<String>())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn distance_to_score(distance: f32) -> f32 {
    1.0 / (1.0 + distance.max(0.0))
}

fn is_allowed_edge(edge_type: &str, from_kind: &str, to_kind: &str) -> bool {
    matches!(
        (edge_type, from_kind, to_kind),
        ("task_pipeline", "task", "pipeline")
            | ("pipeline_module", "pipeline", "module")
            | ("challenge_insight", "challenge", "insight")
    )
}

fn research_root(app: &AppHandle) -> Result<PathBuf> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| anyhow!(error.to_string()))?;
    let root = app_data_dir.join("research_memory");
    if !root.exists() {
        fs::create_dir_all(&root)?;
    }
    Ok(root)
}

fn sqlite_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(research_root(app)?.join(SQLITE_FILE))
}

fn open_sqlite(app: &AppHandle) -> Result<SqliteConnection> {
    let conn = SqliteConnection::open(sqlite_path(app)?)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

fn stable_id(namespace: &str, value: impl AsRef<str>) -> String {
    Uuid::new_v5(&Uuid::NAMESPACE_URL, format!("researchassistant:{}:{}", namespace, value.as_ref()).as_bytes()).to_string()
}

fn get_meta(conn: &SqliteConnection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM runtime_state WHERE key = ?1", [key], |row| row.get::<_, String>(0))
        .optional()?)
}

fn set_meta(conn: &SqliteConnection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO runtime_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn emit_progress(window: &Window, progress: IngestProgress) {
    let _ = window.emit("ingest-progress", progress);
}
