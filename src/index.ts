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

interface ReviewResponse {
  ok: true;
  reviewId: string;
  summary: string;
  findings: Finding[];
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
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `You are Diff-Sheriff, an expert code reviewer. Your job is to review code diffs and provide actionable feedback.

Rules:
- Only comment on code visible in the diff or its immediate context.
- Be concise and specific.
- Focus on bugs, security issues, performance problems, and code quality.
- Do not comment on code style unless it impacts readability significantly.
- Output ONLY valid JSON matching the schema below. No markdown, no explanations outside JSON.

Output JSON Schema:
{
  "summary": "string - Brief overall assessment (1-3 sentences)",
  "findings": [
    {
      "severity": "high" | "medium" | "low" | "nit",
      "title": "string - Short title for the issue",
      "rationale": "string - Why this is a problem",
      "suggestion": "string (optional) - How to fix it",
      "file": "string (optional) - File path if identifiable",
      "line": "number (optional) - Line number if identifiable"
    }
  ]
}

If the diff looks good with no issues, return:
{
  "summary": "Code looks good. No significant issues found.",
  "findings": []
}`;

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

  return {
    summary: obj.summary,
    findings,
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

    if (typeof aiResponse === "object" && aiResponse !== null && "response" in aiResponse) {
      aiResponseText = String((aiResponse as { response: unknown }).response);
    } else {
      throw new Error("Unexpected AI response format");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown AI error";
    return errorResponse(`AI failure: ${message}`, 500);
  }

  let validated: { summary: string; findings: Finding[] };
  try {
    const parsed = extractJson(aiResponseText);
    validated = validateAiResponse(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to parse AI response";
    return errorResponse(`AI response parsing failed: ${message}`, 500);
  }

  const response: ReviewResponse = {
    ok: true,
    reviewId: crypto.randomUUID(),
    summary: validated.summary,
    findings: validated.findings,
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
