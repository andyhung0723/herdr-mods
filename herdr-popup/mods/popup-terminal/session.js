const LABEL = "herdr.popup-terminal";

export function shellContext(focus, spaces) {
  const space = spaces.find((item) => item.id === focus?.space);
  if (!space) throw new Error("請先選擇工作空間");

  const localId = space.id.split("/").pop();
  return {
    space: space.id,
    machine: space.machine ?? null,
    name: `popup-${localId.replace(/[^a-z0-9_-]/gi, "").toLowerCase().slice(-24)}`,
    cwd: focus.cwd || space.folder || null,
    returnTerminal: focus.shown ?? focus.terminal ?? null,
  };
}

function addressOnMachine(address, machine) {
  if (typeof address !== "string" || !address) {
    throw new Error("herdr-core 未回傳有效的 terminal address");
  }
  if (machine && !address.includes("/")) return `${machine}/${address}`;
  if (address.includes("/") && address.split("/")[0] !== machine) {
    throw new Error("herdr-core 回傳的 terminal 不在目前工作空間的機器上");
  }
  return address;
}

function resultData(result, operation) {
  if (result.code !== 0) {
    throw new Error(`${operation}：${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.code}`}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${operation}：herdr-core 回傳了無效的 JSON`);
  }
}

export async function ensureShell(context, hc) {
  const target = context.machine ? `${context.machine}/${context.name}` : context.name;
  const lookup = await hc(["get", target, "--json"]);
  if (lookup.code !== 3) {
    const data = resultData(lookup, "無法查詢 popup shell");
    const terminal = data.terminal ?? data;
    if (terminal.state === "live") {
      if (terminal.labels?.[LABEL] !== context.space) {
        throw new Error(`終端名稱 ${target} 已被其他工作占用`);
      }
      return addressOnMachine(terminal.address, context.machine);
    }
    if (terminal.state !== "finished") {
      throw new Error("無法辨識 popup shell 的狀態，未建立重複終端機");
    }
  }

  const args = [
    "run", "--bg", "--json", "--no-parent", "--keep",
    "--name", context.name,
    "--label", `${LABEL}=${context.space}`,
  ];
  if (context.machine) args.push("--on", context.machine);
  if (context.cwd) args.push("--cwd", context.cwd);
  const created = resultData(await hc(args), "無法啟動 popup shell");
  return addressOnMachine(created.address, context.machine);
}

export function terminalOverlay(terminal, context) {
  return {
    kind: "dialog",
    width: 0.82,
    height: 0.72,
    layout: {
      type: "column",
      children: [
        {
          type: "block",
          size: { px: 36 },
          content: {
            mod: "popup-terminal",
            props: { role: "header", terminal, returnTerminal: context.returnTerminal },
          },
        },
        { type: "block", content: { terminal } },
      ],
    },
  };
}
