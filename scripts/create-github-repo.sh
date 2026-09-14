#!/usr/bin/env bash
# Cria o repositório GitHub e faz push da branch main.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-forge-agent}"
VISIBILITY="${2:-public}" # public | private

if ! gh auth status >/dev/null 2>&1; then
  echo "Faça login primeiro: gh auth login"
  exit 1
fi

gh repo create "$NAME" \
  --"$VISIBILITY" \
  --source=. \
  --remote=origin \
  --description "VS Code agentic coding extension with BYOK (OpenAI, compatible+TLS insecure, Ollama, Anthropic, Gemini)" \
  --push

OWNER="$(gh api user --jq .login)"
URL="https://github.com/${OWNER}/${NAME}"

# Atualiza package.json.repository se jq estiver disponível
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs=require('fs');
    const p=JSON.parse(fs.readFileSync('package.json','utf8'));
    p.repository={type:'git',url:'${URL}.git'};
    p.homepage='${URL}#readme';
    p.bugs={url:'${URL}/issues'};
    fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
  "
  git add package.json
  git commit -m "Add GitHub repository metadata" || true
  git push -u origin HEAD || true
fi

echo "Repositório: $URL"
