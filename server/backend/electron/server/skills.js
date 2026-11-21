// Skills CRUD on real .claude/skills/<name>/SKILL.md files in the workspace path.
import fs from "node:fs";
import path from "node:path";
import { T } from "./i18n.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function skillsDir(wsPath) {
  return path.join(wsPath, ".claude", "skills");
}

function skillDir(wsPath, name) {
  const dir = skillsDir(wsPath);
  const target = path.join(dir, name);
  // Confinement: the target folder must lie directly under .claude/skills.
  if (path.dirname(path.resolve(target)) !== path.resolve(dir)) {
    throw new Error(T("Invalid skill path"));
  }
  return target;
}

export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name) && name.length <= 64;
}

// Frontmatter of a SKILL.md. `allowed-tools` and `model` belong to the Claude Code format; they must be kept — otherwise an
// imported skill would silently LOSE its tool restriction, and nobody could see that it was ever there.
export function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const out = { name: "", description: "", allowedTools: "", model: "" };
  if (!m) return out;
  const block = m[1];
  const name = block.match(/^name:\s*(.+)$/m);
  const desc = block.match(/^description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:\s|\n*$)/m);
  // Both spellings: `allowed-tools` (Claude Code) and `allowed_tools`.
  const tools = block.match(/^allowed[-_]tools:\s*(.+)$/m);
  const model = block.match(/^model:\s*(.+)$/m);
  if (name) out.name = name[1].trim();
  if (desc) out.description = desc[1].trim().replace(/\n\s*/g, " ");
  // Lists may be written as "a, b" or as "[a, b]".
  if (tools) out.allowedTools = tools[1].trim().replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
  if (model) out.model = model[1].trim();
  return out;
}

export function buildSkillMd({ name, description, body, allowedTools = "", model = "" }) {
  const desc = String(description || "").replace(/\n+/g, " ").trim();
  const extra = [
    allowedTools ? `allowed-tools: ${allowedTools}` : "",
    model ? `model: ${model}` : "",
  ].filter(Boolean).map((l) => l + "\n").join("");
  return `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n${(body || "").trim()}\n`;
}

export function listSkills(wsPath) {
  const dir = skillsDir(wsPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const md = path.join(dir, e.name, "SKILL.md");
      let fm = { name: e.name, description: "" };
      if (fs.existsSync(md)) fm = { ...fm, ...parseFrontmatter(fs.readFileSync(md, "utf8")) };
      const refs = path.join(dir, e.name, "references");
      return {
        id: e.name,
        name: fm.name || e.name,
        description: fm.description,
        hasReferences: fs.existsSync(refs),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readSkill(wsPath, name) {
  const md = path.join(skillDir(wsPath, name), "SKILL.md");
  if (!fs.existsSync(md)) return null;
  const content = fs.readFileSync(md, "utf8");
  const fm = parseFrontmatter(content);
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  return { id: name, name: fm.name || name, description: fm.description, allowedTools: fm.allowedTools, model: fm.model, body, raw: content };
}

export function writeSkill(wsPath, name, { description, body, allowedTools = "", model = "" }) {
  if (!validName(name)) throw new Error(T("Skill name must be lowercase kebab-case (a-z, 0-9, -)"));
  const dir = skillDir(wsPath, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), buildSkillMd({ name, description, body, allowedTools, model }));
  return readSkill(wsPath, name);
}

export function deleteSkill(wsPath, name) {
  if (!validName(name)) throw new Error(T("Invalid name"));
  const dir = skillDir(wsPath, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
