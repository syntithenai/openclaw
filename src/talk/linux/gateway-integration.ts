import { platform } from "node:process";
import { LinuxTalkRuntime } from "./runtime.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("talk/linux");
let linuxTalkRuntime: LinuxTalkRuntime | null = null;

export function hasLinuxTalkRuntime() {
  return linuxTalkRuntime !== null;
}

export async function setLinuxTalkMode(enabled: boolean) {
  if (!linuxTalkRuntime) {
    return { ok: false, error: "linux talk runtime not initialized" };
  }
  await linuxTalkRuntime.setEnabled(enabled);
  return { ok: true };
}

/**
 * Initialize the Linux talk runtime if running on a Linux system
 */
export async function initializeLinuxTalkRuntime() {
  // Only initialize on Linux systems
  if (platform !== "linux") {
    log.info("Not running on Linux, skipping talk mode initialization");
    return;
  }

  log.info("Initializing Linux talk runtime for Linux system");
  
  try {
    const talkRuntime = new LinuxTalkRuntime();
    linuxTalkRuntime = talkRuntime;
    await talkRuntime.setEnabled(false);
    log.info("Linux talk runtime initialized successfully");
  } catch (error) {
    log.error(`Failed to initialize Linux talk runtime: ${String(error)}`);
  }
}