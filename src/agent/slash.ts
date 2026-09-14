export interface SlashCommand {
  name: string;
  description: string;
  /** If set, expands user text into this prompt template. Use {input} placeholder. */
  template: string;
  /** Optional autonomy override for this command. */
  autonomy?: "ask" | "plan" | "agent" | "auto";
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "fix",
    description: "Explicar código ou conceito no workspace",
    template:
      "Explique com clareza:\n{input}\n\nUse tools de leitura se precisar inspecionar o código.",
    autonomy: "ask",
  },
  {
    name: "review",
    description: "Revisar código em busca de bugs/riscos",
    template:
      "Faça uma code review focada em bugs, segurança e clareza:\n{input}\n\nListe achados por severidade.",
    autonomy: "ask",
  },
  {
    name: "tests",
    description: "Escrever ou melhorar testes",
    template:
      "Adicione ou melhore testes para:\n{input}\n\nSiga o estilo de testes do projeto e rode-os se possível.",
    autonomy: "agent",
  },
  {
    name: "commit",
    description: "Sugerir mensagem de commit a partir do diff",
    template:
      "Analise as mudanças atuais (git status/diff) e sugira uma mensagem de commit Conventional Commits em português ou inglês curto.\n{input}",
    autonomy: "ask",
  },
  {
    name: "plan",
    description: "Gerar plano antes de executar",
    template: "{input}",
    autonomy: "plan",
  },
  {
    name: "help",
    description: "Listar comandos slash",
    template:
      "Liste os comandos disponíveis do Forge Agent (/fix /review /tests /commit /plan) e explique brevemente cada um.\n{input}",
    autonomy: "ask",
  },
];

export function parseSlash(text: string): {
  command?: SlashCommand;
  rest: string;
} {
  const m = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) {
    return { rest: text };
  }
  const name = m[1].toLowerCase();
  const command = SLASH_COMMANDS.find((c) => c.name === name);
  if (!command) {
    return { rest: text };
  }
  return { command, rest: (m[2] || "").trim() };
}

export function expandSlash(command: SlashCommand, rest: string): string {
  return command.template.replace(/\{input\}/g, rest || "(sem detalhes extras)");
}
