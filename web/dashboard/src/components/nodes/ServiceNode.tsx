import { memo } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Service, ServiceStatus } from '../../types';
import { CheckCircle2, AlertTriangle, XCircle, Activity } from 'lucide-react';
import { cn } from './ServerGroupNode';

export const ServiceNode = memo(({ data, selected }: NodeProps) => {
  const service = data.service as Service;
  
  // Use status.status if provided, otherwise map ok (boolean) to healthy/error
  let status: ServiceStatus = 'degraded';
  if (service.status?.status) {
    status = service.status.status;
  } else if (service.ok !== undefined) {
    status = service.ok ? 'healthy' : 'error';
  }

  const statusColors = {
    healthy: 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400',
    degraded: 'bg-amber-500/10 border-amber-500/50 text-amber-400',
    error: 'bg-rose-500/10 border-rose-500/50 text-rose-400',
  };

  const StatusIcon = {
    healthy: CheckCircle2,
    degraded: AlertTriangle,
    error: XCircle,
  }[status];

  return (
    <div
      className={cn(
        "px-4 py-3 shadow-lg rounded-lg border-2 bg-slate-800 transition-all w-[260px] cursor-pointer",
        statusColors[status],
        selected && "ring-2 ring-white/50"
      )}
    >
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-slate-400" />
      
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className={cn("p-1.5 rounded-md", statusColors[status].split(' ')[0])}>
            <StatusIcon size={16} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold text-slate-100">{service.name}</span>
            <span className="text-xs text-slate-400 font-mono">{service.type}</span>
          </div>
        </div>
        {service.status?.metrics && (
          <div className="flex items-center gap-1 text-xs text-slate-400 bg-slate-900/50 px-2 py-1 rounded-full">
            <Activity size={12} />
            <span>{Object.values(service.status.metrics)[0]}</span>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-slate-400" />
    </div>
  );
});
