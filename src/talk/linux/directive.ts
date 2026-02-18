export type TalkDirective = {
  voiceId?: string;
  modelId?: string;
  rate?: number;
  speed?: number;
  stability?: number;
  similarity?: number;
  style?: number;
  speakerBoost?: boolean;
  seed?: number;
  normalize?: boolean;
  lang?: string;
  outputFormat?: string;
  latencyTier?: number;
  once?: boolean;
};

export const TalkDirectiveParser = {
  parse(text: string) {
    const lines = text.split("\n");
    const first = lines[0]?.trim();
    if (first?.startsWith("{") && first.endsWith("}")) {
      try {
        const obj = JSON.parse(first);
        const directive: TalkDirective = {
          voiceId: obj.voice || obj.voiceId || obj.voice_id,
          modelId: obj.model || obj.modelId || obj.model_id,
          rate: typeof obj.rate === "number" ? obj.rate : undefined,
          speed: typeof obj.speed === "number" ? obj.speed : undefined,
          stability: typeof obj.stability === "number" ? obj.stability : undefined,
          similarity: typeof obj.similarity === "number" ? obj.similarity : undefined,
          style: typeof obj.style === "number" ? obj.style : undefined,
          speakerBoost:
            typeof obj.speakerBoost === "boolean"
              ? obj.speakerBoost
              : typeof obj.speaker_boost === "boolean"
                ? obj.speaker_boost
                : undefined,
          seed: typeof obj.seed === "number" ? obj.seed : undefined,
          normalize: typeof obj.normalize === "boolean" ? obj.normalize : undefined,
          lang: typeof obj.lang === "string" ? obj.lang : undefined,
          outputFormat:
            typeof obj.output_format === "string"
              ? obj.output_format
              : typeof obj.outputFormat === "string"
                ? obj.outputFormat
                : undefined,
          latencyTier:
            typeof obj.latency_tier === "number"
              ? obj.latency_tier
              : typeof obj.latencyTier === "number"
                ? obj.latencyTier
                : undefined,
          once: !!obj.once,
        };
        return { directive, stripped: lines.slice(1).join("\n") };
      } catch {
        return { directive: null, stripped: text };
      }
    }
    return { directive: null, stripped: text };
  },
};