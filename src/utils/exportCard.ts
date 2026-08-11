import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

interface KnowledgeCardDetail {
  markdown: string;
}

const getFileName = (path: string) => path.split(/[\\/]/).pop() || path;

export const exportKnowledgeCardMarkdown = async (
  cardPath: string,
  fallbackName?: string,
) => {
  const destination = await save({
    defaultPath: fallbackName || getFileName(cardPath),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (!destination || typeof destination !== "string") {
    return null;
  }

  const detail = await invoke<KnowledgeCardDetail>("read_knowledge_card", {
    cardPath: cardPath,
  });
  await invoke("write_text_file", {
    path: destination,
    content: detail.markdown,
  });
  return destination;
};
