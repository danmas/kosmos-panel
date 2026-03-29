// =============================================================================
// Service Node Component
// =============================================================================

import { memo, useState } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import type { ServiceNodeData } from '../types';
import { statusColors, serviceTypeIcons, getStatusIcon } from '../utils/statusColors';

import './ServiceNode.css';

function ServiceNode({ data }: NodeProps<ServiceNodeData>) {
  const { service, serverId } = data;
  const [showTooltip, setShowTooltip] = useState(false);
  
  const statusColor = service.ok ? statusColors.ok : statusColors.fail;
  const typeIcon = serviceTypeIcons[service.type] || '📦';
  const statusIcon = getStatusIcon(service.ok);
  
  const handleClick = () => {
    if (data.onServiceClick) {
      data.onServiceClick(serverId, service.id);
    }
  };
  
  return (
    <div 
      className="service-node"
      onClick={handleClick}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Status indicator */}
      <div 
        className="service-status-indicator"
        style={{ backgroundColor: statusColor }}
      />
      
      {/* Content */}
      <div className="service-content">
        <div className="service-header">
          <span className="service-icon">{statusIcon}</span>
          <span className="service-name">{service.name}</span>
        </div>
        <div className="service-meta">
          <span className="service-type">
            {typeIcon} {service.type}
          </span>
          {service.url && (
            <a 
              href={service.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="service-link"
              onClick={(e) => e.stopPropagation()}
              title="Открыть в новой вкладке"
            >
              🔗
            </a>
          )}
        </div>
      </div>
      
      {/* Tooltip */}
      {showTooltip && (
        <div className="service-tooltip">
          <div className="tooltip-title">{service.name}</div>
          <div className="tooltip-status">
            {statusIcon} {service.ok ? 'Работает' : 'Не работает'}
          </div>
          <div className="tooltip-detail">{service.detail}</div>
          {service.description && (
            <div className="tooltip-description">{service.description}</div>
          )}
          {service.url && (
            <div className="tooltip-url">{service.url}</div>
          )}
        </div>
      )}
      
      {/* Handles for edges */}
      <Handle 
        type="target" 
        position={Position.Left} 
        className="service-handle"
      />
      <Handle 
        type="source" 
        position={Position.Right} 
        className="service-handle"
      />
    </div>
  );
}

export default memo(ServiceNode);
