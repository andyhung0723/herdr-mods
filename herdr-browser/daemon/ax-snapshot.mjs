// Compact accessibility-tree snapshot with element refs.
//
// Output is one line per meaningful node, indented by depth:
//   - link "Docs" [ref=e3]
//   - textbox "Email" value="a@b.c" [ref=e7]
// Refs map to backend DOM node ids so click/type can target them directly,
// without the agent having to invent CSS selectors.

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "listbox",
]);

const STRUCTURAL_ROLES = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak", "RootWebArea"]);

const MAX_LINES = 1500;
const MAX_TEXT = 120;

function clip(text) {
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TEXT ? `${oneLine.slice(0, MAX_TEXT)}…` : oneLine;
}

function propertyValue(node, name) {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function isInteractive(node, role) {
  return INTERACTIVE_ROLES.has(role) || propertyValue(node, "focusable") === true;
}

export function renderAxSnapshot(nodes, { url, title }) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const refs = new Map();
  const lines = [`url: ${url}`, `title: ${title}`, ""];
  let truncated = false;

  const visit = (node, depth, parentName) => {
    if (!node || truncated) return;
    const role = node.role?.value ?? "";
    const name = clip(node.name?.value ?? "");
    const isText = role === "StaticText";
    const redundantText = isText && (!name || name === parentName);
    const printable = !node.ignored && !redundantText && (isText || !STRUCTURAL_ROLES.has(role));

    let nextDepth = depth;
    let nextParentName = parentName;
    if (printable) {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      const parts = [isText ? "text" : role];
      if (name) parts.push(JSON.stringify(name));
      const value = node.value?.value;
      if (value !== undefined && value !== "" && !isText) parts.push(`value=${JSON.stringify(clip(value))}`);
      if (propertyValue(node, "checked") !== undefined) parts.push(`checked=${propertyValue(node, "checked")}`);
      if (propertyValue(node, "disabled") === true) parts.push("disabled");
      if (!isText && node.backendDOMNodeId && isInteractive(node, role)) {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        parts.push(`[ref=${ref}]`);
      }
      lines.push(`${"  ".repeat(depth)}- ${parts.join(" ")}`);
      nextDepth = depth + 1;
      nextParentName = name;
    }
    for (const childId of node.childIds ?? []) visit(byId.get(childId), nextDepth, nextParentName);
  };

  visit(root, 0, "");
  if (truncated) lines.push(`… truncated at ${MAX_LINES} lines; scroll or navigate to narrow the page`);
  return { text: lines.join("\n"), refs };
}
