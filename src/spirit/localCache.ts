import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContextState } from "./workerClient";

const CACHE_PATH = join(homedir(), ".fire-spirit", "last-state.json");

export async function saveLastState(state: ContextState): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

export async function loadLastState(): Promise<ContextState | null> {
  try {
    const txt = await readFile(CACHE_PATH, "utf-8");
    return JSON.parse(txt) as ContextState;
  } catch {
    return null;
  }
}
