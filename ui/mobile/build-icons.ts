// Copies Material Icon Theme (the icon set VS Code users see in Explorer) into the maw UI dir
// and writes a slim name→icon manifest for m.html. Run: bun ui/mobile/build-icons.ts
import { generateManifest } from "material-icon-theme";
import { cpSync, mkdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";

const out = join(process.env.MAW_UI_DIR ?? join(homedir(), ".maw/ui/dist"), "icons");
const m: any = generateManifest();
const icon = (id: string) => basename(m.iconDefinitions[id]?.iconPath ?? "", ".svg");
const map = (o: Record<string, string> = {}) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), icon(v)]));
// extension → VS Code language id, for files Material matches by language instead of extension
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", mjs: "javascript", cjs: "javascript",
  md: "markdown", json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", py: "python", html: "html", css: "css", scss: "scss",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", xml: "xml", sql: "sql", php: "php", rb: "ruby",
  vue: "vue", txt: "plaintext", ini: "ini", toml: "toml", lua: "lua", r: "r", dart: "dart", gradle: "groovy", groovy: "groovy",
};
const lang = Object.fromEntries(Object.entries(EXT_LANG).map(([e, l]) => [e, m.languageIds?.[l] ? icon(m.languageIds[l]) : ""]).filter(([, v]) => v));
mkdirSync(out, { recursive: true });
cpSync(join(import.meta.dir, "../../node_modules/material-icon-theme/icons"), out, { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify({
  file: icon(m.file), folder: icon(m.folder), folderOpen: icon(m.folderExpanded),
  fileNames: map(m.fileNames), fileExtensions: map(m.fileExtensions), lang,
  folderNames: map(m.folderNames), folderNamesOpen: map(m.folderNamesExpanded),
}));
console.log("icons →", out);
