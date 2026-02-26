import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Download, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  details: any;
}

interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (model: string) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ currentModel, onModelChange }) => {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [isPulling, setIsPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = async () => {
    try {
      const list = await invoke<OllamaModel[]>('get_ollama_models');
      setModels(list);
      // If current model is not set or not in list, set to first available or keep empty
      if (!currentModel && list.length > 0) {
        onModelChange(list[0].name);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError('Failed to connect to Ollama');
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  useEffect(() => {
    const unlisten = listen<PullProgress>('pull-progress', (event) => {
      setPullProgress(event.payload);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handlePullModel = async () => {
    if (!newModelName.trim()) return;
    
    setIsPulling(true);
    setPullProgress({ status: 'Starting download...' });
    setError(null);

    try {
      await invoke('pull_ollama_model', { name: newModelName });
      setNewModelName('');
      await fetchModels();
      onModelChange(newModelName); // Switch to new model
    } catch (err) {
      console.error('Pull failed:', err);
      setError(`Pull failed: ${err}`);
    } finally {
      setIsPulling(false);
      setPullProgress(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="model-selector-container" style={{ padding: '16px', borderTop: '1px solid var(--border-color)' }}>
      <div className="model-selector-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>MODEL</span>
        <button 
          onClick={() => setIsOpen(!isOpen)} 
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <span style={{ fontSize: '0.9rem' }}>{currentModel || 'Select Model'}</span>
          {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {isOpen && (
        <div className="model-list" style={{ marginBottom: '12px', maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
          {models.map((model) => (
            <div 
              key={model.digest} 
              onClick={() => {
                onModelChange(model.name);
                setIsOpen(false);
              }}
              style={{ 
                padding: '8px', 
                cursor: 'pointer', 
                backgroundColor: currentModel === model.name ? 'var(--bg-tertiary)' : 'transparent',
                fontSize: '0.9rem'
              }}
            >
              {model.name} <span style={{ color: '#999', fontSize: '0.8em' }}>({formatBytes(model.size)})</span>
            </div>
          ))}
          {models.length === 0 && <div style={{ padding: '8px', color: '#999' }}>No models found</div>}
        </div>
      )}

      <div className="pull-model-form" style={{ display: 'flex', gap: '8px' }}>
        <input 
          type="text" 
          placeholder="Pull model (e.g. llama3)" 
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          disabled={isPulling}
          style={{ 
            flex: 1, 
            padding: '6px', 
            borderRadius: '4px', 
            border: '1px solid var(--border-color)',
            fontSize: '0.9rem'
          }}
        />
        <button 
          onClick={handlePullModel} 
          disabled={isPulling || !newModelName.trim()}
          style={{ 
            padding: '6px 10px', 
            borderRadius: '4px', 
            border: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            cursor: isPulling ? 'not-allowed' : 'pointer'
          }}
        >
          {isPulling ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
        </button>
      </div>

      {pullProgress && (
        <div className="pull-progress" style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <div>{pullProgress.status}</div>
          {pullProgress.total && pullProgress.completed && (
            <div style={{ width: '100%', height: '4px', background: '#eee', marginTop: '4px', borderRadius: '2px' }}>
              <div 
                style={{ 
                  width: `${(pullProgress.completed / pullProgress.total) * 100}%`, 
                  height: '100%', 
                  background: 'var(--text-accent)',
                  borderRadius: '2px',
                  transition: 'width 0.2s'
                }} 
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ marginTop: '8px', fontSize: '0.8rem', color: '#dc3545' }}>
          {error}
        </div>
      )}
    </div>
  );
};
