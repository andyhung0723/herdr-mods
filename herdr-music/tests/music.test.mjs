import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  formatSeconds,
  parsePlayerJson,
  getYtmStatus,
  sendYtmCommand,
} from "../mods/enhanced-music/player-state.js";

test("formatSeconds - formats seconds into mm:ss accurately", () => {
  assert.equal(formatSeconds(0), "00:00");
  assert.equal(formatSeconds(9), "00:09");
  assert.equal(formatSeconds(59), "00:59");
  assert.equal(formatSeconds(60), "01:00");
  assert.equal(formatSeconds(125), "02:05");
  assert.equal(formatSeconds(3599), "59:59");
  assert.equal(formatSeconds(-10), "00:00");
  assert.equal(formatSeconds(null), "00:00");
  assert.equal(formatSeconds(undefined), "00:00");
});

test("parsePlayerJson - parses full ytm JSON object", () => {
  const jsonOutput = JSON.stringify({
    playing: true,
    title: "Bad Guy",
    artist: "Billie Eilish",
    album: "WHEN WE ALL FALL ASLEEP, WHERE DO WE GO?",
    elapsed: 60,
    duration: 180,
  });

  const parsed = parsePlayerJson(jsonOutput);
  assert.equal(parsed.running, true);
  assert.equal(parsed.playing, true);
  assert.equal(parsed.title, "Bad Guy");
  assert.equal(parsed.artist, "Billie Eilish");
  assert.equal(parsed.elapsed, 60);
  assert.equal(parsed.duration, 180);
  assert.equal(parsed.percent, 33);
});

test("parsePlayerJson - handles offline / not running string", () => {
  const errorText = "Error: ytm-player is not running. Launch with `ytm` first.";
  const parsed = parsePlayerJson(errorText);
  assert.equal(parsed.running, false);
  assert.equal(parsed.playing, false);
  assert.equal(parsed.title, "");
});

test("parsePlayerJson - handles empty or null input", () => {
  const parsed = parsePlayerJson("");
  assert.equal(parsed.running, false);
  assert.equal(parsed.playing, false);
});

test("getYtmStatus - queries ytm CLI and returns parsed status", async () => {
  const mockExec = async (cmd, args) => {
    assert.equal(cmd, "/Users/dev/.local/bin/ytm");
    assert.deepEqual(args, ["now"]);
    return {
      code: 0,
      stdout: JSON.stringify({
        playing: true,
        title: "Stay",
        artist: "The Kid LAROI, Justin Bieber",
        elapsed: 45,
        duration: 135,
      }),
      stderr: "",
    };
  };

  const status = await getYtmStatus(mockExec);
  assert.equal(status.running, true);
  assert.equal(status.playing, true);
  assert.equal(status.title, "Stay");
  assert.equal(status.percent, 33);
});

test("sendYtmCommand - invokes ytm CLI with specified action", async () => {
  const calls = [];
  const mockExec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout: "ok", stderr: "" };
  };

  const res1 = await sendYtmCommand("play", mockExec);
  assert.equal(res1.ok, true);
  assert.deepEqual(calls[0].args, ["play"]);

  const res2 = await sendYtmCommand("next", mockExec);
  assert.equal(res2.ok, true);
  assert.deepEqual(calls[1].args, ["next"]);
});

test("enhanced-music - all required SVG assets exist", () => {
  const modDir = path.resolve(
    import.meta.dirname,
    "../mods/enhanced-music"
  );
  const required = [
    "music.svg",
    "play.svg",
    "pause.svg",
    "skip-forward.svg",
    "skip-back.svg",
    "heart.svg",
    "terminal.svg",
  ];

  for (const file of required) {
    const fullPath = path.join(modDir, file);
    assert.equal(fs.existsSync(fullPath), true, `File must exist: ${file}`);
    const content = fs.readFileSync(fullPath, "utf-8");
    assert.match(content, /<svg/);
  }
});
