import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function functionSource(name) {
  const asyncMarker = `async function ${name}(`;
  const syncMarker = `function ${name}(`;
  const start = source.includes(asyncMarker)
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  assert.notEqual(start, -1, `${name} is missing`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function compile(name, dependencies) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return new Function(...names, `${functionSource(name)}; return ${name};`)(...values);
}

function entries(count = 13) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Recovered ${index + 1}`,
    page: `pdf:${index + 15}`,
    level: 0,
  }));
}

async function analyzeCase(terminal) {
  const state = { analysisRunId: 1 };
  const analyzeSource = compile("analyzeSource", {
    state,
    assertAnalysisRunActive() {},
    addProgress() {},
    startAnalysisJobWithRetry: async () => terminal,
    createStaleAnalysisError: () => new Error("stale"),
    setActiveAnalysisJobId() {},
    syncProgressMessages() {},
    updateJobStatusText() {},
    JOB_TIMEOUT_MS: 1000,
    JOB_POLL_INTERVAL_MS: 1,
    delay: async () => {},
    getAnalysisJob: async () => terminal,
    isRecentStartedJobNotFound: () => false,
    isRetryableJobError: () => false,
  });
  return analyzeSource(1);
}

async function renderCase(analysis) {
  const rendered = [];
  const progress = [];
  const state = {
    analysisRunId: 0,
    pdfUrl: "",
    previewDoc: null,
    pdfBytesUrl: "",
    pdfBytes: null,
    essayOrderMode: "keep_source",
  };
  const els = {
    url: { value: "https://www.dropbox.com/s/test/offline.pdf" },
    createPdf: { disabled: true },
    downloadState: { textContent: "" },
    alignmentStatus: { textContent: "" },
  };
  const runAnalysis = compile("runAnalysis", {
    state,
    els,
    resetProgress(message) { progress.push(message); },
    resetFeedbackState() {},
    assertAnalysisRunActive() {},
    normalizeDropboxUrl: (value) => value,
    filenameFromUrl: () => "offline.pdf",
    resetPreview: async () => {},
    renderRunId() {},
    schedulePreviewAutoload() {},
    suggestMetadataForSource: async () => null,
    analyzeSource: async () => analysis,
    setEssayOrderMode() {},
    setEntries(value) { rendered.splice(0, rendered.length, ...value); },
    updateLearningPanel() {},
    getEntriesFromTable: () => rendered,
    updateCreatePdfAvailability() {
      els.createPdf.disabled = rendered.length === 0;
    },
    addProgress(message) { progress.push(message); },
    syncProgressMessages() {},
    refreshDebug() {},
  });
  await runAnalysis({ preventDefault() {} });
  return { rendered, progress, els };
}

async function downloadCase(recovered) {
  let clicked = false;
  const assigned = [];
  let next = 0;
  const context = {
    nextRef: () => ({ id: ++next }),
    obj: (value) => value,
    assign: (ref, value) => assigned.push([ref, value]),
  };
  const pdfDoc = {
    context,
    getPageCount: () => 400,
    getPage: (index) => ({ ref: { page: index } }),
    catalog: { set() {} },
    save: async () => new Uint8Array([1, 2, 3]),
  };
  const createBookmarkedPdf = compile("createBookmarkedPdf", {
    getEntriesFromTable: () => recovered,
    state: { essayOrderMode: "keep_source", analysis: {} },
    buildAutomaticTitleTransformations: () => [],
    els: { entriesBody: { querySelectorAll: () => [] } },
    window: {
      PDFLib: {
        PDFDocument: { load: async () => pdfDoc },
        PDFHexString: { fromText: (value) => value },
        PDFName: { of: (value) => value },
      },
    },
    ensurePdfBytes: async () => new Uint8Array([1]),
    entryToPageIndex: (entry) => Number(entry.page.slice(4)) - 1,
    Blob,
    document: {
      createElement: () => ({
        href: "",
        download: "",
        click() { clicked = true; },
      }),
    },
    URL: {
      createObjectURL: () => "blob:offline",
      revokeObjectURL() {},
    },
    buildOutputFilename: () => "offline.pdf",
    setTimeout: (callback) => callback(),
  });
  const result = await createBookmarkedPdf();
  assert.equal(clicked, true);
  assert.equal(result.count, recovered.length);
  assert.deepEqual(result.entries, recovered);
  assert.ok(assigned.length >= recovered.length);
}

const thirteen = entries();
const review = await analyzeCase({
  job_id: "review",
  status: "needs_review",
  result: { entries: thirteen, quality_gate: "needs_review" },
  progress: [],
});
assert.equal(review.entries.length, 13);

const recoveredFailure = await analyzeCase({
  job_id: "failed",
  status: "failed",
  error: "pipeline_stage:mapping",
  result: { entries: thirteen, quality_gate: "not_evaluated" },
  progress: [],
});
assert.equal(recoveredFailure.recovered_execution_failure.status, "failed");
assert.equal(recoveredFailure.entries.length, 13);
const renderedFailure = await renderCase(recoveredFailure);
assert.equal(renderedFailure.rendered.length, 13);
assert.equal(renderedFailure.els.createPdf.disabled, false);
assert.match(renderedFailure.els.downloadState.textContent, /Recovered bookmarks/);
await downloadCase(renderedFailure.rendered);

const zero = await analyzeCase({
  job_id: "zero",
  status: "needs_review",
  result: { entries: [], quality_gate: "needs_review" },
  progress: [],
});
const renderedZero = await renderCase(zero);
assert.equal(renderedZero.rendered.length, 0);
assert.equal(renderedZero.els.createPdf.disabled, true);
assert.match(renderedZero.progress.join("\n"), /0 entries; review required/);

const manualRows = [];
const manualState = { analysis: zero };
const manualEls = { createPdf: { disabled: true } };
const updateCreatePdfAvailability = compile("updateCreatePdfAvailability", {
  state: manualState,
  els: manualEls,
  getEntriesFromTable: () => manualRows,
});
updateCreatePdfAvailability();
assert.equal(manualEls.createPdf.disabled, true);
manualRows.push({ title: "Manual bookmark", page: "pdf:2", level: 0 });
updateCreatePdfAvailability();
assert.equal(manualEls.createPdf.disabled, false);

assert.match(
  source,
  /result\?\.entries \|\| getEntriesFromTable\(\)/,
  "finalization must consume the entries returned by PDF creation",
);

console.log("no-discard frontend contract tests passed: 3/3 terminal shapes + download/finalization");
