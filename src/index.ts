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

interface InlineComment {
  path: string;
  line: number;
  body: string;
}

interface ReviewResponse {
  ok: true;
  reviewId: string;
  summary: string;
  findings: Finding[];
  commentMd: string;
  inlineComments: InlineComment[];
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
const AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

const SYSTEM_PROMPT = `
You are Diff-Sheriff, a senior software engineer performing a pull request review.

Review ONLY the code changes provided to you.
Do NOT assume access to the full repository, tools, or runtime.
Do NOT speculate about unseen files or architecture.

Review style:
- Think like a lead engineer responsible for correctness, security, and long-term maintainability.
- Prefer fewer, higher-signal comments.
- Avoid nitpicks unless they materially improve clarity or safety.
- If no meaningful issues exist, say so clearly.

Focus areas (in priority order):
1. Correctness & logic errors
2. Security issues and unsafe patterns
3. Breaking changes or API contracts
4. Performance or reliability risks
5. Maintainability and clarity

Rules:
- Comment only on issues you are confident about.
- Base all feedback strictly on the provided diff and optional context.
- Do not invent tests, files, or repo structure.
- Do not praise or summarize code quality beyond what is necessary.

Output requirements:
- Return STRICT JSON only.
- No markdown.
- No explanations outside JSON.

You must return an object with:
{
  "summary": string, // 2–4 sentences, high-level assessment
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "nit",
      "title": string,
      "rationale": string,
      "suggestion"?: string,
      "file"?: string,
      "line"?: number
    }
  ]
}
`;
;

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
  
  const recEmoji = recommendation === "approve" ? "✅" : recommendation === "approve_with_changes" ? "⚠️" : "❌";
  lines.push(`## ${recEmoji} Diff-Sheriff`);
  lines.push("");
  lines.push(`${summary}`);
  lines.push("");

  const high = findings.filter((f) => f.severity === "high");
  const medium = findings.filter((f) => f.severity === "medium");
  const lowAndNit = findings.filter((f) => f.severity === "low" || f.severity === "nit");

  if (high.length > 0) {
    lines.push("**🚨 Blocking**");
    for (const f of high) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("**⚠️ Should Fix**");
    for (const f of medium) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (lowAndNit.length > 0) {
    lines.push("**💡 Optional**");
    for (const f of lowAndNit) {
      lines.push(formatFindingBullet(f));
    }
    lines.push("");
  }

  if (testingNotes.length > 0) {
    lines.push("**🧪 Test**");
    for (const note of testingNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  const commitRef = sha ? sha.slice(0, 7) : "";
  lines.push(`<sub>${commitRef}</sub>`);

  return lines.join("\n");
}

function formatFindingBullet(f: Finding): string {
  let loc = "";
  if (f.file) {
    loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
  }
  
  let bullet = `- **${f.title}**`;
  if (loc) bullet += ` ${loc}`;
  bullet += `: ${f.rationale}`;
  if (f.suggestion) {
    bullet += ` → ${f.suggestion}`;
  }
  return bullet;
}

function buildInlineComments(findings: Finding[]): InlineComment[] {
  const comments: InlineComment[] = [];
  
  for (const f of findings) {
    if (!f.file || !f.line) continue;
    
    const severityEmoji = f.severity === "high" ? "🚨" : f.severity === "medium" ? "⚠️" : "💡";
    let body = `${severityEmoji} **${f.title}**\n\n${f.rationale}`;
    if (f.suggestion) {
      body += `\n\n**Suggestion:**\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
    }
    
    comments.push({
      path: f.file,
      line: f.line,
      body,
    });
  }
  
  return comments;
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

  const userPrompt = buildUserPrompt(reviewReq, truncatedDiff);

  let aiResponseText: string;
  try {
    const aiResponse = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    if (typeof aiResponse === "object" && aiResponse !== null) {
      const obj = aiResponse as Record<string, unknown>;
      if ("choices" in obj && Array.isArray(obj.choices) && obj.choices.length > 0) {
        const choice = obj.choices[0] as Record<string, unknown>;
        const message = choice.message as Record<string, unknown> | undefined;
        if (message && typeof message.content === "string") {
          aiResponseText = message.content;
        } else {
          throw new Error("No content in choices[0].message");
        }
      } else {
        throw new Error(`Unexpected AI response format: ${JSON.stringify(Object.keys(obj))}`);
      }
    } else {
      throw new Error("Unexpected AI response format");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown AI error";
    return errorResponse(`AI failure: ${message}`, 500);
  }

  let validated: { summary: string; findings: Finding[]; testingNotes: string[] };
  try {
    const parsed = extractJson(aiResponseText);
    validated = validateAiResponse(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse AI response";
    return errorResponse(`AI response parsing failed: ${message}`, 500);
  }

  const recommendation = deriveRecommendation(validated.findings);
  const commentMd = renderReviewMarkdown(
    validated.summary,
    validated.findings,
    validated.testingNotes,
    recommendation,
    reviewReq.sha
  );
  const inlineComments = buildInlineComments(validated.findings);

  const response: ReviewResponse = {
    ok: true,
    reviewId: crypto.randomUUID(),
    summary: validated.summary,
    findings: validated.findings,
    commentMd,
    inlineComments,
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