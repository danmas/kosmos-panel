// =============================================================================
// Service Details Panel Component
// =============================================================================

import type { SelectedService, Dependency } from '../types';
import { getStatusIcon, getStatusText, serviceTypeIcons, dependencyColors } from '../utils/statusColors';

import './ServiceDetailsPanel.css';

interface ServiceDetailsPanelProps {
  selected: SelectedService | null;
  onClose: () => void;
}

export default function ServiceDetailsPanel({ selected, onClose }: ServiceDetailsPanelProps) {
  if (!selected) return null;
  
  const { service, server, dependencies } = selected;
  const statusIcon = getStatusIcon(service.ok);
  const statusText = getStatusText(service.ok);
  const typeIcon = serviceTypeIcons[service.type] || '📦';
  
  const handleOpenUrl = () => {
    if (service.url) {
      window.open(service.url, '_blank', 'noopener,noreferrer');
    }
  };
  
  const handleOpenTerminal = () => {
    const termUrl = `/term.html?mode=terminal&serverId=${encodeURIComponent(server.id)}`;
    window.open(termUrl, '_blank', 'width=900,height=600');
  };
  
  const handleOpenWorkspace = () => {
    const workspaceUrl = `/workspace.html?serverId=${encodeURIComponent(server.id)}`;
    window.open(workspaceUrl, '_blank', 'width=1200,height=800');
  };
  
  const handleCopySSH = () => {
    const sshCmd = `ssh ${server.ssh.user}@${server.ssh.host} -p ${server.ssh.port || 22}`;
    navigator.clipboard.writeText(sshCmd).then(() => {
      alert('SSH команда скопирована!');
    });
  };
  
  const handleShowLog = async () => {
    if (!service.hasLogs) return;
    
    try {
      const res = await fetch(`/api/service-log?serverId=${selected.serverId}&serviceId=${service.id}`);
      const data = await res.json();
      
      if (data.success) {
        // Show log in alert (or could open a modal)
        alert(data.log || '(пустой лог)');
      } else {
        alert('Ошибка: ' + data.error);
      }
    } catch (err) {
      alert('Ошибка загрузки лога');
    }
  };
  
  return (
    <div className="service-details-panel">
      {/* Header */}
      <div className="panel-header">
        <h3 className="panel-title">{service.name}</h3>
        <button className="panel-close" onClick={onClose}>×</button>
      </div>
      
      {/* Status */}
      <div className="panel-section">
        <div className={`panel-status ${service.ok ? 'ok' : 'fail'}`}>
          <span className="status-icon">{statusIcon}</span>
          <span className="status-text">{statusText}</span>
        </div>
        <div className="panel-detail">{service.detail}</div>
      </div>
      
      {/* Info */}
      <div className="panel-section">
        <div className="panel-row">
          <span className="row-label">Тип:</span>
          <span className="row-value">{typeIcon} {service.type}</span>
        </div>
        <div className="panel-row">
          <span className="row-label">Сервер:</span>
          <span className="row-value">{server.name}</span>
        </div>
        {service.url && (
          <div className="panel-row">
            <span className="row-label">URL:</span>
            <a href={service.url} target="_blank" rel="noopener noreferrer" className="row-link">
              {service.url}
            </a>
          </div>
        )}
        {service.description && (
          <div className="panel-description">{service.description}</div>
        )}
      </div>
      
      {/* Dependencies */}
      {dependencies && dependencies.length > 0 && (
        <div className="panel-section">
          <h4 className="section-title">Зависимости</h4>
          <div className="dependencies-list">
            {dependencies.map((dep: Dependency) => (
              <div 
                key={dep.targetServiceId} 
                className="dependency-item"
                style={{ borderLeftColor: dependencyColors[dep.type] }}
              >
                <span className="dep-target">{dep.targetServiceId}</span>
                <span className="dep-type">{dep.type}</span>
                {dep.required && <span className="dep-required">required</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* Actions */}
      <div className="panel-section panel-actions">
        {service.url && (
          <button className="action-btn" onClick={handleOpenUrl}>
            🔗 Открыть URL
          </button>
        )}
        {service.hasLogs && (
          <button className="action-btn" onClick={handleShowLog}>
            📜 Показать лог
          </button>
        )}
        <button className="action-btn" onClick={handleOpenTerminal}>
          💻 Терминал
        </button>
        <button className="action-btn" onClick={handleOpenWorkspace}>
          ⚡ Workspace
        </button>
        <button className="action-btn" onClick={handleCopySSH}>
          📎 Скопировать SSH
        </button>
      </div>
    </div>
  );
}
