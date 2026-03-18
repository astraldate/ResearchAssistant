export interface MirrorModelSpec {
  url: string;
  filename: string;
}

export const MIRROR_MODELS: Record<string, MirrorModelSpec> = {
  "nomic-embed-text": {
    url: "https://modelscope.cn/models/AI-ModelScope/nomic-embed-text-v1.5-GGUF/resolve/master/nomic-embed-text-v1.5.Q4_K_M.gguf",
    filename: "nomic-embed-text-v1.5.Q4_K_M.gguf",
  },
};

export const resolveMirrorModel = (name: string): MirrorModelSpec | null => {
  const normalized = name.trim();
  if (!normalized) return null;

  const exact = MIRROR_MODELS[normalized];
  if (exact) return exact;

  const base = normalized.split(":")[0];
  return MIRROR_MODELS[base] ?? null;
};
