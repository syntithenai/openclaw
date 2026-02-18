import { spawn } from "node:child_process";

export async function* captureAudio(
  signal: AbortSignal,
  opts?: {
    device?: string;
    backend?: "pulseaudio" | "pipewire";
    onError?: (err: unknown) => void;
    onExit?: (code: number | null, signal?: NodeJS.Signals | null) => void;
  },
) {
  const backend = opts?.backend ?? "pulseaudio";
  const usePipewire = backend === "pipewire";
  const command = usePipewire ? "pw-record" : "parecord";
  const args = usePipewire
    ? ["--format", "s16", "--rate", "16000", "--channels", "1", "--raw", "-"]
    : ["--raw", "--format=s16le", "--rate=16000", "--channels=1"];
  if (!usePipewire && opts?.device) {
    args.push("--device", opts.device);
  }
  const proc = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  proc.on("error", (err) => opts?.onError?.(err));
  proc.on("exit", (code, sig) => opts?.onExit?.(code, sig));
  signal.addEventListener("abort", () => proc.kill("SIGTERM"));

  const stream = proc.stdout!;
  for await (const chunk of stream) {
    if (signal.aborted) break;
    yield new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
  }
}