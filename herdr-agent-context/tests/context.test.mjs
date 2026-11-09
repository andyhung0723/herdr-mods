import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(import.meta.dirname, "..");
const modDir = path.resolve(rootDir, "mods/enhanced-agent-context");
const collectorPy = path.resolve(modDir, "collector.py");

test("enhanced-agent-context - file structure exists", () => {
  assert.equal(fs.existsSync(path.resolve(modDir, "main.js")), true, "main.js exists");
  assert.equal(fs.existsSync(path.resolve(modDir, "collector.js")), true, "collector.js exists");
  assert.equal(fs.existsSync(collectorPy), true, "collector.py exists");
  assert.equal(fs.existsSync(path.resolve(modDir, "mod.json")), true, "mod.json exists");

  const modJson = JSON.parse(fs.readFileSync(path.resolve(modDir, "mod.json"), "utf-8"));
  assert.equal(modJson.place, "panel");
  assert.equal(modJson.title, "Agent Context");
});

test("enhanced-agent-context - collector.py outputs valid JSON schema", () => {
  const stdout = execFileSync("python3", [collectorPy, "--cwd", rootDir], { encoding: "utf-8" });
  assert.ok(stdout.length > 0, "collector output is not empty");

  const data = JSON.parse(stdout);
  assert.ok(data.cwd, "data contains cwd");
  assert.ok(Array.isArray(data.rules), "rules is an array");
  assert.ok(Array.isArray(data.skills), "skills is an array");
  assert.ok(Array.isArray(data.connectors), "connectors is an array");
  assert.ok(Array.isArray(data.plugins), "plugins is an array");
  assert.ok(data.summary, "data contains summary");
  assert.ok(data.models, "data contains models mapping");

  // Rules should detect global or project CLAUDE.md
  assert.ok(data.rules.length > 0, "rules array should have at least 1 rule");
  const claudeRule = data.rules.find((r) => r.name === "CLAUDE.md");
  assert.ok(claudeRule, "CLAUDE.md found in rules");
  assert.ok(claudeRule.lines > 0, "CLAUDE.md has line count");

  // Skills should detect existing skills
  assert.ok(data.skills.length > 0, "skills array should have items");
  const sampleSkill = data.skills[0];
  assert.ok(sampleSkill.name, "skill has name");
  assert.ok(sampleSkill.agent, "skill has agent");

  // Connectors should detect configured MCP servers
  assert.ok(data.connectors.length > 0, "connectors array should have items");
  const sampleConn = data.connectors[0];
  assert.ok(sampleConn.name, "connector has name");
  assert.ok(sampleConn.command, "connector has command");
});

test("enhanced-agent-context - collector.py filters context per active agent", () => {
  for (const agent of ["claude", "codex", "antigravity"]) {
    const stdout = execFileSync("python3", [collectorPy, "--cwd", rootDir, "--agent", agent], {
      encoding: "utf-8",
    });
    const data = JSON.parse(stdout);
    assert.equal(data.targetAgent, agent);
    for (const r of data.rules) {
      assert.equal(r.agent, agent, `Rule ${r.name} should belong to ${agent}`);
    }
    for (const s of data.skills) {
      assert.equal(s.agent, agent, `Skill ${s.name} should belong to ${agent}`);
    }
    for (const c of data.connectors) {
      assert.equal(c.agent, agent, `Connector ${c.name} should belong to ${agent}`);
    }
  }
});

test("enhanced-agent-context - main.js implements tab views and responsive narrow layout", () => {
  const content = fs.readFileSync(path.resolve(modDir, "main.js"), "utf-8");
  assert.match(content, /export default class EnhancedAgentContext extends View/);
  assert.match(content, /renderOverview/);
  assert.match(content, /renderRules/);
  assert.match(content, /renderSkills/);
  assert.match(content, /renderConnectors/);
  assert.match(content, /Agent Inspector/);

  // Responsive adaptive layout features
  assert.match(content, /getPanelWidth/);
  assert.match(content, /isNarrow/);
  assert.match(content, /isVeryNarrow/);
  assert.match(content, /\.min_w\(0\)/);
  assert.doesNotMatch(content, /overflow_x_scrollbar/);
});
