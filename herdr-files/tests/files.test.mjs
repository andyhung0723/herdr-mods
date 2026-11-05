import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanRelativePath,
  generateCopyName,
  createFile,
  createFolder,
  renamePath,
  deletePath,
  copyPath,
  movePath,
  revealInPathFinder,
} from "../mods/enhanced-files/fs-actions.js";

test("cleanRelativePath - handles normal and edge cases", () => {
  assert.equal(cleanRelativePath("foo/bar.js"), "foo/bar.js");
  assert.equal(cleanRelativePath("/foo/bar.js"), "foo/bar.js");
  assert.equal(cleanRelativePath("./foo/bar.js"), "foo/bar.js");
  assert.equal(cleanRelativePath("foo/../bar.js"), "bar.js");
  assert.equal(cleanRelativePath("../../../bar.js"), "bar.js");
  assert.equal(cleanRelativePath(""), "");
  assert.equal(cleanRelativePath(null), "");
});

test("generateCopyName - produces natural copy suffixes", () => {
  const existing = ["index.js", "app.py"];
  assert.equal(generateCopyName(existing, "index.js"), "index copy.js");

  const existingWithCopy = ["index.js", "index copy.js"];
  assert.equal(generateCopyName(existingWithCopy, "index.js"), "index copy 2.js");

  const existingMultiple = ["index.js", "index copy.js", "index copy 2.js"];
  assert.equal(generateCopyName(existingMultiple, "index.js"), "index copy 3.js");

  assert.equal(generateCopyName([], "folder"), "folder copy");
});

test("createFile - invokes shell with correct script and path", async () => {
  const calls = [];
  const mockExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "", stderr: "" };
  };

  const res = await createFile("/workspace", "src/components/Header.vue", mockExec);
  assert.equal(res.ok, true);
  assert.equal(res.path, "src/components/Header.vue");
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /mkdir -p.*touch/);
  assert.equal(calls[0].args[3], "/workspace/src/components/Header.vue");
});

test("createFile - throws on empty filename or error", async () => {
  const mockExec = async () => ({ code: 1, stderr: "Permission denied" });
  await assert.rejects(async () => createFile("/workspace", "", mockExec), /檔名不得為空/);
  await assert.rejects(async () => createFile("/workspace", "test.txt", mockExec), /Permission denied/);
});

test("createFolder - invokes shell to create directory", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: "" };
  };

  const res = await createFolder("/workspace", "src/hooks", mockExec);
  assert.equal(res.ok, true);
  assert.equal(res.path, "src/hooks");
  assert.match(calls[0][1], /mkdir -p "\$1"/);
});

test("renamePath - invokes shell to rename", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: "" };
  };

  const res = await renamePath("/workspace", "old.js", "new.js", mockExec);
  assert.equal(res.ok, true);
  assert.equal(res.newPath, "new.js");
  assert.match(calls[0][1], /mv "\$1" "\$2"/);
});

test("deletePath - calls trash/rm script", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push(args);
    return { code: 0, stdout: "" };
  };

  const res = await deletePath("/workspace", "junk.tmp", mockExec);
  assert.equal(res.ok, true);
  assert.match(calls[0][1], /trash "\$1"/);
});

test("copyPath and movePath - invoke shell correctly", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push(args[1]);
    return { code: 0, stdout: "" };
  };

  await copyPath("/workspace", "a.js", "b.js", mockExec);
  assert.match(calls[0], /cp -R/);

  await movePath("/workspace", "a.js", "c.js", mockExec);
  assert.match(calls[1], /mv "\$1"/);
});

test("revealInPathFinder - triggers Path Finder AppleScript", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push(args[1]);
    return { code: 0, stdout: "" };
  };

  const res = await revealInPathFinder("/workspace/file.js", mockExec);
  assert.equal(res.ok, true);
  assert.match(calls[0], /tell application "Path Finder"/);
});
