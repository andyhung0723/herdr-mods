import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("enhanced-tabs - main.js renders Git and Music buttons", () => {
  const mainPath = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-tabs/main.js"
  );
  assert.equal(fs.existsSync(mainPath), true, "main.js must exist");
  const content = fs.readFileSync(mainPath, "utf-8");

  // Verify 'Changes' is replaced with 'Git' and uses 'icons/git.svg'
  assert.match(
    content,
    /panelButton\("changes",\s*"Git",\s*"icons\/git\.svg"\)/
  );
  assert.doesNotMatch(
    content,
    /panelButton\("changes",\s*"Changes",\s*"mods\/changes\/changes\.svg"\)/
  );

  // Verify Music button is present
  assert.match(
    content,
    /panelButton\("music",\s*"Music",\s*"mods\/enhanced-music\/music\.svg"\)/
  );

  // Verify Agent button is present
  assert.match(
    content,
    /panelButton\("context",\s*"Agent",\s*"mods\/workspace-chrome\/layers\.svg"\)/
  );
});

test("enhanced-tabs - mod.json exists and has valid place", () => {
  const modJsonPath = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-tabs/mod.json"
  );
  assert.equal(fs.existsSync(modJsonPath), true, "mod.json must exist");
  const data = JSON.parse(fs.readFileSync(modJsonPath, "utf-8"));
  assert.equal(data.place, "none");
});

test("git icon asset exists in home icons directory", () => {
  const homeIconPath = path.resolve(
    process.env.HOME,
    ".config/herdr-app/icons/git.svg"
  );
  assert.equal(fs.existsSync(homeIconPath), true, "icons/git.svg must exist");
  const svgContent = fs.readFileSync(homeIconPath, "utf-8");
  assert.match(svgContent, /<svg/);
  assert.match(svgContent, /viewBox="0 0 24 24"/);
});
