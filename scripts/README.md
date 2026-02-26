# How to run Qwen3-4B-Thinking-2507 locally

This application expects a local LLM API compatible with OpenAI Chat Completions API running at `http://localhost:11434/v1/chat/completions`.

This is the default port for **Ollama**.

## Prerequisites

1.  **Install Ollama**: [https://ollama.com/](https://ollama.com/)
2.  **Pull Embedding Model**:
    The application uses `nomic-embed-text` for vector embeddings.
    ```bash
    ollama pull nomic-embed-text
    ```
3.  **Run Chat Model**:
    You need to have `qwen3-4b-thinking-2507` available.
    
    If it's available in Ollama library:
    ```bash
    ollama run qwen3-4b-thinking-2507
    ```
    
    If you have a GGUF file, create a Modelfile:
    ```dockerfile
    FROM ./qwen3-4b-thinking-2507.gguf
    ```
    Then:
    ```bash
    ollama create qwen3-4b-thinking-2507 -f Modelfile
    ollama run qwen3-4b-thinking-2507
    ```

## Troubleshooting

-   **Embedding Failed**: Check if `nomic-embed-text` is pulled (`ollama list`).
-   **Chat Failed**: Check if `qwen3-4b-thinking-2507` is running or available.
-   **Port Issues**: Ensure Ollama is running on port 11434.
