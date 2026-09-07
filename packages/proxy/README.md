# @office-agents/proxy

A minimal Cloudflare Worker that acts as a CORS proxy. It lets browser-based
Office Add-ins (which run inside a taskpane webview and are subject to CORS)
reach LLM providers whose API endpoints do **not** send CORS headers — notably
**opencode-go** (`https://opencode.ai/zen/go/v1`) and **Anthropic**
(`https://api.anthropic.com`).

Without a CORS proxy, requests from the taskpane to these providers fail with
an opaque **"Connection error"** because the browser blocks the cross-origin
response.

## How it works

The worker accepts a target URL in the `?url=<encoded>` query parameter (this
matches the format produced by `applyProxyToModel()` in
`@office-agents/sdk`). For example, when the OpenAI SDK requests
`https://api.opencode.ai/.../chat/completions`, the SDK first rewrites the
model `baseUrl` to:

```
https://<your-worker>.workers.dev/?url=https%3A%2F%2Fopencode.ai%2Fzen%2Fgo%2Fv1
```

and then appends the path, so the worker receives:

```
https://<your-worker>.workers.dev/?url=https%3A%2F%2Fopencode.ai%2Fzen%2Fgo%2Fv1/chat/completions
```

The worker:

1. Answers `OPTIONS` preflight requests with permissive CORS headers.
2. Reads the `url` query param (also supports a path-encoded target as a fallback).
3. Forwards the request (method, headers, streaming body) to the target.
4. Returns the upstream response with CORS headers added, streaming the body
   through unchanged so SSE streaming works.

## Deploy

`wrangler` is already available as a root dev dependency.

> **Note:** Do not use `pnpm deploy` — that is pnpm's built-in package-publish
> command, not wrangler's worker deploy. The script below (`publish:worker`)
> runs `wrangler deploy`.

```bash
# from repo root
pnpm --filter @office-agents/proxy publish:worker
# or, from inside packages/proxy/:
wrangler deploy
```

After the first deploy, note the worker URL printed by wrangler, e.g.
`https://office-agents-cors-proxy.<your-subdomain>.workers.dev`.

## Configure the add-in

Open the add-in **Settings** panel:

1. Set **Provider** to `opencode-go` (or `anthropic`).
2. Set your **API Key** and pick a **Model**.
3. Turn on **CORS Proxy** and enter the worker URL from the deploy step into
   **Proxy URL** (e.g. `https://office-agents-cors-proxy.<sub>.workers.dev`).

For CORS-restricted providers the proxy is auto-applied as long as a proxy URL
is present, so forgetting to flip the toggle is no longer fatal — but a proxy
URL is always required for these providers to work from the browser.

## Lock it down (recommended)

By default the worker is an open CORS proxy (any origin → any http(s) target).
Restrict it via `wrangler.toml` `[vars]` (or `wrangler secret` for production):

```toml
[vars]
ALLOWED_ORIGINS = "https://localhost:3000,https://localhost:3001,https://localhost:3002"
ALLOWED_TARGETS = "opencode.ai,api.anthropic.com"
```

- `ALLOWED_ORIGINS` — comma-separated allowed request `Origin`s. Unset = any.
- `ALLOWED_TARGETS` — comma-separated allowed upstream hostnames (or parent
  domains, e.g. `opencode.ai` also matches `www.opencode.ai`). Unset = any.

Redeploy after editing `wrangler.toml`.

## Local development

```bash
pnpm --filter @office-agents/proxy dev   # runs wrangler dev on http://localhost:8787
```

Point the add-in's **Proxy URL** at `http://localhost:8787` while testing.
