import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function loadHarness() {
  const runIdNode = { textContent: "none", title: "" };
  const copyButton = { disabled: true };
  const downloadState = { textContent: "" };
  const context = {
    state: {
      analysis: null, analysisJobId: null, analysisJobStartedAt: null,
      analysisRunId: 1, startedAt: new Date(),
    },
    els: { learningRunId: runIdNode, copyRunId: copyButton, downloadState },
  };
  vm.createContext(context);
  vm.runInContext(`${section("function createStaleAnalysisError", "if (window.pdfjsLib)")}
    ${section("function elapsedSeconds", "function formatNumber")}
    ${section("function currentRunId", "function outputStatus")}
    this.api = { currentRunId, renderRunId, setActiveAnalysisJobId, updateJobStatusText };`, context);
  return { context, api: context.api, runIdNode, copyButton, downloadState };
}

test("successful and needs-review states retain the complete copyable job ID", () => {
  const { api, runIdNode, copyButton } = loadHarness();
  const jobId = "0caf341e0e694384a2572ae5686d5c22";
  api.setActiveAnalysisJobId(jobId, 1);
  assert.equal(runIdNode.textContent, jobId);
  assert.equal(runIdNode.title, jobId);
  assert.equal(copyButton.disabled, false);
  for (const status of ["succeeded", "needs_review"]) {
    api.updateJobStatusText(status);
    assert.equal(runIdNode.textContent, jobId);
  }
});

test("failure, readiness, quality, cancellation, polling, and timeout states retain the ID", () => {
  const { api, runIdNode } = loadHarness();
  const jobId = "3761138137984c7fbc19b73646d8e856";
  api.setActiveAnalysisJobId(jobId, 1);
  for (const status of ["failed", "failed_quality_gate", "cancelled", "running", "retrying"]) {
    api.updateJobStatusText(status);
    assert.equal(runIdNode.textContent, jobId);
  }
  assert.match(source, /Lost contact with the analysis job[\s\S]*Last error/);
  assert.match(source, /Analysis timed out/);
});

test("new runs replace IDs, reset clears them, and stale runs cannot overwrite", () => {
  const { context, api, runIdNode, copyButton } = loadHarness();
  api.setActiveAnalysisJobId("job-old", 1);
  context.state.analysisRunId = 2;
  assert.throws(() => api.setActiveAnalysisJobId("job-stale", 1), /Analysis was reset/);
  assert.equal(runIdNode.textContent, "job-old");
  api.setActiveAnalysisJobId("job-new", 2);
  assert.equal(runIdNode.textContent, "job-new");
  api.setActiveAnalysisJobId("", 2);
  assert.equal(runIdNode.textContent, "none");
  assert.equal(copyButton.disabled, true);
});

test("debug bundle includes the job ID and visible output excludes credentials", () => {
  const debugSource = section("function buildDebugBundle", "function refreshDebug");
  assert.match(debugSource, /`run_id=\$\{currentRunId\(\)\}`/);
  assert.doesNotMatch(debugSource, /staffPassword|staff-password|dtl_staff_password/);
  const { context, api, runIdNode } = loadHarness();
  context.state.analysis = { run_id: "result-id", password: "must-not-render" };
  api.setActiveAnalysisJobId("job-id", 1);
  assert.equal(api.currentRunId(), "job-id");
  assert.equal(runIdNode.textContent, "job-id");
  assert.doesNotMatch(runIdNode.textContent, /must-not-render/);
});

test("markup and marker expose the full ID with the generic copy mechanism", () => {
  assert.match(html, /Run ID: <strong id="learning-run-id">none<\/strong>/);
  assert.match(html, /id="copy-run-id"[^>]+data-copy-target="learning-run-id"/);
  assert.match(source, /LEARNING_FRONTEND_VERSION = "20260718-failed-run-id"/);
  assert.match(html, /app\.js\?v=20260731-path-provenance-display/);
  assert.doesNotMatch(section("function renderRunId", "function setActiveAnalysisJobId"), /slice\(/);
});
