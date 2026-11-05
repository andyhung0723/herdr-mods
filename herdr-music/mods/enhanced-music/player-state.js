/**
 * Helpers and status parsing for ytm-player (YouTube Music CLI)
 */

export function formatSeconds(totalSeconds) {
  if (typeof totalSeconds !== "number" || isNaN(totalSeconds) || totalSeconds < 0) {
    return "00:00";
  }
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.floor(totalSeconds % 60);
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function parsePlayerJson(rawOutput) {
  if (!rawOutput || typeof rawOutput !== "string") {
    return {
      running: false,
      playing: false,
      title: "",
      artist: "",
      album: "",
      elapsed: 0,
      duration: 0,
      percent: 0,
    };
  }

  try {
    const data = JSON.parse(rawOutput.trim());
    const running = true;
    const playing = Boolean(data.playing ?? data.is_playing ?? (data.state === "playing"));
    const title = data.title ?? data.track ?? data.song ?? "Unknown Track";
    const artist = data.artist ?? data.author ?? data.channel ?? "Unknown Artist";
    const album = data.album ?? "";
    const elapsed = Number(data.elapsed ?? data.progress ?? data.position ?? 0);
    const duration = Number(data.duration ?? data.total ?? 0);
    const percent = duration > 0 ? Math.min(100, Math.max(0, Math.round((elapsed / duration) * 100))) : 0;

    return {
      running,
      playing,
      title,
      artist,
      album,
      elapsed,
      duration,
      percent,
    };
  } catch {
    // If not valid JSON, check if it contains status text
    if (rawOutput.includes("not running")) {
      return {
        running: false,
        playing: false,
        title: "",
        artist: "",
        album: "",
        elapsed: 0,
        duration: 0,
        percent: 0,
      };
    }
    return {
      running: true,
      playing: true,
      title: rawOutput.trim().slice(0, 40),
      artist: "YouTube Music",
      album: "",
      elapsed: 0,
      duration: 0,
      percent: 0,
    };
  }
}

export async function getYtmStatus(execFn) {
  const ytmBin = "/Users/dev/.local/bin/ytm";
  try {
    const res = await execFn(ytmBin, ["now"]);
    if (res.code === 0 && res.stdout) {
      return parsePlayerJson(res.stdout);
    }
    // Fallback to `ytm status`
    const statusRes = await execFn(ytmBin, ["status"]);
    if (statusRes.code === 0 && statusRes.stdout) {
      return parsePlayerJson(statusRes.stdout);
    }
    return {
      running: false,
      playing: false,
      title: "",
      artist: "",
      album: "",
      elapsed: 0,
      duration: 0,
      percent: 0,
    };
  } catch {
    return {
      running: false,
      playing: false,
      title: "",
      artist: "",
      album: "",
      elapsed: 0,
      duration: 0,
      percent: 0,
    };
  }
}

export async function sendYtmCommand(action, execFn) {
  const ytmBin = "/Users/dev/.local/bin/ytm";
  try {
    const res = await execFn(ytmBin, [action]);
    return { ok: res.code === 0, code: res.code, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
