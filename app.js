const state = {
  pdfBytes: null,
  pdfName: "",
  pdfUrl: "",
  analysis: null,
  startedAt: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  form: $("toc-form"),
  url: $("pdf-url"),
  backendUrl: $("backend-url"),
  bearerToken: $("bearer-token"),
  proxyUrl: $("proxy-url"),
  backendStatus: $("backend-status"),
  progressLog: $("progress-log"),
  entriesBody: $("entries-body"),
  entryCount: $("entry-count"),
  alignmentStatus: $("alignment-status"),
  downloadState: $("download-state"),
  createPdf: $("create-pdf"),
  addEntry: $("add-entry"),
  debugOutput: $("debug-output"),
  jsonOutput: $("json-output"),
  filenamePreview: $("filename-preview"),
  authorLast: $("author-last"),
  authorFirst: $("author-first"),
  title: $("work-title"),
  oclc: $("oclc"),
  healthCheck: $("health-check"),
};

function addProgress(message) {
  const item = document.createElement("li");
  item.textContent = message;
  els.progressLog.appendChild(item);
  item.scrollIntoView({ block: "nearest" });
}

function resetProgress(message) {
  els.progressLog.innerHTML = "";
  addProgress(message);
}

function normalizeDropboxUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("dropbox.com")) {
      parsed.searchParams.set("dl", "1");
      parsed.searchParams.delete("raw");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanFilenamePart(value) {
  return (value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseFromSlug(value) {
  return (value || "")
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop() || "document.pdf";
    return decodeURIComponent(segment);
  } catch {
    return "document.pdf";
  }
}

function inferMetadataFromName(name) {
  const base = titleCaseFromSlug(name);
  const oclcMatch = base.match(/\b(?:oclc|ocn)?\s*(\d{6,})\b/i);
  if (oclcMatch && !els.oclc.value.trim()) {
    els.oclc.value = oclcMatch[1];
  }

  const withoutOclc = base
    .replace(/\b(?:oclc|ocn)?\s*\d{6,}\b/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!els.title.value.trim()) {
    const commaParts = withoutOclc.split(",").map((part) => part.trim()).filter(Boolean);
    if (commaParts.length >= 3) {
      if (!els.authorLast.value.trim()) els.authorLast.value = commaParts[0];
      if (!els.authorFirst.value.trim()) els.authorFirst.value = commaParts[1];
      els.title.value = commaParts.slice(2).join(", ");
    } else {
      els.title.value = withoutOclc || base || "Untitled";
    }
  }
  updateFilenamePreview();
}

function buildOutputFilename() {
  const last = cleanFilenamePart(els.authorLast.value);
  const first = cleanFilenamePart(els.authorFirst.value);
  const title = cleanFilenamePart(els.title.value) || cleanFilenamePart(state.pdfName.replace(/\.pdf$/i, "")) || "Untitled";
  const oclc = cleanFilenamePart(els.oclc.value);

  const pieces = [];
  if (last) pieces.push(last);
  if (first) pieces.push(first);
  pieces.push(title);
  if (oclc) pieces.push(`OCLC ${oclc}`);

  return `${pieces.join(", ")}.pdf`;
}

function updateFilenamePreview() {
  els.filenamePreview.textContent = buildOutputFilename();
}

function setBackendStatus(text, kind = "neutral") {
  els.backendStatus.textContent = text;
  els.backendStatus.className = `status-pill ${kind}`;
}

function requestHeaders() {
  const token = els.bearerToken.value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function checkBackend() {
  setBackendStatus("Checking...", "neutral");
  const base = els.backendUrl.value.replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/health`, { headers: requestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    setBackendStatus("Backend ready", "ok");
    addProgress(`Backend health ok: ${text.slice(0, 100)}`);
  } catch (error) {
    setBackendStatus("Backend check failed", "error");
    addProgress(`Backend health failed: ${error.message}`);
  }
}

async function fetchPdfBytes(url) {
  const normalized = normalizeDropboxUrl(url);
  const proxy = els.proxyUrl.value.trim();
  const downloadUrl = proxy ? `${proxy}${encodeURIComponent(normalized)}` : normalized;
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  const head = new TextDecoder().decode(buffer.slice(0, Math.min(64, buffer.byteLength))).trim().toLowerCase();
  if (contentType.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new Error("Downloaded HTML instead of a PDF. Use a direct Dropbox file link or configure a PDF proxy.");
  }
  return buffer;
}

async function analyzeSource() {
  const base = els.backendUrl.value.replace(/\/+$/, "");
  const form = new FormData();
  form.append("max_pages", "100");
  form.append("skip_bookmarks", "false");

  const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
  if (!normalizedUrl) throw new Error("Paste a Dropbox PDF link first.");
  state.pdfUrl = normalizedUrl;
  state.pdfName = filenameFromUrl(normalizedUrl);
  form.append("pdf_url", normalizedUrl);

  state.startedAt = new Date();
  const response = await fetch(`${base}/analyze-pdf-ai`, {
    method: "POST",
    headers: requestHeaders(),
    body: form,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Backend returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  return data;
}

function setEntries(entries) {
  els.entriesBody.innerHTML = "";
  (entries || []).forEach((entry) => addEntryRow(entry));
  updateEntryCount();
}

function addEntryRow(entry = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input class="entry-title" type="text"></td>
    <td class="page-cell"><input class="entry-page" type="text"></td>
    <td class="level-cell"><input class="entry-level" type="number" min="0" step="1"></td>
    <td><button class="remove-row" type="button" aria-label="Remove row">x</button></td>
  `;
  row.querySelector(".entry-title").value = entry.title || "";
  row.querySelector(".entry-page").value = entry.page || "";
  row.querySelector(".entry-level").value = Number.isFinite(entry.level) ? entry.level : (entry.level || 0);
  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    updateEntryCount();
  });
  els.entriesBody.appendChild(row);
}

function getEntriesFromTable() {
  return [...els.entriesBody.querySelectorAll("tr")]
    .map((row) => ({
      title: row.querySelector(".entry-title").value.trim(),
      page: row.querySelector(".entry-page").value.trim(),
      level: parseInt(row.querySelector(".entry-level").value || "0", 10) || 0,
    }))
    .filter((entry) => entry.title && entry.page);
}

function updateEntryCount() {
  els.entryCount.textContent = String(getEntriesFromTable().length);
}

function romanToInt(value) {
  const numerals = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  let prev = 0;
  [...(value || "").toLowerCase()].reverse().forEach((char) => {
    const current = numerals[char] || 0;
    total += current < prev ? -current : current;
    prev = current;
  });
  return total || null;
}

function entryToPageIndex(entry, analysis, pageCount) {
  const page = (entry.page || "").trim().toLowerCase();
  if (page.startsWith("pdf:")) {
    return parseInt(page.split(":")[1], 10) - 1;
  }
  if (/^[ivxlcdm]+$/.test(page)) {
    const roman = romanToInt(page);
    const romanStart = analysis?.roman_start_pdf_page || 1;
    const romanFirst = analysis?.roman_first_page_number || 1;
    return roman == null ? -1 : romanStart + roman - romanFirst - 1;
  }
  const printed = parseInt(page, 10);
  if (!Number.isFinite(printed)) return -1;
  const contentStart = analysis?.content_start_pdf_page || analysis?.arabic_start_pdf_page || 1;
  const firstPage = analysis?.first_page_number || 1;
  const index = contentStart + printed - firstPage - 1;
  return index >= 0 && index < pageCount ? index : -1;
}

async function ensurePdfBytes() {
  if (state.pdfBytes) return state.pdfBytes;
  if (!state.pdfUrl) throw new Error("The PDF bytes are not loaded yet. Re-run analysis with a Dropbox link.");
  addProgress("Downloading PDF for bookmark creation...");
  state.pdfBytes = await fetchPdfBytes(state.pdfUrl);
  return state.pdfBytes;
}

async function createBookmarkedPdf() {
  const entries = getEntriesFromTable();
  if (!entries.length) throw new Error("No bookmark rows are available.");
  const pdfBytes = await ensurePdfBytes();
  const { PDFDocument, PDFHexString, PDFName } = PDFLib;
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pageCount = pdfDoc.getPageCount();
  const validEntries = entries
    .map((entry) => ({ ...entry, pageIndex: entryToPageIndex(entry, state.analysis, pageCount) }))
    .filter((entry) => entry.pageIndex >= 0 && entry.pageIndex < pageCount);

  if (!validEntries.length) throw new Error("No entries resolved to valid PDF pages.");

  const context = pdfDoc.context;
  const outlineRef = context.nextRef();
  const outlineItems = validEntries.map((entry) => ({ ...entry, ref: context.nextRef() }));

  outlineItems.forEach((entry, index) => {
    const page = pdfDoc.getPage(entry.pageIndex);
    const prev = index > 0 ? outlineItems[index - 1].ref : null;
    const next = index < outlineItems.length - 1 ? outlineItems[index + 1].ref : null;
    const item = context.obj({
      Title: PDFHexString.fromText(entry.title),
      Parent: outlineRef,
      ...(prev ? { Prev: prev } : {}),
      ...(next ? { Next: next } : {}),
      Dest: [page.ref, "XYZ", null, null, null],
    });
    context.assign(entry.ref, item);
  });

  context.assign(outlineRef, context.obj({
    Type: "Outlines",
    First: outlineItems[0].ref,
    Last: outlineItems[outlineItems.length - 1].ref,
    Count: outlineItems.length,
  }));

  pdfDoc.catalog.set(PDFName.of("Outlines"), outlineRef);
  pdfDoc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));

  const output = await pdfDoc.save();
  const blob = new Blob([output], { type: "application/pdf" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = buildOutputFilename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  return outlineItems.length;
}

function buildDebugBundle() {
  const analysis = state.analysis || {};
  const entries = getEntriesFromTable();
  return [
    "source=dropbox_url",
    `pdf_name=${state.pdfName || ""}`,
    `pdf_url=${state.pdfUrl || ""}`,
    `backend=${els.backendUrl.value.trim()}`,
    `output_filename=${buildOutputFilename()}`,
    `started_at=${state.startedAt ? state.startedAt.toISOString() : ""}`,
    `entries=${entries.length}`,
    `alignment_source=${analysis.alignment_source || ""}`,
    `alignment_confidence=${analysis.alignment_confidence || ""}`,
    `notes=${analysis.notes || ""}`,
    "",
    "progress:",
    ...[...els.progressLog.querySelectorAll("li")].map((li) => `- ${li.textContent}`),
    "",
    "entries:",
    ...entries.map((entry, index) => `${index + 1}. [${entry.page}] level ${entry.level} ${entry.title}`),
  ].join("\n");
}

function refreshDebug() {
  els.debugOutput.value = buildDebugBundle();
  els.jsonOutput.value = state.analysis ? JSON.stringify(state.analysis, null, 2) : "";
}

async function runAnalysis(event) {
  event?.preventDefault();
  resetProgress("Submitting PDF to backend...");
  els.createPdf.disabled = true;
  els.downloadState.textContent = "Analyzing";
  try {
    const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
    state.pdfUrl = normalizedUrl;
    state.pdfName = filenameFromUrl(normalizedUrl);
    state.pdfBytes = null;
    inferMetadataFromName(state.pdfName);

    state.analysis = await analyzeSource();
    setEntries(state.analysis.entries || []);
    els.alignmentStatus.textContent = `${state.analysis.alignment_source || "unknown"} / ${state.analysis.alignment_confidence || "unknown"}`;
    els.downloadState.textContent = "Ready to create PDF";
    els.createPdf.disabled = false;
    addProgress(`Analysis complete: ${getEntriesFromTable().length} entries.`);
    (state.analysis.progress || []).forEach((message) => addProgress(message));
  } catch (error) {
    els.downloadState.textContent = "Analysis failed";
    addProgress(`Error: ${error.message}`);
  } finally {
    refreshDebug();
  }
}

async function copyTextFromTarget(targetId) {
  const target = $(targetId);
  const text = target.value !== undefined ? target.value : target.textContent;
  await navigator.clipboard.writeText(text || "");
}

document.addEventListener("DOMContentLoaded", () => {
  [els.authorLast, els.authorFirst, els.title, els.oclc].forEach((input) => {
    input.addEventListener("input", updateFilenamePreview);
  });

  els.url.addEventListener("input", () => {
    const name = filenameFromUrl(els.url.value.trim());
    if (name && name !== "document.pdf") {
      state.pdfName = name;
      inferMetadataFromName(name);
    }
  });

  els.form.addEventListener("submit", runAnalysis);
  els.healthCheck.addEventListener("click", checkBackend);

  els.addEntry.addEventListener("click", () => {
    addEntryRow({ title: "", page: "", level: 0 });
    updateEntryCount();
    refreshDebug();
  });

  els.entriesBody.addEventListener("input", () => {
    updateEntryCount();
    refreshDebug();
  });

  els.createPdf.addEventListener("click", async () => {
    els.downloadState.textContent = "Creating PDF";
    addProgress("Creating bookmarked PDF in browser...");
    try {
      const count = await createBookmarkedPdf();
      els.downloadState.textContent = `Downloaded ${count} bookmarks`;
      addProgress(`Download started with ${count} bookmarks.`);
    } catch (error) {
      els.downloadState.textContent = "PDF creation failed";
      addProgress(`PDF creation error: ${error.message}`);
    } finally {
      refreshDebug();
    }
  });

  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyTextFromTarget(button.dataset.copyTarget);
      const oldText = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = oldText;
      }, 900);
    });
  });

  updateFilenamePreview();
});
