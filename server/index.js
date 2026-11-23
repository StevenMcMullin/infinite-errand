#!/usr/bin/env node
// The Infinite Errand - local stdio MCP shim.
//
// This is a thin client, not the service. The service itself is hosted and
// proprietary. This shim speaks MCP over stdio to a local client (Claude
// Desktop, Cursor, and similar), forwards each JSON-RPC message to the
// hosted MCP endpoint over HTTPS, and prints each response back on stdout.
// It holds no task logic, no scoring, and no state.
//
// Transport: newline-delimited JSON-RPC on stdin/stdout, the framing most
// stdio MCP clients use. Content-Length framed input is also accepted.
// Requires Node 18+ (global fetch). No dependencies.

const ENDPOINT =
  process.env.INFINITE_ERRAND_MCP_URL ||
  "https://infinite-errand.stevenmcmullin.workers.dev/mcp";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
}

// Extract the JSON-RPC payload from an HTTP response that may be plain
// JSON or an SSE stream (streamable HTTP servers may answer either way).
async function readPayload(res) {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get("content-type") || "";
  if (type.includes("text/event-stream")) {
    let payload = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        try { payload = JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
      }
    }
    return payload;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function forward(msg) {
  const isNotification = msg.id === undefined;
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "infinite-errand-mcp-shim/0.1.0",
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    if (!isNotification) sendError(msg.id, -32000, "Hosted endpoint unreachable: " + err.message);
    return;
  }
  // Notifications (for example notifications/initialized) get an empty
  // success from the hosted endpoint and expect no reply on stdio.
  if (isNotification) return;
  const payload = await readPayload(res);
  if (payload) {
    if (payload.id === undefined && msg.id !== undefined) payload.id = msg.id;
    send(payload);
  } else if (!res.ok) {
    sendError(msg.id, -32000, "Hosted endpoint returned HTTP " + res.status);
  } else {
    sendError(msg.id, -32000, "Hosted endpoint returned no JSON-RPC payload");
  }
}

// Input pump: accept newline-delimited messages, and also tolerate
// Content-Length framed messages. Messages are forwarded in order.
let buffer = Buffer.alloc(0);
let queue = Promise.resolve();

function enqueue(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  queue = queue.then(() => forward(msg)).catch(() => {});
}

function pump() {
  for (;;) {
    const text = buffer.toString("utf8");
    const headerEnd = text.indexOf("\r\n\r\n");
    if (text.startsWith("Content-Length:") && headerEnd !== -1) {
      const match = /Content-Length:\s*(\d+)/i.exec(text.slice(0, headerEnd));
      if (!match) { buffer = Buffer.alloc(0); return; }
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (Buffer.byteLength(text, "utf8") < bodyStart + len) return;
      const body = Buffer.from(text, "utf8").slice(bodyStart, bodyStart + len).toString("utf8");
      buffer = Buffer.from(text.slice(bodyStart + len), "utf8");
      enqueue(body);
      continue;
    }
    const nl = text.indexOf("\n");
    if (nl === -1) return;
    const line = text.slice(0, nl).trim();
    buffer = Buffer.from(text.slice(nl + 1), "utf8");
    if (line) enqueue(line);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
process.stdin.resume();
