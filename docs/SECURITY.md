# Segurança do Forge Agent

## Modelo de confiança

- **BYOK**: API keys ficam no `SecretStorage` do VS Code — não no `settings.json`.
- **Ask / Plan**: apenas tools de leitura.
- **Agent**: writes passam por diff + aprovação (salvo se você desligar `requireApprovalForWrites`).
- **Auto**: aplica writes sem pedir; terminal ainda respeita `requireApprovalForTerminal` por padrão.

## Sandbox de arquivos

Tools e `@mentions` só acessam paths dentro das pastas do workspace (multi-root). Symlinks que saem do workspace são rejeitados.

## Terminal

`run_terminal` executa com `cwd` na raiz do workspace e ambiente reduzido (sem copiar secrets óbvios do `process.env`). Mesmo assim, um comando aprovado pode alterar o disco — revise aprovações.

## O que fazer se algo parecer errado

1. Command Palette → **Forge Agent: Show Logs**
2. **Forge Agent: Repair Sidebar** se o chat estiver em branco
3. Troque para modo **Ask** para inspeção sem risco de escrita
4. **Forge Agent: Undo Last Checkpoint** após um write indesejado
