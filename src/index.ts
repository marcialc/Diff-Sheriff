interface Env {
  AUTH_TOKEN: string;
  AI: Ai;
}

interface ReviewRequest {
  diff: string;
  provider?: string;
  repo?: string;
  prNumber?: number;
  mrIid?: number;
  sha?: string;
  title?: string;
  description?: string;
  mode?: "summary" | "inline";
  rulesMd?: string;
}

interface Finding {
  severity: "high" | "medium" | "low" | "nit";
  title: string;
  rationale: string;
  suggestion?: string;
  file?: string;
  line?: number;
}

type Recommendation = "approve" | "approve_with_changes" | "request_changes";

// Response from Human
interface ReviewResponse {
  ok: true;
  reviewId: string;
  summary: string;
  findings: Finding[];
  commentMd: string;
  recommendation: Recommendation;
  meta: {
    provider?: string;
    repo?: string;
    sha?: string;
    mode: "summary" | "inline";
    truncatedDiff: boolean;
  };
}

interface ErrorResponse {
  ok: false;
  error: string;
}

const MAX_DIFF_LENGTH = 60_000;
const AI_MODEL = "@cf/openai/gpt-oss-120b";

const SYSTEM_PROMPT = `You are Diff-Sheriff, a senior/lead engineer conducting a thorough PR review. Your job is to review code diffs and provide actionable, high-signal feedback.

Priorities (in order):
1. Correctness — bugs, logic errors, edge cases
2. Security — vulnerabilities, data exposure, injection risks
3. Maintainability — clarity, testability, future-proofing
4. Performance — only if clearly impactful

Rules:
- ONLY comment on actual code changes visible in the diff. Do NOT invent feedback.
- Do NOT comment on missing PR title, description, or other metadata. Do NOT give process feedback.
- Do NOT flag GitHub Actions secrets references like \`\${{ secrets.* }}\` as hardcoded secrets.
- Do NOT comment on code style unless it significantly impacts readability.
- Be concise and specific. Avoid nitpicks unless they matter.
- If the diff only contains comments, whitespace, or trivial changes with no functional impact, return an empty findings array.
- Output ONLY valid JSON matching the schema below. No markdown, no explanations outside JSON.

Severity guide:
- high: Bugs, security issues, data loss risks — must fix before merge
- medium: Logic issues, missing validation, poor error handling — should fix
- low: Minor improvements, edge cases, clarity — nice to have
- nit: Trivial suggestions — only include if truly valuable

Output JSON Schema:
{
  "summary": "string - 2-4 sentence high-level assessment of the actual code changes",
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "nit",
      "title": "string - Short title for the issue",
      "rationale": "string - Why this is a problem",
      "suggestion": "string (optional) - How to fix it",
      "file": "string (optional) - File path if identifiable",
      "line": "number (optional) - Line number if identifiable"
    }
  ],
  "testingNotes": ["string (optional) - 1-3 testing suggestions if relevant"]
}

If the diff looks good with no issues, return:
{
  "summary": "Code looks good. No significant issues found.",
  "findings": [],
  "testingNotes": []
}`;

function getAiResponseText(aiResponse: unknown): string {
  if (typeof aiResponse === "string") return aiResponse;
  if (typeof aiResponse !== "object" || aiResponse === null) {
    throw new Error("Unexpected AI response format");
  }

  const obj = aiResponse as Record<string, unknown>;

  if ("response" in obj) {
    return String(obj.response);
  }
  if ("output_text" in obj) {
    return String(obj.output_text);
  }
  if ("output" in obj && Array.isArray(obj.output)) {
    // Best-effort extraction for Responses API style outputs.
    // Keep this minimal + defensive; we still require JSON extraction downstream.
    const chunks: string[] = [];
    for (const item of obj.output) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (Array.isArray(rec.content)) {
        for (const c of rec.content) {
          if (typeof c !== "object" || c === null) continue;
          const cc = c as Record<string, unknown>;
          if (typeof cc.text === "string") chunks.push(cc.text);
        }
      }
    }
    if (chunks.length > 0) return chunks.join("\n");
  }

  throw new Error("Unexpected AI response format");
}

function deriveRecommendation(findings: Finding[]): Recommendation {
  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  if (hasHigh) return "request_changes";
  if (hasMedium) return "approve_with_changes";
  return "approve";
}

function renderReviewMarkdown(
  summary: string,
  findings: Finding[],
  testingNotes: string[],
  recommendation: Recommendation,
  sha?: string
): string {
  const lines: string[] = [];

  lines.push("<!-- diff-sheriff -->");
  lines.push("## ✅ Diff-Sheriff Review");
  lines.push("");

  lines.push("### 🔎 Summary");
  lines.push(`> ${summary}`);
  lines.push("");

  const high = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");
  const lowAndNit = findings.filter((f) => f.severity === "low" || f.severity === "nit");

  if (high.length > 0) {
    lines.push("### 🚨 Must Fix (Blocking)");
    for (const f of high) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("### ⚠️ Should Fix (Recommended)");
    for (const f of medium) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (lowAndNit.length > 0) {
    lines.push("### 💡 Nice to Have (Optional)");
    for (const f of lowAndNit) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (testingNotes.length > 0) {
    lines.push("### 🧪 Testing Notes");
    for (const note of testingNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push("### 🧭 Overall Recommendation");
  const recText = recommendation === "approve"
    ? "**Approve** — No blocking issues found."
    : recommendation === "approve_with_changes"
    ? "**Approve with changes** — Address the recommended items before or shortly after merge."
    : "**Request changes** — Blocking issues must be resolved before merge.";
  lines.push(`- ${recText}`);
  lines.push("");

  const commitRef = sha ? `\`${sha.slice(0, 7)}\`` : "N/A";
  lines.push(`<sub>Reviewed by Diff-Sheriff • AI-assisted, human-aligned • Commit: ${commitRef}</sub>`);

  return lines.join("\n");
}

function formatFindingBullet(f: Finding): string {
  let bullet = `- **${f.title}**`;
  if (f.file) {
    bullet += ` (\`${f.file}\``;
    if (f.line) bullet += `:${f.line}`;
    bullet += ")";
  }
  bullet += ` — ${f.rationale}`;
  if (f.suggestion) {
    bullet += ` *Suggestion:* ${f.suggestion}`;
  }
  return bullet;
}

function buildUserPrompt(req: ReviewRequest, truncated: boolean): string {
  const parts: string[] = [];

  if (req.title) {
    parts.push(`PR Title: ${req.title}`);
  }
  if (req.description) {
    parts.push(`PR Description: ${req.description}`);
  }
  if (req.rulesMd) {
    parts.push(`Additional Review Rules:\n${req.rulesMd}`);
  }
  parts.push(`Review Mode: ${req.mode || "summary"}`);
  if (truncated) {
    parts.push("Note: The diff was truncated due to length limits.");
  }
  parts.push(`\nDiff to review:\n\`\`\`diff\n${req.diff}\n\`\`\``);

  return parts.join("\n\n");
}

function extractJson(text: string): unknown {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("No JSON object found in response");
  }

  const jsonStr = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonStr);
}

function validateFinding(f: unknown): Finding | null {
  if (typeof f !== "object" || f === null) return null;

  const obj = f as Record<string, unknown>;
  const validSeverities = ["high", "medium", "low", "nit"];

  if (
    typeof obj.severity !== "string" ||
    !validSeverities.includes(obj.severity)
  ) {
    return null;
  }
  if (typeof obj.title !== "string" || !obj.title) return null;
  if (typeof obj.rationale !== "string" || !obj.rationale) return null;

  const finding: Finding = {
    severity: obj.severity as Finding["severity"],
    title: obj.title,
    rationale: obj.rationale,
  };

  if (typeof obj.suggestion === "string" && obj.suggestion) {
    finding.suggestion = obj.suggestion;
  }
  if (typeof obj.file === "string" && obj.file) {
    finding.file = obj.file;
  }
  if (typeof obj.line === "number" && Number.isInteger(obj.line)) {
    finding.line = obj.line;
  }

  return finding;
}

const METADATA_NOISE_PATTERNS = [
  /\bpr\s+title\b/i,
  /\bpr\s+description\b/i,
  /\bmissing\s+(title|description|context)\b/i,
  /\black\s+of\s+(context|description)\b/i,
  /\bempty\s+(title|description)\b/i,
  /\bno\s+(title|description|context)\b/i,
  /\bprovide\s+(a\s+)?(clear\s+)?(title|description)\b/i,
];

function isMetadataNoiseFinding(finding: Finding): boolean {
  const text = `${finding.title} ${finding.rationale} ${finding.suggestion || ""}`.toLowerCase();
  return METADATA_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function filterNonsensicalFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => !isMetadataNoiseFinding(f));
}

function isTrivialDiff(diff: string): boolean {
  const lines = diff.split("\n");
  let hasSubstantiveChange = false;

  for (const line of lines) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;

    const content = line.slice(1).trim();
    if (!content) continue;

    if (content.startsWith("//") || content.startsWith("#") || content.startsWith("*") || content.startsWith("/*") || content.startsWith("*/")) {
      continue;
    }

    if (/^\s*$/.test(content)) continue;

    hasSubstantiveChange = true;
    break;
  }

  return !hasSubstantiveChange;
}

function validateAiResponse(parsed: unknown): {
  summary: string;
  findings: Finding[];
  testingNotes: string[];
} {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("AI response is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.summary !== "string") {
    throw new Error("AI response missing summary");
  }

  const findings: Finding[] = [];
  if (Array.isArray(obj.findings)) {
    for (const f of obj.findings) {
      const validated = validateFinding(f);
      if (validated) {
        findings.push(validated);
      }
    }
  }

  const testingNotes: string[] = [];
  if (Array.isArray(obj.testingNotes)) {
    for (const note of obj.testingNotes) {
      if (typeof note === "string" && note.trim()) {
        testingNotes.push(note.trim());
      }
    }
  }

  return {
    summary: obj.summary,
    findings,
    testingNotes,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(error: string, status: number): Response {
  const body: ErrorResponse = { ok: false, error };
  return jsonResponse(body, status);
}

async function handleHealth(): Promise<Response> {
  return jsonResponse({
    ok: true,
    name: "diff-sheriff",
    ts: new Date().toISOString(),
  });
}

async function handleReview(
  request: Request,
  env: Env
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized: Missing or invalid Authorization header", 401);
  }

  const token = authHeader.slice(7);
  if (token !== env.AUTH_TOKEN) {
    return errorResponse("Unauthorized: Invalid token", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("Request body must be a JSON object", 400);
  }

  const reqBody = body as Record<string, unknown>;

  if (typeof reqBody.diff !== "string" || !reqBody.diff.trim()) {
    return errorResponse("Missing or empty 'diff' field", 400);
  }

  const reviewReq: ReviewRequest = {
    diff: reqBody.diff,
    provider: typeof reqBody.provider === "string" ? reqBody.provider : undefined,
    repo: typeof reqBody.repo === "string" ? reqBody.repo : undefined,
    prNumber: typeof reqBody.prNumber === "number" ? reqBody.prNumber : undefined,
    mrIid: typeof reqBody.mrIid === "number" ? reqBody.mrIid : undefined,
    sha: typeof reqBody.sha === "string" ? reqBody.sha : undefined,
    title: typeof reqBody.title === "string" ? reqBody.title : undefined,
    description: typeof reqBody.description === "string" ? reqBody.description : undefined,
    mode: reqBody.mode === "inline" ? "inline" : "summary",
    rulesMd: typeof reqBody.rulesMd === "string" ? reqBody.rulesMd : undefined,
  };

  let truncatedDiff = false;
  if (reviewReq.diff.length > MAX_DIFF_LENGTH) {
    reviewReq.diff = reviewReq.diff.slice(0, MAX_DIFF_LENGTH);
    truncatedDiff = true;
  }

  if (isTrivialDiff(reviewReq.diff)) {
    const trivialSummary = "Trivial change (comments, whitespace, or non-functional). No issues found.";
    const trivialCommentMd = renderReviewMarkdown(
      trivialSummary,
      [],
      [],
      "approve",
      reviewReq.sha
    );
    return jsonResponse({
      ok: true,
      reviewId: crypto.randomUUID(),
      summary: trivialSummary,
      findings: [],
      commentMd: trivialCommentMd,
      recommendation: "approve",
      meta: {
        provider: reviewReq.provider,
        repo: reviewReq.repo,
        sha: reviewReq.sha,
        mode: reviewReq.mode || "summary",
        truncatedDiff,
      },
    } satisfies ReviewResponse);
  }

  const userPrompt = buildUserPrompt(reviewReq, truncatedDiff);

  const strictUserPrompt = `${userPrompt}\n\nIMPORTANT: Return ONLY a single valid JSON object (double quotes for keys/strings). No markdown, no code fences, no commentary.`;

  let aiResponseText: string;
  try {
    const aiInput: Record<string, unknown> = {
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: strictUserPrompt },
      ],
      response_format: { type: "json_object" },
    };

    const aiResponse = await env.AI.run(AI_MODEL, aiInput as never);

    aiResponseText = getAiResponseText(aiResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown AI error";
    return errorResponse(`AI failure: ${message}`, 500);
  }

  let validated: { summary: string; findings: Finding[]; testingNotes: string[] };
  try {
    const parsed = extractJson(aiResponseText);
    validated = validateAiResponse(parsed);
  } catch (err) {
    try {
      const retryInput: Record<string, unknown> = {
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `${strictUserPrompt}\n\nYour previous response was not valid JSON. Try again and output ONLY valid JSON.`,
          },
        ],
        response_format: { type: "json_object" },
      };

      const retryResp = await env.AI.run(AI_MODEL, retryInput as never);
      const retryText = getAiResponseText(retryResp);
      const parsed = extractJson(retryText);
      validated = validateAiResponse(parsed);
    } catch (retryErr) {
      const message =
        retryErr instanceof Error ? retryErr.message : "Failed to parse AI response";
      return errorResponse(`AI response parsing failed: ${message}`, 500);
    }
  }

  const filteredFindings = filterNonsensicalFindings(validated.findings);
  const recommendation = deriveRecommendation(filteredFindings);
  const commentMd = renderReviewMarkdown(
    validated.summary,
    filteredFindings,
    validated.testingNotes,
    recommendation,
    reviewReq.sha
  );

  const response: ReviewResponse = {
    ok: true,
    reviewId: crypto.randomUUID(),
    summary: validated.summary,
    findings: filteredFindings,
    commentMd,
    recommendation,
    meta: {
      provider: reviewReq.provider,
      repo: reviewReq.repo,
      sha: reviewReq.sha,
      mode: reviewReq.mode || "summary",
      truncatedDiff,
    },
  };

  return jsonResponse(response);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET") {
      return handleHealth();
    }

    if (path === "/review" && method === "POST") {
      return handleReview(request, env);
    }

    return errorResponse("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
