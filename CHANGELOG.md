# Changelog

All notable changes to Forge Agent are documented here.

## [0.16.2] — 2026-09-15

- Feat: janela de contexto por modelo — extrai da API (OpenRouter/`context_length`, Gemini `inputTokenLimit`, Ollama `/api/show`, etc.), usa mapa curado ou padrão 128k, e permite editar no perfil

## [0.16.0] — 2026-03-24

### Security
- Workspace path sandbox with realpath / multi-root checks for tools, mentions, diffs, and checkpoints
- Terminal runs are cwd-jailed to the workspace with scrubbed environment variables

### Reliability
- Approval requests time out and fall back to a host dialog (no infinite hang)
- HTTP stream requests retry on 429/5xx before the body starts
- Agent message history is compacted to stay within context limits
- Session resume replays tool activity, not only chat text
- Saved sessions truncate large tool payloads

### UX
- Chunked deltas for non-SSE providers so the UI feels responsive
- Durable checkpoints across extension reloads
- Correlation IDs in the Forge Agent output channel

### Engineering
- Unit tests (`npm test`) and CI workflow template in `docs/github-ci.yml`
- Packaging metadata for Marketplace releases
- Copy `docs/github-ci.yml` → `.github/workflows/ci.yml` (requires GitHub `workflow` scope)

## [0.15.14] — 2026-03-24

- Fix: opening a session from Recents no longer appends the Histórico card

## [0.15.13] — 2026-03-24

- Feat: last 5 sessions on the home screen

## [0.15.12] — 2026-03-24

- Fix: remember active editor when the chat webview steals focus

## [0.15.11] — 2026-03-24

- Feat: GFM markdown tables in chat

## [0.15.10] — 2026-03-24

- Fix: tool activity group stays collapsed unless the user opens it

## [0.15.0–0.15.9]

- Codex-style UI, settings editor panel, Ask/Plan/Agent/Auto, Ollama tools, sidebar recovery
