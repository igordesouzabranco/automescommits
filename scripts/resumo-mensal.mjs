/* global process */

// Resumo mensal do GitHub -> webhook do Make -> post no LinkedIn
// Roda com Node 20+ (usa fetch nativo, sem dependências).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const USER = process.env.GITHUB_USER || "igordesouzabranco";
const TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK = process.env.MAKE_WEBHOOK_URL;
// Definidos automaticamente pelo GitHub Actions
const REPO = process.env.GITHUB_REPOSITORY; // ex.: igordesouzabranco/automescommits
const BRANCH = process.env.GITHUB_REF_NAME || "main";
const APRENDIZADO = (process.env.APRENDIZADO || "").trim();
const DRY_RUN = process.env.DRY_RUN === "true" || !WEBHOOK;

// Linguagens que não valem como "stack" no post
const IGNORAR_LINGUAGENS = new Set(["Dockerfile", "Shell"]);

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 409) return []; // repositório vazio
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status} em ${path}`);
  return res.json();
}

async function ghPaginado(path) {
  const itens = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const sep = path.includes("?") ? "&" : "?";
    const dados = await gh(`${path}${sep}per_page=100&page=${pagina}`);
    itens.push(...dados);
    if (dados.length < 100) break;
  }
  return itens;
}

// Mês anterior, de 00:00 a 00:00 no horário de Brasília (UTC-3)
const agora = new Date();
const inicio = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1, 3));
const fim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1, 3));
const nomeMes = inicio.toLocaleDateString("pt-BR", {
  month: "long",
  timeZone: "America/Sao_Paulo",
});

const plural = (n, singular, pluralTxt) => `${n} ${n === 1 ? singular : pluralTxt}`;

// Salva o resumo em data/resumos/AAAA-MM.json (o workflow faz o commit)
function salvarJson(dados) {
  const arquivo = `data/resumos/${inicio.toISOString().slice(0, 7)}.json`;
  mkdirSync("data/resumos", { recursive: true });
  writeFileSync(
    arquivo,
    JSON.stringify(
      { mes: nomeMes, gerado_em: new Date().toISOString(), ...dados },
      null,
      2
    ) + "\n"
  );
  console.log(`Resumo salvo em ${arquivo}`);
}

// Sorteia uma imagem da pasta imagens/cobras do repositório.
// Se a pasta não existir ou estiver vazia, o post sai só com texto.
function sortearCobra() {
  const pasta = "imagens/cobras";
  if (!REPO || !existsSync(pasta)) return null;

  const arquivos = readdirSync(pasta).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (arquivos.length === 0) return null;

  const arquivo = arquivos[Math.floor(Math.random() * arquivos.length)];
  return {
    arquivo,
    // Link direto do arquivo no GitHub (funciona em repositório público)
    url: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${pasta}/${encodeURIComponent(arquivo)}`,
  };
}

async function main() {
  // /users/:user/repos devolve só repositórios públicos
  const todos = await ghPaginado(`/users/${USER}/repos?type=owner&sort=pushed`);
  const repos = todos.filter(
    (r) => !r.fork && !r.archived && new Date(r.pushed_at) >= inicio
  );

  const ativos = [];
  for (const r of repos) {
    const commits = await ghPaginado(
      `/repos/${USER}/${r.name}/commits?author=${USER}` +
        `&since=${inicio.toISOString()}&until=${fim.toISOString()}`
    );
    const criado = new Date(r.created_at);
    const novo = criado >= inicio && criado < fim;
    if (commits.length > 0 || novo) {
      ativos.push({ nome: r.name, commits: commits.length, novo });
    }
  }

  const totalCommits = ativos.reduce((soma, r) => soma + r.commits, 0);
  const novos = ativos.filter((r) => r.novo);

  if (ativos.length === 0) {
    // Salva mesmo sem atividade: o commit mantém o repositório ativo
    salvarJson({ atividade: false, projetos: [], stacks: [], total_commits: 0 });
    console.log(`Sem atividade em ${nomeMes}. Nenhum post gerado.`);
    return;
  }

  // Stacks: soma os bytes por linguagem nos repos ativos
  const bytesPorLinguagem = {};
  for (const r of ativos) {
    const langs = await gh(`/repos/${USER}/${r.nome}/languages`);
    for (const [lang, bytes] of Object.entries(langs)) {
      if (IGNORAR_LINGUAGENS.has(lang)) continue;
      bytesPorLinguagem[lang] = (bytesPorLinguagem[lang] || 0) + bytes;
    }
  }
  const stacks = Object.entries(bytesPorLinguagem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([lang]) => lang);

  const maisAtivos = ativos
    .filter((r) => r.commits > 0)
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 3)
    .map((r) => `${r.nome} (${plural(r.commits, "commit", "commits")})`);

  const linhas = [`Resumo de ${nomeMes} 🚀`, ""];
  if (novos.length) {
    linhas.push(
      `📦 ${novos.length === 1 ? "Projeto novo" : "Projetos novos"}: ${novos
        .map((r) => r.nome)
        .join(", ")}`
    );
  }
  if (maisAtivos.length) linhas.push(`🔧 Mais ativos: ${maisAtivos.join(", ")}`);
  if (stacks.length) linhas.push(`🧰 Stacks do mês: ${stacks.join(", ")}`);
  linhas.push(`📈 Total: ${plural(totalCommits, "commit", "commits")}`);
  if (APRENDIZADO) linhas.push(`💡 O que mais aprendi: ${APRENDIZADO}`);
  linhas.push("", `github.com/${USER}`);

  const texto = linhas.join("\n");
  console.log(texto);

  const imagem = sortearCobra();
  if (imagem) console.log(`\n🐍 Imagem sorteada: ${imagem.url}`);
  else console.log("\nNenhuma imagem em imagens/cobras: post só com texto.");

  salvarJson({
    atividade: true,
    projetos: ativos,
    stacks,
    total_commits: totalCommits,
    texto,
    imagem,
  });

  if (DRY_RUN) {
    console.log("\n[DRY RUN] Nada foi enviado ao Make.");
    return;
  }

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tipo: "resumo-mensal",
      mes: nomeMes,
      texto,
      imagem_url: imagem?.url ?? "",
    }),
  });
  if (!res.ok) throw new Error(`Make respondeu ${res.status}`);
  console.log("\nEnviado ao Make com sucesso.");
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});