export type TalkDirective = {
  voiceId?: string;
  modelId?: string;
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