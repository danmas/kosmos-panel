import { memo } from 'react';
import { NodeProps, NodeResizer, Node } from '@xyflow/react';
import { Server } from '../../types';
import { Zap, Maximize2, Minimize2 } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

interface ServerGroupData extends Record<string, unknown> {
  server: Server;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const ServerGroupNode = memo(({ data, selected }: NodeProps<Node<ServerGroupData>>) => {
  const server = data.server;
  const isProd = server.env === 'prod';
  const statusColor = server.color || 'gray';
  const isCollapsed = data.isCollapsed;

  const borderColorMap = {
    green: 'border-emerald-500/50',
    yellow: 'border-amber-500/50',
    red: 'border-rose-500/50',
    gray: 'border-slate-500/50',
  };

  const glowColorMap = {
    green: 'shadow-[0_0_15px_rgba(16,185,129,0.1)]',
    yellow: 'shadow-[0_0_15px_rgba(245,158,11,0.1)]',
    red: 'shadow-[0_0_15px_rgba(244,63,94,0.1)]',
    gray: '',
  };

  const dotColorMap = {
    green: 'bg-emerald-500',
    yellow: 'bg-amber-500',
    red: 'bg-rose-500',
    gray: 'bg-slate-500',
  };

  return (
    <>
      <NodeResizer color="#ff0071" isVisible={selected} minWidth={200} minHeight={100} />
      <div
        className={cn(
          "w-full h-full rounded-xl border-2 border-dashed bg-slate-900/50 backdrop-blur-sm p-4 flex flex-col transition-all duration-300",
          borderColorMap[statusColor as keyof typeof borderColorMap] || borderColorMap.gray,
          glowColorMap[statusColor as keyof typeof glowColorMap] || glowColorMap.gray,
          selected && "border-white/80 ring-2 ring-white/20"
        )}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className={cn("p-1.5 rounded-md", isProd ? "bg-blue-500/20 text-blue-400" : "bg-emerald-500/20 text-emerald-400")}>
              <Zap size={16} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-slate-200">{server.name}</span>
              <span className="text-xs text-slate-400 uppercase tracking-wider font-mono">{server.env}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={(e) => { e.stopPropagation(); data.onToggleCollapse(); }}
              className="p-1 hover:bg-slate-800 rounded transition-colors text-slate-400 hover:text-slate-200 cursor-pointer"
              title={isCollapsed ? "Развернуть" : "Свернуть"}
            >
              {isCollapsed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
            <div className={cn("w-2.5 h-2.5 rounded-full", dotColorMap[statusColor as keyof typeof dotColorMap] || dotColorMap.gray)} />
          </div>
        </div>
        <div className="flex-1" />
      </div>
    </>
  );
});
