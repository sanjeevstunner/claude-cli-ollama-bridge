#!/usr/bin/env node
// Looks like Ollama to anything that speaks its API; every chat is answered by
// `claude -p` (your Claude Code login), run without tools.
// Env: PORT (11435), HOST (127.0.0.1), CLAUDE_BIN, MAX_CONCURRENCY (2),
// TIMEOUT_SECONDS (300), MODELS (comma list, default sonnet,opus,haiku).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const cfg = () => ({
  port: Number(process.env.PORT ?? 11435),
  host: process.env.HOST ?? "127.0.0.1",
  claude: process.env.CLAUDE_BIN ?? "claude",
  concurrency: Number(process.env.MAX_CONCURRENCY ?? 2),
  timeoutMs: Number(process.env.TIMEOUT_SECONDS ?? 300) * 1000,
  models: (process.env.MODELS ?? "sonnet,opus,haiku").split(",").map((m) => m.trim()).filter(Boolean),
});
const MAX_BODY = 4 * 1024 * 1024;

// Claude Code processes are heavy; the rest wait their turn.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active < max && queue.length) {
      active++;
      queue.shift()();
    }
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push(() => task().then(resolve, reject).finally(() => { active--; next(); }));
      next();
    });
}

/** One `claude -p` run. `messages` are Ollama's: {role, content}. */
export function runClaude({ claude, timeoutMs }, { model, messages, schema, signal }) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content);
  if (schema) system.push(`Answer with only JSON that matches this JSON schema, no other text:\n${JSON.stringify(schema)}`);
  const turns = messages.filter((m) => m.role !== "system");
  const prompt = turns.length === 1 ? turns[0].content : turns.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");
  const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config"];
  if (model) args.push("--model", model);
  if (system.length) args.push("--system-prompt", system.join("\n\n"));

  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { signal, timeout: timeoutMs });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(e.code === "ENOENT" ? new Error(`Can't find the Claude Code CLI ("${claude}"). Install it and log in.`) : e));
    child.on("close", (code) => {
      let r;
      try { r = JSON.parse(out); } catch { return reject(new Error((err || out || `claude exited with ${code}`).slice(0, 500))); }
      if (r.is_error) return reject(new Error(String(r.result ?? "Claude Code failed").slice(0, 500)));
      resolve({ text: String(r.result ?? ""), input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 });
    });
    child.stdin.end(prompt);
  });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((size += chunk.length) > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw Object.assign(new Error("Body isn't JSON"), { status: 400 }); }
}

export function createBridge(config = cfg(), run = runClaude) {
  const limit = limiter(config.concurrency);
  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
      if (req.method === "GET" && path === "") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("Ollama is running"); }
      if (req.method === "GET" && path === "/api/version") return json(res, 200, { version: "0.0.0-claude-bridge" });
      if (req.method === "GET" && path === "/api/tags") {
        const now = new Date().toISOString();
        return json(res, 200, { models: config.models.map((name) => ({ name, model: name, modified_at: now, size: 0, digest: "", details: { family: "claude" } })) });
      }
      if (req.method !== "POST" || (path !== "/api/chat" && path !== "/api/generate")) return json(res, 404, { error: "not found" });

      const body = await readJson(req);
      const messages = path === "/api/chat"
        ? body.messages
        : [...(body.system ? [{ role: "system", content: body.system }] : []), { role: "user", content: body.prompt }];
      if (!Array.isArray(messages) || messages.length === 0 || messages.some((m) => typeof m?.content !== "string")) return json(res, 400, { error: "messages are required" });

      // Cancelled when the client hangs up, so abandoned calls don't keep a CLI running.
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const schema = body.format && typeof body.format === "object" ? body.format : undefined;
      const started = Date.now();
      const answer = await limit(() => run(config, { model: body.model, messages, schema, signal: abort.signal }));

      const base = { model: body.model, created_at: new Date().toISOString() };
      const done = { done: true, done_reason: "stop", total_duration: (Date.now() - started) * 1e6, prompt_eval_count: answer.input, eval_count: answer.output };
      const piece = path === "/api/chat" ? { message: { role: "assistant", content: answer.text } } : { response: answer.text };
      if (body.stream === false) return json(res, 200, { ...base, ...piece, ...done });
      // Streaming clients get the whole answer as one chunk, then the end.
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ ...base, ...piece, done: false }) + "\n");
      res.end(JSON.stringify({ ...base, ...(path === "/api/chat" ? { message: { role: "assistant", content: "" } } : { response: "" }), ...done }) + "\n");
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = cfg();
  createBridge(config).listen(config.port, config.host, () => {
    console.log(`Claude Code bridge, Ollama-style, on http://${config.host}:${config.port}`);
    if (config.host !== "127.0.0.1") console.warn("Warning: reachable beyond localhost with no authentication; anyone who can connect can use your Claude Code.");
  });
}
