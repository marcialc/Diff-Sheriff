# Diff-Sheriff

A PR reviewer service using Cloudflare Workers + Workers AI. Accepts unified diffs and returns structured JSON reviews.

## Prerequisites

- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) v3+
- Cloudflare account with Workers AI access

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set the AUTH_TOKEN secret

The `/review` endpoint requires Bearer authentication. Set your secret token:

```bash
wrangler secret put AUTH_TOKEN
```

You'll be prompted to enter your token value. Use a strong, random string.

### 3. Run locally

```bash
npm run dev
```

The worker will start at `http://localhost:8787`.

**Note:** For local development, create a `.dev.vars` file with your token:

```
AUTH_TOKEN=your-dev-token-here
```

## API Endpoints

### GET /health

Public health check endpoint.

**Response:**
```json
{
  "ok": true,
  "name": "diff-sheriff",
  "ts": "2025-12-20T12:00:00.000Z"
}
```

### POST /review

Authenticated endpoint that reviews a code diff.

**Headers:**
- `Authorization: Bearer <AUTH_TOKEN>` (required)
- `Content-Type: application/json`

**Request Body:**
```json
{
  "diff": "string (required) - unified diff content",
  "provider": "string (optional) - e.g., 'github', 'gitlab'",
  "repo": "string (optional) - repository name",
  "prNumber": "number (optional) - PR number for GitHub",
  "mrIid": "number (optional) - MR IID for GitLab",
  "sha": "string (optional) - commit SHA",
  "title": "string (optional) - PR/MR title",
  "description": "string (optional) - PR/MR description",
  "mode": "'summary' | 'inline' (optional, default: 'summary')",
  "rulesMd": "string (optional) - additional review rules in markdown"
}
```

**Response:**
```json
{
  "ok": true,
  "reviewId": "uuid",
  "summary": "Brief overall assessment",
  "findings": [
    {
      "severity": "high | medium | low | nit",
      "title": "Issue title",
      "rationale": "Why this is a problem",
      "suggestion": "How to fix (optional)",
      "file": "path/to/file (optional)",
      "line": 42
    }
  ],
  "meta": {
    "provider": "github",
    "repo": "owner/repo",
    "sha": "abc123",
    "mode": "summary",
    "truncatedDiff": false
  }
}
```

**Error Responses:**
- `401` - Unauthorized (missing/invalid token)
- `400` - Invalid JSON or missing diff
- `404` - Not found
- `500` - AI failure

## curl Examples

### Health check

```bash
curl http://localhost:8787/health
```

### Review a diff

```bash
curl -X POST http://localhost:8787/review \
  -H "Authorization: Bearer your-dev-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "diff": "diff --git a/src/app.ts b/src/app.ts\nindex 1234567..abcdefg 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,6 +10,8 @@ function processData(input: string) {\n   const data = JSON.parse(input);\n+  // TODO: add validation\n+  eval(data.code);\n   return data;\n }",
    "title": "Add code execution feature",
    "provider": "github",
    "repo": "myorg/myrepo"
  }'
```

### Review with custom rules

```bash
curl -X POST http://localhost:8787/review \
  -H "Authorization: Bearer your-dev-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "diff": "diff --git a/api.ts b/api.ts\n--- a/api.ts\n+++ b/api.ts\n@@ -1,3 +1,5 @@\n+const API_KEY = \"sk-1234567890\";\n+\n export async function fetchData() {\n   return fetch(\"/api/data\");\n }",
    "rulesMd": "## Security Rules\n- Never allow hardcoded secrets\n- All API keys must come from environment variables"
  }'
```

## Deploy

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

Make sure you've set the `AUTH_TOKEN` secret before deploying:

```bash
wrangler secret put AUTH_TOKEN
```

## Notes

### Diff Length Truncation

Diffs longer than 60,000 characters are automatically truncated. The `meta.truncatedDiff` field in the response indicates if truncation occurred.

### Security

- The diff content is **never logged** to prevent leaking sensitive code.
- Always use a strong, unique `AUTH_TOKEN`.
- The token is stored as a Cloudflare secret, not in code.

### Future Steps

- GitHub/GitLab webhook integration
- Inline comment posting via GitHub/GitLab APIs
- Custom rule configuration via KV storage
- Review history via D1 database

## GitHub Actions Example (Documentation Only)

Here's an example workflow that calls the Diff-Sheriff API. This is for reference only - GitHub posting is not yet implemented.

```yaml
name: PR Review with Diff-Sheriff

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get diff
        id: diff
        run: |
          DIFF=$(git diff origin/${{ github.base_ref }}...HEAD)
          # Escape for JSON
          DIFF_ESCAPED=$(echo "$DIFF" | jq -Rs .)
          echo "diff=$DIFF_ESCAPED" >> $GITHUB_OUTPUT

      - name: Call Diff-Sheriff
        env:
          DIFF_SHERIFF_URL: ${{ secrets.DIFF_SHERIFF_URL }}
          DIFF_SHERIFF_TOKEN: ${{ secrets.DIFF_SHERIFF_TOKEN }}
        run: |
          curl -X POST "$DIFF_SHERIFF_URL/review" \
            -H "Authorization: Bearer $DIFF_SHERIFF_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
              "diff": ${{ steps.diff.outputs.diff }},
              "provider": "github",
              "repo": "${{ github.repository }}",
              "prNumber": ${{ github.event.pull_request.number }},
              "sha": "${{ github.event.pull_request.head.sha }}",
              "title": "${{ github.event.pull_request.title }}"
            }' | jq .
```

## License

MIT
