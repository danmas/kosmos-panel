import { Service } from '../types';
import { X, ExternalLink, FileText, Activity, AlertCircle, CheckCircle2, XCircle, Settings } from 'lucide-react';

interface SidebarProps {
  service: Service | null;
  onClose: () => void;
}

export function Sidebar({ service, onClose }: SidebarProps) {
  if (!service) return null;

  const status = service.status?.status || (service.ok !== undefined ? (service.ok ? 'healthy' : 'error') : 'degraded');
  const detail = service.status?.detail || service.detail;
  const statusColors = {
    healthy: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    degraded: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
    error: 'text-rose-400 bg-rose-400/10 border-rose-400/20',
  };

  const StatusIcon = {
    healthy: CheckCircle2,
    degraded: AlertCircle,
    error: XCircle,
  }[status];

  return (
    <div className="fixed right-0 top-0 bottom-0 w-96 bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col z-50 animate-in slide-in-from-right">
      <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-sm sticky top-0">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg border ${statusColors[status]}`}>
            <StatusIcon size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-100">{service.name}</h2>
            <p className="text-xs text-slate-400 font-mono">{service.id}</p>
          </div>
        </div>
        <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition-colors">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Status Section */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <Activity size={16} /> Status
          </h3>
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-300">Current State</span>
              <span className={`px-2 py-1 rounded-full text-xs font-medium border ${statusColors[status]}`}>
                {status.toUpperCase()}
              </span>
            </div>
            {detail && (
              <p className="text-sm text-slate-400 mt-2">{detail}</p>
            )}
          </div>
        </section>

        {/* Details Section */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <Settings size={16} /> Details
          </h3>
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50 space-y-3">
            <div>
              <span className="text-xs text-slate-500 block mb-1">Description</span>
              <p className="text-sm text-slate-300">{service.description}</p>
            </div>
            <div>
              <span className="text-xs text-slate-500 block mb-1">Type</span>
              <span className="text-sm text-slate-300 font-mono bg-slate-800 px-2 py-1 rounded">{service.type}</span>
            </div>
            {service.url && (
              <div>
                <span className="text-xs text-slate-500 block mb-1">URL</span>
                <a href={service.url} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:text-blue-300 flex items-center gap-1">
                  {service.url} <ExternalLink size={12} />
                </a>
              </div>
            )}
          </div>
        </section>

        {/* Metrics Section */}
        {service.status?.metrics && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <Activity size={16} /> Metrics
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {Object.entries(service.status.metrics).map(([key, value]) => (
                <div key={key} className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50">
                  <span className="text-xs text-slate-500 block mb-1 uppercase">{key}</span>
                  <span className="text-lg font-semibold text-slate-200">{value}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Dependencies Section */}
        {service.dependencies && service.dependencies.length > 0 && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <Activity size={16} /> Dependencies
            </h3>
            <div className="space-y-2">
              {service.dependencyStatuses?.map((dep, idx) => (
                <div key={idx} className="bg-slate-800/50 rounded-lg p-3 border border-slate-700/50 flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-slate-200">{dep.targetServiceId}</span>
                    <span className="text-xs text-slate-500">{dep.type} {dep.required ? '(Required)' : '(Optional)'}</span>
                  </div>
                  <span className={`px-2 py-1 rounded-full text-xs font-medium border ${statusColors[dep.status || 'degraded']}`}>
                    {(dep.status || 'unknown').toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Actions Section */}
        <section className="space-y-3 pt-4 border-t border-slate-800">
          <div className="flex gap-3">
            {service.url && (
              <button 
                onClick={() => window.open(service.url, '_blank')}
                className="flex-1 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 py-2 px-4 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                <ExternalLink size={16} /> Open
              </button>
            )}
            <button 
              onClick={() => alert('Logs viewer not implemented in this prototype')}
              className="flex-1 bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700 py-2 px-4 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <FileText size={16} /> Logs
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
