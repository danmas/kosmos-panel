// =============================================================================
// Control Panel Component
// =============================================================================

import type { FilterState } from '../types';

import './ControlPanel.css';

interface ControlPanelProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  lastUpdate: number;
  onRefresh: () => void;
  onFitView: () => void;
  onCollapseAll?: () => void;
}

export default function ControlPanel({
  filters,
  onFiltersChange,
  lastUpdate,
  onRefresh,
  onFitView,
}: ControlPanelProps) {
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, search: e.target.value });
  };
  
  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onFiltersChange({ ...filters, status: e.target.value as FilterState['status'] });
  };
  
  const handleEnvChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onFiltersChange({ ...filters, env: e.target.value as FilterState['env'] });
  };
  
  const formatTime = (ts: number) => {
    if (!ts) return '--:--:--';
    return new Date(ts).toLocaleTimeString();
  };
  
  return (
    <div className="control-panel">
      {/* Left section: Logo and title */}
      <div className="control-left">
        <h1 className="dashboard-title">KOSMOS Flow</h1>
        <span className="dashboard-update">
          Обновлено: {formatTime(lastUpdate)}
        </span>
      </div>
      
      {/* Center section: Search and filters */}
      <div className="control-center">
        <div className="search-box">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Поиск сервиса или сервера..."
            value={filters.search}
            onChange={handleSearchChange}
          />
          {filters.search && (
            <button 
              className="search-clear"
              onClick={() => onFiltersChange({ ...filters, search: '' })}
            >
              ×
            </button>
          )}
        </div>
        
        <select 
          className="filter-select"
          value={filters.status}
          onChange={handleStatusChange}
        >
          <option value="all">Все статусы</option>
          <option value="ok">✓ Работает</option>
          <option value="fail">✕ Не работает</option>
        </select>
        
        <select 
          className="filter-select"
          value={filters.env}
          onChange={handleEnvChange}
        >
          <option value="all">Все окружения</option>
          <option value="prod">prod</option>
          <option value="test">test</option>
          <option value="dev">dev</option>
        </select>
      </div>
      
      {/* Right section: Actions */}
      <div className="control-right">
        <button className="control-btn" onClick={onRefresh} title="Обновить данные">
          🔄
        </button>
        <button className="control-btn" onClick={onFitView} title="Центрировать">
          ⊡
        </button>
        <a href="/" className="control-btn" title="Вернуться на главную">
          🏠
        </a>
      </div>
    </div>
  );
}
