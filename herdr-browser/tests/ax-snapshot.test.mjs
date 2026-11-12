import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAxSnapshot } from "../daemon/ax-snapshot.mjs";

const node = (nodeId, role, name, extra = {}) => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

test("renders compact tree, assigns refs to interactive nodes, drops redundant text", () => {
  const nodes = [
    node("1", "RootWebArea", "Page", { childIds: ["2", "5"] }),
    node("2", "generic", "", { parentId: "1", childIds: ["3"] }),
    node("3", "link", "Docs", { parentId: "2", childIds: ["4"], backendDOMNodeId: 30 }),
    node("4", "StaticText", "Docs", { parentId: "3" }),
    node("5", "textbox", "Email", { parentId: "1", backendDOMNodeId: 50, value: { value: "a@b.c" } }),
    node("6", "button", "Hidden", { parentId: "1", ignored: true }),
  ];
  const { text, refs } = renderAxSnapshot(nodes, { url: "http://x/", title: "Page" });
  const lines = text.split("\n");

  assert.ok(lines.includes('- link "Docs" [ref=e1]'), text);
  assert.ok(lines.includes('- textbox "Email" value="a@b.c" [ref=e2]'), text);
  assert.ok(!text.includes('text "Docs"'), "text equal to parent name is redundant");
  assert.ok(!text.includes("Hidden"), "ignored nodes are skipped");
  assert.deepEqual([...refs], [["e1", 30], ["e2", 50]]);
});
