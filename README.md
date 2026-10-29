# claude-ollama-bridge

A local server that looks like [Ollama](https://ollama.com) and answers with your Claude Code CLI (`claude -p`, no tools, your own login). Point any Ollama client at it, e.g. Dossier's **Local model** provider.

```sh
node server.mjs            # http://127.0.0.1:11435
```

| Env | Default | |
|---|---|---|
| `PORT` | `11435` | |
| `HOST` | `127.0.0.1` | use `0.0.0.0` for clients in Docker (no auth; trusted networks only) |
| `MAX_CONCURRENCY` | `2` | parallel `claude` processes; others queue |
| `TIMEOUT_SECONDS` | `300` | per call |
| `MODELS` | `sonnet,opus,haiku` | names listed by `/api/tags` and passed to `claude --model` |
| `CLAUDE_BIN` | `claude` | |

Endpoints: `GET /api/version`, `GET /api/tags`, `POST /api/chat`, `POST /api/generate`. `format` (JSON schema) is put in the prompt. Streaming clients get the answer as one chunk. Sampling options are ignored.

**Dossier:** Settings → AI provider → Local model, address `http://host.docker.internal:11435` (or `http://localhost:11435` without Docker), then pick `sonnet`.

`node --test` runs the check.
