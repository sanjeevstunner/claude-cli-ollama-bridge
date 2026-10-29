import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge } from "./server.mjs";

const fake = async (_cfg, { model, messages, schema }) => ({ text: JSON.stringify({ model, n: messages.length, schema: Boolean(schema) }), input: 1, output: 2 });

test("speaks enough Ollama for Dossier", async () => {
  const server = createBridge({ concurrency: 1, models: ["sonnet"] }, fake);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(url + path, { method: "POST", body: JSON.stringify(body) });
  try {
    assert.equal(typeof (await (await fetch(`${url}/api/version`)).json()).version, "string");
    assert.equal((await (await fetch(`${url}/api/tags`)).json()).models[0].name, "sonnet");

    const chat = await (await post("/api/chat", { model: "sonnet", stream: false, format: { type: "object" }, messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] })).json();
    assert.deepEqual(JSON.parse(chat.message.content), { model: "sonnet", n: 2, schema: true });
    assert.equal(chat.done, true);

    const lines = (await (await post("/api/chat", { model: "sonnet", messages: [{ role: "user", content: "hi" }] })).text()).trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].done, true);

    assert.equal((await post("/api/chat", { model: "sonnet" })).status, 400);
  } finally {
    server.close();
  }
});
