# Forge Agent

Extensão VS Code de **agentic coding** com **BYOK** (Bring Your Own Key).

O agent conversa no painel lateral, chama tools no seu workspace (ler/editar arquivos, buscar, terminal, diagnósticos) e usa a API key que você configurar — OpenAI, Anthropic ou qualquer endpoint OpenAI-compatible (OpenRouter, Groq, DeepSeek, Ollama, Azure…).

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
3. Ajuste em Settings:
   - `forgeAgent.provider` — `openai` | `anthropic` | `openai-compatible`
   - `forgeAgent.model` — ex. `gpt-4o`, `claude-sonnet-4-20250514`
   - `forgeAgent.baseUrl` — obrigatório para `openai-compatible`

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
  providers/            # OpenAI / Anthropic / compatible
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

## Roadmap sugerido

- Streaming token-a-token na UI
- Diff preview antes de aplicar edits
- Memória/regras por projeto (`.forge/rules.md`)
- MCP tools
- Modo plano → execução
