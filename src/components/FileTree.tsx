import React, { useState } from 'react';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';

export interface FileNode {
  id: string;
  name: string;
  path: string;
  type_name: 'file' | 'folder';
  children?: FileNode[];
}

const mockData: FileNode[] = [
  {
    id: '1',
    name: 'Research',
    path: '/mock/Research',
    type_name: 'folder',
    children: [
      { id: '1-1', name: 'Thesis Proposal.md', path: '/mock/Research/Thesis Proposal.md', type_name: 'file' },
    ],
  },
];

interface FileTreeProps {
  data?: FileNode[];
  onSelect?: (file: FileNode) => void;
}

const FileTreeNode: React.FC<{ node: FileNode; level: number; onSelect?: (file: FileNode) => void }> = ({
  node,
  level,
  onSelect,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isActive, setIsActive] = useState(false);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type_name === 'folder') {
      setIsOpen(!isOpen);
    } else {
      setIsActive(true); 
      onSelect?.(node);
    }
  };

  return (
    <div>
      <div
        className={`tree-item ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: `${level * 12 + 12}px` }}
        onClick={handleToggle}
      >
        <span style={{ display: 'flex', alignItems: 'center', width: '16px', marginRight: '4px' }}>
          {node.type_name === 'folder' && (
            isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          )}
        </span>
        
        {node.type_name === 'folder' ? (
          <Folder size={14} className="icon" color="#6c757d" fill="#6c757d" fillOpacity={0.2} />
        ) : (
          <File size={14} className="icon" color="#6c757d" />
        )}
        
        <span style={{ marginLeft: '6px' }}>{node.name}</span>
      </div>
      
      {node.type_name === 'folder' && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode key={child.id} node={child} level={level + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: React.FC<FileTreeProps> = ({ data, onSelect }) => {
  const displayData = data || mockData;
  return (
    <div className="file-tree">
      {displayData.map((node) => (
        <FileTreeNode key={node.id} node={node} level={0} onSelect={onSelect} />
      ))}
    </div>
  );
};
