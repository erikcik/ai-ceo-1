/**
 * A per-provider local adapter the wrapper starts on demand. Two modes:
 *
 * wire "anthropic" -- pass-through to an Anthropic-compatible backend, with
 * `"thinking":{"type":"disabled"}` injected into /v1/messages bodies (the
 * claude CLI's `--thinking disabled` OMITS the field, and open-weight backends
 * default thinking ON when it is absent).
 *
 * wire "openai" -- full request/response translation to an OpenAI
 * chat-completions backend, plus any `extraBody` the provider declares (e.g.
 * vLLM's `chat_template_kwargs.enable_thinking=false`, the only switch that
 * actually stops Qwen reasoning on OrcaRouter -- verified 2026-08-20: on the
 * Anthropic wire, `thinking:disabled`, `budget_tokens`, `/no_think`, and
 * `reasoning_effort` are all ignored for large prompts, and at ~18 tok/s an
 * unbounded reasoning trace stalls a session for 15-30 min per turn).
 * The upstream call is made non-streaming and a minimal Anthropic SSE stream
 * is fabricated from the finished response: with thinking off a turn is
 * seconds, so buffering one turn costs little and avoids incremental
 * stream-format translation entirely.
 *
 * The server binds an ephemeral localhost port inside the wrapper process and
 * dies with it (`unref` keeps it from holding the process open).
 */
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type ShimConfig = {
  upstreamBase: string;
  wire: "anthropic" | "openai";
  /** Merged into every upstream request body (openai wire only). */
  extraBody?: Record<string, unknown>;
};

const shims = new Map<string, Promise<string>>();

/** Returns a local base URL for this config, starting the server on first use. */
export function ensureShim(cfg: ShimConfig): Promise<string> {
  const key = JSON.stringify([cfg.upstreamBase, cfg.wire, cfg.extraBody ?? null]);
  let p = shims.get(key);
  if (!p) {
    p = start(cfg);
    shims.set(key, p);
  }
  return p;
}

async function start(cfg: ShimConfig): Promise<string> {
  const u = new URL(cfg.upstreamBase);
  const isHttps = u.protocol === "https:";

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (cfg.wire === "openai" && req.method === "POST" && req.url?.startsWith("/v1/messages")) {
        if (req.url.startsWith("/v1/messages/count_tokens")) return countTokens(body, res);
        return translate(cfg, u, isHttps, req, body, res);
      }
      // anthropic wire: inject thinking:disabled, forward everything else untouched
      let out = body;
      if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
        try {
          const j = JSON.parse(body.toString("utf-8"));
          j.thinking = { type: "disabled" };
          out = Buffer.from(JSON.stringify(j), "utf-8");
        } catch { /* not JSON -- forward as-is */ }
      }
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: u.host, "content-length": String(out.length) };
      const fwd = (isHttps ? https : http).request(
        { host: u.hostname, port: u.port || (isHttps ? 443 : 80), path: req.url, method: req.method, headers },
        (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
      );
      fwd.on("error", () => res.destroy());
      fwd.end(out);
    });
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  server.unref();
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("shim: could not determine listen port");
  return `http://127.0.0.1:${addr.port}`;
}

/** The CLI asks for token counts during context management; estimate rather than 404. */
function countTokens(body: Buffer, res: http.ServerResponse) {
  const tokens = Math.max(1, Math.ceil(body.length / 4));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: tokens }));
}

// ---------------------------------------------------------------------------
// Anthropic /v1/messages  ->  OpenAI /v1/chat/completions
// ---------------------------------------------------------------------------

function anthropicContentToOpenAI(content: unknown): { text: string; toolCalls: any[]; toolResults: any[] } {
  const text: string[] = [];
  const toolCalls: any[] = [];
  const toolResults: any[] = [];
  if (typeof content === "string") return { text: [content].filter(Boolean).join("\n"), toolCalls, toolResults };
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text") text.push(b.text);
      else if (b?.type === "thinking") { /* drop: never send reasoning back upstream */ }
      else if (b?.type === "tool_use") {
        toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      } else if (b?.type === "tool_result") {
        const inner = typeof b.content === "string"
          ? b.content
          : (Array.isArray(b.content) ? b.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "");
        toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: inner || "(no output)" });
      } else if (b?.type === "image" && b.source?.type === "base64") {
        text.push(`[image omitted: ${b.source.media_type}]`); // this wire is text-only; say so rather than drop silently
      }
    }
  }
  return { text: text.join("\n"), toolCalls, toolResults };
}

export function anthropicToOpenAI(a: any, extraBody?: Record<string, unknown>): any {
  const messages: any[] = [];
  const sys = typeof a.system === "string"
    ? a.system
    : Array.isArray(a.system) ? a.system.map((b: any) => b?.text ?? "").join("\n") : "";
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of a.messages ?? []) {
    const { text, toolCalls, toolResults } = anthropicContentToOpenAI(m.content);
    if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      // anthropic packs tool_result blocks into user turns; OpenAI wants them as role:"tool"
      for (const tr of toolResults) messages.push(tr);
      if (text) messages.push({ role: "user", content: text });
    }
  }

  const out: any = { model: a.model, max_tokens: a.max_tokens, messages, stream: false };
  if (a.temperature !== undefined) out.temperature = a.temperature;
  if (a.top_p !== undefined) out.top_p = a.top_p;
  if (a.stop_sequences?.length) out.stop = a.stop_sequences;
  if (a.tools?.length) {
    out.tools = a.tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } },
    }));
  }
  if (a.tool_choice?.type === "tool") out.tool_choice = { type: "function", function: { name: a.tool_choice.name } };
  return { ...out, ...(extraBody ?? {}) };
}

export function openAIToAnthropic(o: any, model: string): any {
  const choice = o.choices?.[0];
  const msg = choice?.message ?? {};
  const content: any[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  const stop = choice?.finish_reason === "tool_calls" ? "tool_use"
    : choice?.finish_reason === "length" ? "max_tokens"
    : "end_turn";
  return {
    id: o.id ?? "shim",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: o.usage?.prompt_tokens ?? 0,
      output_tokens: o.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Emit a finished anthropic message as a minimal, valid SSE stream. */
function writeSse(res: http.ServerResponse, m: any) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  ev("message_start", { type: "message_start", message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 0 } } });
  m.content.forEach((block: any, i: number) => {
    if (block.type === "text") {
      ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else {
      ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: m.usage.output_tokens } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

function translate(cfg: ShimConfig, u: URL, isHttps: boolean, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) {
  let a: any;
  try { a = JSON.parse(body.toString("utf-8")); } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "shim: request body is not JSON" } }));
  }
  const wantStream = a.stream === true;
  const oBody = Buffer.from(JSON.stringify(anthropicToOpenAI(a, cfg.extraBody)), "utf-8");
  const auth = req.headers["authorization"] ?? (req.headers["x-api-key"] ? `Bearer ${req.headers["x-api-key"]}` : undefined);

  const fwd = (isHttps ? https : http).request(
    {
      host: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: "/v1/chat/completions",
      method: "POST",
      headers: { host: u.host, "content-type": "application/json", "content-length": String(oBody.length), ...(auth ? { authorization: auth } : {}) },
    },
    (ur) => {
      const parts: Buffer[] = [];
      ur.on("data", (c) => parts.push(c));
      ur.on("end", () => {
        const raw = Buffer.concat(parts).toString("utf-8");
        let o: any;
        try { o = JSON.parse(raw); } catch {
          res.writeHead(502, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `shim: upstream sent non-JSON (status ${ur.statusCode})` } }));
        }
        if ((ur.statusCode ?? 500) >= 400 || o.error) {
          const msg = o?.error?.message ?? raw.slice(0, 300);
          res.writeHead(ur.statusCode ?? 502, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(msg) } }));
        }
        const m = openAIToAnthropic(o, a.model);
        if (wantStream) return writeSse(res, m);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(m));
      });
    },
  );
  fwd.on("error", (e) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `shim: upstream unreachable: ${e.message}` } }));
  });
  fwd.end(oBody);
}
