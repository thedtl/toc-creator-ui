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
  feedbackSaveTimer: null,
  metadataSuggestion: null,
  metadataTouched: new Set(),
  metadataAutoValues: {},
};

const WORKER_URL = "https://dtl-chapter-reader-dropbox-lab.reference-dfe.workers.dev";
const PDFJS_WORKER_URL = "./vendor/pdf.worker.min.js?v=3.11.174";
const JOB_POLL_INTERVAL_MS = 2500;
const JOB_TIMEOUT_MS = 45 * 60 * 1000;
const JOB_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const JOB_POLL_RETRY_GRACE_MS = 5 * 60 * 1000;
const JOB_STILL_WORKING_NOTICE_MS = 2 * 60 * 1000;
const PREVIEW_AUTOLOAD_DELAY_MS = 650;
const CONTRIBUTOR_ROLES = {
  author: { label: "Author" },
  editor: { label: "Editor", primarySingle: "ed.", primaryPlural: "eds.", secondary: "Edited by" },
  compiler: { label: "Compiler", primarySingle: "comp.", primaryPlural: "comps.", secondary: "Compiled by" },
};
const CONTRIBUTOR_ROLE_ORDER = ["author", "editor", "compiler"];

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
  contributorsList: $("contributors-list"),
  addContributor: $("add-contributor"),
  title: $("work-title"),
  mmsId: $("mms-id"),
  oclc: $("oclc"),
  sourceCode: $("source-code"),
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
  els.progressLog.scrollTop = els.progressLog.scrollHeight;
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

function setFeedbackState(text, kind = "neutral") {
  if (!els.feedbackState) return;
  els.feedbackState.textContent = text;
  els.feedbackState.className = `feedback-state ${kind}`;
}

function resetFeedbackState() {
  state.feedbackOutcome = "";
  state.feedbackIssues = [];
  if (state.feedbackSaveTimer) {
    clearTimeout(state.feedbackSaveTimer);
    state.feedbackSaveTimer = null;
  }
  if (els.feedbackNote) els.feedbackNote.value = "";
  setFeedbackState("No feedback saved", "neutral");
  if (els.saveFeedback) els.saveFeedback.textContent = "Save feedback";
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
  setFeedbackState("Feedback saved and submitted.", "saved");
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

function normalizeSourceCode(value) {
  return cleanFilenamePart(value)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeContributorRole(role) {
  const cleaned = cleanFilenamePart(role).toLowerCase();
  return CONTRIBUTOR_ROLES[cleaned] ? cleaned : "author";
}

function normalizeContributor(contributor = {}) {
  return {
    role: normalizeContributorRole(contributor.role),
    last: cleanFilenamePart(contributor.last),
    first: cleanFilenamePart(contributor.first),
  };
}

function normalizeContributors(contributors = []) {
  return contributors
    .map(normalizeContributor)
    .filter((contributor) => contributor.last || contributor.first);
}

function contributorRows() {
  return Array.from(els.contributorsList.querySelectorAll(".contributor-row"));
}

function getContributorsFromForm() {
  return normalizeContributors(contributorRows().map((row) => ({
    role: row.querySelector(".contributor-role").value,
    last: row.querySelector(".contributor-last").value,
    first: row.querySelector(".contributor-first").value,
  })));
}

function serializeContributors(contributors) {
  const normalized = normalizeContributors(contributors);
  return normalized.length ? JSON.stringify(normalized) : "";
}

function contributorName(contributor, invert = false) {
  const normalized = normalizeContributor(contributor);
  if (normalized.last && normalized.first) {
    return invert ? `${normalized.last}, ${normalized.first}` : `${normalized.first} ${normalized.last}`;
  }
  return normalized.last || normalized.first;
}

function joinContributorNames(contributors, invertFirst = true) {
  const names = normalizeContributors(contributors)
    .map((contributor, index) => contributorName(contributor, invertFirst && index === 0))
    .filter(Boolean);
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return invertFirst ? `${names[0]}, and ${names[1]}` : `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function primaryContributorCredit(role, contributors) {
  const names = joinContributorNames(contributors, true);
  if (!names) return "";
  const roleConfig = CONTRIBUTOR_ROLES[normalizeContributorRole(role)];
  if (!roleConfig?.primarySingle) return names;
  const suffix = normalizeContributors(contributors).length > 1 ? roleConfig.primaryPlural : roleConfig.primarySingle;
  return `${names}, ${suffix}`;
}

function secondaryContributorCredit(role, contributors) {
  const names = joinContributorNames(contributors, false);
  const label = CONTRIBUTOR_ROLES[normalizeContributorRole(role)]?.secondary;
  return names && label ? `${label} ${names}` : "";
}

function buildContributorCredits() {
  const contributors = getContributorsFromForm();
  const byRole = CONTRIBUTOR_ROLE_ORDER.reduce((groups, role) => {
    groups[role] = contributors.filter((contributor) => contributor.role === role);
    return groups;
  }, {});

  if (byRole.author.length) {
    return {
      primary: joinContributorNames(byRole.author, true),
      afterTitle: ["editor"]
        .map((role) => secondaryContributorCredit(role, byRole[role] || []))
        .filter(Boolean),
    };
  }

  const primaryRole = byRole.editor.length ? "editor" : (byRole.compiler.length ? "compiler" : "");
  if (!primaryRole) return { primary: "", afterTitle: [] };

  return {
    primary: primaryContributorCredit(primaryRole, byRole[primaryRole]),
    afterTitle: [],
  };
}

function markContributorsTouched() {
  state.metadataTouched.add("contributors");
  delete state.metadataAutoValues.contributors;
  updateFilenamePreview();
}

function contributorRoleOptions(selectedRole) {
  const selected = normalizeContributorRole(selectedRole);
  return CONTRIBUTOR_ROLE_ORDER.map((role) => {
    const isSelected = role === selected ? " selected" : "";
    return `<option value="${role}"${isSelected}>${CONTRIBUTOR_ROLES[role].label}</option>`;
  }).join("");
}

function addContributorRow(contributor = {}, options = {}) {
  const normalized = normalizeContributor(contributor);
  const row = document.createElement("div");
  row.className = "contributor-row";
  row.innerHTML = `
    <div class="input-stack">
      <label>Role</label>
      <select class="contributor-role" aria-label="Contributor role">${contributorRoleOptions(normalized.role)}</select>
    </div>
    <div class="input-stack">
      <label>Last name or full name</label>
      <input class="contributor-last" type="text" placeholder="Barth" aria-label="Last name or full name">
    </div>
    <div class="input-stack">
      <label>First name</label>
      <input class="contributor-first" type="text" placeholder="Karl" aria-label="First name">
    </div>
    <button class="remove-contributor" type="button" aria-label="Remove contributor">x</button>
  `;
  row.querySelector(".contributor-last").value = normalized.last;
  row.querySelector(".contributor-first").value = normalized.first;
  row.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", markContributorsTouched);
  });
  row.querySelector(".contributor-role").addEventListener("change", markContributorsTouched);
  row.querySelector(".remove-contributor").addEventListener("click", () => {
    row.remove();
    if (!contributorRows().length) {
      addContributorRow();
    }
    markContributorsTouched();
  });
  els.contributorsList.appendChild(row);
  if (options.focus) {
    row.querySelector(".contributor-last").focus();
  }
  return row;
}

function setContributorRows(contributors = [], options = {}) {
  els.contributorsList.innerHTML = "";
  const rows = contributors.length ? contributors : [{}];
  rows.forEach((contributor) => addContributorRow(contributor));
  if (options.auto) {
    state.metadataAutoValues.contributors = serializeContributors(getContributorsFromForm());
  }
}

function setContributorMetadata(contributors) {
  const normalized = normalizeContributors(contributors);
  if (!normalized.length) return false;
  const current = serializeContributors(getContributorsFromForm());
  const currentWasAuto = state.metadataAutoValues.contributors && current === state.metadataAutoValues.contributors;
  if (state.metadataTouched.has("contributors") && current) return false;
  if (current && !currentWasAuto) return false;
  setContributorRows(normalized, { auto: true });
  return true;
}

function clearContributorsIfAuto() {
  const current = serializeContributors(getContributorsFromForm());
  const currentWasAuto = state.metadataAutoValues.contributors && current === state.metadataAutoValues.contributors;
  if (state.metadataTouched.has("contributors") && current) return false;
  if (current && !currentWasAuto) return false;
  setContributorRows([{}]);
  delete state.metadataAutoValues.contributors;
  return true;
}

function isSourceCodeCandidate(value) {
  const code = normalizeSourceCode(value);
  if (!/[0-9]/.test(code)) return false;
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(code)) return false;
  const segments = code.split("-");
  return code.length <= 14 && segments.length <= 4 && segments.some((segment) => segment.length <= 2);
}

function addSourceCode(codes, value) {
  const code = normalizeSourceCode(value);
  if (code && isSourceCodeCandidate(code) && !codes.includes(code)) {
    codes.push(code);
  }
}

function metadataFieldElement(field) {
  return {
    title: els.title,
    mmsId: els.mmsId,
    oclc: els.oclc,
    sourceCode: els.sourceCode,
  }[field] || null;
}

function normalizeMetadataField(field, value) {
  if (field === "mmsId") return normalizeIdentifier(value);
  if (field === "sourceCode") return normalizeSourceCode(value);
  return cleanFilenamePart(value);
}

function setMetadataField(field, value) {
  const input = metadataFieldElement(field);
  const cleaned = normalizeMetadataField(field, value);
  if (!input || !cleaned) return false;

  const current = input.value.trim();
  const currentWasAuto = state.metadataAutoValues[field] && current === state.metadataAutoValues[field];
  if (state.metadataTouched.has(field) && current) return false;
  if (current && !currentWasAuto) return false;

  input.value = cleaned;
  state.metadataAutoValues[field] = cleaned;
  return true;
}

function clearMetadataFieldIfAuto(field) {
  const input = metadataFieldElement(field);
  if (!input) return false;
  const current = input.value.trim();
  const currentWasAuto = state.metadataAutoValues[field] && current === state.metadataAutoValues[field];
  if (state.metadataTouched.has(field) && current) return false;
  if (current && !currentWasAuto) return false;
  input.value = "";
  delete state.metadataAutoValues[field];
  return true;
}

function clearMetadataTracking() {
  state.metadataTouched.clear();
  state.metadataAutoValues = {};
}

function clearAutomaticMetadataFields() {
  clearContributorsIfAuto();
  ["title", "mmsId", "oclc", "sourceCode"].forEach((field) => {
    clearMetadataFieldIfAuto(field);
  });
  updateFilenamePreview();
}

function extractFilenameIdentifiers(value) {
  let text = stripBookmarkedSuffix((value || "").normalize("NFC").replace(/\.pdf$/i, ""));
  let mmsId = "";
  let oclc = "";
  const sourceCodes = [];

  text = text.replace(/\b(?:oclc|ocn)\b[\s:_-]*(\d{6,})\b/gi, (match, id) => {
    if (!oclc) oclc = id;
    return " ";
  });

  text = text.replace(/\bmms[\s_-]*id\b[\s:_-]*(\d{12,})(?:[\s_-]+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+))?/gi, (match, id, code) => {
    if (!mmsId) mmsId = id;
    if (code) addSourceCode(sourceCodes, code);
    return " ";
  });

  text = text.replace(/\b(\d{12,})(?:[-_\s]+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+))?\b/g, (match, id, code) => {
    if (!mmsId) {
      mmsId = id;
    }
    if (code) addSourceCode(sourceCodes, code);
    return " ";
  });

  text = text.replace(/\b(\d{6,11})\b/g, (match, id) => {
    if (!oclc) {
      oclc = id;
      return " ";
    }
    return id;
  });

  text = text.replace(/\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\b/g, (match, code) => {
    if (isSourceCodeCandidate(code)) {
      addSourceCode(sourceCodes, code);
      return " ";
    }
    return match;
  });

  return {
    text: text.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(),
    mmsId,
    oclc,
    sourceCode: sourceCodes[0] || "",
  };
}

function inferMetadataFromName(name) {
  const inferred = extractFilenameIdentifiers(name);
  const applied = [];
  if (setMetadataField("oclc", inferred.oclc)) applied.push("OCLC");
  if (setMetadataField("mmsId", inferred.mmsId)) applied.push("MMS ID");
  if (setMetadataField("sourceCode", inferred.sourceCode)) applied.push("source code");
  updateFilenamePreview();
  return applied;
}

function buildOutputFilename() {
  const contributorCredits = buildContributorCredits();
  const title = cleanFilenamePart(els.title.value) || "Untitled";
  const mmsId = normalizeIdentifier(els.mmsId.value);
  const oclc = cleanFilenamePart(els.oclc.value);
  const sourceCode = normalizeSourceCode(els.sourceCode.value);
  const identifiers = [];
  if (mmsId) identifiers.push(`MMS ID ${mmsId}`);
  if (oclc) identifiers.push(`OCLC ${oclc}`);
  if (sourceCode) identifiers.push(sourceCode);
  const pieces = [
    contributorCredits.primary,
    title,
    ...contributorCredits.afterTitle,
    identifiers.join(", "),
  ].filter(Boolean);
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
    const error = new Error(`${context} returned non-JSON response: ${text.slice(0, 200)}`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.detail || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return data;
}

function isRetryableJobPollError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401 || status === 403) return false;
  if (error?.retryable) return true;
  return /Failed to fetch|Load failed|NetworkError|Service Unavailable|non-JSON response|backend job status failed/i.test(error?.message || "");
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
  });
  return `${WORKER_URL}/analyze?${params.toString()}`;
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
  const availableWidth = Math.max(280, els.previewFrame.clientWidth);
  const availableHeight = Math.max(320, els.previewFrame.clientHeight);
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

function joinMetadataParts(...parts) {
  return parts
    .map((part) => cleanFilenamePart(part))
    .filter(Boolean)
    .join(": ");
}

function equivalentText(a, b) {
  const normalize = (value) => cleanFilenamePart(value).toLocaleLowerCase();
  return normalize(a) && normalize(a) === normalize(b);
}

function bracketedEquivalent(original, equivalent) {
  const base = cleanFilenamePart(original);
  const bracket = cleanFilenamePart(equivalent);
  if (!base) return bracket;
  if (!bracket || equivalentText(base, bracket)) return base;
  return `${base} [${bracket}]`;
}

function containsNonLatinLetters(value) {
  for (const char of cleanFilenamePart(value)) {
    if (/\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)) return true;
  }
  return false;
}

function suggestedTitleValue(metadata) {
  const original = joinMetadataParts(metadata?.title_original, metadata?.subtitle_original);
  const english = joinMetadataParts(metadata?.title_english, metadata?.subtitle_english);
  if (containsNonLatinLetters(original)) return bracketedEquivalent(original, english);
  return original || english;
}

function suggestedAuthorDisplay(metadata) {
  const original = cleanFilenamePart(metadata?.author_original);
  const romanized = cleanFilenamePart(metadata?.author_romanized);
  const westernName = joinMetadataParts(metadata?.author_first, metadata?.author_last).replace(/: /g, " ");
  if (containsNonLatinLetters(original)) return bracketedEquivalent(original, romanized);
  return original || westernName || romanized;
}

function metadataCreatorRoleIsContributor(metadata) {
  const role = cleanFilenamePart(metadata?.creator_role).toLowerCase();
  return !role || ["author", "editor", "compiler"].includes(role);
}

function contributorRoleFromMetadata(metadata) {
  const role = cleanFilenamePart(metadata?.creator_role).toLowerCase();
  if (role.includes("edit")) return "editor";
  if (role.includes("compil")) return "compiler";
  if (!role || role.includes("author")) return "author";
  return "";
}

function contributorRoleFromMetadataContributor(contributor) {
  const role = cleanFilenamePart(contributor?.role).toLowerCase();
  if (role.includes("edit")) return "editor";
  if (role.includes("compil")) return "compiler";
  if (!role || role.includes("author")) return "author";
  return "";
}

function suggestedContributor(metadata) {
  const role = contributorRoleFromMetadata(metadata);
  if (!role) return null;
  if (metadata.is_english === false) {
    return { role, last: suggestedAuthorDisplay(metadata), first: "" };
  }
  if (cleanFilenamePart(metadata.author_last) || cleanFilenamePart(metadata.author_first)) {
    return {
      role,
      last: metadata.author_last || suggestedAuthorDisplay(metadata),
      first: metadata.author_first || "",
    };
  }
  return { role, last: suggestedAuthorDisplay(metadata), first: "" };
}

function suggestedContributorFromMetadataContributor(contributor, metadata) {
  const role = contributorRoleFromMetadataContributor(contributor);
  if (!role) return null;
  const original = cleanFilenamePart(contributor?.name_original);
  const romanized = cleanFilenamePart(contributor?.name_romanized);
  const first = cleanFilenamePart(contributor?.first);
  const last = cleanFilenamePart(contributor?.last);
  if (metadata?.is_english === false && containsNonLatinLetters(original)) {
    return { role, last: bracketedEquivalent(original, romanized), first: "" };
  }
  if (last || first) {
    return { role, last: last || original || romanized, first };
  }
  return { role, last: original || romanized, first: "" };
}

function suggestedContributors(metadata) {
  const contributors = Array.isArray(metadata?.contributors)
    ? metadata.contributors
      .map((contributor) => suggestedContributorFromMetadataContributor(contributor, metadata))
      .filter(Boolean)
      .filter((contributor) => cleanFilenamePart(contributor.last) || cleanFilenamePart(contributor.first))
    : [];
  const primaryContributors = contributors.filter((contributor) => ["author", "editor"].includes(contributor.role));
  if (primaryContributors.length) return primaryContributors;
  const compilerContributors = contributors.filter((contributor) => contributor.role === "compiler");
  if (compilerContributors.length) return compilerContributors;

  const legacyContributor = suggestedContributor(metadata);
  if (!legacyContributor) return [];
  return cleanFilenamePart(legacyContributor.last) || cleanFilenamePart(legacyContributor.first)
    ? [legacyContributor]
    : [];
}

function metadataHasVisibleEvidence(metadata) {
  const page = Number(metadata?.evidence_page);
  return Number.isFinite(page) && page > 0 && cleanFilenamePart(metadata?.evidence).length >= 8;
}

function applyMetadataSuggestion(metadata) {
  if (!metadata || metadata.error) return [];
  const confidence = cleanFilenamePart(metadata.confidence).toLowerCase();
  if (!["high", "medium"].includes(confidence)) return [];
  if (!metadataHasVisibleEvidence(metadata)) return [];

  const applied = [];
  const title = suggestedTitleValue(metadata);
  if (setMetadataField("title", title)) applied.push("title");

  const contributors = suggestedContributors(metadata);
  if (!contributors.length && !metadataCreatorRoleIsContributor(metadata)) {
    updateFilenamePreview();
    return applied;
  }

  if (!contributors.length) {
    updateFilenamePreview();
    return applied;
  }

  if (setContributorMetadata(contributors)) {
    applied.push(contributors.length > 1 ? "contributors" : "contributor");
  }

  updateFilenamePreview();
  return [...new Set(applied)];
}

async function suggestMetadataForSource(normalizedUrl, runId) {
  assertAnalysisRunActive(runId);
  const password = requireStaffPassword();
  addProgress("Looking for title/contributors on the first pages...");
  const response = await fetch(`${WORKER_URL}/toc/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      password,
      pdf_url: normalizedUrl,
      max_pages: 8,
    }),
  });
  const data = await parseJsonResponse(response, "Worker");
  assertAnalysisRunActive(runId);

  const metadata = data.suggested_metadata || {};
  state.metadataSuggestion = metadata;
  const identifierFields = metadata.error ? [] : inferMetadataFromName(state.pdfName);
  const applied = applyMetadataSuggestion(metadata);
  const page = metadata.evidence_page ? ` page ${metadata.evidence_page}` : "";
  const appliedFields = [...identifierFields, ...applied];
  if (appliedFields.length) {
    addProgress(`Applied ${appliedFields.join(" and ")} from metadata scan${page}.`);
  } else {
    addProgress("Metadata scan did not find confident title/contributor fields to apply.");
  }
  refreshDebug();
  return data;
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
  let lastSeenHeartbeatCount = Number(started.heartbeat_count) || 0;
  let lastHeartbeatNoticeAt = 0;
  let firstPollErrorAt = null;
  let consecutivePollErrors = 0;
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
    try {
      latest = await getAnalysisJob(jobId);
      if (consecutivePollErrors > 0) {
        addProgress("Progress connection restored.");
      }
      firstPollErrorAt = null;
      consecutivePollErrors = 0;
    } catch (error) {
      if (!isRetryableJobPollError(error)) throw error;
      const now = Date.now();
      firstPollErrorAt = firstPollErrorAt || now;
      consecutivePollErrors += 1;
      const retryElapsed = now - firstPollErrorAt;
      if (retryElapsed > JOB_POLL_RETRY_GRACE_MS) {
        throw new Error(`Lost contact with the analysis job after retrying progress updates. Last error: ${error.message}`);
      }
      if (consecutivePollErrors === 1) {
        addProgress(`Progress update temporarily failed (${error.message}). Retrying without stopping the analysis...`);
      } else if (consecutivePollErrors % 8 === 0) {
        addProgress(`Still retrying progress updates (${Math.round(retryElapsed / 1000)}s since the first failure)...`);
      }
      updateJobStatusText(lastSeenStatus || "running");
      continue;
    }
    assertAnalysisRunActive(runId);
    const progressCount = Array.isArray(latest.progress) ? latest.progress.length : 0;
    const status = latest.status || "running";
    const heartbeatCount = Number(latest.heartbeat_count) || 0;
    const heartbeatAdvanced = heartbeatCount > lastSeenHeartbeatCount;
    if (progressCount > lastSeenProgressCount || status !== lastSeenStatus || heartbeatAdvanced) {
      lastActivityAt = Date.now();
      if (heartbeatAdvanced && progressCount <= lastSeenProgressCount && status === lastSeenStatus) {
        const now = Date.now();
        if (now - lastHeartbeatNoticeAt > JOB_STILL_WORKING_NOTICE_MS) {
          addProgress("Backend heartbeat received; analysis is still working in the current stage.");
          lastHeartbeatNoticeAt = now;
        }
      }
      lastSeenProgressCount = progressCount;
      lastSeenStatus = status;
      lastSeenHeartbeatCount = Math.max(lastSeenHeartbeatCount, heartbeatCount);
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

function iconSvg(name) {
  const icons = {
    eye: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2.06 12.35a1 1 0 0 1 0-.7C3.42 7.58 7.25 5 12 5s8.58 2.58 9.94 6.65a1 1 0 0 1 0 .7C20.58 16.42 16.75 19 12 19s-8.58-2.58-9.94-6.65Z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    flag: '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4"></path><path d="M4 4h12l-1 4 1 4H4"></path></svg>',
  };
  return icons[name] || "";
}

function addEntryRow(entry = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input class="entry-title" type="text"></td>
    <td class="page-cell"><input class="entry-page" type="text"></td>
    <td class="level-cell"><input class="entry-level" type="number" min="0" step="1"></td>
    <td class="row-actions">
      <button class="preview-row" type="button" aria-label="Preview row" title="Preview row">${iconSvg("eye")}</button>
      <button class="flag-row" type="button" aria-label="Flag row" title="Flag row">${iconSvg("flag")}</button>
      <button class="remove-row" type="button" aria-label="Remove row" title="Remove row">x</button>
    </td>
  `;
  row.dataset.originalTitle = entry.title || "";
  row.dataset.originalPage = entry.page || "";
  row.querySelector(".entry-title").value = entry.title || "";
  row.querySelector(".entry-page").value = entry.page || "";
  row.querySelector(".entry-level").value = Number.isFinite(entry.level) ? entry.level : (entry.level || 0);
  row.querySelector(".preview-row").addEventListener("click", async () => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const restoreScroll = () => window.scrollTo(scrollX, scrollY);
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
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    } catch (error) {
      setPreviewStatus(error.message, "error");
      addProgress(`Preview error: ${error.message}`);
      restoreScroll();
      requestAnimationFrame(restoreScroll);
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
    `source_code=${normalizeSourceCode(els.sourceCode.value)}`,
    `metadata_confidence=${state.metadataSuggestion?.confidence || ""}`,
    `metadata_language=${state.metadataSuggestion?.language || ""}`,
    `metadata_evidence_page=${state.metadataSuggestion?.evidence_page || ""}`,
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
  state.metadataSuggestion = null;
  clearMetadataTracking();
  state.lastProgressCount = 0;
  state.startedAt = null;

  els.url.value = "";
  setContributorRows([{}]);
  [els.title, els.mmsId, els.oclc, els.sourceCode].forEach((input) => {
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
    const metadataPromise = suggestMetadataForSource(normalizedUrl, runId).catch((error) => {
      if (error.name !== "StaleAnalysisRun") {
        addProgress(`Metadata scan skipped: ${error.message}`);
      }
      return null;
    });

    state.analysis = await analyzeSource(runId);
    assertAnalysisRunActive(runId);
    setEntries(state.analysis.entries || []);
    els.alignmentStatus.textContent = `${state.analysis.alignment_source || "unknown"} / ${state.analysis.alignment_confidence || "unknown"}`;
    updateLearningPanel();
    els.downloadState.textContent = "Ready to create PDF";
    els.createPdf.disabled = false;
    addProgress(`Analysis complete: ${getEntriesFromTable().length} entries.`);
    syncProgressMessages(state.analysis.progress || []);
    await metadataPromise;
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

  setContributorRows([{}]);

  [
    [els.title, "title"],
    [els.mmsId, "mmsId"],
    [els.oclc, "oclc"],
    [els.sourceCode, "sourceCode"],
  ].forEach(([input, field]) => {
    input.addEventListener("input", () => {
      state.metadataTouched.add(field);
      delete state.metadataAutoValues[field];
      updateFilenamePreview();
    });
  });

  els.addContributor.addEventListener("click", () => {
    state.metadataTouched.add("contributors");
    delete state.metadataAutoValues.contributors;
    addContributorRow({}, { focus: true });
    updateFilenamePreview();
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
  });

  els.url.addEventListener("input", () => {
    clearPreviewAutoload();
    state.pdfBytes = null;
    state.pdfBytesUrl = "";
    state.metadataSuggestion = null;
    clearAutomaticMetadataFields();
    resetPreview("Preview will load when analysis starts.");
    updateSourceLink();
    const name = filenameFromUrl(els.url.value.trim());
    if (name && name !== "document.pdf") {
      state.pdfName = name;
    }
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
    if (state.feedbackSaveTimer) {
      clearTimeout(state.feedbackSaveTimer);
      state.feedbackSaveTimer = null;
    }
    els.saveFeedback.disabled = true;
    els.saveFeedback.textContent = "Saving...";
    setFeedbackState("Saving feedback...", "saving");
    try {
      await saveRunFeedback();
      els.saveFeedback.textContent = "Saved";
      state.feedbackSaveTimer = setTimeout(() => {
        els.saveFeedback.textContent = "Save feedback";
        els.saveFeedback.disabled = !currentRunId();
        state.feedbackSaveTimer = null;
      }, 2500);
    } catch (error) {
      els.saveFeedback.textContent = "Save failed";
      setFeedbackState("Feedback save failed.", "error");
      addProgress(`Feedback error: ${error.message}`);
      state.feedbackSaveTimer = setTimeout(() => {
        els.saveFeedback.textContent = "Save feedback";
        els.saveFeedback.disabled = !currentRunId();
        state.feedbackSaveTimer = null;
      }, 2500);
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
