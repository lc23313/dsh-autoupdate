// npm registry access (dist-tag query) with retry + tolerant JSON extraction.
// npm's CLI output can carry warning lines before the JSON payload, so the
// JSON object is extracted by brace matching rather than blind JSON.parse.
import { runCommand } from "./install.js";

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in npm output");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Fetch the dist-tags map of a package, e.g. { latest: "0.1.2", rc: "0.2.0-rc.1" }.
 * Retries once. Throws only after all attempts fail — callers treat this as a
 * soft failure (network blip), never a crash.
 */
export async function fetchDistTags(
  packageName,
  { npmCommand = "npm", timeoutMs = 30000, registry = "", attempts = 2 } = {},
) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const args = ["view", packageName, "dist-tags", "--json"];
    if (registry) args.push("--registry", registry);
    const r = await runCommand(npmCommand, args, { timeoutMs });
    if (r.ok) {
      try {
        const tags = extractJson(r.stdout);
        if (tags && typeof tags === "object") return tags;
        lastError = new Error(`npm view returned ${JSON.stringify(tags).slice(0, 200)}`);
      } catch (e) {
        lastError = new Error(`parse dist-tags: ${e?.message ?? e}`);
      }
    } else {
      lastError = new Error(
        `npm view failed (code ${r.code}${r.timedOut ? ", timed out" : ""}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`,
      );
    }
  }
  throw lastError ?? new Error("npm view failed");
}
