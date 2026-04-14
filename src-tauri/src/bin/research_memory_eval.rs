use researchassistant_lib::research_memory::{
    load_default_extraction_provider_settings, preview_extract_path, ExtractionPreviewRequest,
    ExtractionProviderKind, ExtractionProviderSettings,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_LIMIT: usize = 3;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalDiagnostics {
    relation_map_unit_count: usize,
    candidate_conflict_count: usize,
    pipeline_summary_empty_count: usize,
    pipeline_name_empty_count: usize,
    edge_candidate_count: usize,
    edge_validated_count: usize,
    edge_validate_fallback_count: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalNodeSets {
    tasks: Vec<String>,
    pipelines: Vec<String>,
    modules: Vec<String>,
    challenges: Vec<String>,
    insights: Vec<String>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalEdgePair {
    from: String,
    to: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalEdgeSets {
    task_pipeline_pairs: Vec<EvalEdgePair>,
    pipeline_module_pairs: Vec<EvalEdgePair>,
    challenge_insight_pairs: Vec<EvalEdgePair>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalPredictionSnapshot {
    nodes: EvalNodeSets,
    edges: EvalEdgeSets,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalPaperSample {
    paper_id: String,
    title: String,
    path: String,
    annotation_source: String,
    annotation_status: String,
    diagnostics_baseline: EvalDiagnostics,
    gold: EvalPredictionSnapshot,
    prediction_seed: EvalPredictionSnapshot,
    notes: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalSampleFile {
    schema_version: String,
    generated_at: String,
    db_path: String,
    papers: Vec<EvalPaperSample>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetricCounts {
    gold_count: usize,
    predicted_count: usize,
    true_positive: usize,
    false_positive: usize,
    false_negative: usize,
    precision: f32,
    recall: f32,
    f1: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalPaperResult {
    paper_id: String,
    title: String,
    path: String,
    diagnostics_baseline: EvalDiagnostics,
    diagnostics_current: EvalDiagnostics,
    task: MetricCounts,
    pipeline: MetricCounts,
    module: MetricCounts,
    challenge: MetricCounts,
    insight: MetricCounts,
    task_pipeline: MetricCounts,
    pipeline_module: MetricCounts,
    challenge_insight: MetricCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalRunReport {
    schema_version: String,
    generated_at: String,
    db_path: String,
    source_file: String,
    aggregate: EvalPaperResult,
    papers: Vec<EvalPaperResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkRunResult {
    label: String,
    elapsed_ms: u128,
    result: serde_json::Value,
}

#[derive(Clone, Debug)]
struct PaperRow {
    paper_id: String,
    title: String,
    path: String,
    has_approved_gold: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("research_memory_eval failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let Some(command) = args.first().map(|value| value.as_str()) else {
        print_usage();
        return Ok(());
    };

    match command {
        "scaffold" => run_scaffold(&args[1..]),
        "run" => run_eval(&args[1..]),
        "inspect" => run_inspect(&args[1..]),
        "preview" => run_preview(&args[1..]),
        "benchmark" => run_benchmark(&args[1..]),
        _ => {
            print_usage();
            Ok(())
        }
    }
}

fn run_scaffold(args: &[String]) -> anyhow::Result<()> {
    let output = parse_flag_value(args, "--output")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("research_memory_eval_samples.json"));
    let db_path = resolve_db_path(parse_flag_value(args, "--db").map(PathBuf::from))?;
    let limit = parse_flag_value(args, "--limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_LIMIT);
    let conn = Connection::open(&db_path)?;
    let papers = list_sample_papers(&conn, limit)?;
    let mut samples = Vec::new();

    for paper in papers {
        let diagnostics = load_diagnostics(&conn, &paper.paper_id)?;
        let prediction_seed =
            load_prediction_snapshot(&conn, &paper.paper_id, &["approved", "pending"])?;
        let is_prediction_seed_empty = snapshot_is_empty(&prediction_seed);
        let (annotation_source, annotation_status, gold, notes) = if paper.has_approved_gold {
            (
                "approved_review_queue_snapshot".to_string(),
                "reviewed_gold".to_string(),
                load_prediction_snapshot(&conn, &paper.paper_id, &["approved"])?,
                "gold 基于已审核通过候选自动生成，可直接用于小样本回归。".to_string(),
            )
        } else if is_prediction_seed_empty {
            (
                "paper_only_placeholder".to_string(),
                "needs_reingest_and_annotation".to_string(),
                EvalPredictionSnapshot::default(),
                "当前仅发现 paper 记录，尚无候选或诊断。请先重新 ingest，再补充 gold。".to_string(),
            )
        } else {
            (
                "pending_extraction_seed".to_string(),
                "seed_needs_review".to_string(),
                prediction_seed.clone(),
                "当前库里没有已审核通过候选；gold 临时由当前抽取结果播种，使用前请人工修订。"
                    .to_string(),
            )
        };
        samples.push(EvalPaperSample {
            paper_id: paper.paper_id,
            title: paper.title,
            path: paper.path,
            annotation_source,
            annotation_status,
            diagnostics_baseline: diagnostics,
            gold,
            prediction_seed,
            notes,
        });
    }

    let payload = EvalSampleFile {
        schema_version: "research_memory_eval_v1".to_string(),
        generated_at: now_iso_like(),
        db_path: db_path.display().to_string(),
        papers: samples,
    };
    let content = serde_json::to_string_pretty(&payload)?;
    fs::write(&output, content)?;
    println!(
        "Scaffolded {} sample papers to {}",
        payload.papers.len(),
        output.display()
    );
    Ok(())
}

fn run_eval(args: &[String]) -> anyhow::Result<()> {
    let input = parse_flag_value(args, "--input")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("research_memory_eval_samples.json"));
    let output = parse_flag_value(args, "--output")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("research_memory_eval_report.json"));
    let source = fs::read_to_string(&input)?;
    let samples: EvalSampleFile = serde_json::from_str(&source)?;
    let db_path = resolve_db_path(parse_flag_value(args, "--db").map(PathBuf::from))
        .unwrap_or_else(|_| PathBuf::from(&samples.db_path));
    let conn = Connection::open(&db_path)?;

    let mut paper_results = Vec::new();
    let mut aggregate = EvalPaperResult {
        paper_id: "aggregate".to_string(),
        title: "aggregate".to_string(),
        path: String::new(),
        diagnostics_baseline: EvalDiagnostics::default(),
        diagnostics_current: EvalDiagnostics::default(),
        task: MetricCounts::default(),
        pipeline: MetricCounts::default(),
        module: MetricCounts::default(),
        challenge: MetricCounts::default(),
        insight: MetricCounts::default(),
        task_pipeline: MetricCounts::default(),
        pipeline_module: MetricCounts::default(),
        challenge_insight: MetricCounts::default(),
    };

    for sample in samples.papers {
        let predicted =
            load_prediction_snapshot(&conn, &sample.paper_id, &["approved", "pending"])?;
        let current_diagnostics = load_diagnostics(&conn, &sample.paper_id)?;
        let result = EvalPaperResult {
            paper_id: sample.paper_id.clone(),
            title: sample.title.clone(),
            path: sample.path.clone(),
            diagnostics_baseline: sample.diagnostics_baseline.clone(),
            diagnostics_current: current_diagnostics,
            task: compare_string_sets(&sample.gold.nodes.tasks, &predicted.nodes.tasks),
            pipeline: compare_string_sets(&sample.gold.nodes.pipelines, &predicted.nodes.pipelines),
            module: compare_string_sets(&sample.gold.nodes.modules, &predicted.nodes.modules),
            challenge: compare_string_sets(
                &sample.gold.nodes.challenges,
                &predicted.nodes.challenges,
            ),
            insight: compare_string_sets(&sample.gold.nodes.insights, &predicted.nodes.insights),
            task_pipeline: compare_edge_sets(
                &sample.gold.edges.task_pipeline_pairs,
                &predicted.edges.task_pipeline_pairs,
            ),
            pipeline_module: compare_edge_sets(
                &sample.gold.edges.pipeline_module_pairs,
                &predicted.edges.pipeline_module_pairs,
            ),
            challenge_insight: compare_edge_sets(
                &sample.gold.edges.challenge_insight_pairs,
                &predicted.edges.challenge_insight_pairs,
            ),
        };
        accumulate_metric(&mut aggregate.task, &result.task);
        accumulate_metric(&mut aggregate.pipeline, &result.pipeline);
        accumulate_metric(&mut aggregate.module, &result.module);
        accumulate_metric(&mut aggregate.challenge, &result.challenge);
        accumulate_metric(&mut aggregate.insight, &result.insight);
        accumulate_metric(&mut aggregate.task_pipeline, &result.task_pipeline);
        accumulate_metric(&mut aggregate.pipeline_module, &result.pipeline_module);
        accumulate_metric(&mut aggregate.challenge_insight, &result.challenge_insight);
        paper_results.push(result);
    }

    finalize_metric(&mut aggregate.task);
    finalize_metric(&mut aggregate.pipeline);
    finalize_metric(&mut aggregate.module);
    finalize_metric(&mut aggregate.challenge);
    finalize_metric(&mut aggregate.insight);
    finalize_metric(&mut aggregate.task_pipeline);
    finalize_metric(&mut aggregate.pipeline_module);
    finalize_metric(&mut aggregate.challenge_insight);

    let report = EvalRunReport {
        schema_version: "research_memory_eval_report_v1".to_string(),
        generated_at: now_iso_like(),
        db_path: db_path.display().to_string(),
        source_file: input.display().to_string(),
        aggregate,
        papers: paper_results,
    };
    fs::write(&output, serde_json::to_string_pretty(&report)?)?;
    println!("Wrote regression report to {}", output.display());
    println!(
        "Aggregate F1 | task {:.3} | pipeline {:.3} | module {:.3} | challenge {:.3} | insight {:.3} | task->pipeline {:.3} | pipeline->module {:.3} | challenge->insight {:.3}",
        report.aggregate.task.f1,
        report.aggregate.pipeline.f1,
        report.aggregate.module.f1,
        report.aggregate.challenge.f1,
        report.aggregate.insight.f1,
        report.aggregate.task_pipeline.f1,
        report.aggregate.pipeline_module.f1,
        report.aggregate.challenge_insight.f1
    );
    Ok(())
}

fn run_inspect(args: &[String]) -> anyhow::Result<()> {
    let db_path = resolve_db_path(parse_flag_value(args, "--db").map(PathBuf::from))?;
    let conn = Connection::open(&db_path)?;
    let paper_count = count_rows(&conn, "SELECT COUNT(*) FROM papers")?;
    let candidate_count = count_rows(&conn, "SELECT COUNT(*) FROM extraction_candidates")?;
    let approved_count = count_rows(
        &conn,
        "SELECT COUNT(*) FROM extraction_candidates WHERE review_status = 'approved'",
    )?;
    let pending_count = count_rows(
        &conn,
        "SELECT COUNT(*) FROM extraction_candidates WHERE review_status = 'pending'",
    )?;
    let diag_count = count_rows(&conn, "SELECT COUNT(*) FROM extraction_diagnostics")?;
    println!("db_path={}", db_path.display());
    println!("papers={paper_count}");
    println!("extraction_candidates={candidate_count}");
    println!("approved_candidates={approved_count}");
    println!("pending_candidates={pending_count}");
    println!("diagnostics_rows={diag_count}");
    Ok(())
}

fn run_preview(args: &[String]) -> anyhow::Result<()> {
    let paper = parse_flag_value(args, "--paper")
        .or_else(|| parse_flag_value(args, "--path"))
        .ok_or_else(|| anyhow::anyhow!("preview requires --paper <path>"))?;
    let unit_limit =
        parse_flag_value(args, "--limit").and_then(|value| value.parse::<usize>().ok());
    let stage = parse_flag_value(args, "--stage");
    let extraction_mode = parse_flag_value(args, "--mode");
    let extract_fast_model = parse_flag_value(args, "--fast-model");
    let extract_fallback_model = parse_flag_value(args, "--fallback-model");
    let extract_pipeline_summary_model = parse_flag_value(args, "--pipeline-summary-model");
    let extract_pipeline_name_model = parse_flag_value(args, "--pipeline-name-model");
    let extract_edge_model = parse_flag_value(args, "--edge-model");
    let extract_edge_validate_model = parse_flag_value(args, "--edge-validate-model");
    let provider_settings = resolve_provider_settings(args, "")?;
    let show_content = has_flag(args, "--show-content");
    let show_sections = has_flag(args, "--show-sections");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(preview_extract_path(ExtractionPreviewRequest {
        path: paper,
        extract_provider: Some(provider_settings),
        extract_fast_model,
        extract_fallback_model,
        extract_pipeline_summary_model,
        extract_pipeline_name_model,
        extract_edge_model,
        extract_edge_validate_model,
        unit_limit,
        stage,
        extraction_mode,
        show_content: Some(show_content),
        show_sections: Some(show_sections),
    }))?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn build_preview_request(
    paper: &str,
    unit_limit: Option<usize>,
    stage: Option<String>,
    extraction_mode: Option<String>,
    show_content: bool,
    show_sections: bool,
    provider_settings: ExtractionProviderSettings,
    args: &[String],
    prefix: &str,
) -> ExtractionPreviewRequest {
    ExtractionPreviewRequest {
        path: paper.to_string(),
        extract_provider: Some(provider_settings),
        extract_fast_model: parse_flag_value(args, &format!("--{}fast-model", prefix)),
        extract_fallback_model: parse_flag_value(args, &format!("--{}fallback-model", prefix)),
        extract_pipeline_summary_model: parse_flag_value(
            args,
            &format!("--{}pipeline-summary-model", prefix),
        ),
        extract_pipeline_name_model: parse_flag_value(
            args,
            &format!("--{}pipeline-name-model", prefix),
        ),
        extract_edge_model: parse_flag_value(args, &format!("--{}edge-model", prefix)),
        extract_edge_validate_model: parse_flag_value(
            args,
            &format!("--{}edge-validate-model", prefix),
        ),
        unit_limit,
        stage,
        extraction_mode,
        show_content: Some(show_content),
        show_sections: Some(show_sections),
    }
}

fn resolve_provider_settings(
    args: &[String],
    prefix: &str,
) -> anyhow::Result<ExtractionProviderSettings> {
    let mut settings = load_default_extraction_provider_settings().unwrap_or_default();
    if let Some(provider) = parse_flag_value(args, &format!("--{}provider", prefix)) {
        settings.provider = match provider.trim().to_ascii_lowercase().as_str() {
            "openai_compatible" | "openai-compatible" | "openai" => {
                ExtractionProviderKind::OpenAiCompatible
            }
            _ => ExtractionProviderKind::Ollama,
        };
    }
    if let Some(base_url) = parse_flag_value(args, &format!("--{}base-url", prefix)) {
        settings.base_url = Some(base_url);
    }
    if let Some(api_key) = parse_flag_value(args, &format!("--{}api-key", prefix)) {
        settings.api_key = Some(api_key);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}fast-model", prefix)) {
        settings.extract_fast_model = Some(model);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}fallback-model", prefix)) {
        settings.extract_fallback_model = Some(model);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}pipeline-summary-model", prefix)) {
        settings.extract_pipeline_summary_model = Some(model);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}pipeline-name-model", prefix)) {
        settings.extract_pipeline_name_model = Some(model);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}edge-model", prefix)) {
        settings.extract_edge_model = Some(model);
    }
    if let Some(model) = parse_flag_value(args, &format!("--{}edge-validate-model", prefix)) {
        settings.extract_edge_validate_model = Some(model);
    }
    Ok(settings)
}

fn run_benchmark(args: &[String]) -> anyhow::Result<()> {
    let paper = parse_flag_value(args, "--paper")
        .or_else(|| parse_flag_value(args, "--path"))
        .ok_or_else(|| anyhow::anyhow!("benchmark requires --paper <path>"))?;
    let unit_limit =
        parse_flag_value(args, "--limit").and_then(|value| value.parse::<usize>().ok());
    let stage = parse_flag_value(args, "--stage");
    let extraction_mode = parse_flag_value(args, "--mode");
    let show_content = has_flag(args, "--show-content");
    let show_sections = has_flag(args, "--show-sections");
    let base_provider = resolve_provider_settings(args, "")?;
    let compare_provider = parse_flag_value(args, "--compare-provider")
        .map(|_| resolve_provider_settings(args, "compare-"))
        .transpose()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    let mut runs = Vec::new();
    let base_request = build_preview_request(
        &paper,
        unit_limit,
        stage.clone(),
        extraction_mode.clone(),
        show_content,
        show_sections,
        base_provider,
        args,
        "",
    );
    let started = SystemTime::now();
    let result = runtime.block_on(preview_extract_path(base_request))?;
    runs.push(BenchmarkRunResult {
        label: "primary".to_string(),
        elapsed_ms: started.elapsed().unwrap_or_default().as_millis(),
        result: serde_json::to_value(result)?,
    });

    if let Some(compare_provider) = compare_provider {
        let compare_request = build_preview_request(
            &paper,
            unit_limit,
            stage,
            extraction_mode,
            show_content,
            show_sections,
            compare_provider,
            args,
            "compare-",
        );
        let started = SystemTime::now();
        let result = runtime.block_on(preview_extract_path(compare_request))?;
        runs.push(BenchmarkRunResult {
            label: "compare".to_string(),
            elapsed_ms: started.elapsed().unwrap_or_default().as_millis(),
            result: serde_json::to_value(result)?,
        });
    }

    println!("{}", serde_json::to_string_pretty(&runs)?);
    Ok(())
}

fn list_sample_papers(conn: &Connection, limit: usize) -> anyhow::Result<Vec<PaperRow>> {
    let mut approved_stmt = conn.prepare(
        "SELECT p.paper_id, p.title, p.path, 1 AS has_approved_gold
         FROM papers p
         JOIN (
             SELECT paper_id, COUNT(*) AS approved_count
             FROM extraction_candidates
             WHERE review_status = 'approved'
             GROUP BY paper_id
         ) a ON a.paper_id = p.paper_id
         ORDER BY a.approved_count DESC, p.updated_at DESC, p.title COLLATE NOCASE ASC
        LIMIT ?1",
    )?;
    let approved_rows = approved_stmt.query_map(params![limit as i64], |row| {
        Ok(PaperRow {
            paper_id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
            has_approved_gold: row.get::<_, i64>(3)? > 0,
        })
    })?;
    let mut papers = Vec::new();
    for row in approved_rows {
        papers.push(row?);
    }
    if !papers.is_empty() {
        return Ok(papers);
    }

    let mut pending_stmt = conn.prepare(
        "SELECT p.paper_id, p.title, p.path, 0 AS has_approved_gold
         FROM papers p
         JOIN (
             SELECT paper_id, COUNT(*) AS candidate_count
             FROM extraction_candidates
             WHERE review_status IN ('pending', 'approved')
             GROUP BY paper_id
         ) c ON c.paper_id = p.paper_id
         ORDER BY c.candidate_count DESC, p.updated_at DESC, p.title COLLATE NOCASE ASC
         LIMIT ?1",
    )?;
    let pending_rows = pending_stmt.query_map(params![limit as i64], |row| {
        Ok(PaperRow {
            paper_id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
            has_approved_gold: row.get::<_, i64>(3)? > 0,
        })
    })?;
    for row in pending_rows {
        papers.push(row?);
    }
    if !papers.is_empty() {
        return Ok(papers);
    }

    let mut papers_stmt = conn.prepare(
        "SELECT paper_id, title, path, 0 AS has_approved_gold
         FROM papers
         ORDER BY updated_at DESC, title COLLATE NOCASE ASC
         LIMIT ?1",
    )?;
    let paper_rows = papers_stmt.query_map(params![limit as i64], |row| {
        Ok(PaperRow {
            paper_id: row.get(0)?,
            title: row.get(1)?,
            path: row.get(2)?,
            has_approved_gold: row.get::<_, i64>(3)? > 0,
        })
    })?;
    for row in paper_rows {
        papers.push(row?);
    }
    Ok(papers)
}

fn load_diagnostics(conn: &Connection, paper_id: &str) -> anyhow::Result<EvalDiagnostics> {
    let diagnostics = conn
        .query_row(
            "SELECT relation_map_unit_count,
                    candidate_conflict_count,
                    pipeline_summary_empty_count,
                    pipeline_name_empty_count,
                    edge_candidate_count,
                    edge_validated_count,
                    edge_validate_fallback_count
             FROM extraction_diagnostics
             WHERE paper_id = ?1",
            [paper_id],
            |row| {
                Ok(EvalDiagnostics {
                    relation_map_unit_count: row.get::<_, i64>(0)?.max(0) as usize,
                    candidate_conflict_count: row.get::<_, i64>(1)?.max(0) as usize,
                    pipeline_summary_empty_count: row.get::<_, i64>(2)?.max(0) as usize,
                    pipeline_name_empty_count: row.get::<_, i64>(3)?.max(0) as usize,
                    edge_candidate_count: row.get::<_, i64>(4)?.max(0) as usize,
                    edge_validated_count: row.get::<_, i64>(5)?.max(0) as usize,
                    edge_validate_fallback_count: row.get::<_, i64>(6)?.max(0) as usize,
                })
            },
        )
        .optional()?;
    Ok(diagnostics.unwrap_or_default())
}

fn load_prediction_snapshot(
    conn: &Connection,
    paper_id: &str,
    statuses: &[&str],
) -> anyhow::Result<EvalPredictionSnapshot> {
    let mut nodes = EvalNodeSets::default();
    let mut edges = EvalEdgeSets::default();
    let status_sql = statuses
        .iter()
        .map(|status| format!("'{}'", status.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");

    let node_query = format!(
        "SELECT entity_kind, label
         FROM extraction_candidates
         WHERE paper_id = ?1
           AND candidate_kind = 'node'
           AND review_status IN ({status_sql})"
    );
    let mut node_stmt = conn.prepare(&node_query)?;
    let node_rows = node_stmt.query_map([paper_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?;
    let mut task_set = BTreeSet::new();
    let mut pipeline_set = BTreeSet::new();
    let mut module_set = BTreeSet::new();
    let mut challenge_set = BTreeSet::new();
    let mut insight_set = BTreeSet::new();
    for row in node_rows {
        let (kind, label) = row?;
        let normalized = normalize_label(label.as_deref().unwrap_or_default());
        if normalized.is_empty() {
            continue;
        }
        match kind.as_deref().unwrap_or_default() {
            "task" => {
                task_set.insert(normalized);
            }
            "pipeline" => {
                pipeline_set.insert(normalized);
            }
            "module" => {
                module_set.insert(normalized);
            }
            "challenge" => {
                challenge_set.insert(normalized);
            }
            "insight" => {
                insight_set.insert(normalized);
            }
            _ => {}
        }
    }
    nodes.tasks = task_set.into_iter().collect();
    nodes.pipelines = pipeline_set.into_iter().collect();
    nodes.modules = module_set.into_iter().collect();
    nodes.challenges = challenge_set.into_iter().collect();
    nodes.insights = insight_set.into_iter().collect();

    let edge_query = format!(
        "SELECT entity_kind, from_label, to_label
         FROM extraction_candidates
         WHERE paper_id = ?1
           AND candidate_kind = 'edge'
           AND review_status IN ({status_sql})"
    );
    let mut edge_stmt = conn.prepare(&edge_query)?;
    let edge_rows = edge_stmt.query_map([paper_id], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut task_pipeline_set = BTreeSet::new();
    let mut pipeline_module_set = BTreeSet::new();
    let mut challenge_insight_set = BTreeSet::new();
    for row in edge_rows {
        let (kind, from_label, to_label) = row?;
        let pair = EvalEdgePair {
            from: normalize_label(from_label.as_deref().unwrap_or_default()),
            to: normalize_label(to_label.as_deref().unwrap_or_default()),
        };
        if pair.from.is_empty() || pair.to.is_empty() {
            continue;
        }
        match kind.as_deref().unwrap_or_default() {
            "task_pipeline" => {
                task_pipeline_set.insert(pair);
            }
            "pipeline_module" => {
                pipeline_module_set.insert(pair);
            }
            "challenge_insight" => {
                challenge_insight_set.insert(pair);
            }
            _ => {}
        }
    }
    edges.task_pipeline_pairs = task_pipeline_set.into_iter().collect();
    edges.pipeline_module_pairs = pipeline_module_set.into_iter().collect();
    edges.challenge_insight_pairs = challenge_insight_set.into_iter().collect();

    Ok(EvalPredictionSnapshot { nodes, edges })
}

fn compare_string_sets(gold: &[String], predicted: &[String]) -> MetricCounts {
    let gold_set = gold
        .iter()
        .map(|item| normalize_label(item))
        .filter(|item| !item.is_empty())
        .collect::<BTreeSet<_>>();
    let predicted_set = predicted
        .iter()
        .map(|item| normalize_label(item))
        .filter(|item| !item.is_empty())
        .collect::<BTreeSet<_>>();
    compare_set_metrics(&gold_set, &predicted_set)
}

fn snapshot_is_empty(snapshot: &EvalPredictionSnapshot) -> bool {
    snapshot.nodes.tasks.is_empty()
        && snapshot.nodes.pipelines.is_empty()
        && snapshot.nodes.modules.is_empty()
        && snapshot.nodes.challenges.is_empty()
        && snapshot.nodes.insights.is_empty()
        && snapshot.edges.task_pipeline_pairs.is_empty()
        && snapshot.edges.pipeline_module_pairs.is_empty()
        && snapshot.edges.challenge_insight_pairs.is_empty()
}

fn compare_edge_sets(gold: &[EvalEdgePair], predicted: &[EvalEdgePair]) -> MetricCounts {
    let gold_set = gold
        .iter()
        .map(|item| EvalEdgePair {
            from: normalize_label(&item.from),
            to: normalize_label(&item.to),
        })
        .filter(|item| !item.from.is_empty() && !item.to.is_empty())
        .collect::<BTreeSet<_>>();
    let predicted_set = predicted
        .iter()
        .map(|item| EvalEdgePair {
            from: normalize_label(&item.from),
            to: normalize_label(&item.to),
        })
        .filter(|item| !item.from.is_empty() && !item.to.is_empty())
        .collect::<BTreeSet<_>>();
    compare_set_metrics(&gold_set, &predicted_set)
}

fn compare_set_metrics<T>(gold: &BTreeSet<T>, predicted: &BTreeSet<T>) -> MetricCounts
where
    T: Ord,
{
    let true_positive = gold.intersection(predicted).count();
    let false_positive = predicted.difference(gold).count();
    let false_negative = gold.difference(predicted).count();
    let mut metric = MetricCounts {
        gold_count: gold.len(),
        predicted_count: predicted.len(),
        true_positive,
        false_positive,
        false_negative,
        precision: 0.0,
        recall: 0.0,
        f1: 0.0,
    };
    finalize_metric(&mut metric);
    metric
}

fn accumulate_metric(target: &mut MetricCounts, current: &MetricCounts) {
    target.gold_count += current.gold_count;
    target.predicted_count += current.predicted_count;
    target.true_positive += current.true_positive;
    target.false_positive += current.false_positive;
    target.false_negative += current.false_negative;
}

fn finalize_metric(metric: &mut MetricCounts) {
    metric.precision = if metric.predicted_count == 0 {
        0.0
    } else {
        metric.true_positive as f32 / metric.predicted_count as f32
    };
    metric.recall = if metric.gold_count == 0 {
        0.0
    } else {
        metric.true_positive as f32 / metric.gold_count as f32
    };
    metric.f1 = if metric.precision + metric.recall <= f32::EPSILON {
        0.0
    } else {
        2.0 * metric.precision * metric.recall / (metric.precision + metric.recall)
    };
}

fn parse_flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|item| item == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|item| item == flag)
}

fn count_rows(conn: &Connection, sql: &str) -> anyhow::Result<usize> {
    Ok(conn.query_row(sql, [], |row| row.get::<_, i64>(0))?.max(0) as usize)
}

fn resolve_db_path(cli_db_path: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    if let Some(path) = cli_db_path {
        return Ok(path);
    }
    let app_data = env::var("APPDATA")?;
    Ok(Path::new(&app_data)
        .join("com.xingyve.researchassistant")
        .join("research_memory")
        .join("research_memory.sqlite3"))
}

fn normalize_label(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_lowercase()
}

fn now_iso_like() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

fn print_usage() {
    println!("research_memory_eval scaffold [--db PATH] [--output FILE] [--limit N]");
    println!("research_memory_eval run [--db PATH] [--input FILE] [--output FILE]");
    println!("research_memory_eval inspect [--db PATH]");
    println!("research_memory_eval preview --paper PATH [--limit N] [--stage candidate|full] [--mode fast|balanced] [--provider ollama|openai_compatible] [--base-url URL] [--api-key KEY] [--show-content] [--show-sections]");
    println!("research_memory_eval benchmark --paper PATH [--limit N] [--stage candidate|full] [--mode fast|balanced] [--provider ...] [--compare-provider ...]");
}
