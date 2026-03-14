use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TermLookupMode {
    PopularCn,
    CsEncyclopedia,
    Bioinformatics,
}

impl Default for TermLookupMode {
    fn default() -> Self {
        Self::PopularCn
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReferenceEntry {
    pub title: String,
    pub url: String,
    pub provider: String,
    pub language: Option<String>,
    pub extract: String,
}

pub async fn lookup_term(
    term: &str,
    mode: TermLookupMode,
) -> Result<Option<ReferenceEntry>, String> {
    let normalized = term.trim();
    if normalized.is_empty() {
        return Ok(None);
    }

    match mode {
        TermLookupMode::PopularCn => lookup_popular_cn(normalized).await,
        TermLookupMode::CsEncyclopedia => lookup_cs_encyclopedia(normalized).await,
        TermLookupMode::Bioinformatics => lookup_bioinformatics(normalized).await,
    }
}

async fn lookup_popular_cn(term: &str) -> Result<Option<ReferenceEntry>, String> {
    fetch_baidu_baike(term).await
}

async fn lookup_cs_encyclopedia(term: &str) -> Result<Option<ReferenceEntry>, String> {
    if let Some(entry) = fetch_stackoverflow_tag_wiki(term).await? {
        return Ok(Some(entry));
    }

    if let Some(entry) = fetch_mdn_glossary(term).await? {
        return Ok(Some(entry));
    }

    fetch_github_topic(term).await
}

async fn lookup_bioinformatics(term: &str) -> Result<Option<ReferenceEntry>, String> {
    if let Some(entry) = fetch_ncbi_gene_summary(term).await? {
        return Ok(Some(entry));
    }

    Ok(None)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("ResearchAssistant/0.1 (+https://tauri.app)")
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

async fn fetch_baidu_baike(term: &str) -> Result<Option<ReferenceEntry>, String> {
    let client = http_client()?;
    let url =
        reqwest::Url::parse_with_params("https://baike.baidu.com/search/word", &[("word", term)])
            .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Baidu Baike request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let final_url = response.url().to_string();
    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Baidu Baike response: {}", e))?;

    let title = extract_html_title(&html)
        .map(|raw| raw.replace("_百度百科", "").trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| term.to_string());

    let extract = extract_baidu_summary(&html)
        .or_else(|| extract_meta_description(&html))
        .as_deref()
        .map(cleanup_text)
        .filter(|text| !text.is_empty() && !looks_generic_baidu_summary(text));

    Ok(extract.map(|text| ReferenceEntry {
        title,
        url: final_url,
        provider: "百度百科".to_string(),
        language: Some("zh-CN".to_string()),
        extract: text,
    }))
}

async fn fetch_stackoverflow_tag_wiki(term: &str) -> Result<Option<ReferenceEntry>, String> {
    let tag = normalize_stackoverflow_tag(term);
    if tag.is_empty() {
        return Ok(None);
    }

    let client = http_client()?;
    let url = format!(
        "https://api.stackexchange.com/2.3/tags/{}/wikis?site=stackoverflow",
        percent_encode(&tag)
    );

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Stack Overflow tag wiki request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode Stack Overflow response: {}", e))?;

    let item = json
        .get("items")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first());

    let excerpt = item
        .and_then(|value| value.get("excerpt"))
        .and_then(|value| value.as_str())
        .map(cleanup_text)
        .filter(|text| !text.is_empty());

    let title = item
        .and_then(|value| value.get("tag_name"))
        .and_then(|value| value.as_str())
        .unwrap_or(&tag)
        .to_string();

    Ok(excerpt.map(|text| ReferenceEntry {
        title,
        url: format!(
            "https://stackoverflow.com/tags/{}/info",
            percent_encode(&tag)
        ),
        provider: "Stack Overflow Tag Wiki".to_string(),
        language: Some("en".to_string()),
        extract: text,
    }))
}

async fn fetch_mdn_glossary(term: &str) -> Result<Option<ReferenceEntry>, String> {
    let client = http_client()?;
    let mut candidates = vec![term.replace(' ', "_")];
    let lowercase = term.to_lowercase().replace(' ', "_");
    if lowercase != candidates[0] {
        candidates.push(lowercase);
    }

    let locales = ["zh-CN", "en-US"];
    for locale in locales {
        for candidate in &candidates {
            let url = format!(
                "https://developer.mozilla.org/{}/docs/Glossary/{}",
                locale,
                percent_encode(candidate)
            );

            let response = match client.get(&url).send().await {
                Ok(value) => value,
                Err(_) => continue,
            };

            if !response.status().is_success() {
                continue;
            }

            let final_url = response.url().to_string();
            if !final_url.contains("/docs/Glossary/") {
                continue;
            }

            let html = match response.text().await {
                Ok(value) => value,
                Err(_) => continue,
            };

            let extract = extract_meta_description(&html)
                .or_else(|| extract_first_paragraph(&html))
                .as_deref()
                .map(cleanup_text)
                .filter(|text| !text.is_empty());

            if let Some(text) = extract {
                let title = extract_html_title(&html)
                    .map(|raw| raw.replace(" - MDN", "").trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| term.to_string());

                return Ok(Some(ReferenceEntry {
                    title,
                    url: final_url,
                    provider: "MDN Glossary".to_string(),
                    language: Some(locale.to_string()),
                    extract: text,
                }));
            }
        }
    }

    Ok(None)
}

async fn fetch_github_topic(term: &str) -> Result<Option<ReferenceEntry>, String> {
    let slug = normalize_topic_slug(term);
    if slug.is_empty() {
        return Ok(None);
    }

    let client = http_client()?;
    let url = format!("https://github.com/topics/{}", slug);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GitHub Topics request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read GitHub Topics response: {}", e))?;

    let extract = extract_meta_description(&html)
        .as_deref()
        .map(cleanup_text)
        .filter(|text| !text.is_empty() && !text.contains("Explore GitHub"));

    Ok(extract.map(|text| ReferenceEntry {
        title: term.to_string(),
        url,
        provider: "GitHub Topics".to_string(),
        language: Some("en".to_string()),
        extract: text,
    }))
}

async fn fetch_ncbi_gene_summary(term: &str) -> Result<Option<ReferenceEntry>, String> {
    let client = http_client()?;
    let strict_query = format!("{}[sym] AND human[orgn]", term);
    let fallback_query = format!("{} AND human[orgn]", term);

    let gene_id = search_ncbi_gene_id(&client, &strict_query)
        .await?
        .or(search_ncbi_gene_id(&client, &fallback_query).await?);

    let Some(gene_id) = gene_id else {
        return Ok(None);
    };

    let url = reqwest::Url::parse_with_params(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
        &[
            ("db", "gene"),
            ("retmode", "json"),
            ("id", gene_id.as_str()),
        ],
    )
    .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("NCBI gene summary request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode NCBI gene summary: {}", e))?;

    let gene = json
        .get("result")
        .and_then(|value| value.get(&gene_id))
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let symbol = gene
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(term)
        .to_string();
    let description = gene
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let summary = gene
        .get("summary")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let organism = gene
        .get("organism")
        .and_then(|value| value.get("scientificname"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let extract = format!(
        "{}{}{}",
        if !description.is_empty() {
            format!("{}。", description)
        } else {
            String::new()
        },
        if !summary.is_empty() {
            summary
        } else {
            String::new()
        },
        if !organism.is_empty() {
            format!(" 物种：{}。", organism)
        } else {
            String::new()
        }
    )
    .trim()
    .to_string();

    if extract.is_empty() {
        return Ok(None);
    }

    Ok(Some(ReferenceEntry {
        title: symbol,
        url: format!("https://www.ncbi.nlm.nih.gov/gene/{}", gene_id),
        provider: "NCBI Gene".to_string(),
        language: Some("en".to_string()),
        extract,
    }))
}

async fn search_ncbi_gene_id(
    client: &reqwest::Client,
    term: &str,
) -> Result<Option<String>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
        &[("db", "gene"), ("retmode", "json"), ("term", term)],
    )
    .map_err(|e| e.to_string())?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("NCBI gene search failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to decode NCBI gene search response: {}", e))?;

    Ok(json
        .get("esearchresult")
        .and_then(|value| value.get("idlist"))
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|value| value.as_str())
        .map(|value| value.to_string()))
}

fn normalize_stackoverflow_tag(term: &str) -> String {
    term.trim()
        .chars()
        .map(|ch| match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' | '+' | '#' | '-' | '.' => ch,
            '_' | '/' | ' ' => '-',
            _ => '-',
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_topic_slug(term: &str) -> String {
    term.trim()
        .chars()
        .map(|ch| match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => ch,
            '_' | '/' | ' ' => '-',
            _ => '-',
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn percent_encode(input: &str) -> String {
    let mut encoded = String::new();
    for byte in input.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{:02X}", byte));
        }
    }
    encoded
}

fn extract_baidu_summary(html: &str) -> Option<String> {
    let markers = ["lemmaSummary", "J-summary"];
    for marker in markers {
        if let Some(pos) = html.find(marker) {
            let tail = &html[pos..];
            if let Some(start) = tail.find('>') {
                let fragment = &tail[start + 1..];
                if let Some(end) = fragment.find("</div>") {
                    let candidate = cleanup_text(&fragment[..end]);
                    if !candidate.is_empty() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    None
}

fn extract_html_title(html: &str) -> Option<String> {
    let start = html.find("<title>")? + "<title>".len();
    let end = html[start..].find("</title>")? + start;
    Some(cleanup_text(&html[start..end]))
}

fn extract_meta_description(html: &str) -> Option<String> {
    extract_meta_content(html, r#"name="description""#)
        .or_else(|| extract_meta_content(html, r#"property="og:description""#))
}

fn extract_meta_content(html: &str, attr_marker: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let needle = attr_marker.to_lowercase();
    let mut offset = 0usize;

    while let Some(found) = lower[offset..].find("<meta") {
        let tag_start = offset + found;
        let tail = &lower[tag_start..];
        let Some(tag_rel_end) = tail.find('>') else {
            break;
        };
        let tag_end = tag_start + tag_rel_end + 1;
        let tag_lower = &lower[tag_start..tag_end];
        if tag_lower.contains(&needle) {
            let tag = &html[tag_start..tag_end];
            if let Some(value) = extract_attr_value(tag, "content") {
                return Some(cleanup_text(&value));
            }
        }
        offset = tag_end;
    }

    None
}

fn extract_attr_value(tag: &str, attr_name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let marker = format!("{}={}", attr_name, quote);
        if let Some(found) = tag.find(&marker) {
            let start = found + marker.len();
            if let Some(end_rel) = tag[start..].find(quote) {
                return Some(tag[start..start + end_rel].to_string());
            }
        }
    }
    None
}

fn extract_first_paragraph(html: &str) -> Option<String> {
    let article_start = html.find("<article").or_else(|| html.find("<main"))?;
    let fragment = &html[article_start..];
    let paragraph_start = fragment.find("<p")?;
    let paragraph_fragment = &fragment[paragraph_start..];
    let content_start = paragraph_fragment.find('>')? + 1;
    let content_fragment = &paragraph_fragment[content_start..];
    let content_end = content_fragment.find("</p>")?;
    Some(cleanup_text(&content_fragment[..content_end]))
}

fn cleanup_text(input: &str) -> String {
    let no_tags = strip_html_tags(input);
    let decoded = decode_html_entities(&no_tags);
    decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn strip_html_tags(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}

fn decode_html_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
}

fn looks_generic_baidu_summary(text: &str) -> bool {
    text.contains("百度百科是一部内容开放") || text.contains("搜索结果")
}
