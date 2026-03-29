// =============================================================================
// Server Group Node Component
// =============================================================================

import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import type { ServerGroupNodeData } from '../types';
import { serverColors, envColors } from '../utils/statusColors';

import './ServerGroupNode.css';

function ServerGroupNode({ data }: NodeProps<ServerGroupNodeData>) {
  const { server } = data;
  
  const borderColor = serverColors[server.color] || serverColors.gray;
  const envStyle = envColors[server.env as keyof typeof envColors] || envColors.test;
  
  const handleActionsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Open actions modal - will be handled by parent
    if (data.onServerAction) {
      data.onServerAction(server.id);
    }
  };
  
  // Count service statuses
  const okCount = server.services.filter(s => s.ok).length;
  const failCount = server.services.filter(s => !s.ok).length;
  
  return (
    <div 
      className="server-group-node"
      style={{ borderColor }}
    >
      {/* Header */}
      <div className="server-group-header">
        <div className="server-group-title">
          <span className="server-name">{server.name}</span>
          <span 
            className="server-env-badge"
            style={{ 
              backgroundColor: envStyle.bg,
              color: envStyle.text,
            }}
          >
            {server.env}
          </span>
        </div>
        
        <button 
          className="server-actions-btn"
          onClick={handleActionsClick}
          title="Действия с сервером"
        >
          ⚡
        </button>
      </div>
      
      {/* Status summary */}
      <div className="server-group-status">
        <span className="status-ok">✓ {okCount}</span>
        <span className="status-fail">✕ {failCount}</span>
        <span className="status-host">{server.ssh.host}</span>
      </div>
      
      {/* Handles for edges */}
      <Handle 
        type="target" 
        position={Position.Left} 
        className="server-handle"
      />
      <Handle 
        type="source" 
        position={Position.Right} 
        className="server-handle"
      />
    </div>
  );
}

export default memo(ServerGroupNode);
