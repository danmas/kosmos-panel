import { memo } from 'react';
import { NodeProps, NodeResizer } from '@xyflow/react';
import { Server } from '../../types';
import { Zap } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

export const ServerGroupNode = memo(({ data, selected }: NodeProps) => {
  const server = data.server as Server;
  const isProd = server.env === 'prod';

  return (
    <>
      <NodeResizer color="#ff0071" isVisible={selected} minWidth={200} minHeight={100} />
      <div
        className={cn(
          "w-full h-full rounded-xl border-2 border-dashed bg-slate-900/50 backdrop-blur-sm p-4 flex flex-col transition-colors",
          isProd ? "border-blue-500/50" : "border-emerald-500/50",
          selected && "border-white/80"
        )}
      >
        <div className="flex items-center gap-2 mb-4">
          <div className={cn("p-1.5 rounded-md", isProd ? "bg-blue-500/20 text-blue-400" : "bg-emerald-500/20 text-emerald-400")}>
            <Zap size={16} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-slate-200">{server.name}</span>
            <span className="text-xs text-slate-400 uppercase tracking-wider">{server.env}</span>
          </div>
        </div>
        <div className="flex-1" />
      </div>
    </>
  );
});
