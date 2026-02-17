export function createVad() {
  const silenceWindowMs = 700;
  const minSpeechRms = 5e-6;
  const speechBoostFactor = 1.0;
  let noiseFloor = 1e-4;
  let lastTranscript = "";

  return {
    note(chunk: Int16Array) {
      const rms = computeRms(chunk);
      const alpha = rms < noiseFloor ? 0.08 : 0.01;
      noiseFloor = Math.max(1e-7, noiseFloor + (rms - noiseFloor) * alpha);
      const threshold = Math.max(minSpeechRms, noiseFloor * speechBoostFactor);
      return { speech: rms >= threshold * 0.9, rms, threshold };
    },
    shouldInterrupt(lastSpoken: string) {
      return lastSpoken.length > 3;
    },
    hasTranscript() {
      return !!lastTranscript;
    },
    getTranscript() {
      return lastTranscript;
    },
    finalizeTranscript(current: string) {
      lastTranscript = "";
      return current.trim() || null;
    },
    shouldFinalize(lastHeardAt: number | null) {
      if (!lastHeardAt) return false;
      return Date.now() - lastHeardAt >= silenceWindowMs;
    },
  };
}

function computeRms(chunk: Int16Array) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const sample = chunk[i] / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, chunk.length));
}