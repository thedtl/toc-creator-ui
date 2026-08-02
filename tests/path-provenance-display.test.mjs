import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
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
    if (char === "'" || char === "\"" || char === "`") {
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

function compile(name) {
  return new Function(
    `${functionSource("outputStatus")}
${functionSource("pathProvenance")}
${functionSource("pathDisplayLabel")}
${functionSource("outputDisplayLabel")}
return ${name};`,
  )();
}

const pathDisplayLabel = compile("pathDisplayLabel");
const outputDisplayLabel = compile("outputDisplayLabel");

function analysis(path, outputStatus, statusMessage = "") {
  return {
    quality_gate: outputStatus.quality_gate || outputStatus.product_status || "auto_complete",
    publishability: {
      job_status: outputStatus.job_status || outputStatus.product_status || "succeeded",
      publishable: true,
      output_status: outputStatus,
    },
    direct_toc_diagnostics: {
      path_provenance: {
        analysis_path: path,
        status_message: statusMessage,
        product_truth_source: "publishability.output_status",
      },
    },
  };
}

assert.match(html, /Path: <strong id="learning-route">not run<\/strong>/);
assert.doesNotMatch(source, /progress\.includes\("toc found in back pages"\)/);
assert.match(source, /pathProvenance\(analysis\)/);
assert.match(source, /outputStatus\(analysis\)/);
assert.doesNotMatch(source, /publishability\?\.publishable[^\\n]*Ready to create PDF/);

assert.equal(
  pathDisplayLabel(analysis("premium_whole_toc", {
    product_status: "succeeded",
    resolved_output_complete: true,
    editable_available: true,
    review_required: false,
  }, "Premium path used")),
  "Premium path used",
);

assert.equal(
  pathDisplayLabel(analysis("protected_good_enough_fallback", {
    product_status: "needs_review",
    editable_available: true,
    review_required: true,
  })),
  "Review fallback used — editable ToC evidence preserved",
);

assert.equal(
  pathDisplayLabel(analysis("mixed_premium_review", {
    product_status: "needs_review",
    editable_available: true,
    review_evidence_available: true,
    review_required: true,
  })),
  "Mixed review path — review required",
);

assert.equal(
  pathDisplayLabel(analysis("failed_no_safe_output", {
    product_status: "failed",
    output_available: false,
    editable_available: false,
  })),
  "No safe ToC output",
);

assert.equal(
  outputDisplayLabel(analysis("premium_whole_toc", {
    product_status: "succeeded",
    resolved_output_complete: true,
    editable_available: true,
    review_required: false,
  })),
  "Ready to create PDF",
);

assert.equal(
  outputDisplayLabel(analysis("protected_good_enough_fallback", {
    product_status: "needs_review",
    editable_available: true,
    review_required: true,
  })),
  "Ready to create PDF — review noted",
);

assert.equal(
  outputDisplayLabel(analysis("mixed_premium_review", {
    product_status: "needs_review",
    editable_available: false,
    review_evidence_available: true,
    review_required: true,
  })),
  "Review evidence available",
);

assert.equal(
  outputDisplayLabel(analysis("failed_no_safe_output", {
    product_status: "failed",
    output_available: false,
    editable_available: false,
  })),
  "No safe ToC output",
);

console.log("path provenance display tests passed");
