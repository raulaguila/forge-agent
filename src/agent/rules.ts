import * as vscode from "vscode";

const RULE_CANDIDATES = [
  ".forge/rules.md",
  "AGENTS.md",
  ".cursorrules",
];

export async function loadProjectRules(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "";
  }
  const chunks: string[] = [];
  for (const rel of RULE_CANDIDATES) {
    try {
      const uri = vscode.Uri.joinPath(folder.uri, rel);
      const data = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(data).toString("utf8").trim();
      if (text) {
        chunks.push(`### ${rel}\n${text}`);
      }
    } catch {
      // missing is fine
    }
  }
  return chunks.join("\n\n");
}

export async function openProjectRules(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("Abra uma pasta no workspace.");
    return;
  }
  const uri = vscode.Uri.joinPath(folder.uri, ".forge/rules.md");
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const dir = vscode.Uri.joinPath(folder.uri, ".forge");
    await vscode.workspace.fs.createDirectory(dir);
    const starter =
      "# Forge Agent — regras do projeto\n\n" +
      "- Preferências de estilo, arquitetura e testes vão aqui.\n" +
      "- O agent lê este arquivo a cada sessão.\n";
    await vscode.workspace.fs.writeFile(uri, Buffer.from(starter, "utf8"));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}
