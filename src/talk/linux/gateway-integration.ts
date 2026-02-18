import { platform } from "node:process";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { LinuxTalkRuntime } from "./runtime.js";

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

export function getLinuxTalkStatus() {
  if (!linuxTalkRuntime) {
    return { ok: false, error: "linux talk runtime not initialized" };
  }
  return { ok: true, status: linuxTalkRuntime.getStatus() };
}

export async function setVoiceWakeMode(enabled: boolean) {
  if (!linuxTalkRuntime) {
    return { ok: false, error: "linux talk runtime not initialized" };
  }
  await linuxTalkRuntime.setVoiceWakeEnabled(enabled);
  return { ok: true };
}

export function getVoiceWakeStatus() {
  if (!linuxTalkRuntime) {
    return { ok: false, error: "linux talk runtime not initialized" };
  }
  return { ok: true, status: linuxTalkRuntime.getVoiceWakeStatus() };
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
    const cfg = loadConfig();
    const autoStart = cfg.talk?.autoStart === true;
    await talkRuntime.setEnabled(autoStart);
    log.info("Linux talk runtime initialized successfully");
  } catch (error) {
    log.error(`Failed to initialize Linux talk runtime: ${String(error)}`);
  }
}