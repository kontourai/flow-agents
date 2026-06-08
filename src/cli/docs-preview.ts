import * as fs from "node:fs";
import * as path from "node:path";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function titleFor(file: string, text: string): string {
  return text.match(/^title:\s*(.+)$/m)?.[1].trim() ?? text.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() ?? path.basename(file, ".md").replace(/-/g, " ");
}

function render(text: string): string {
  return text.replace(/^---\n.*?\n---\n/s, "").split(/\r?\n/).map((line) => {
    if (line.startsWith("# ")) return `<h1>${esc(line.slice(2).trim())}</h1>`;
    if (line.startsWith("## ")) return `<h2>${esc(line.slice(3).trim())}</h2>`;
    if (line.startsWith("- ")) return `<li>${esc(line.slice(2).trim())}</li>`;
    return line.trim() ? `<p>${esc(line.trim())}</p>` : "";
  }).join("\n");
}

export function main(): number {
  const root = path.resolve(path.dirname(process.argv[1]), "..");
  const docs = path.join(root, "docs");
  const out = path.join(root, "_site");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const assets = path.join(docs, "assets");
  if (fs.existsSync(assets)) fs.cpSync(assets, path.join(out, "assets"), { recursive: true });
  for (const file of fs.readdirSync(docs).filter((name) => name.endsWith(".md")).sort()) {
    const source = path.join(docs, file);
    const text = fs.readFileSync(source, "utf8");
    const title = titleFor(file, text);
    fs.writeFileSync(path.join(out, `${path.basename(file, ".md")}.html`), `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="assets/site.css"></head><body>${render(text)}<script src="assets/site.js" defer></script></body></html>`, "utf8");
  }
  console.log(`Built local docs preview: ${out}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
