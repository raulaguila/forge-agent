# Solução de problemas

## Chat em branco / sidebar vazia

1. `Forge Agent: Repair Sidebar`
2. `Forge Agent: Open Chat in Editor`
3. `Forge Agent: Show Logs` — procure `Resolving chat webview` / erros de boot
4. Reset View Locations no VS Code, depois reabra o ícone Forge

## “Nenhum arquivo aberto” / não acha o arquivo ativo

Foque o arquivo no editor **antes** de clicar no chat. O Forge lembra o último editor de código, mas precisa tê-lo visto ao menos uma vez na sessão.

## Provider / API key

1. `Forge Agent: Open Settings`
2. Confirme perfil, base URL (`…/v1` para compatible) e key
3. Ollama: modelo com suporte a tools; veja logs se arguments falharem

## Agent travado em “aguardando”

Aprovações expiram (~2 min) e também aparecem como diálogo do VS Code. Use **Recusar** ou **Stop**.

## Chat longo falha no meio

O Forge compacta contexto automaticamente. Ainda assim, **New Chat** periodicamente ajuda com modelos de janela pequena.
