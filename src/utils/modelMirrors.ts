export interface MirrorCandidate {
  url: string;
  filename: string;
}

export interface MirrorModelSpec {
  url: string;
  filename: string;
  candidates?: MirrorCandidate[];
}

export const MIRROR_MODELS: Record<string, MirrorModelSpec> = {
  "qwen3:8b": {
    url: "https://modelscope.cn/models/unsloth/Qwen3-8B-GGUF/resolve/master/Qwen3-8B-Q4_K_M.gguf",
    filename: "Qwen3-8B-Q4_K_M.gguf",
    candidates: [
      {
        url: "https://modelscope.cn/models/unsloth/Qwen3-8B-GGUF/resolve/master/Qwen3-8B-Q4_K_M.gguf",
        filename: "Qwen3-8B-Q4_K_M.gguf",
      },
      {
        url: "https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
        filename: "Qwen3-8B-Q4_K_M.gguf",
      },
    ],
  },
  qwen3: {
    url: "https://modelscope.cn/models/unsloth/Qwen3-8B-GGUF/resolve/master/Qwen3-8B-Q4_K_M.gguf",
    filename: "Qwen3-8B-Q4_K_M.gguf",
    candidates: [
      {
        url: "https://modelscope.cn/models/unsloth/Qwen3-8B-GGUF/resolve/master/Qwen3-8B-Q4_K_M.gguf",
        filename: "Qwen3-8B-Q4_K_M.gguf",
      },
      {
        url: "https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf",
        filename: "Qwen3-8B-Q4_K_M.gguf",
      },
    ],
  },
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
