# Forge Agent

Extensão VS Code de **agentic coding** com **BYOK** (Bring Your Own Key).

Provedores suportados:

| Provider | Auth | Base URL | Notas |
|----------|------|----------|-------|
| `openai` | API key | `https://api.openai.com/v1` | Oficial |
| `openai-compatible` | API key | **obrigatória** (`…/v1`) | OpenRouter, Groq, DeepSeek, Azure, proxies; **TLS insecure** opcional |
| `ollama` | opcional | `http://localhost:11434` | API nativa `/api/chat` + tools |
| `anthropic` | API key | `https://api.anthropic.com` | Claude |
| `gemini` | API key | `https://generativelanguage.googleapis.com/v1beta` | Function calling |

## Instalação (dev)

```bash
npm install
npm run compile
```

No VS Code/Cursor: **Run and Debug → Run Extension** (abre uma janela Extension Development Host).

Para gerar `.vsix`:

```bash
npm run package
```

## Configurar BYOK

1. Command Palette → **Forge Agent: Set API Key (BYOK)**
2. Escolha o provedor e cole a key (fica no `SecretStorage`, não no `settings.json`)
3. Settings úteis:
   - `forgeAgent.provider` — `openai` \| `openai-compatible` \| `ollama` \| `anthropic` \| `gemini`
   - `forgeAgent.model` — ex. `gpt-4o`, `claude-sonnet-4-20250514`, `gemini-2.0-flash`, `llama3.1`
   - `forgeAgent.baseUrl` — obrigatório para `openai-compatible`
   - `forgeAgent.tlsInsecure` — `true` para HTTPS com certificado self-signed (proxies corporativos)

### Exemplos

**OpenAI-compatible + TLS insecure**
```json
{
  "forgeAgent.provider": "openai-compatible",
  "forgeAgent.baseUrl": "https://llm.empresa.local/v1",
  "forgeAgent.model": "gpt-4o",
  "forgeAgent.tlsInsecure": true
}
```

**Ollama**
```json
{
  "forgeAgent.provider": "ollama",
  "forgeAgent.baseUrl": "http://localhost:11434",
  "forgeAgent.model": "llama3.1"
}
```

**Gemini**
```json
{
  "forgeAgent.provider": "gemini",
  "forgeAgent.model": "gemini-2.0-flash"
}
```

## Uso

- Ícone **Forge Agent** na Activity Bar → chat
- `Forge Agent: Explain Selection` / `Edit Selection with Agent` no menu de contexto
- Writes e terminal pedem aprovação (configurável)

## Tools do agent

| Tool | Risco | Função |
|------|-------|--------|
| `read_file` | read | Ler arquivo |
| `write_file` | write | Criar/sobrescrever |
| `apply_edit` | write | Patch por trecho exato |
| `list_dir` | read | Listar pasta |
| `search` | read | Regex no workspace |
| `run_terminal` | terminal | Shell |
| `get_diagnostics` | read | Erros do language service |
| `get_open_editors` | read | Editores visíveis |
| `get_selection` | read | Seleção atual |

## Arquitetura

```
src/
  extension.ts          # ativação + commands
  config.ts             # settings
  types.ts
  secrets/keys.ts       # BYOK via SecretStorage
  providers/            # OpenAI / compatible / Ollama / Anthropic / Gemini
  agent/
    session.ts          # loop agentic (LLM ↔ tools)
    tools.ts            # implementação das tools
  webview/              # ChatViewProvider + UI
media/                  # ícone + assets do webview
```

## Segurança

- Keys só no SecretStorage do VS Code
- Paths das tools restritos à raiz do workspace
- Aprovação explícita para write/terminal (default ligado)
- `tlsInsecure` desliga verificação de certificado — use só em redes confiáveis

## Roadmap sugerido

- Streaming token-a-token na UI
- Diff preview antes de aplicar edits
- Memória/regras por projeto (`.forge/rules.md`)
- MCP tools
- Modo plano → execução
