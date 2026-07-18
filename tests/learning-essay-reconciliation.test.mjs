import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const prefix = source.slice(0, source.indexOf("const state ="));
const essayFunctions = source.slice(source.indexOf("function analysisUsesEditedVolumeTitles"), source.indexOf("function iconSvg"));
const tableFunction = source.slice(source.indexOf("function getEntriesFromTable"), source.indexOf("function updateEntryCount"));

function makeRow(entry, format) {
  const title = { value: format(entry, { document_type: "edited_volume" }, "keep_source") };
  return { dataset: { originalTitle: entry.title, originalBookmark: String(entry.bookmark !== false),
    lastAutoTitle: title.value, lastAutoMode: "keep_source", learningId: entry.learning_id,
    parentIdentity: entry.parent_identity || "", manualTitleEdited: "false" },
  querySelector(selector) {
    if (selector === ".entry-title") return title;
    if (selector === ".entry-page") return { value: entry.page };
    if (selector === ".entry-level") return { value: String(entry.level || 0) };
    throw new Error(`unexpected selector ${selector}`);
  } };
}

function loadHarness(entries) {
  const state = { essayOrderMode: "keep_source", analysis: { document_type: "edited_volume", entries } };
  const rows = [], buttons = ["keep_source", "author_first", "title_first"].map((essayOrder) => ({
    dataset: { essayOrder }, classList: { toggle() {} }, setAttribute() {},
  }));
  const els = { entriesBody: { querySelectorAll: () => rows }, essayOrderOptions: { querySelectorAll: () => buttons },
    essayOrderControl: { hidden: true } };
  const context = { state, els, crypto: { randomUUID: () => "uuid-1" }, updateEntryCount() {}, refreshDebug() {}, addEntryRow() {} };
  vm.createContext(context);
  vm.runInContext(`${prefix}\n${essayFunctions}\n${tableFunction}\nthis.api = { newLearningIdentity, learningEntryFromValues,
    withOneTransportRetry, createPdfThenCapture, formatEntryTitleForEditor, setEssayOrderMode,
    shouldShowEssayOrderControl, buildAutomaticTitleTransformations, getEntriesFromTable };`, context);
  rows.push(...entries.map((entry) => makeRow(entry, context.api.formatEntryTitleForEditor)));
  return { ...context, rows, api: context.api };
}

test("essay modes preserve structure, stable identity, parentage, and original analysis", () => {
  const entries = [
    { learning_id: "source:1", parent_identity: "part:1", title: "Alice Author\nEssay One", page: "pdf:3", level: 1 },
    { learning_id: "source:2", parent_identity: "", title: "PART ONE\nWRAPPER", page: "pdf:4", level: 0, bookmark: false },
  ];
  const originalBytes = JSON.stringify(entries), { state, rows, api } = loadHarness(entries);
  const identities = () => rows.map((row) => [row.dataset.learningId, row.dataset.parentIdentity]);
  assert.equal(api.shouldShowEssayOrderControl(entries, state.analysis), true);
  assert.equal(api.shouldShowEssayOrderControl(entries, { document_type: "monograph" }), false);
  assert.equal(rows[0].querySelector(".entry-title").value, "Alice Author Essay One");
  const expectedIds = [["source:1", "part:1"], ["source:2", ""]];
  assert.deepEqual(identities(), expectedIds);
  api.setEssayOrderMode("author_first");
  assert.equal(rows[0].querySelector(".entry-title").value, 'Alice Author, "Essay One"');
  assert.deepEqual(identities(), expectedIds);
  api.setEssayOrderMode("title_first");
  assert.equal(rows[0].querySelector(".entry-title").value, 'Essay One, "Alice Author"');
  assert.deepEqual(identities(), expectedIds);
  assert.equal(rows[1].querySelector(".entry-title").value, "PART ONE WRAPPER");
  assert.equal(JSON.stringify(state.analysis.entries), originalBytes);
  rows[0].querySelector(".entry-title").value = "Manual title";
  rows[0].dataset.manualTitleEdited = "true";
  api.setEssayOrderMode("author_first");
  assert.equal(rows[0].querySelector(".entry-title").value, "Manual title");
  assert.equal(api.buildAutomaticTitleTransformations(rows, "author_first")[0].manually_changed_after_transform, true);
  assert.equal(rows.length, 2);
});

test("PDF and finalization use the same identity-bearing entries", async () => {
  const entries = [{ learning_id: "source:7", parent_identity: "part:2", title: "Writer\nWork", page: "pdf:9", level: 2 }];
  const { rows, api } = loadHarness(entries);
  api.setEssayOrderMode("author_first");
  const finalEntries = api.getEntriesFromTable();
  assert.deepEqual(JSON.parse(JSON.stringify(finalEntries)), [{ title: 'Writer, "Work"', page: "pdf:9",
    level: 2, learning_id: "source:7", parent_identity: "part:2" }]);
  const records = api.buildAutomaticTitleTransformations(rows, "author_first");
  assert.deepEqual(JSON.parse(JSON.stringify(records)), [{ identity: "source:7", transformation_type: "essay_order_formatting",
    essay_order_mode: "author_first", original_title: "Writer\nWork", automatic_title: 'Writer, "Work"',
    final_title: 'Writer, "Work"', final_title_equals_automatic: true, manually_changed_after_transform: false }]);
  let captured;
  const created = await api.createPdfThenCapture(async () => ({ count: 1, entries: finalEntries }),
    async (value) => { captured = value.entries; });
  assert.equal(captured, created.entries);
});

test("capture is nonblocking and retries only one transport failure", async () => {
  const { api } = loadHarness([]); let attempts = 0, captureErrors = 0;
  assert.equal(api.newLearningIdentity(), "local:uuid-1");
  assert.equal(await api.withOneTransportRetry(async () => { attempts += 1;
    if (attempts === 1) { const error = new Error("offline"); error.transportFailure = true; throw error; }
    return "saved"; }), "saved");
  assert.equal(attempts, 2);
  let nontransport = 0; await assert.rejects(api.withOneTransportRetry(async () => { nontransport += 1; throw new Error("HTTP"); }), /HTTP/);
  assert.equal(nontransport, 1);
  const created = await api.createPdfThenCapture(async () => ({ count: 1, entries: [] }),
    async () => { throw new Error("capture unavailable"); }, () => { captureErrors += 1; });
  assert.equal(created.count, 1); assert.equal(captureErrors, 1);
});

test("combined marker and immutable-finalization wiring are synchronized", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(source, /LEARNING_FRONTEND_VERSION = "20260718-failed-run-id"/);
  assert.match(html, /app\.js\?v=20260718-failed-run-id/);
  assert.match(source, /row\.dataset\.learningId = entry\.learning_id \|\| entry\.identity/);
  assert.match(source, /original_source_url: originalSourceUrl/);
  assert.match(source, /result\?\.entries \|\| getEntriesFromTable\(\)/);
  assert.match(source, /original_entries: Array\.isArray\(state\.analysis\?\.entries\)/);
});
