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

## Instalação

### Do Marketplace / VSIX

1. Baixe o `.vsix` da [release](https://github.com/raulaguila/forge-agent/releases) ou gere com `npm run package`
2. VS Code → **Extensions: Install from VSIX…**
3. Recarregue a janela

### Dev

```bash
npm install
npm run compile
npm test
```

No VS Code/Cursor: **Run and Debug → Run Extension**.

## Documentação

- [Segurança](docs/SECURITY.md)
- [Solução de problemas](docs/TROUBLESHOOTING.md)
- [Changelog](CHANGELOG.md)

## Modos de autonomia

| Modo | Comportamento |
|------|----------------|
| `ask` | Só leitura — bloqueia write/terminal |
| `agent` | Writes abrem **diff nativo** e pedem aprovação antes de gravar |
| `auto` | Aplica writes automaticamente (terminal ainda pode pedir aprovação) |

Alterar: botão de modo no header do chat, command **Forge Agent: Cycle Autonomy Mode**, ou setting `forgeAgent.autonomy`.

## Configurar BYOK

1. Command Palette → **Forge Agent: Open Settings** (ou botão **Config** no chat)
2. Crie/ative um perfil, escolha provedor, base URL, modelo e cole a API key no formulário
3. Ajuste autonomia, aprovações, temperature e system prompt na mesma tela
4. Keys ficam no `SecretStorage` (nunca no `settings.json`)
5. Settings ainda espelham o perfil ativo (`forgeAgent.provider`, `model`, `baseUrl`, `tlsInsecure`, …)

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
- Mentions: `@arquivo`, `@pasta/`, `@selection`, `@active`
- Slash: `/explain`, `/review`, `/tests`, `/commit`, `/plan`, `/help`
- Regras do projeto: `.forge/rules.md` (também `AGENTS.md` / `.cursorrules`) — command **Open Project Rules**
- Histórico de sessões (Hist) e undo de checkpoint (Undo)

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

Ver [docs/SECURITY.md](docs/SECURITY.md). Resumo:

- Keys só no SecretStorage do VS Code
- Paths (tools + `@mentions`) restritos ao workspace (multi-root, realpath)
- Terminal com cwd no workspace e env reduzido
- Aprovação explícita para write/terminal (default ligado); timeout + diálogo do host
- `tlsInsecure` desliga verificação de certificado — use só em redes confiáveis

## Roadmap sugerido

- [x] Streaming token-a-token na UI
- [x] Diff preview antes de aplicar edits
- [x] Memória/regras por projeto (`.forge/rules.md`)
- [x] Modo plano → execução
- [x] Multi-provider profiles + model picker
- [x] Settings UI (perfis / keys / agent) sem QuickPicks
- [x] Sandbox / terminal jail / CI / compactação de contexto
- [ ] MCP tools
