import { useState } from "react";
// @ts-ignore
import { Panel, Group, Separator } from "react-resizable-panels";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FileTree, FileNode } from "./components/FileTree";
import { ChatInterface } from "./components/ChatInterface";
import { ModelSelector } from "./components/ModelSelector";
import { FolderOpen } from "lucide-react";
import "./App.css";

function App() {
  // const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [isIngesting, setIsIngesting] = useState(false);
  const [currentModel, setCurrentModel] = useState<string>('');

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === "string") {
        console.log("Selected path:", selected);
        // Scan directory
        const fileTree = await invoke<FileNode>("scan_directory", { path: selected });
        // The backend returns a single root node, wrap in array
        setFiles([fileTree]);

        // Start Ingest
        setIsIngesting(true);
        try {
          const count = await invoke<number>("ingest_knowledge_base", { path: selected });
          console.log(`Ingested ${count} documents`);
        } catch (e) {
          console.error("Ingestion failed:", e);
        } finally {
          setIsIngesting(false);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="app-container">
      {/* @ts-ignore */}
      <Group direction="horizontal"> 
        <Panel 
          defaultSize={300} 
          minSize={250} 
          maxSize={600} 
          collapsible={false}
          className="sidebar-panel"
        >
          <div className="sidebar">
            <div className="sidebar-header">
              <span>Files</span>
              <button 
                onClick={handleOpenFolder} 
                className="icon-button" 
                title="Open Folder"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
              >
                <FolderOpen size={16} />
              </button>
            </div>
            {isIngesting && (
              <div style={{ padding: "8px", fontSize: "0.8rem", color: "#666" }}>
                Processing knowledge base...
              </div>
            )}
            <FileTree data={files.length > 0 ? files : undefined} />
            <ModelSelector currentModel={currentModel} onModelChange={setCurrentModel} />
          </div>
        </Panel>
        
        <Separator className="PanelResizeHandle" />
        
        <Panel>
          <ChatInterface currentModel={currentModel} />
        </Panel>
      </Group>
    </div>
  );
}

export default App;
