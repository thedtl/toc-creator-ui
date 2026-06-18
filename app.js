const state = {
  pdfBytes: null,
  pdfName: "",
  pdfUrl: "",
  analysis: null,
  analysisJobId: null,
  lastProgressCount: 0,
  startedAt: null,
  previewDoc: null,
  previewPage: 1,
  previewPageCount: 0,
  previewAutoloadTimer: null,
  previewLoadId: 0,
  pdfBytesUrl: "",
  analysisRunId: 0,
  feedbackOutcome: "",
  feedbackIssues: [],
};

const WORKER_URL = "https://dtl-chapter-request.ccrawford.workers.dev";
const PDFJS_WORKER_URL = "./vendor/pdf.worker.min.js?v=3.11.174";
const JOB_POLL_INTERVAL_MS = 2500;
const JOB_TIMEOUT_MS = 45 * 60 * 1000;
const JOB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const PREVIEW_AUTOLOAD_DELAY_MS = 650;

function createStaleAnalysisError() {
  const error = new Error("Analysis was reset.");
  error.name = "StaleAnalysisRun";
  return error;
}

function assertAnalysisRunActive(runId) {
  if (state.analysisRunId !== runId) {
    throw createStaleAnalysisError();
  }
}

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
}

const $ = (id) => document.getElementById(id);

const els = {
  form: $("toc-form"),
  url: $("pdf-url"),
  staffPassword: $("staff-password"),
  passwordSaved: $("password-saved"),
  accessStatus: $("access-status"),
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
  mmsId: $("mms-id"),
  oclc: $("oclc"),
  healthCheck: $("health-check"),
  resetTool: $("reset-tool"),
  loadPreview: $("load-preview"),
  openSource: $("open-source"),
  previewPrev: $("preview-prev"),
  previewNext: $("preview-next"),
  previewPage: $("preview-page"),
  previewPageCount: $("preview-page-count"),
  previewStatus: $("preview-status"),
  previewFrame: $("preview-frame"),
  previewCanvas: $("preview-canvas"),
  previewEmpty: $("preview-empty"),
  learningRunId: $("learning-run-id"),
  learningRoute: $("learning-route"),
  learningTokens: $("learning-tokens"),
  feedbackState: $("feedback-state"),
  feedbackOptions: $("feedback-options"),
  feedbackNote: $("feedback-note"),
  feedbackIssues: $("feedback-issues"),
  clearFeedbackIssues: $("clear-feedback-issues"),
  saveFeedback: $("save-feedback"),
};

function addProgress(message) {
  const item = document.createElement("li");
  item.textContent = message;
  els.progressLog.appendChild(item);
  item.scrollIntoView({ block: "nearest" });
}

function resetProgress(message) {
  els.progressLog.innerHTML = "";
  state.lastProgressCount = 0;
  addProgress(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncProgressMessages(messages = []) {
  if (!Array.isArray(messages)) return;
  messages.slice(state.lastProgressCount).forEach((message) => addProgress(message));
  state.lastProgressCount = Math.max(state.lastProgressCount, messages.length);
}

function elapsedSeconds() {
  if (!state.startedAt) return 0;
  return Math.max(0, Math.round((Date.now() - state.startedAt.getTime()) / 1000));
}

function updateJobStatusText(status) {
  const label = status === "succeeded"
    ? "Analysis complete"
    : status === "failed"
      ? "Analysis failed"
      : status === "queued"
        ? "Queued"
        : "Analyzing";
  els.downloadState.textContent = `${label} (${elapsedSeconds()}s)`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toLocaleString() : "unknown";
}

function currentRunId() {
  return state.analysis?.run_id || state.analysisJobId || "";
}

function routeSummary(analysis = state.analysis) {
  const progress = Array.isArray(analysis?.progress) ? analysis.progress.join("\n").toLowerCase() : "";
  if (progress.includes("skipping front toc scan")) return "back first, front skipped";
  if (progress.includes("toc found in back pages")) return "back ToC";
  if (progress.includes("toc found in front pages")) return "front ToC";
  return analysis ? "unknown" : "not run";
}

function resetFeedbackState() {
  state.feedbackOutcome = "";
  state.feedbackIssues = [];
  if (els.feedbackNote) els.feedbackNote.value = "";
  if (els.feedbackState) els.feedbackState.textContent = "No feedback saved";
  document.querySelectorAll("#feedback-options button").forEach((button) => {
    button.classList.remove("active");
  });
  renderFeedbackIssues();
  updateLearningPanel();
}

function rowMatchesFeedbackIssue(row, issue) {
  const title = row.querySelector(".entry-title").value.trim();
  const currentPage = row.querySelector(".entry-page").value.trim();
  const originalPage = row.dataset.originalPage || currentPage;
  return issue.title === title && issue.returned_page === originalPage;
}

function syncFlagButtons() {
  document.querySelectorAll("#entries-body tr").forEach((row) => {
    const flagged = state.feedbackIssues.some((issue) => rowMatchesFeedbackIssue(row, issue));
    row.querySelector(".flag-row")?.classList.toggle("flagged", flagged);
  });
}

function updateLearningPanel() {
  const analysis = state.analysis;
  const runId = currentRunId();
  const usage = analysis?.gemini_usage || {};
  const totalTokens = usage.tokens?.total_token_count;
  els.learningRunId.textContent = runId ? runId.slice(0, 12) : "none";
  els.learningRunId.title = runId || "";
  els.learningRoute.textContent = routeSummary(analysis);
  els.learningTokens.textContent = formatNumber(totalTokens);
  els.saveFeedback.disabled = !runId;
}

function renderFeedbackIssues() {
  if (!els.feedbackIssues) return;
  els.feedbackIssues.innerHTML = "";
  if (!state.feedbackIssues.length) {
    const empty = document.createElement("li");
    empty.className = "empty-issue";
    empty.textContent = "No rows flagged.";
    els.feedbackIssues.appendChild(empty);
    syncFlagButtons();
    return;
  }

  state.feedbackIssues.forEach((issue, index) => {
    const item = document.createElement("li");
    item.className = "issue-row";
    item.innerHTML = `
      <input class="issue-title" type="text" aria-label="Flagged title">
      <input class="issue-returned" type="text" aria-label="Returned page">
      <input class="issue-correct" type="text" aria-label="Correct page">
      <button class="remove-issue" type="button" aria-label="Remove flagged row">x</button>
    `;
    item.querySelector(".issue-title").value = issue.title || "";
    item.querySelector(".issue-returned").value = issue.returned_page || "";
    item.querySelector(".issue-correct").value = issue.correct_page || "";
    item.querySelector(".issue-title").addEventListener("input", (event) => {
      state.feedbackIssues[index].title = event.target.value;
    });
    item.querySelector(".issue-returned").addEventListener("input", (event) => {
      state.feedbackIssues[index].returned_page = event.target.value;
    });
    item.querySelector(".issue-correct").addEventListener("input", (event) => {
      state.feedbackIssues[index].correct_page = event.target.value;
    });
    item.querySelector(".remove-issue").addEventListener("click", () => {
      state.feedbackIssues.splice(index, 1);
      renderFeedbackIssues();
      refreshDebug();
    });
    els.feedbackIssues.appendChild(item);
  });
  syncFlagButtons();
}

function flagEntryRow(row) {
  const title = row.querySelector(".entry-title").value.trim();
  const currentPage = row.querySelector(".entry-page").value.trim();
  const originalPage = row.dataset.originalPage || currentPage;
  const existing = state.feedbackIssues.find((issue) => issue.title === title && issue.returned_page === originalPage);
  if (existing) {
    existing.correct_page = currentPage;
  } else {
    state.feedbackIssues.push({
      issue_type: "wrong_page",
      title,
      returned_page: originalPage,
      correct_page: currentPage,
      note: "",
    });
  }
  if (!state.feedbackOutcome) setFeedbackOutcome("wrong_pages");
  renderFeedbackIssues();
}

function setFeedbackOutcome(outcome) {
  state.feedbackOutcome = outcome || "";
  document.querySelectorAll("#feedback-options button").forEach((button) => {
    button.classList.toggle("active", button.dataset.outcome === state.feedbackOutcome);
  });
}

function feedbackResultSummary() {
  const analysis = state.analysis || {};
  const usage = analysis.gemini_usage || {};
  return {
    entries: getEntriesFromTable().length,
    original_entries: Array.isArray(analysis.entries) ? analysis.entries.length : 0,
    notes: analysis.notes || "",
    alignment_source: analysis.alignment_source || "",
    alignment_confidence: analysis.alignment_confidence || "",
    route: routeSummary(analysis),
    total_token_count: Number(usage.tokens?.total_token_count || 0),
    calls: Number(usage.calls || 0),
    images: Number(usage.images || 0),
    wall_ms: Number(usage.wall_ms || 0),
  };
}

async function saveRunFeedback() {
  const runId = currentRunId();
  if (!runId) throw new Error("No completed run is available.");
  const password = requireStaffPassword();
  const response = await fetch(`${WORKER_URL}/toc/run-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      run_id: runId,
      outcome: state.feedbackOutcome || (state.feedbackIssues.length ? "wrong_pages" : "good"),
      note: els.feedbackNote.value.trim(),
      issues: state.feedbackIssues,
      edited_entries: getEntriesFromTable(),
      result_summary: feedbackResultSummary(),
    }),
  });
  const result = await parseJsonResponse(response, "Worker");
  if (!result.ok) throw new Error(result.error || "Feedback was not saved.");
  els.feedbackState.textContent = "Feedback saved";
  addProgress(`Feedback saved for run ${runId.slice(0, 12)}.`);
  return result;
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

function isPreviewableDropboxPdfUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("dropbox.com") && parsed.pathname.toLowerCase().includes(".pdf");
  } catch {
    return false;
  }
}

function cleanFilenamePart(value) {
  return (value || "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
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

function stripBookmarkedSuffix(value) {
  return (value || "")
    .replace(/\s*\[bookmarked\]\s*$/i, "")
    .replace(/\s*\(bookmarked\)\s*$/i, "")
    .trim();
}

function normalizeIdentifier(value) {
  return cleanFilenamePart(value)
    .replace(/\b(?:mms\s*id|oclc|ocn)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFilenameIdentifiers(value) {
  let text = value || "";
  let mmsId = "";
  let oclc = "";

  text = text.replace(/\b(?:oclc|ocn)\b[\s:#-]*(\d{6,})\b/gi, (match, id) => {
    if (!oclc) oclc = id;
    return " ";
  });

  text = text.replace(/\bmms\s*id\b[\s:#-]*([A-Z0-9]+(?:\s+[A-Z0-9]+){0,3})\b/gi, (match, id) => {
    if (!mmsId) mmsId = normalizeIdentifier(id);
    return " ";
  });

  text = text.replace(/\b\d{6,}\b/g, (id) => {
    if (!mmsId && id.length >= 13) {
      mmsId = id;
      return " ";
    }
    if (!oclc && id.length < 13) {
      oclc = id;
      return " ";
    }
    return id;
  });

  return {
    text: text.replace(/\s+/g, " ").trim(),
    mmsId,
    oclc,
  };
}

function stripFilenameFormatTail(value) {
  return (value || "")
    .replace(/\b(?:ebook|e-book|pdf)\b(?:\s+e)?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTrailingAuthor(value) {
  const tokens = (value || "").split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;

  const isInitial = (token) => /^\p{L}\.$/u.test(token) || /^[A-Za-z]$/u.test(token);
  const isNamePart = (token) => /^\p{L}[\p{L}\p{M}'’.-]*$/u.test(token);
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (!isNamePart(last) || !(isNamePart(prev) || isInitial(prev))) return null;

  let authorStart = tokens.length - 2;
  if (tokens.length >= 4 && isInitial(prev) && isNamePart(tokens[tokens.length - 3])) {
    authorStart = tokens.length - 3;
  }

  const titleTokens = tokens.slice(0, authorStart);
  if (!titleTokens.length) return null;
  const authorTokens = tokens.slice(authorStart);
  return {
    title: titleTokens.join(" "),
    first: authorTokens.slice(0, -1).join(" "),
    last: authorTokens[authorTokens.length - 1],
  };
}

function splitTitleAuthor(value) {
  const cleaned = stripBookmarkedSuffix(value).replace(/\s+/g, " ").trim();
  const editionMatch = cleaned.match(/^(.*?\b\d+(?:st|nd|rd|th)?\s+ed\.)\s+(.+)$/i);
  if (editionMatch) {
    const author = splitTrailingAuthor(`Title ${editionMatch[2]}`);
    if (author) {
      return {
        title: editionMatch[1],
        first: author.first,
        last: author.last,
      };
    }
  }
  return splitTrailingAuthor(cleaned);
}

function inferMetadataFromName(name) {
  const base = stripBookmarkedSuffix(titleCaseFromSlug(name));
  const inferred = extractFilenameIdentifiers(base);
  if (inferred.oclc && !els.oclc.value.trim()) {
    els.oclc.value = inferred.oclc;
  }
  if (inferred.mmsId && !els.mmsId.value.trim()) {
    els.mmsId.value = inferred.mmsId;
  }

  const withoutIdentifiers = stripFilenameFormatTail(inferred.text);

  const commaParts = withoutIdentifiers.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 3) {
    if (!els.authorLast.value.trim()) els.authorLast.value = commaParts[0];
    if (!els.authorFirst.value.trim()) els.authorFirst.value = commaParts[1];
    if (!els.title.value.trim()) els.title.value = commaParts.slice(2).join(", ");
  } else {
    const parsed = splitTitleAuthor(withoutIdentifiers);
    if (parsed) {
      if (!els.authorLast.value.trim()) els.authorLast.value = parsed.last;
      if (!els.authorFirst.value.trim()) els.authorFirst.value = parsed.first;
      if (!els.title.value.trim()) els.title.value = parsed.title;
    } else if (!els.title.value.trim()) {
      els.title.value = withoutIdentifiers || base || "Untitled";
    }
  }
  updateFilenamePreview();
}

function buildOutputFilename() {
  const last = cleanFilenamePart(els.authorLast.value);
  const first = cleanFilenamePart(els.authorFirst.value);
  const title = cleanFilenamePart(els.title.value) || cleanFilenamePart(state.pdfName.replace(/\.pdf$/i, "")) || "Untitled";
  const mmsId = normalizeIdentifier(els.mmsId.value);
  const oclc = cleanFilenamePart(els.oclc.value);
  const author = last && first ? `${last}, ${first}` : (last || first);
  const identifiers = [];
  if (mmsId) identifiers.push(`MMS ID ${mmsId}`);
  if (oclc) identifiers.push(`OCLC ${oclc}`);
  const pieces = [author, title, identifiers.join(", ")].filter(Boolean);
  let base = pieces.join(". ").replace(/\.\s*\./g, ".").trim();
  base = base.replace(/\s+\./g, ".").replace(/\s+/g, " ");

  return `${base} [Bookmarked].pdf`;
}

function updateFilenamePreview() {
  els.filenamePreview.textContent = buildOutputFilename();
}

function setAccessStatus(text, kind = "neutral") {
  els.accessStatus.textContent = text;
  els.accessStatus.className = `status-pill ${kind}`;
}

function setPreviewStatus(text, kind = "neutral") {
  els.previewStatus.textContent = text;
  els.previewStatus.className = `preview-status ${kind}`;
}

function updatePreviewControls() {
  const ready = Boolean(state.previewDoc && state.previewPageCount);
  els.previewPage.disabled = !ready;
  els.previewPrev.disabled = !ready || state.previewPage <= 1;
  els.previewNext.disabled = !ready || state.previewPage >= state.previewPageCount;
  els.previewPageCount.textContent = String(state.previewPageCount || 0);
  els.previewPage.max = state.previewPageCount || 1;
  els.previewPage.value = String(state.previewPage || 1);
}

function updateSourceLink() {
  const rawUrl = els.url.value.trim();
  if (!rawUrl) {
    els.openSource.href = "#";
    els.openSource.classList.add("disabled-link");
    return;
  }
  els.openSource.href = normalizeDropboxUrl(rawUrl);
  els.openSource.classList.remove("disabled-link");
}

function getStaffPassword() {
  return els.staffPassword.value;
}

function requireStaffPassword() {
  const password = getStaffPassword();
  if (!password) {
    els.staffPassword.focus();
    throw new Error("Enter the staff password first.");
  }
  return password;
}

async function parseJsonResponse(response, context) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${context} returned non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function checkAccess() {
  setAccessStatus("Checking...", "neutral");
  try {
    const password = requireStaffPassword();
    const response = await fetch(`${WORKER_URL}/toc/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    await parseJsonResponse(response, "Worker");
    setAccessStatus("Access ready", "ok");
    addProgress("Staff password accepted.");
  } catch (error) {
    setAccessStatus("Access failed", "error");
    addProgress(`Access check failed: ${error.message}`);
  }
}

async function getProtectedPdfUrl(dropboxUrl) {
  const password = requireStaffPassword();
  const params = new URLSearchParams({
    password,
    dropbox: normalizeDropboxUrl(dropboxUrl),
    start: "1",
    end: "99999",
    expires: "0",
  });
  const response = await fetch(`${WORKER_URL}/sign?${params.toString()}`);
  const data = await parseJsonResponse(response, "PDF proxy");
  if (!data.token) throw new Error("PDF proxy did not return a token.");
  return `${WORKER_URL}/?token=${encodeURIComponent(data.token)}`;
}

async function fetchPdfBytes(url) {
  const downloadUrl = await getProtectedPdfUrl(url);
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

async function destroyPreviewDoc() {
  if (state.previewDoc) {
    try {
      await state.previewDoc.destroy();
    } catch {
      // PDF.js cleanup can fail after a partially loaded document; replacement can continue.
    }
  }
  state.previewDoc = null;
}

async function resetPreview(message = "Paste a Dropbox PDF link to preview it.") {
  state.previewLoadId += 1;
  await destroyPreviewDoc();
  state.previewPage = 1;
  state.previewPageCount = 0;
  els.previewCanvas.hidden = true;
  els.previewEmpty.hidden = false;
  setPreviewStatus(message);
  updatePreviewControls();
}

async function renderPreviewPage(pageNumber) {
  if (!state.previewDoc) throw new Error("Load the PDF preview first.");
  const safePage = Math.max(1, Math.min(state.previewPageCount, parseInt(pageNumber, 10) || 1));
  state.previewPage = safePage;
  updatePreviewControls();
  setPreviewStatus(`Rendering page ${safePage}...`);

  const page = await state.previewDoc.getPage(safePage);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(280, els.previewFrame.clientWidth - 36);
  const availableHeight = Math.max(320, els.previewFrame.clientHeight - 36);
  const scale = Math.max(
    0.2,
    Math.min(2, availableWidth / baseViewport.width, availableHeight / baseViewport.height)
  );
  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio || 1;
  const canvas = els.previewCanvas;
  const context = canvas.getContext("2d");

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  context.clearRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: context, viewport }).promise;
  els.previewCanvas.hidden = false;
  els.previewEmpty.hidden = true;
  setPreviewStatus(`Showing page ${safePage} of ${state.previewPageCount}.`, "ok");
  updatePreviewControls();
}

async function loadPreviewDocument(targetPage = 1) {
  const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
  if (!normalizedUrl) throw new Error("Paste a Dropbox PDF link first.");
  if (!window.pdfjsLib) throw new Error("PDF preview library did not load.");
  const loadId = ++state.previewLoadId;

  state.pdfUrl = normalizedUrl;
  state.pdfName = filenameFromUrl(normalizedUrl);
  inferMetadataFromName(state.pdfName);
  updateSourceLink();

  setPreviewStatus("Loading PDF preview...");
  els.loadPreview.disabled = true;
  try {
    if (!state.pdfBytes || state.pdfBytesUrl !== state.pdfUrl) {
      addProgress("Downloading PDF for preview...");
      const pdfBytes = await fetchPdfBytes(state.pdfUrl);
      if (loadId !== state.previewLoadId) return;
      state.pdfBytes = pdfBytes;
      state.pdfBytesUrl = state.pdfUrl;
    }

    if (loadId !== state.previewLoadId) return;
    await destroyPreviewDoc();
    const loadingTask = window.pdfjsLib.getDocument({
      data: state.pdfBytes.slice(0),
      disableRange: true,
      disableStream: true,
    });
    state.previewDoc = await loadingTask.promise;
    if (loadId !== state.previewLoadId) return;
    state.previewPageCount = state.previewDoc.numPages;
    await renderPreviewPage(targetPage);
    addProgress(`PDF preview loaded (${state.previewPageCount} pages).`);
  } finally {
    els.loadPreview.disabled = false;
  }
}

async function ensurePreviewDocument() {
  if (!state.previewDoc) {
    await loadPreviewDocument();
  }
  if (!state.previewDoc) throw new Error("PDF preview is still loading. Try again in a moment.");
  return state.previewDoc;
}

function clearPreviewAutoload() {
  if (state.previewAutoloadTimer) {
    clearTimeout(state.previewAutoloadTimer);
    state.previewAutoloadTimer = null;
  }
}

async function autoLoadPreview() {
  const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
  if (!getStaffPassword() || !isPreviewableDropboxPdfUrl(normalizedUrl)) return;
  if (state.previewDoc && state.pdfUrl === normalizedUrl) return;

  try {
    await loadPreviewDocument();
  } catch (error) {
    setPreviewStatus(error.message, "error");
    addProgress(`Auto-preview error: ${error.message}`);
  }
}

function schedulePreviewAutoload(delay = PREVIEW_AUTOLOAD_DELAY_MS) {
  clearPreviewAutoload();
  const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
  if (!getStaffPassword() || !isPreviewableDropboxPdfUrl(normalizedUrl)) return;
  state.previewAutoloadTimer = setTimeout(() => {
    state.previewAutoloadTimer = null;
    autoLoadPreview();
  }, delay);
}

async function startAnalysisJob() {
  const password = requireStaffPassword();
  const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
  if (!normalizedUrl) throw new Error("Paste a Dropbox PDF link first.");
  state.pdfUrl = normalizedUrl;
  state.pdfName = filenameFromUrl(normalizedUrl);

  const response = await fetch(`${WORKER_URL}/toc/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      pdf_url: normalizedUrl,
      max_pages: 100,
      skip_bookmarks: false,
    }),
  });
  return parseJsonResponse(response, "Worker");
}

async function getAnalysisJob(jobId) {
  const password = requireStaffPassword();
  const response = await fetch(`${WORKER_URL}/toc/job-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, job_id: jobId }),
  });
  return parseJsonResponse(response, "Worker");
}

async function analyzeSource(runId) {
  assertAnalysisRunActive(runId);
  state.startedAt = new Date();
  addProgress("Starting protected analysis job...");
  const started = await startAnalysisJob();
  const jobId = started.job_id;
  if (!jobId) throw new Error("Worker did not return a job ID.");
  if (state.analysisRunId !== runId) {
    throw createStaleAnalysisError();
  }
  state.analysisJobId = jobId;

  syncProgressMessages(started.progress || []);
  updateJobStatusText(started.status || "queued");

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastActivityAt = Date.now();
  let lastSeenProgressCount = Array.isArray(started.progress) ? started.progress.length : 0;
  let lastSeenStatus = started.status || "queued";
  let latest = started;
  while (Date.now() < deadline) {
    if (latest.status === "succeeded") {
      syncProgressMessages(latest.progress || []);
      updateJobStatusText("succeeded");
      if (!latest.result) throw new Error("Analysis job finished without a result.");
      return latest.result;
    }
    if (latest.status === "failed") {
      syncProgressMessages(latest.progress || []);
      updateJobStatusText("failed");
      throw new Error(latest.error || "Analysis job failed.");
    }
    await delay(JOB_POLL_INTERVAL_MS);
    assertAnalysisRunActive(runId);
    latest = await getAnalysisJob(jobId);
    assertAnalysisRunActive(runId);
    const progressCount = Array.isArray(latest.progress) ? latest.progress.length : 0;
    const status = latest.status || "running";
    if (progressCount > lastSeenProgressCount || status !== lastSeenStatus) {
      lastActivityAt = Date.now();
      lastSeenProgressCount = progressCount;
      lastSeenStatus = status;
    }
    syncProgressMessages(latest.progress || []);
    updateJobStatusText(latest.status || "running");
    if (Date.now() - lastActivityAt > JOB_IDLE_TIMEOUT_MS) {
      throw new Error("Analysis stopped reporting progress for more than 30 minutes. Try again or check backend logs.");
    }
  }

  throw new Error("Analysis timed out after 45 minutes while waiting for job status.");
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
    <td class="row-actions">
      <button class="preview-row" type="button">Preview</button>
      <button class="flag-row" type="button">Flag</button>
      <button class="remove-row" type="button" aria-label="Remove row">x</button>
    </td>
  `;
  row.dataset.originalTitle = entry.title || "";
  row.dataset.originalPage = entry.page || "";
  row.querySelector(".entry-title").value = entry.title || "";
  row.querySelector(".entry-page").value = entry.page || "";
  row.querySelector(".entry-level").value = Number.isFinite(entry.level) ? entry.level : (entry.level || 0);
  row.querySelector(".preview-row").addEventListener("click", async () => {
    try {
      await ensurePreviewDocument();
      const rowEntry = {
        title: row.querySelector(".entry-title").value.trim(),
        page: row.querySelector(".entry-page").value.trim(),
        level: parseInt(row.querySelector(".entry-level").value || "0", 10) || 0,
      };
      const pageIndex = entryToPageIndex(rowEntry, state.analysis, state.previewPageCount);
      if (pageIndex < 0) throw new Error(`Could not map "${rowEntry.page}" to a PDF page.`);
      await renderPreviewPage(pageIndex + 1);
      addProgress(`Previewing "${rowEntry.title || "row"}" at PDF page ${pageIndex + 1}.`);
    } catch (error) {
      setPreviewStatus(error.message, "error");
      addProgress(`Preview error: ${error.message}`);
    }
  });
  row.querySelector(".flag-row").addEventListener("click", () => {
    flagEntryRow(row);
    refreshDebug();
  });
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
  if (!window.PDFLib) throw new Error("PDF creation library did not load. Refresh the page and try again.");
  const pdfBytes = await ensurePdfBytes();
  const { PDFDocument, PDFHexString, PDFName } = window.PDFLib;
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
  const usage = analysis.gemini_usage || {};
  return [
    "source=dropbox_url",
    `run_id=${currentRunId()}`,
    `route=${routeSummary(analysis)}`,
    `pdf_name=${state.pdfName || ""}`,
    `pdf_url=${state.pdfUrl || ""}`,
    `worker=${WORKER_URL}`,
    `output_filename=${buildOutputFilename()}`,
    `started_at=${state.startedAt ? state.startedAt.toISOString() : ""}`,
    `entries=${entries.length}`,
    `alignment_source=${analysis.alignment_source || ""}`,
    `alignment_confidence=${analysis.alignment_confidence || ""}`,
    `total_token_count=${usage.tokens?.total_token_count || ""}`,
    `feedback_outcome=${state.feedbackOutcome || ""}`,
    `flagged_issues=${state.feedbackIssues.length}`,
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

async function resetForNextPdf() {
  state.analysisRunId += 1;
  clearPreviewAutoload();
  state.pdfBytes = null;
  state.pdfBytesUrl = "";
  state.pdfName = "";
  state.pdfUrl = "";
  state.analysis = null;
  state.analysisJobId = null;
  state.lastProgressCount = 0;
  state.startedAt = null;

  els.url.value = "";
  [els.authorLast, els.authorFirst, els.title, els.mmsId, els.oclc].forEach((input) => {
    input.value = "";
  });
  setEntries([]);
  els.alignmentStatus.textContent = "not run";
  els.downloadState.textContent = "No output yet";
  els.createPdf.disabled = true;
  els.debugOutput.value = "";
  els.jsonOutput.value = "";
  els.loadPreview.disabled = false;
  resetFeedbackState();
  updateFilenamePreview();
  updateSourceLink();
  await resetPreview("Paste a Dropbox PDF link to preview it.");
  resetProgress("Ready for the next Dropbox link.");
}

async function runAnalysis(event) {
  event?.preventDefault();
  const runId = state.analysisRunId + 1;
  state.analysisRunId = runId;
  resetProgress("Preparing PDF analysis...");
  resetFeedbackState();
  els.createPdf.disabled = true;
  els.downloadState.textContent = "Starting";
  try {
    assertAnalysisRunActive(runId);
    const normalizedUrl = normalizeDropboxUrl(els.url.value.trim());
    const alreadyLoadedSource = state.pdfUrl === normalizedUrl && (state.previewDoc || state.pdfBytesUrl === normalizedUrl);
    state.pdfUrl = normalizedUrl;
    state.pdfName = filenameFromUrl(normalizedUrl);
    if (!alreadyLoadedSource) {
      state.pdfBytes = null;
      state.pdfBytesUrl = "";
      await resetPreview("Loading preview while analysis runs.");
    }
    state.analysisJobId = null;
    schedulePreviewAutoload(0);
    inferMetadataFromName(state.pdfName);

    state.analysis = await analyzeSource(runId);
    assertAnalysisRunActive(runId);
    setEntries(state.analysis.entries || []);
    els.alignmentStatus.textContent = `${state.analysis.alignment_source || "unknown"} / ${state.analysis.alignment_confidence || "unknown"}`;
    updateLearningPanel();
    els.downloadState.textContent = "Ready to create PDF";
    els.createPdf.disabled = false;
    addProgress(`Analysis complete: ${getEntriesFromTable().length} entries.`);
    syncProgressMessages(state.analysis.progress || []);
  } catch (error) {
    if (error.name === "StaleAnalysisRun") return;
    els.downloadState.textContent = "Analysis failed";
    addProgress(`Error: ${error.message}`);
  } finally {
    if (state.analysisRunId === runId) {
      refreshDebug();
    }
  }
}

async function copyTextFromTarget(targetId) {
  const target = $(targetId);
  const text = target.value !== undefined ? target.value : target.textContent;
  await navigator.clipboard.writeText(text || "");
}

document.addEventListener("DOMContentLoaded", () => {
  const savedPassword = sessionStorage.getItem("dtl_staff_password");
  if (savedPassword) {
    els.staffPassword.value = savedPassword;
    els.passwordSaved.hidden = false;
  }

  [els.authorLast, els.authorFirst, els.title, els.mmsId, els.oclc].forEach((input) => {
    input.addEventListener("input", updateFilenamePreview);
  });

  els.staffPassword.addEventListener("change", () => {
    if (els.staffPassword.value) {
      sessionStorage.setItem("dtl_staff_password", els.staffPassword.value);
      els.passwordSaved.hidden = false;
    } else {
      sessionStorage.removeItem("dtl_staff_password");
      els.passwordSaved.hidden = true;
      setAccessStatus("Access not checked", "neutral");
    }
    schedulePreviewAutoload();
  });

  els.url.addEventListener("input", () => {
    clearPreviewAutoload();
    state.pdfBytes = null;
    state.pdfBytesUrl = "";
    resetPreview("Loading preview for the updated Dropbox link.");
    updateSourceLink();
    const name = filenameFromUrl(els.url.value.trim());
    if (name && name !== "document.pdf") {
      state.pdfName = name;
      inferMetadataFromName(name);
    }
    schedulePreviewAutoload();
  });

  els.form.addEventListener("submit", runAnalysis);
  els.resetTool.addEventListener("click", () => {
    resetForNextPdf().catch((error) => {
      addProgress(`Reset error: ${error.message}`);
    });
  });
  els.healthCheck.addEventListener("click", checkAccess);
  els.loadPreview.addEventListener("click", async () => {
    try {
      await loadPreviewDocument();
    } catch (error) {
      setPreviewStatus(error.message, "error");
      addProgress(`Preview error: ${error.message}`);
    }
  });
  els.previewPrev.addEventListener("click", () => {
    renderPreviewPage(state.previewPage - 1).catch((error) => {
      setPreviewStatus(error.message, "error");
    });
  });
  els.previewNext.addEventListener("click", () => {
    renderPreviewPage(state.previewPage + 1).catch((error) => {
      setPreviewStatus(error.message, "error");
    });
  });
  els.previewPage.addEventListener("change", () => {
    renderPreviewPage(els.previewPage.value).catch((error) => {
      setPreviewStatus(error.message, "error");
    });
  });
  els.openSource.addEventListener("click", (event) => {
    if (els.openSource.classList.contains("disabled-link")) {
      event.preventDefault();
    }
  });

  els.addEntry.addEventListener("click", () => {
    addEntryRow({ title: "", page: "", level: 0 });
    updateEntryCount();
    refreshDebug();
  });

  els.entriesBody.addEventListener("input", () => {
    updateEntryCount();
    refreshDebug();
  });

  els.feedbackOptions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-outcome]");
    if (!button) return;
    setFeedbackOutcome(button.dataset.outcome);
    refreshDebug();
  });

  els.clearFeedbackIssues.addEventListener("click", () => {
    state.feedbackIssues = [];
    renderFeedbackIssues();
    refreshDebug();
  });

  els.saveFeedback.addEventListener("click", async () => {
    els.feedbackState.textContent = "Saving feedback";
    try {
      await saveRunFeedback();
    } catch (error) {
      els.feedbackState.textContent = "Feedback save failed";
      addProgress(`Feedback error: ${error.message}`);
    }
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
  updateSourceLink();
  resetFeedbackState();
  updatePreviewControls();
});
