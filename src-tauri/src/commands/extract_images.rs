//! Image extraction from PDF / PPTX / DOCX (Phase 1 of the multimodal
//! pipeline; see plans/multimodal-images.md).
//!
//! NO LLM calls happen in this module. Output is the raw extracted
//! images as PNG-encoded base64 strings, ready for either:
//!   - the vision-caption helper (Phase 3) which sends them to a VLM
//!   - direct write-to-disk in `wiki/media/<source-slug>/`
//!
//! This module is intentionally separate from `fs.rs` (which already
//! has its own pdfium binding lifecycle for text extraction). PDF
//! image extraction reuses the same global `Pdfium` instance via the
//! `pdfium()` helper exposed by `fs.rs`.
//!
//! Outputs are deterministic for a given input file (same image
//! ordering, same `index` per image), so the dedup cache in Phase 3
//! can key purely on the SHA-256 of `data_base64`.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Filter knobs. The defaults mirror what's documented in
/// plans/multimodal-images.md; callers (the TS layer wiring this up)
/// will eventually surface them in Settings.
#[derive(Debug, Clone)]
pub struct ExtractOptions {
    /// Skip images smaller than this on EITHER axis. 100×100 catches
    /// the vast majority of icons / logos / page-corner decorations
    /// without dropping legitimate small chart insets.
    pub min_width: u32,
    pub min_height: u32,
    /// Hard cap on the number of images returned per document. A
    /// pathological 5000-image PDF would otherwise blow up memory
    /// (each image base64'd is ~MB-scale) AND blow up downstream VLM
    /// cost during Phase 3.
    pub max_images: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            min_width: 100,
            min_height: 100,
            max_images: 500,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    /// 1-based index in document order. Stable across re-extractions.
    /// Used as the filename suffix when the caller writes images to
    /// `wiki/media/<slug>/img-<index>.<ext>`.
    pub index: u32,
    /// MIME type ("image/png" / "image/jpeg" / etc.). PNG for any
    /// image we re-encode (PDFs always); pass-through for office docs
    /// where the original bytes are already in a web-friendly format.
    pub mime_type: String,
    /// 1-based page number for PDFs / 1-based slide number for PPTX.
    /// `None` for DOCX (which doesn't have a per-image page concept
    /// at extraction time without parsing document.xml position
    /// markers, which is more work than this phase needs).
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Image bytes, base64-encoded. JSON IPC can't carry raw binary.
    pub data_base64: String,
    /// SHA-256 hex of the *encoded* bytes (same encoding as
    /// `data_base64` decodes to). Used by the Phase 3 caption cache
    /// to dedupe identical images across files.
    pub sha256: String,
    /// Text immediately before the image anchor in the source, when
    /// the document format exposes that anchor. Used by the vision
    /// caption pipeline as disambiguating context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before: Option<String>,
    /// Text immediately after the image anchor in the source, when
    /// available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_after: Option<String>,
}

// ── PDF (pdfium) ────────────────────────────────────────────────────────

/// Combined PDF text + image extraction in a single pdfium session.
///
/// Output is a markdown string with `## Page N` headers, the page's
/// extracted text, and `![](url)` references to images embedded on
/// that page — interleaved per-page so the document reads top-to-
/// bottom the way the source did.
///
/// When `media_dest_dir` is `Some`, every embedded raster image
/// passing the size filter is written to that directory as
/// `img-<N>.png` (1-based across the whole document) and referenced
/// in the markdown via `media_url_prefix + "/img-<N>.png"`. Pass an
/// absolute path as the prefix when you want the markdown to render
/// regardless of where the file is opened (this is what the raw-
/// source preview wants — see `extract_pdf_text` in fs.rs).
///
/// When `media_dest_dir` is `None`, image objects are skipped
/// entirely and the output is text + page headers only — useful for
/// PDFs outside the project's `raw/sources/` layout where there's no
/// stable place to land the image files.
///
/// Holds the global pdfium lock for its full duration. Callers MUST
/// NOT acquire the lock themselves before calling this (would
/// deadlock — `std::sync::Mutex` is non-reentrant).
pub fn extract_pdf_markdown(
    path: &str,
    media_dest_dir: Option<&Path>,
    media_url_prefix: &str,
    options: &ExtractOptions,
) -> Result<String, String> {
    use pdfium_render::prelude::*;

    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium.load_pdf_from_file(path, None).map_err(|e| match e {
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
            format!("PDF is password-protected and cannot be read: '{path}'")
        }
        _ => format!("Failed to open PDF '{path}': {e}"),
    })?;

    let mut out = String::new();
    let mut idx: u32 = 0;
    let mut total_saved: u32 = 0;
    // Strip a single trailing slash from the prefix so we can always
    // emit `prefix + "/" + name` without producing `path//name`.
    let prefix = media_url_prefix.trim_end_matches('/');

    let page_count = doc.pages().len();
    if media_dest_dir.is_some() {
        eprintln!(
            "[extract_pdf_markdown] '{path}': {page_count} page(s), images→{:?}",
            media_dest_dir.map(|d| d.display().to_string())
        );
    }

    for (page_idx, page) in doc.pages().iter().enumerate() {
        let page_num = page_idx + 1;
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("## Page {page_num}\n\n"));

        let page_text = page
            .text()
            .map_err(|e| format!("Page {page_num} text extraction failed in '{path}': {e}"))?;
        out.push_str(&page_text.all());
        // Single trailing newline so the next block starts on its own
        // line; the `\n\n` separator before the next `## Page` heading
        // gets prepended by the loop entry above.
        out.push('\n');

        // Skip image extraction when the caller didn't supply a
        // destination — no point burning pdfium cycles to throw the
        // pixels away.
        let dest_dir = match media_dest_dir {
            Some(d) => d,
            None => continue,
        };

        let mut page_image_md: Vec<String> = Vec::new();
        for object in page.objects().iter() {
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!("[extract_pdf_markdown] page {page_num} image read failed: {e}");
                    continue;
                }
            };
            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                continue;
            }
            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                eprintln!("[extract_pdf_markdown] page {page_num} PNG encode failed: {e}");
                continue;
            }
            idx += 1;
            let file_name = format!("img-{idx}.png");
            // `dest_dir_relative_to` is unused here (we don't need a
            // rel_path return — the markdown uses media_url_prefix);
            // pass dest_dir for both args so save_one_image's
            // strip_prefix is a no-op.
            if let Err(e) = save_one_image(&png_bytes, dest_dir, dest_dir, &file_name) {
                eprintln!("[extract_pdf_markdown] page {page_num} save failed: {e}");
                continue;
            }
            total_saved += 1;
            // Empty alt-text on purpose: until the vision-caption
            // helper lands (Phase 3a) we have nothing meaningful to
            // put there, and a placeholder like "image" or the file
            // name only adds noise to the LLM and to screen readers.
            let image_url = encode_markdown_image_url(&format!("{prefix}/{file_name}"));
            page_image_md.push(format!("![]({image_url})"));
            if total_saved as usize >= options.max_images {
                eprintln!(
                    "[extract_pdf_markdown] reached max_images={} cap; skipped rest",
                    options.max_images
                );
                break;
            }
        }
        if !page_image_md.is_empty() {
            out.push('\n');
            for img_md in &page_image_md {
                out.push_str(img_md);
                out.push('\n');
            }
        }
        if total_saved as usize >= options.max_images {
            break;
        }
    }

    if media_dest_dir.is_some() {
        eprintln!("[extract_pdf_markdown] '{path}' DONE — pages={page_count}, saved={total_saved}");
    }

    Ok(out)
}

/// Iterate every PDF page, extract every embedded raster image, and
/// re-encode each to PNG. Vector content (paths, glyph outlines) is
/// NOT extracted here — that's a Phase 1.5 follow-up if needed (would
/// involve rendering the entire page to a bitmap as a fallback).
pub fn extract_pdf_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    use pdfium_render::prelude::*;

    // Hold the global PDFium lock for the entire call. The C library
    // is NOT safe for concurrent access — see `lock_pdfium` in fs.rs
    // for the full rationale. Held for the whole document lifetime so
    // page iteration doesn't race a concurrent `load_pdf_from_file`
    // on a different worker thread.
    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF '{path}': {e}"))?;

    let mut out: Vec<ExtractedImage> = Vec::new();
    let mut idx: u32 = 0;

    'pages: for (page_idx, page) in doc.pages().iter().enumerate() {
        for object in page.objects().iter() {
            // Only image objects. Path / text / shading / form / etc.
            // are all skipped — we don't try to rasterize vector charts
            // in this phase.
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };

            // get_raw_image returns an `image::DynamicImage`. PDFium
            // can fail per-image on a corrupt embed; we log + skip
            // rather than aborting the whole document.
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!(
                        "[extract_pdf_images] page {} image read failed: {e}",
                        page_idx + 1
                    );
                    continue;
                }
            };

            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                continue;
            }

            // Re-encode to PNG. We don't try to preserve the source
            // codec — PDFium often hands us raw RGBA, and even when
            // the embedded form was JPEG, decode → re-encode is fine
            // for the kind of resolutions inside PDFs.
            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                eprintln!(
                    "[extract_pdf_images] page {} PNG encode failed: {e}",
                    page_idx + 1
                );
                continue;
            }

            idx += 1;
            let data_base64 = B64.encode(&png_bytes);
            let sha256 = sha256_hex(&png_bytes);

            out.push(ExtractedImage {
                index: idx,
                mime_type: "image/png".to_string(),
                page: Some((page_idx + 1) as u32),
                width,
                height,
                data_base64,
                sha256,
                context_before: None,
                context_after: None,
            });

            if out.len() >= options.max_images {
                eprintln!(
                    "[extract_pdf_images] reached max_images={} cap; remaining images skipped",
                    options.max_images
                );
                break 'pages;
            }
        }
    }

    Ok(out)
}

// ── PPTX / DOCX (zip) ──────────────────────────────────────────────────

/// Office Open XML formats (PPTX, DOCX) embed images verbatim under
/// `<root>/media/`. We don't parse the surrounding XML to figure out
/// which slide / paragraph an image lives in — that's more work than
/// this phase needs. PPTX gets a slide number heuristic via the
/// reference graph (`slide<N>.xml.rels` files reference `media/...`),
/// but for v1 we just pass `page: None` for DOCX and a best-effort
/// slide number for PPTX.
pub fn extract_office_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip '{path}': {e}"))?;

    // Detect whether this is a PPTX or DOCX/etc. by looking for the
    // canonical xml entry. PPTX has presentation.xml; DOCX has
    // document.xml. Only PPTX gets the slide-number lookup.
    let is_pptx = archive
        .file_names()
        .any(|n| n == "ppt/presentation.xml" || n.starts_with("ppt/slides/slide"));

    // Build a map of media_filename -> Option<slide_number>. For
    // PPTX, scan each slide<N>.xml.rels for media references. For
    // DOCX, no per-image page info — leave map empty / None.
    let media_to_slide = if is_pptx {
        build_pptx_media_slide_map(&mut archive)
    } else {
        HashMap::new()
    };
    let media_to_context = if is_pptx {
        build_pptx_media_context_map(&mut archive)
    } else {
        build_docx_media_context_map(&mut archive)
    };

    // List media entries up front so we can iterate by_index in a
    // stable order (file_names order is consistent within a single
    // archive). `by_index` is the zip crate's recommended pattern
    // for iteration since `by_name` re-walks the central directory
    // on every call.
    let media_indices: Vec<usize> = (0..archive.len())
        .filter(|i| {
            archive
                .by_index_raw(*i)
                .ok()
                .map(|f| is_media_path(f.name()))
                .unwrap_or(false)
        })
        .collect();

    let mut out: Vec<ExtractedImage> = Vec::new();
    let mut idx: u32 = 0;

    for archive_idx in media_indices {
        let mut entry = match archive.by_index(archive_idx) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[extract_office_images] zip entry {archive_idx} read failed: {e}");
                continue;
            }
        };

        let entry_name = entry.name().to_string();
        let mime_type = guess_mime_from_name(&entry_name);
        if mime_type.is_none() {
            // Unknown extension (svg / emf / wmf etc.) — skip rather
            // than try to handle vector formats in this phase.
            continue;
        }
        let mime_type = mime_type.unwrap();

        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            eprintln!("[extract_office_images] read '{entry_name}' failed: {e}");
            continue;
        }

        // We need width/height to apply the size filter. Decoding via
        // the `image` crate is the safest cross-format path; it
        // recognizes PNG/JPEG/GIF/WEBP/BMP without re-encoding.
        let (width, height) = match image::load_from_memory(&bytes) {
            Ok(img) => (img.width(), img.height()),
            Err(e) => {
                eprintln!("[extract_office_images] decode '{entry_name}' failed: {e}");
                continue;
            }
        };
        if width < options.min_width || height < options.min_height {
            continue;
        }

        idx += 1;
        let data_base64 = B64.encode(&bytes);
        let sha256 = sha256_hex(&bytes);
        let page = media_to_slide.get(&entry_name).copied().flatten();
        let context = media_to_context.get(&entry_name);

        out.push(ExtractedImage {
            index: idx,
            mime_type,
            page,
            width,
            height,
            data_base64,
            sha256,
            context_before: context.map(|ctx| ctx.context_before.clone()),
            context_after: context.map(|ctx| ctx.context_after.clone()),
        });

        if out.len() >= options.max_images {
            eprintln!(
                "[extract_office_images] reached max_images={} cap; remaining skipped",
                options.max_images
            );
            break;
        }
    }

    Ok(out)
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn is_media_path(name: &str) -> bool {
    // PPTX: ppt/media/...    DOCX: word/media/...    XLSX: xl/media/...
    let lower = name.to_ascii_lowercase();
    lower.starts_with("ppt/media/")
        || lower.starts_with("word/media/")
        || lower.starts_with("xl/media/")
}

fn guess_mime_from_name(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "gif" => Some("image/gif".to_string()),
        "webp" => Some("image/webp".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        // Vector formats explicitly skipped — we don't have a
        // rasterizer wired up in this phase.
        _ => None,
    }
}

fn encode_uri_component_like(segment: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(segment.len());
    for &byte in segment.as_bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')') {
            out.push(ch);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn encode_markdown_image_url(url: &str) -> String {
    let normalized = url.replace('\\', "/");
    if normalized.is_empty() {
        return normalized;
    }
    if normalized.contains("://") {
        return normalized;
    }

    let (prefix, rest) = if normalized.len() >= 3
        && normalized.as_bytes()[0].is_ascii_alphabetic()
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
    {
        (&normalized[..3], &normalized[3..])
    } else if let Some(stripped) = normalized.strip_prefix("//") {
        ("//", stripped)
    } else if let Some(stripped) = normalized.strip_prefix('/') {
        ("/", stripped)
    } else if let Some(stripped) = normalized.strip_prefix("./") {
        ("./", stripped)
    } else {
        ("", normalized.as_str())
    };

    let trailing_slash = !rest.is_empty() && rest.ends_with('/');
    let encoded = rest
        .split('/')
        .map(|segment| {
            if segment.is_empty() {
                String::new()
            } else {
                encode_uri_component_like(segment)
            }
        })
        .collect::<Vec<_>>()
        .join("/");

    if trailing_slash && !encoded.ends_with('/') {
        format!("{prefix}{encoded}/")
    } else {
        format!("{prefix}{encoded}")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Walk every `ppt/slides/slide<N>.xml.rels` file and record which
/// `ppt/media/*` files each slide references. Returns a flat map
/// `media_path -> Some(slide_number)`. If a media file isn't
/// referenced from any slide (rare; usually unused theme assets),
/// it's absent from the map and gets `None` at the call site.
fn build_pptx_media_slide_map(archive: &mut zip::ZipArchive<File>) -> HashMap<String, Option<u32>> {
    let mut out: HashMap<String, Option<u32>> = HashMap::new();

    // Collect rels paths first so we don't hold an active `archive`
    // borrow while reading. The clone is cheap (just file names).
    let rels_paths: Vec<String> = archive
        .file_names()
        .filter(|n| {
            // ppt/slides/_rels/slide<N>.xml.rels
            n.starts_with("ppt/slides/_rels/slide") && n.ends_with(".xml.rels")
        })
        .map(String::from)
        .collect();

    for rels_path in rels_paths {
        // Slide number is the digits between "slide" and ".xml.rels".
        let slide_num: Option<u32> = rels_path
            .strip_prefix("ppt/slides/_rels/slide")
            .and_then(|s| s.strip_suffix(".xml.rels"))
            .and_then(|s| s.parse().ok());

        let mut entry = match archive.by_name(&rels_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_err() {
            continue;
        }

        // Naive extraction: rels XML has Target="../media/imageN.png"
        // attributes for image relationships. We don't bother with a
        // full XML parser — a substring scan is plenty for this.
        let mut search_from = 0;
        while let Some(pos) = xml[search_from..].find("Target=\"") {
            let start = search_from + pos + "Target=\"".len();
            let end = match xml[start..].find('"') {
                Some(e) => start + e,
                None => break,
            };
            let target = &xml[start..end];
            search_from = end + 1;

            // Targets are relative to the slide's _rels folder, e.g.
            // "../media/image3.png" → "ppt/media/image3.png".
            if let Some(stripped) = target.strip_prefix("../") {
                let canonical = format!("ppt/{stripped}");
                if is_media_path(&canonical) {
                    out.insert(canonical, slide_num);
                }
            }
        }
    }

    out
}

#[derive(Debug, Clone, Default)]
struct ImageContext {
    context_before: String,
    context_after: String,
}

fn pptx_rel_target_to_media_path(target: &str) -> Option<String> {
    let cleaned = target.replace('\\', "/");
    let without_prefix = cleaned.strip_prefix("../").unwrap_or(&cleaned);
    if without_prefix.starts_with("media/") {
        Some(format!("ppt/{without_prefix}"))
    } else if without_prefix.starts_with("ppt/media/") {
        Some(without_prefix.to_string())
    } else {
        None
    }
}

fn build_pptx_relationship_map(rels_xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut search_from = 0;
    while let Some(pos) = rels_xml[search_from..].find("<Relationship") {
        let start = search_from + pos;
        let end = match rels_xml[start..].find('>') {
            Some(end) => start + end + 1,
            None => break,
        };
        let tag = &rels_xml[start..end];
        search_from = end;
        let Some(id) = xml_attr_value(tag, "Id") else {
            continue;
        };
        let Some(target) = xml_attr_value(tag, "Target") else {
            continue;
        };
        if let Some(media_path) = pptx_rel_target_to_media_path(&target) {
            out.insert(id, media_path);
        }
    }
    out
}

fn extract_pptx_text_runs(xml: &str) -> String {
    let mut out = String::new();
    let mut search_from = 0;
    while let Some(pos) = xml[search_from..].find("<a:t") {
        let tag_start = search_from + pos;
        let tag_end = match xml[tag_start..].find('>') {
            Some(end) => tag_start + end + 1,
            None => break,
        };
        let close = match xml[tag_end..].find("</a:t>") {
            Some(end) => tag_end + end,
            None => break,
        };
        let text = decode_xml_entities(&xml[tag_end..close]);
        if !text.trim().is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(text.trim());
        }
        search_from = close + "</a:t>".len();
    }
    out
}

fn find_next_pptx_event(xml: &str, search_from: usize) -> Option<(usize, usize, String)> {
    let text_pos = xml[search_from..].find("<a:t").map(|p| search_from + p);
    let embed_pos = xml[search_from..]
        .find("r:embed=\"")
        .map(|p| search_from + p);
    match (text_pos, embed_pos) {
        (Some(t), Some(e)) if t < e => {
            let close = xml[t..].find("</a:t>")? + t + "</a:t>".len();
            Some((t, close, "text".to_string()))
        }
        (Some(t), None) => {
            let close = xml[t..].find("</a:t>")? + t + "</a:t>".len();
            Some((t, close, "text".to_string()))
        }
        (_, Some(e)) => {
            let start = e + "r:embed=\"".len();
            let end = xml[start..].find('"')? + start + 1;
            Some((e, end, "image".to_string()))
        }
        (None, None) => None,
    }
}

fn build_pptx_media_context_map_from_xml(
    slides: &[(u32, &str)],
    rels: &[(u32, &str)],
) -> HashMap<String, ImageContext> {
    let rel_by_slide: HashMap<u32, HashMap<String, String>> = rels
        .iter()
        .map(|(slide_num, xml)| (*slide_num, build_pptx_relationship_map(xml)))
        .collect();
    let mut out = HashMap::new();

    for (slide_num, slide_xml) in slides {
        let Some(rel_to_media) = rel_by_slide.get(slide_num) else {
            continue;
        };
        if rel_to_media.is_empty() {
            continue;
        }

        let mut parts: Vec<String> = Vec::new();
        let mut image_positions: Vec<(usize, String)> = Vec::new();
        let mut search_from = 0;
        while let Some((start, end, kind)) = find_next_pptx_event(slide_xml, search_from) {
            if kind == "text" {
                let text = extract_pptx_text_runs(&slide_xml[start..end])
                    .trim()
                    .to_string();
                if !text.is_empty() {
                    parts.push(text);
                }
            } else {
                let rel_id_start = start + "r:embed=\"".len();
                let Some(rel_id_end) = slide_xml[rel_id_start..]
                    .find('"')
                    .map(|p| rel_id_start + p)
                else {
                    search_from = end;
                    continue;
                };
                let rel_id = &slide_xml[rel_id_start..rel_id_end];
                if let Some(media_path) = rel_to_media.get(rel_id) {
                    let idx = parts.len();
                    parts.push(format!("[image:{media_path}]"));
                    image_positions.push((idx, media_path.clone()));
                }
            }
            search_from = end;
        }

        for (idx, media_path) in image_positions {
            out.insert(
                media_path,
                ImageContext {
                    context_before: context_window(&parts, idx, true),
                    context_after: context_window(&parts, idx, false),
                },
            );
        }
    }

    out
}

fn build_pptx_media_context_map(
    archive: &mut zip::ZipArchive<File>,
) -> HashMap<String, ImageContext> {
    let mut slide_names: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(|n| {
            if !(n.starts_with("ppt/slides/slide") && n.ends_with(".xml")) {
                return None;
            }
            let slide_num = n
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((slide_num, n.to_string()))
        })
        .collect();
    slide_names.sort_by_key(|(num, _)| *num);

    let mut rel_names: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(|n| {
            if !(n.starts_with("ppt/slides/_rels/slide") && n.ends_with(".xml.rels")) {
                return None;
            }
            let slide_num = n
                .strip_prefix("ppt/slides/_rels/slide")?
                .strip_suffix(".xml.rels")?
                .parse()
                .ok()?;
            Some((slide_num, n.to_string()))
        })
        .collect();
    rel_names.sort_by_key(|(num, _)| *num);

    let slides_owned: Vec<(u32, String)> = slide_names
        .iter()
        .filter_map(|(num, name)| read_zip_text(archive, name).map(|xml| (*num, xml)))
        .collect();
    let rels_owned: Vec<(u32, String)> = rel_names
        .iter()
        .filter_map(|(num, name)| read_zip_text(archive, name).map(|xml| (*num, xml)))
        .collect();

    let slides: Vec<(u32, &str)> = slides_owned
        .iter()
        .map(|(num, xml)| (*num, xml.as_str()))
        .collect();
    let rels: Vec<(u32, &str)> = rels_owned
        .iter()
        .map(|(num, xml)| (*num, xml.as_str()))
        .collect();
    build_pptx_media_context_map_from_xml(&slides, &rels)
}

fn read_zip_text(archive: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
}

fn xml_attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_string())
}

fn extract_text_runs(xml: &str) -> String {
    let mut out = String::new();
    let mut search_from = 0;
    while let Some(pos) = xml[search_from..].find("<w:t") {
        let tag_start = search_from + pos;
        let tag_end = match xml[tag_start..].find('>') {
            Some(end) => tag_start + end + 1,
            None => break,
        };
        let close = match xml[tag_end..].find("</w:t>") {
            Some(end) => tag_end + end,
            None => break,
        };
        out.push_str(&decode_xml_entities(&xml[tag_end..close]));
        search_from = close + "</w:t>".len();
    }
    out
}

fn docx_rel_target_to_media_path(target: &str) -> Option<String> {
    let cleaned = target.replace('\\', "/");
    let without_prefix = cleaned.strip_prefix("../").unwrap_or(&cleaned);
    if without_prefix.starts_with("media/") {
        Some(format!("word/{without_prefix}"))
    } else if without_prefix.starts_with("word/media/") {
        Some(without_prefix.to_string())
    } else {
        None
    }
}

fn build_docx_relationship_map(rels_xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut search_from = 0;
    while let Some(pos) = rels_xml[search_from..].find("<Relationship") {
        let start = search_from + pos;
        let end = match rels_xml[start..].find('>') {
            Some(end) => start + end + 1,
            None => break,
        };
        let tag = &rels_xml[start..end];
        search_from = end;
        let Some(id) = xml_attr_value(tag, "Id") else {
            continue;
        };
        let Some(target) = xml_attr_value(tag, "Target") else {
            continue;
        };
        if let Some(media_path) = docx_rel_target_to_media_path(&target) {
            out.insert(id, media_path);
        }
    }
    out
}

fn find_embed_ids(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut search_from = 0;
    while let Some(pos) = xml[search_from..].find("r:embed=\"") {
        let start = search_from + pos + "r:embed=\"".len();
        let end = match xml[start..].find('"') {
            Some(end) => start + end,
            None => break,
        };
        out.push(xml[start..end].to_string());
        search_from = end + 1;
    }
    out
}

fn context_window(parts: &[String], image_idx: usize, before: bool) -> String {
    const MAX_CONTEXT_PARTS: usize = 3;
    if before {
        let start = image_idx.saturating_sub(MAX_CONTEXT_PARTS);
        parts[start..image_idx].join("\n")
    } else {
        let end = usize::min(parts.len(), image_idx + 1 + MAX_CONTEXT_PARTS);
        parts[image_idx + 1..end].join("\n")
    }
}

fn build_docx_media_context_map_from_xml(
    document_xml: &str,
    rels_xml: &str,
) -> HashMap<String, ImageContext> {
    let rel_to_media = build_docx_relationship_map(rels_xml);
    if rel_to_media.is_empty() {
        return HashMap::new();
    }

    let mut parts: Vec<String> = Vec::new();
    let mut image_positions: Vec<(usize, String)> = Vec::new();
    let mut search_from = 0;

    while let Some(pos) = document_xml[search_from..].find("<w:p") {
        let start = search_from + pos;
        let open_end = match document_xml[start..].find('>') {
            Some(end) => start + end + 1,
            None => break,
        };
        let close = match document_xml[open_end..].find("</w:p>") {
            Some(end) => open_end + end,
            None => break,
        };
        let paragraph = &document_xml[open_end..close];
        search_from = close + "</w:p>".len();

        let text = extract_text_runs(paragraph).trim().to_string();
        if !text.is_empty() {
            parts.push(text);
        }

        for rel_id in find_embed_ids(paragraph) {
            if let Some(media_path) = rel_to_media.get(&rel_id) {
                let idx = parts.len();
                parts.push(format!("[image:{media_path}]"));
                image_positions.push((idx, media_path.clone()));
            }
        }
    }

    let mut out = HashMap::new();
    for (idx, media_path) in image_positions {
        out.insert(
            media_path,
            ImageContext {
                context_before: context_window(&parts, idx, true),
                context_after: context_window(&parts, idx, false),
            },
        );
    }
    out
}

fn build_docx_media_context_map(
    archive: &mut zip::ZipArchive<File>,
) -> HashMap<String, ImageContext> {
    let Some(document_xml) = read_zip_text(archive, "word/document.xml") else {
        return HashMap::new();
    };
    let Some(rels_xml) = read_zip_text(archive, "word/_rels/document.xml.rels") else {
        return HashMap::new();
    };
    build_docx_media_context_map_from_xml(&document_xml, &rels_xml)
}

#[derive(Debug, Clone)]
struct DocxManualOccurrenceSeed {
    media_path: String,
    doc_order: u32,
    section_title: Option<String>,
    heading_path: Vec<String>,
    container_kind: &'static str,
    table_id: Option<u32>,
    row_index: Option<u32>,
    col_index: Option<u32>,
    row_text: String,
    cell_text: String,
    row_header_text: String,
    table_text_snapshot: String,
    preceding_paragraph: String,
    following_paragraph: String,
    row_image_count: u32,
    table_image_count: u32,
    table_row_count: u32,
    table_col_count: u32,
    local_text_before: String,
    local_text_after: String,
    context_before: String,
    context_after: String,
}

#[derive(Debug, Clone)]
enum DocxBlockPart {
    Text(String),
    Image(String),
}

#[derive(Debug, Clone)]
struct DocxParsedBlock {
    section_title: Option<String>,
    heading_path: Vec<String>,
    container_kind: &'static str,
    table_id: Option<u32>,
    row_index: Option<u32>,
    col_index: Option<u32>,
    plain_text: String,
    row_text: String,
    cell_text: String,
    row_header_text: String,
    table_text_snapshot: String,
    row_image_count: u32,
    table_image_count: u32,
    table_row_count: u32,
    table_col_count: u32,
    parts: Vec<DocxBlockPart>,
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn paragraph_is_heading(paragraph_xml: &str) -> bool {
    paragraph_xml.contains("w:pStyle") && paragraph_xml.contains("Heading")
}

fn paragraph_heading_level(paragraph_xml: &str) -> Option<usize> {
    let heading_pos = paragraph_xml.find("Heading")?;
    let digits = paragraph_xml[heading_pos + "Heading".len()..]
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        Some(1)
    } else {
        digits.parse::<usize>().ok()
    }
}

fn paragraph_is_list_item(paragraph_xml: &str) -> bool {
    paragraph_xml.contains("<w:numPr")
}

fn count_images(parts: &[DocxBlockPart]) -> u32 {
    parts.iter()
        .filter(|part| matches!(part, DocxBlockPart::Image(_)))
        .count() as u32
}

fn find_docx_open_tag(xml: &str, search_from: usize, tag: &str) -> Option<usize> {
    let exact = format!("<{tag}>");
    let with_attrs = format!("<{tag} ");
    let exact_pos = xml[search_from..].find(&exact).map(|pos| search_from + pos);
    let attrs_pos = xml[search_from..]
        .find(&with_attrs)
        .map(|pos| search_from + pos);
    match (exact_pos, attrs_pos) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn find_next_docx_event(xml: &str, search_from: usize) -> Option<(usize, usize, &'static str)> {
    let text_pos = find_docx_open_tag(xml, search_from, "w:t");
    let embed_pos = xml[search_from..]
        .find("r:embed=\"")
        .map(|p| search_from + p);

    match (text_pos, embed_pos) {
        (Some(t), Some(e)) if t < e => {
            let close = xml[t..].find("</w:t>")? + t + "</w:t>".len();
            Some((t, close, "text"))
        }
        (Some(t), None) => {
            let close = xml[t..].find("</w:t>")? + t + "</w:t>".len();
            Some((t, close, "text"))
        }
        (_, Some(e)) => {
            let start = e + "r:embed=\"".len();
            let end = xml[start..].find('"')? + start + 1;
            Some((e, end, "image"))
        }
        (None, None) => None,
    }
}

fn parse_docx_block_parts(
    xml: &str,
    rel_to_media: &HashMap<String, String>,
) -> Vec<DocxBlockPart> {
    let mut parts = Vec::new();
    let mut search_from = 0;

    while let Some((start, end, kind)) = find_next_docx_event(xml, search_from) {
        if kind == "text" {
            let text = normalize_text(&extract_text_runs(&xml[start..end]));
            if !text.is_empty() {
                parts.push(DocxBlockPart::Text(text));
            }
        } else {
            let rel_id_start = start + "r:embed=\"".len();
            let Some(rel_id_end) = xml[rel_id_start..].find('"').map(|p| rel_id_start + p) else {
                search_from = end;
                continue;
            };
            let rel_id = &xml[rel_id_start..rel_id_end];
            if let Some(media_path) = rel_to_media.get(rel_id) {
                parts.push(DocxBlockPart::Image(media_path.clone()));
            }
        }
        search_from = end;
    }

    parts
}

fn block_plain_text(parts: &[DocxBlockPart]) -> String {
    normalize_text(
        &parts
            .iter()
            .filter_map(|part| match part {
                DocxBlockPart::Text(text) => Some(text.as_str()),
                DocxBlockPart::Image(_) => None,
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn nearest_block_text(parts: &[DocxBlockPart], image_idx: usize, before: bool) -> String {
    if before {
        for idx in (0..image_idx).rev() {
            if let DocxBlockPart::Text(text) = &parts[idx] {
                let normalized = normalize_text(text);
                if !normalized.is_empty() {
                    return normalized;
                }
            }
        }
    } else {
        for part in parts.iter().skip(image_idx + 1) {
            if let DocxBlockPart::Text(text) = part {
                let normalized = normalize_text(text);
                if !normalized.is_empty() {
                    return normalized;
                }
            }
        }
    }
    String::new()
}

fn join_context(parts: Vec<String>) -> String {
    normalize_text(
        &parts
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn build_docx_manual_occurrence_seeds_from_xml(
    document_xml: &str,
    rels_xml: &str,
) -> Vec<DocxManualOccurrenceSeed> {
    let rel_to_media = build_docx_relationship_map(rels_xml);
    if rel_to_media.is_empty() {
        return Vec::new();
    }

    let body_xml = document_xml
        .split("<w:body>")
        .nth(1)
        .and_then(|rest| rest.split("</w:body>").next())
        .unwrap_or(document_xml);

    let mut blocks: Vec<DocxParsedBlock> = Vec::new();
    let mut search_from = 0;
    let mut current_section_title: Option<String> = None;
    let mut current_heading_path: Vec<String> = Vec::new();
    let mut next_table_id: u32 = 1;

    while search_from < body_xml.len() {
        let paragraph_pos = find_docx_open_tag(body_xml, search_from, "w:p");
        let table_pos = find_docx_open_tag(body_xml, search_from, "w:tbl");

        let Some((kind, start)) = (match (paragraph_pos, table_pos) {
            (Some(p), Some(t)) if p < t => Some(("paragraph", p)),
            (_, Some(t)) => Some(("table", t)),
            (Some(p), None) => Some(("paragraph", p)),
            (None, None) => None,
        }) else {
            break;
        };

        if kind == "paragraph" {
            let Some(open_end) = body_xml[start..].find('>').map(|end| start + end + 1) else {
                break;
            };
            let Some(close_start) = body_xml[open_end..].find("</w:p>").map(|end| open_end + end) else {
                break;
            };
            let close_end = close_start + "</w:p>".len();
            let paragraph_full = &body_xml[start..close_end];
            let paragraph_inner = &body_xml[open_end..close_start];
            let parts = parse_docx_block_parts(paragraph_inner, &rel_to_media);
            let plain_text = block_plain_text(&parts);

            if paragraph_is_heading(paragraph_full) && !plain_text.is_empty() {
                let heading_level = paragraph_heading_level(paragraph_full).unwrap_or(1);
                current_heading_path.truncate(heading_level.saturating_sub(1));
                current_heading_path.push(plain_text.clone());
                current_section_title = Some(plain_text.clone());
            }

            if !parts.is_empty() || !plain_text.is_empty() {
                blocks.push(DocxParsedBlock {
                    section_title: current_section_title.clone(),
                    heading_path: current_heading_path.clone(),
                    container_kind: if paragraph_is_list_item(paragraph_full) {
                        "list_item"
                    } else {
                        "paragraph"
                    },
                    table_id: None,
                    row_index: None,
                    col_index: None,
                    plain_text: plain_text.clone(),
                    row_text: plain_text.clone(),
                    cell_text: plain_text.clone(),
                    row_header_text: String::new(),
                    table_text_snapshot: String::new(),
                    row_image_count: count_images(&parts),
                    table_image_count: count_images(&parts),
                    table_row_count: 1,
                    table_col_count: 1,
                    parts,
                });
            }

            search_from = close_end;
            continue;
        }

        let Some(open_end) = body_xml[start..].find('>').map(|end| start + end + 1) else {
            break;
        };
        let Some(close_start) = body_xml[open_end..].find("</w:tbl>").map(|end| open_end + end) else {
            break;
        };
        let close_end = close_start + "</w:tbl>".len();
        let table_inner = &body_xml[open_end..close_start];
        let table_id = next_table_id;
        next_table_id += 1;
        let mut table_rows: Vec<Vec<(Vec<DocxBlockPart>, String)>> = Vec::new();

        let mut row_search = 0;
        while let Some(row_pos) = find_docx_open_tag(table_inner, row_search, "w:tr") {
            let Some(row_open_end) = table_inner[row_pos..].find('>').map(|end| row_pos + end + 1) else {
                break;
            };
            let Some(row_close_start) = table_inner[row_open_end..]
                .find("</w:tr>")
                .map(|end| row_open_end + end)
            else {
                break;
            };
            let row_close_end = row_close_start + "</w:tr>".len();
            let row_inner = &table_inner[row_open_end..row_close_start];
            let mut row_cells: Vec<(Vec<DocxBlockPart>, String)> = Vec::new();

            let mut cell_search = 0;
            while let Some(cell_pos) = find_docx_open_tag(row_inner, cell_search, "w:tc") {
                let Some(cell_open_end) = row_inner[cell_pos..].find('>').map(|end| cell_pos + end + 1) else {
                    break;
                };
                let Some(cell_close_start) = row_inner[cell_open_end..]
                    .find("</w:tc>")
                    .map(|end| cell_open_end + end)
                else {
                    break;
                };
                let cell_close_end = cell_close_start + "</w:tc>".len();
                let cell_inner = &row_inner[cell_open_end..cell_close_start];
                let parts = parse_docx_block_parts(cell_inner, &rel_to_media);
                let plain_text = block_plain_text(&parts);
                row_cells.push((parts, plain_text));
                cell_search = cell_close_end;
            }

            if !row_cells.is_empty() {
                table_rows.push(row_cells);
            }
            row_search = row_close_end;
        }

        let table_row_count = table_rows.len() as u32;
        let table_col_count = table_rows
            .iter()
            .map(|row| row.len() as u32)
            .max()
            .unwrap_or(0);
        let table_image_count = table_rows
            .iter()
            .flat_map(|row| row.iter())
            .map(|(parts, _)| count_images(parts))
            .sum::<u32>();
        let row_texts = table_rows
            .iter()
            .map(|row| {
                normalize_text(
                    &row.iter()
                        .map(|(_, text)| text.as_str())
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            })
            .collect::<Vec<_>>();
        let table_text_snapshot = normalize_text(
            &row_texts
                .iter()
                .filter(|text| !text.is_empty())
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
        );
        let header_row = table_rows
            .first()
            .map(|row| row.iter().map(|(_, text)| text.clone()).collect::<Vec<_>>())
            .unwrap_or_default();

        for (row_index, row_cells) in table_rows.into_iter().enumerate() {
            let row_text = row_texts.get(row_index).cloned().unwrap_or_default();
            let row_image_count = row_cells
                .iter()
                .map(|(parts, _)| count_images(parts))
                .sum::<u32>();
            for (col_index, (parts, plain_text)) in row_cells.into_iter().enumerate() {
                if !parts.is_empty() || !plain_text.is_empty() {
                    let row_header_text = if row_index > 0 {
                        header_row.get(col_index).cloned().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    blocks.push(DocxParsedBlock {
                        section_title: current_section_title.clone(),
                        heading_path: current_heading_path.clone(),
                        container_kind: "table_cell",
                        table_id: Some(table_id),
                        row_index: Some(row_index as u32),
                        col_index: Some(col_index as u32),
                        plain_text: plain_text.clone(),
                        row_text: row_text.clone(),
                        cell_text: plain_text,
                        row_header_text,
                        table_text_snapshot: table_text_snapshot.clone(),
                        row_image_count,
                        table_image_count,
                        table_row_count,
                        table_col_count,
                        parts,
                    });
                }
            }
        }

        search_from = close_end;
    }

    let block_texts: Vec<String> = blocks
        .iter()
        .map(|block| block.plain_text.clone())
        .collect();

    let mut out = Vec::new();
    let mut doc_order: u32 = 0;
    for (block_index, block) in blocks.iter().enumerate() {
        let before_blocks = block_texts[..block_index]
            .iter()
            .filter(|text| !text.is_empty())
            .rev()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let after_blocks = block_texts[block_index + 1..]
            .iter()
            .filter(|text| !text.is_empty())
            .take(3)
            .cloned()
            .collect::<Vec<_>>();

        for (part_index, part) in block.parts.iter().enumerate() {
            let DocxBlockPart::Image(media_path) = part else {
                continue;
            };
            doc_order += 1;
            let local_text_before = nearest_block_text(&block.parts, part_index, true);
            let local_text_after = nearest_block_text(&block.parts, part_index, false);
            let context_before = join_context(
                before_blocks
                    .iter()
                    .cloned()
                    .chain(
                        (!local_text_before.is_empty())
                            .then_some(local_text_before.clone())
                            .into_iter(),
                    )
                    .collect(),
            );
            let context_after = join_context(
                (!local_text_after.is_empty())
                    .then_some(local_text_after.clone())
                    .into_iter()
                    .chain(after_blocks.iter().cloned())
                    .collect(),
            );
            let preceding_paragraph = before_blocks.last().cloned().unwrap_or_default();
            let following_paragraph = after_blocks.first().cloned().unwrap_or_default();

            out.push(DocxManualOccurrenceSeed {
                media_path: media_path.clone(),
                doc_order,
                section_title: block.section_title.clone(),
                heading_path: block.heading_path.clone(),
                container_kind: block.container_kind,
                table_id: block.table_id,
                row_index: block.row_index,
                col_index: block.col_index,
                row_text: block.row_text.clone(),
                cell_text: block.cell_text.clone(),
                row_header_text: block.row_header_text.clone(),
                table_text_snapshot: block.table_text_snapshot.clone(),
                preceding_paragraph,
                following_paragraph,
                row_image_count: block.row_image_count,
                table_image_count: block.table_image_count,
                table_row_count: block.table_row_count,
                table_col_count: block.table_col_count,
                local_text_before,
                local_text_after,
                context_before,
                context_after,
            });
        }
    }

    out
}

fn classify_document_manual_visual(
    seed: &DocxManualOccurrenceSeed,
    width: u32,
    height: u32,
) -> Option<&'static str> {
    const TABLE_CELL_SMALL_VISUAL_MAX_DIMENSION: u32 = 360;
    const TABLE_CELL_SMALL_VISUAL_MAX_AREA: u64 = 70_000;

    if width < 12 || height < 12 {
        return None;
    }
    // Manual DOCX tables often embed medium-sized status legends
    // (solid color blocks, gauge fragments, state icons) that are
    // semantically "small visuals" even when both axes exceed 100px.
    // Keep this override narrow so full screenshots still remain
    // regular visuals.
    if seed.container_kind == "table_cell"
        && width.max(height) <= TABLE_CELL_SMALL_VISUAL_MAX_DIMENSION
        && u64::from(width) * u64::from(height) <= TABLE_CELL_SMALL_VISUAL_MAX_AREA
    {
        return Some("small_visual");
    }
    if width >= 100 && height >= 100 {
        return Some("regular_visual");
    }
    if width.min(height) >= 12 && width.max(height) < 192 {
        return Some("small_visual");
    }
    None
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocxManualVisualOccurrence {
    pub occurrence_index: u32,
    pub rel_path: String,
    pub abs_path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub sha256: String,
    pub visual_class: String,
    pub doc_order: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_title: Option<String>,
    pub heading_path: Vec<String>,
    pub container_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col_index: Option<u32>,
    pub row_text: String,
    pub cell_text: String,
    pub row_header_text: String,
    pub table_text_snapshot: String,
    pub preceding_paragraph: String,
    pub following_paragraph: String,
    pub row_image_count: u32,
    pub table_image_count: u32,
    pub table_row_count: u32,
    pub table_col_count: u32,
    pub local_text_before: String,
    pub local_text_after: String,
    pub context_before: String,
    pub context_after: String,
}

pub fn extract_and_save_docx_manual_visuals(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
) -> Result<Vec<SavedDocxManualVisualOccurrence>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip '{path}': {e}"))?;
    let Some(document_xml) = read_zip_text(&mut archive, "word/document.xml") else {
        return Ok(Vec::new());
    };
    let Some(rels_xml) = read_zip_text(&mut archive, "word/_rels/document.xml.rels") else {
        return Ok(Vec::new());
    };

    let seeds = build_docx_manual_occurrence_seeds_from_xml(&document_xml, &rels_xml);
    if seeds.is_empty() {
        return Ok(Vec::new());
    }

    let mut saved_media: HashMap<String, (String, String, String, u32, u32, String)> =
        HashMap::new();
    let mut next_saved_index: u32 = 1;
    let mut out = Vec::new();

    for seed in seeds {
        if !saved_media.contains_key(&seed.media_path) {
            let Some(mime_type) = guess_mime_from_name(&seed.media_path) else {
                continue;
            };
            let mut entry = match archive.by_name(&seed.media_path) {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            if entry.read_to_end(&mut bytes).is_err() {
                continue;
            }
            let (width, height) = match image::load_from_memory(&bytes) {
                Ok(img) => (img.width(), img.height()),
                Err(_) => continue,
            };
            let Some(_visual_class) = classify_document_manual_visual(&seed, width, height) else {
                continue;
            };
            let ext = ext_for_mime(&mime_type);
            let file_name = format!("img-{next_saved_index}.{ext}");
            next_saved_index += 1;
            let (rel_path, abs_path) = save_one_image(&bytes, dest_dir, rel_to, &file_name)?;
            let sha256 = sha256_hex(&bytes);
            saved_media.insert(
                seed.media_path.clone(),
                (
                    rel_path,
                    abs_path,
                    mime_type,
                    width,
                    height,
                    sha256,
                ),
            );
        }

        let Some((rel_path, abs_path, mime_type, width, height, sha256)) =
            saved_media.get(&seed.media_path)
        else {
            continue;
        };
        let Some(visual_class) = classify_document_manual_visual(&seed, *width, *height) else {
            continue;
        };

        out.push(SavedDocxManualVisualOccurrence {
            occurrence_index: out.len() as u32 + 1,
            rel_path: rel_path.clone(),
            abs_path: abs_path.clone(),
            mime_type: mime_type.clone(),
            width: *width,
            height: *height,
            sha256: sha256.clone(),
            visual_class: visual_class.to_string(),
            doc_order: seed.doc_order,
            section_title: seed.section_title.clone(),
            heading_path: seed.heading_path.clone(),
            container_kind: seed.container_kind.to_string(),
            table_id: seed.table_id,
            row_index: seed.row_index,
            col_index: seed.col_index,
            row_text: seed.row_text.clone(),
            cell_text: seed.cell_text.clone(),
            row_header_text: seed.row_header_text.clone(),
            table_text_snapshot: seed.table_text_snapshot.clone(),
            preceding_paragraph: seed.preceding_paragraph.clone(),
            following_paragraph: seed.following_paragraph.clone(),
            row_image_count: seed.row_image_count,
            table_image_count: seed.table_image_count,
            table_row_count: seed.table_row_count,
            table_col_count: seed.table_col_count,
            local_text_before: seed.local_text_before.clone(),
            local_text_after: seed.local_text_after.clone(),
            context_before: seed.context_before.clone(),
            context_after: seed.context_after.clone(),
        });
    }

    Ok(out)
}

// ── Extract-and-save: write to disk, skip the base64 round-trip ────────
//
// The base64-returning commands above are useful for future
// captioning paths that need bytes in-memory. The ingest pipeline
// just wants to land images on disk and reference them from
// markdown — the round-trip via JS is wasteful (5 MB image → 6.7 MB
// base64 string → JS allocates → JS calls back to Rust → decode →
// write). The functions below short-circuit by writing directly.

/// Metadata for an image that's already been written to disk.
/// Mirrors `ExtractedImage` but swaps `data_base64` for `rel_path` —
/// the path the caller can embed in markdown (`![alt](rel_path)`).
///
/// `rename_all = "camelCase"` is REQUIRED, not cosmetic. The TS layer
/// validates the IPC payload by exact field names (`relPath`,
/// `absPath`, `mimeType`) — without this attribute serde would emit
/// `rel_path`/`abs_path`/`mime_type` and the validator drops every
/// item, returning `[]` even when extraction succeeded and saved
/// files to disk. Tauri's IPC auto-camelCase only applies to
/// COMMAND PARAMETER names, never to serialized return values.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub index: u32,
    pub mime_type: String,
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Path of the written file, relative to `dest_dir_relative_to`.
    /// E.g. when `dest_dir` is `<project>/wiki/media/foo` and
    /// `dest_dir_relative_to` is `<project>/wiki`, this is
    /// `media/foo/img-1.png`. The caller-provided base lets us
    /// generate paths that work inside markdown rendered from
    /// anywhere under the wiki root.
    pub rel_path: String,
    /// Absolute path on disk — the chat / file-preview UI uses this
    /// (via `convertFileSrc`) to actually load the image.
    pub abs_path: String,
    pub sha256: String,
    /// Text immediately before the image anchor in the source, when
    /// available. DOCX provides paragraph-level context; PDF relies
    /// on inline markdown refs instead, so this remains absent there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_before: Option<String>,
    /// Text immediately after the image anchor in the source, when
    /// available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_after: Option<String>,
}

fn save_one_image(
    bytes: &[u8],
    dest_dir: &Path,
    dest_dir_relative_to: &Path,
    file_name: &str,
) -> Result<(String, String), String> {
    if !dest_dir.exists() {
        std::fs::create_dir_all(dest_dir)
            .map_err(|e| format!("create_dir_all '{}': {e}", dest_dir.display()))?;
    }
    let abs = dest_dir.join(file_name);
    std::fs::write(&abs, bytes).map_err(|e| format!("write '{}': {e}", abs.display()))?;

    let rel = abs
        .strip_prefix(dest_dir_relative_to)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file_name.to_string());
    Ok((rel, abs.to_string_lossy().to_string()))
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

/// PDF: extract every embedded image AND write each to
/// `dest_dir / img-<index>.<ext>`. `rel_to` is the directory the
/// returned `rel_path` is anchored at (typically the wiki root).
/// PNG re-encoding is unconditional (pdfium hands us decoded bitmaps
/// regardless of source codec).
pub fn extract_and_save_pdf_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    use pdfium_render::prelude::*;

    // See `extract_pdf_images` for why this lock is mandatory.
    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF '{path}': {e}"))?;

    let mut out: Vec<SavedImage> = Vec::new();
    let mut idx: u32 = 0;
    // Diagnostic counters — when extraction returns empty, the user's
    // first question is "did the PDF actually have raster images?"
    // These let us answer it from logs without having to crack open
    // the PDF in a debugger.
    let mut total_objects: u32 = 0;
    let mut total_image_objects: u32 = 0;
    let mut filtered_too_small: u32 = 0;
    let mut filtered_decode_err: u32 = 0;
    let mut filtered_encode_err: u32 = 0;

    let page_count = doc.pages().len();
    eprintln!(
        "[extract_and_save_pdf_images] '{path}': {} page(s), filter=({}x{}) min, max={}",
        page_count, options.min_width, options.min_height, options.max_images
    );

    'pages: for (page_idx, page) in doc.pages().iter().enumerate() {
        for object in page.objects().iter() {
            total_objects += 1;
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };
            total_image_objects += 1;
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    filtered_decode_err += 1;
                    eprintln!(
                        "[extract_and_save_pdf_images] page {} image read failed: {e}",
                        page_idx + 1
                    );
                    continue;
                }
            };
            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                filtered_too_small += 1;
                eprintln!(
                    "[extract_and_save_pdf_images] page {} image {}x{} < min ({}x{}) — skipped",
                    page_idx + 1,
                    width,
                    height,
                    options.min_width,
                    options.min_height
                );
                continue;
            }

            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                filtered_encode_err += 1;
                eprintln!(
                    "[extract_and_save_pdf_images] page {} PNG encode failed: {e}",
                    page_idx + 1
                );
                continue;
            }

            idx += 1;
            let file_name = format!("img-{idx}.png");
            let (rel_path, abs_path) = save_one_image(&png_bytes, dest_dir, rel_to, &file_name)?;
            let sha256 = sha256_hex(&png_bytes);

            out.push(SavedImage {
                index: idx,
                mime_type: "image/png".to_string(),
                page: Some((page_idx + 1) as u32),
                width,
                height,
                rel_path,
                abs_path,
                sha256,
                context_before: None,
                context_after: None,
            });

            if out.len() >= options.max_images {
                eprintln!(
                    "[extract_and_save_pdf_images] reached max_images={} cap; skipped rest",
                    options.max_images
                );
                break 'pages;
            }
        }
    }

    eprintln!(
        "[extract_and_save_pdf_images] '{path}' DONE — saved={}, total_objects={}, image_objects={}, too_small={}, decode_err={}, encode_err={}",
        out.len(), total_objects, total_image_objects, filtered_too_small, filtered_decode_err, filtered_encode_err,
    );

    Ok(out)
}

/// PPTX/DOCX: pull embedded images directly from the zip media/
/// directory and write each to `dest_dir`. Source format is
/// preserved (PNG stays PNG, JPEG stays JPEG) since pulling the raw
/// bytes is cheap and there's no compositing happening.
pub fn extract_and_save_office_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip '{path}': {e}"))?;

    let is_pptx = archive
        .file_names()
        .any(|n| n == "ppt/presentation.xml" || n.starts_with("ppt/slides/slide"));
    let media_to_slide = if is_pptx {
        build_pptx_media_slide_map(&mut archive)
    } else {
        HashMap::new()
    };
    let media_to_context = if is_pptx {
        build_pptx_media_context_map(&mut archive)
    } else {
        build_docx_media_context_map(&mut archive)
    };

    let media_indices: Vec<usize> = (0..archive.len())
        .filter(|i| {
            archive
                .by_index_raw(*i)
                .ok()
                .map(|f| is_media_path(f.name()))
                .unwrap_or(false)
        })
        .collect();

    let mut out: Vec<SavedImage> = Vec::new();
    let mut idx: u32 = 0;

    for archive_idx in media_indices {
        let mut entry = match archive.by_index(archive_idx) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[extract_and_save_office_images] zip entry read failed: {e}");
                continue;
            }
        };
        let entry_name = entry.name().to_string();
        let mime_type = match guess_mime_from_name(&entry_name) {
            Some(m) => m,
            None => continue,
        };

        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            eprintln!("[extract_and_save_office_images] read '{entry_name}' failed: {e}");
            continue;
        }

        let (width, height) = match image::load_from_memory(&bytes) {
            Ok(img) => (img.width(), img.height()),
            Err(e) => {
                eprintln!("[extract_and_save_office_images] decode '{entry_name}' failed: {e}");
                continue;
            }
        };
        if width < options.min_width || height < options.min_height {
            continue;
        }

        idx += 1;
        let ext = ext_for_mime(&mime_type);
        let file_name = format!("img-{idx}.{ext}");
        let (rel_path, abs_path) = save_one_image(&bytes, dest_dir, rel_to, &file_name)?;
        let sha256 = sha256_hex(&bytes);
        let page = media_to_slide.get(&entry_name).copied().flatten();
        let context = media_to_context.get(&entry_name);

        out.push(SavedImage {
            index: idx,
            mime_type,
            page,
            width,
            height,
            rel_path,
            abs_path,
            sha256,
            context_before: context.map(|ctx| ctx.context_before.clone()),
            context_after: context.map(|ctx| ctx.context_after.clone()),
        });

        if out.len() >= options.max_images {
            eprintln!(
                "[extract_and_save_office_images] reached max_images={} cap; skipped rest",
                options.max_images
            );
            break;
        }
    }

    Ok(out)
}

// ── Tauri command bindings ─────────────────────────────────────────────

// Why every cmd below is `spawn_blocking`:
// PDFium FFI calls and zip+image-decode are all blocking. Running
// them inside an `async fn` body (as we did before this fix) kept
// them on a tokio worker thread, blocking other async tasks on
// that worker for the full duration of the extraction. `spawn_
// blocking` moves the work to tokio's blocking pool — that's the
// pool's contract. (Combined with the PDFium mutex inside
// `extract_pdf_images`, this also prevents the segfault that hit
// when two PDF extractions raced on different workers.)

#[tauri::command]
pub async fn extract_pdf_images_cmd(path: String) -> Result<Vec<ExtractedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_pdf_images", || {
            extract_pdf_images(&path, &ExtractOptions::default())
        })
    })
    .await
    .map_err(|e| format!("extract_pdf_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_office_images_cmd(path: String) -> Result<Vec<ExtractedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_office_images", || {
            extract_office_images(&path, &ExtractOptions::default())
        })
    })
    .await
    .map_err(|e| format!("extract_office_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_and_save_pdf_images_cmd(
    source_path: String,
    dest_dir: String,
    rel_to: String,
) -> Result<Vec<SavedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_and_save_pdf_images", || {
            extract_and_save_pdf_images(
                &source_path,
                Path::new(&dest_dir),
                Path::new(&rel_to),
                &ExtractOptions::default(),
            )
        })
    })
    .await
    .map_err(|e| format!("extract_and_save_pdf_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_and_save_office_images_cmd(
    source_path: String,
    dest_dir: String,
    rel_to: String,
) -> Result<Vec<SavedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_and_save_office_images", || {
            extract_and_save_office_images(
                &source_path,
                Path::new(&dest_dir),
                Path::new(&rel_to),
                &ExtractOptions::default(),
            )
        })
    })
    .await
    .map_err(|e| format!("extract_and_save_office_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_and_save_docx_manual_visuals_cmd(
    source_path: String,
    dest_dir: String,
    rel_to: String,
) -> Result<Vec<SavedDocxManualVisualOccurrence>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_and_save_docx_manual_visuals", || {
            extract_and_save_docx_manual_visuals(
                &source_path,
                Path::new(&dest_dir),
                Path::new(&rel_to),
            )
        })
    })
    .await
    .map_err(|e| format!("extract_and_save_docx_manual_visuals blocking task join error: {e}"))?
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "llm-wiki-extract-images-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([255, 0, 0, 255]),
        ));
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .expect("test image should encode to png");
        bytes
    }

    fn write_test_docx(
        path: &Path,
        document_xml: &str,
        rels_xml: &str,
        media_entries: &[(&str, &[u8])],
    ) {
        let file = File::create(path).expect("test docx should be creatable");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        writer
            .start_file(
                "[Content_Types].xml",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .expect("content types entry should start");
        writer
            .write_all(
                br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"#,
            )
            .expect("content types entry should write");

        writer
            .start_file("word/document.xml", options)
            .expect("document.xml entry should start");
        writer
            .write_all(document_xml.as_bytes())
            .expect("document.xml should write");

        writer
            .start_file("word/_rels/document.xml.rels", options)
            .expect("document rels entry should start");
        writer
            .write_all(rels_xml.as_bytes())
            .expect("document rels should write");

        for (entry_name, bytes) in media_entries {
            writer
                .start_file(*entry_name, options)
                .expect("media entry should start");
            writer.write_all(bytes).expect("media entry should write");
        }

        writer.finish().expect("test docx should finish");
    }

    #[test]
    fn is_media_path_recognizes_pptx_docx_xlsx() {
        assert!(is_media_path("ppt/media/image1.png"));
        assert!(is_media_path("word/media/image2.jpeg"));
        assert!(is_media_path("xl/media/image3.gif"));
        assert!(!is_media_path("ppt/slides/slide1.xml"));
        assert!(!is_media_path("word/document.xml"));
        assert!(!is_media_path("docProps/thumbnail.jpeg"));
    }

    #[test]
    fn guess_mime_from_name_covers_common_formats() {
        assert_eq!(
            guess_mime_from_name("ppt/media/image1.PNG"),
            Some("image/png".to_string())
        );
        assert_eq!(
            guess_mime_from_name("word/media/image2.jpeg"),
            Some("image/jpeg".to_string())
        );
        assert_eq!(
            guess_mime_from_name("ppt/media/image3.jpg"),
            Some("image/jpeg".to_string())
        );
        // Vector formats deliberately rejected — we don't rasterize
        // SVG/EMF/WMF in this phase, surfacing them as strings would
        // mislead the caption pipeline.
        assert_eq!(guess_mime_from_name("ppt/media/foo.svg"), None);
        assert_eq!(guess_mime_from_name("ppt/media/foo.emf"), None);
    }

    #[test]
    fn encode_markdown_image_url_percent_encodes_path_segments() {
        assert_eq!(
            encode_markdown_image_url("/Users/me/My Wiki/wiki/media/foo bar/img-1.png"),
            "/Users/me/My%20Wiki/wiki/media/foo%20bar/img-1.png"
        );
        assert_eq!(
            encode_markdown_image_url("media/望城区“智慧低空” 政务场景/img-2.png"),
            "media/%E6%9C%9B%E5%9F%8E%E5%8C%BA%E2%80%9C%E6%99%BA%E6%85%A7%E4%BD%8E%E7%A9%BA%E2%80%9D%20%E6%94%BF%E5%8A%A1%E5%9C%BA%E6%99%AF/img-2.png"
        );
        assert_eq!(
            encode_markdown_image_url("C:/Users/me/My Files/img 3.png"),
            "C:/Users/me/My%20Files/img%203.png"
        );
    }

    #[test]
    fn sha256_hex_is_deterministic_and_64_chars() {
        let h1 = sha256_hex(b"hello world");
        let h2 = sha256_hex(b"hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        // Known SHA-256 of "hello world".
        assert_eq!(
            h1,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn extract_options_defaults_match_plan() {
        // Plan documents 100×100 / 500 as the v1 defaults. Pinning
        // these here so a casual change is visible.
        let o = ExtractOptions::default();
        assert_eq!(o.min_width, 100);
        assert_eq!(o.min_height, 100);
        assert_eq!(o.max_images, 500);
    }

    #[test]
    fn docx_image_context_uses_surrounding_paragraphs() {
        let rels = r#"
            <Relationships>
              <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:p><w:r><w:t>本图前文说明这是智慧低空政务场景的总体架构。</w:t></w:r></w:p>
                <w:p>
                  <w:r>
                    <w:drawing>
                      <a:blip r:embed="rId7"/>
                    </w:drawing>
                  </w:r>
                </w:p>
                <w:p><w:r><w:t>图后文字说明平台包括感知、调度和服务应用三层。</w:t></w:r></w:p>
              </w:body>
            </w:document>
        "#;

        let contexts = build_docx_media_context_map_from_xml(document, rels);
        let ctx = contexts
            .get("word/media/image1.png")
            .expect("image context should be keyed by canonical media path");

        assert!(ctx.context_before.contains("智慧低空政务场景"));
        assert!(ctx.context_after.contains("感知、调度和服务应用三层"));
    }

    #[test]
    fn pptx_image_context_uses_same_slide_text() {
        let rels = r#"
            <Relationships>
              <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
            </Relationships>
        "#;
        let slide = r#"
            <p:sld>
              <p:cSld>
                <p:spTree>
                  <p:sp><p:txBody><a:p><a:r><a:t>智慧低空政务场景总体架构</a:t></a:r></a:p></p:txBody></p:sp>
                  <p:pic><p:blipFill><a:blip r:embed="rId4"/></p:blipFill></p:pic>
                  <p:sp><p:txBody><a:p><a:r><a:t>平台包括感知、调度和服务应用三层</a:t></a:r></a:p></p:txBody></p:sp>
                </p:spTree>
              </p:cSld>
            </p:sld>
        "#;

        let contexts = build_pptx_media_context_map_from_xml(&[(1, slide)], &[(1, rels)]);
        let ctx = contexts
            .get("ppt/media/image1.png")
            .expect("image context should be keyed by canonical ppt media path");

        assert!(ctx.context_before.contains("智慧低空政务场景总体架构"));
        assert!(ctx.context_after.contains("感知、调度和服务应用三层"));
    }

    #[test]
    fn docx_manual_anchors_follow_document_order_and_keep_heading_context() {
        let rels = r#"
            <Relationships>
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
              <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
              <Relationship Id="rId999" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unused.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:p>
                  <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
                  <w:r><w:t>设备状态</w:t></w:r>
                </w:p>
                <w:p>
                  <w:pPr><w:numPr/></w:pPr>
                  <w:r><w:t>未连接</w:t></w:r>
                  <w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r>
                </w:p>
                <w:p>
                  <w:pPr><w:numPr/></w:pPr>
                  <w:r><w:t>连接中</w:t></w:r>
                  <w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r>
                </w:p>
              </w:body>
            </w:document>
        "#;

        let anchors = build_docx_manual_occurrence_seeds_from_xml(document, rels);
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0].media_path, "word/media/image1.png");
        assert_eq!(anchors[0].doc_order, 1);
        assert_eq!(anchors[0].section_title.as_deref(), Some("设备状态"));
        assert_eq!(anchors[0].heading_path, vec!["设备状态".to_string()]);
        assert_eq!(anchors[0].container_kind, "list_item");
        assert_eq!(anchors[0].row_text, "未连接");
        assert_eq!(anchors[0].cell_text, "未连接");
        assert_eq!(anchors[0].local_text_before, "未连接");

        assert_eq!(anchors[1].media_path, "word/media/image2.png");
        assert_eq!(anchors[1].doc_order, 2);
        assert_eq!(anchors[1].section_title.as_deref(), Some("设备状态"));
        assert_eq!(anchors[1].heading_path, vec!["设备状态".to_string()]);
        assert_eq!(anchors[1].container_kind, "list_item");
        assert_eq!(anchors[1].row_text, "连接中");
        assert_eq!(anchors[1].local_text_before, "连接中");
    }

    #[test]
    fn docx_manual_anchors_capture_table_coordinates() {
        let rels = r#"
            <Relationships>
              <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image5.png"/>
              <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image6.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:p>
                  <w:pPr><w:pStyle w:val="Heading3"/></w:pPr>
                  <w:r><w:t>按钮状态</w:t></w:r>
                </w:p>
                <w:tbl>
                  <w:tr>
                    <w:tc>
                      <w:p>
                        <w:r><w:t>保存</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                  </w:tr>
                  <w:tr>
                    <w:tc>
                      <w:p>
                        <w:r><w:t>取消</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                  </w:tr>
                </w:tbl>
              </w:body>
            </w:document>
        "#;

        let anchors = build_docx_manual_occurrence_seeds_from_xml(document, rels);
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0].container_kind, "table_cell");
        assert_eq!(anchors[0].table_id, Some(1));
        assert_eq!(anchors[0].row_index, Some(0));
        assert_eq!(anchors[0].col_index, Some(0));
        assert_eq!(anchors[0].section_title.as_deref(), Some("按钮状态"));
        assert_eq!(anchors[0].heading_path, vec!["按钮状态".to_string()]);
        assert_eq!(anchors[0].row_text, "保存");
        assert_eq!(anchors[0].cell_text, "保存");
        assert_eq!(anchors[0].table_row_count, 2);
        assert_eq!(anchors[0].table_col_count, 1);
        assert_eq!(anchors[0].local_text_before, "保存");

        assert_eq!(anchors[1].container_kind, "table_cell");
        assert_eq!(anchors[1].table_id, Some(1));
        assert_eq!(anchors[1].row_index, Some(1));
        assert_eq!(anchors[1].col_index, Some(0));
        assert_eq!(anchors[1].row_text, "取消");
        assert_eq!(anchors[1].row_header_text, "保存");
        assert_eq!(anchors[1].table_text_snapshot, "保存 取消");
        assert_eq!(anchors[1].local_text_before, "取消");
    }

    #[test]
    fn docx_manual_visuals_classify_reused_medium_image_by_occurrence_context() {
        let root = make_temp_dir("manual-visual-context");
        let docx_path = root.join("manual.docx");
        let wiki_root = root.join("wiki");
        let media_dir = wiki_root.join("media/manual");
        let image_bytes = solid_png(304, 202);
        let rels = r#"
            <Relationships>
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
              <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:p>
                  <w:r><w:t>主界面示意图</w:t></w:r>
                  <w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r>
                </w:p>
                <w:tbl>
                  <w:tr>
                    <w:tc>
                      <w:p>
                        <w:r><w:t>与前车通信中断</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                  </w:tr>
                </w:tbl>
              </w:body>
            </w:document>
        "#;
        write_test_docx(
            &docx_path,
            document,
            rels,
            &[("word/media/image1.png", &image_bytes)],
        );

        let visuals = extract_and_save_docx_manual_visuals(
            docx_path.to_str().expect("docx path should be valid utf-8"),
            &media_dir,
            &wiki_root,
        )
        .expect("manual visuals should extract");

        assert_eq!(visuals.len(), 2);
        assert_eq!(visuals[0].container_kind, "paragraph");
        assert_eq!(visuals[0].visual_class, "regular_visual");
        assert_eq!(visuals[1].container_kind, "table_cell");
        assert_eq!(visuals[1].visual_class, "small_visual");
        assert_eq!(visuals[0].rel_path, visuals[1].rel_path);
        assert_eq!(visuals[0].sha256, visuals[1].sha256);

        std::fs::remove_dir_all(root).expect("temp dir should be removable");
    }

    #[test]
    fn docx_manual_visuals_keep_large_table_cell_screenshots_regular() {
        let root = make_temp_dir("manual-visual-large-table");
        let docx_path = root.join("manual.docx");
        let wiki_root = root.join("wiki");
        let media_dir = wiki_root.join("media/manual");
        let image_bytes = solid_png(481, 359);
        let rels = r#"
            <Relationships>
              <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image9.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:tbl>
                  <w:tr>
                    <w:tc>
                      <w:p>
                        <w:r><w:t>整页界面截图</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                  </w:tr>
                </w:tbl>
              </w:body>
            </w:document>
        "#;
        write_test_docx(
            &docx_path,
            document,
            rels,
            &[("word/media/image9.png", &image_bytes)],
        );

        let visuals = extract_and_save_docx_manual_visuals(
            docx_path.to_str().expect("docx path should be valid utf-8"),
            &media_dir,
            &wiki_root,
        )
        .expect("manual visuals should extract");

        assert_eq!(visuals.len(), 1);
        assert_eq!(visuals[0].container_kind, "table_cell");
        assert_eq!(visuals[0].visual_class, "regular_visual");

        std::fs::remove_dir_all(root).expect("temp dir should be removable");
    }

    #[test]
    fn docx_manual_anchors_ignore_table_property_tags_when_scanning_cells() {
        let rels = r#"
            <Relationships>
              <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image10.png"/>
              <Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image11.png"/>
            </Relationships>
        "#;
        let document = r#"
            <w:document>
              <w:body>
                <w:tbl>
                  <w:tblPr>
                    <w:tblBorders/>
                  </w:tblPr>
                  <w:tblGrid>
                    <w:gridCol w:w="1200"/>
                    <w:gridCol w:w="1200"/>
                  </w:tblGrid>
                  <w:tr>
                    <w:trPr><w:trHeight w:val="320"/></w:trPr>
                    <w:tc>
                      <w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>
                      <w:p>
                        <w:r><w:t>图标一</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId10"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                    <w:tc>
                      <w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>
                      <w:p>
                        <w:r><w:t>图标二</w:t></w:r>
                        <w:r><w:drawing><a:blip r:embed="rId11"/></w:drawing></w:r>
                      </w:p>
                    </w:tc>
                  </w:tr>
                </w:tbl>
              </w:body>
            </w:document>
        "#;

        let anchors = build_docx_manual_occurrence_seeds_from_xml(document, rels);
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[0].media_path, "word/media/image10.png");
        assert_eq!(anchors[0].row_index, Some(0));
        assert_eq!(anchors[0].col_index, Some(0));
        assert_eq!(anchors[0].local_text_before, "图标一");
        assert_eq!(anchors[1].media_path, "word/media/image11.png");
        assert_eq!(anchors[1].row_index, Some(0));
        assert_eq!(anchors[1].col_index, Some(1));
        assert_eq!(anchors[1].local_text_before, "图标二");
    }
}
