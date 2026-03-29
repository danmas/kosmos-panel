import { useState, useCallback, useEffect, MouseEvent } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node,
  Edge,
  ReactFlowProvider,
  Panel
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useServicesPolling } from '../hooks/useServicesPolling';
import { ServerGroupNode } from './nodes/ServerGroupNode';
import { ServiceNode } from './nodes/ServiceNode';
import { Sidebar } from './Sidebar';
import { Service, Server } from '../types';
import { RefreshCw, Search, Maximize2, Minimize2, Activity } from 'lucide-react';

const nodeTypes = {
  serverGroup: ServerGroupNode,
  serviceNode: ServiceNode,
};

const GRID_SPACING_X = 500;
const GRID_SPACING_Y = 400;
const GROUP_PADDING = 40;
const SERVICE_SPACING_Y = 120;

export function Dashboard() {
  const { data, loading, error, refetch, lastUpdated } = useServicesPolling(7);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [groupsCollapsed, setGroupsCollapsed] = useState(false);

  // Transform backend data into React Flow nodes and edges
  useEffect(() => {
    if (!data) return;

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];

    let currentX = 0;
    let currentY = 0;
    let maxRowHeight = 0;
    const itemsPerRow = 3;

    data.servers.forEach((server, serverIndex) => {
      const col = serverIndex % itemsPerRow;
      const row = Math.floor(serverIndex / itemsPerRow);

      const groupX = col * GRID_SPACING_X;
      const groupY = row * GRID_SPACING_Y;

      const groupWidth = 350;
      const groupHeight = Math.max(200, server.services.length * SERVICE_SPACING_Y + GROUP_PADDING * 2);

      // Add Server Group Node
      newNodes.push({
        id: server.id,
        type: 'serverGroup',
        position: { x: groupX, y: groupY },
        data: { server },
        style: {
          width: groupWidth,
          height: groupsCollapsed ? 100 : groupHeight,
        },
        className: 'light',
      });

      if (!groupsCollapsed) {
        // Add Service Nodes inside the group
        server.services.forEach((service, serviceIndex) => {
          const serviceId = `${server.id}-${service.id}`;
          
          newNodes.push({
            id: serviceId,
            type: 'serviceNode',
            position: { 
              x: GROUP_PADDING, 
              y: GROUP_PADDING + 40 + serviceIndex * SERVICE_SPACING_Y 
            },
            data: { service },
            parentId: server.id,
            extent: 'parent',
          });

          // Add Edges for dependencies
          service.dependencies?.forEach(dep => {
            // Find target service across all servers
            let targetServerId = '';
            data.servers.forEach(s => {
              if (s.services.some(srv => srv.id === dep.targetServiceId)) {
                targetServerId = s.id;
              }
            });

            if (targetServerId) {
              const targetNodeId = `${targetServerId}-${dep.targetServiceId}`;
              
              // Determine edge color based on dependency status
              const depStatus = service.dependencyStatuses?.find(ds => ds.targetServiceId === dep.targetServiceId)?.status;
              const edgeColor = depStatus === 'error' ? '#f43f5e' : depStatus === 'degraded' ? '#f59e0b' : '#94a3b8';

              newEdges.push({
                id: `e-${serviceId}-${targetNodeId}`,
                source: serviceId,
                target: targetNodeId,
                animated: true,
                label: dep.type,
                style: { stroke: edgeColor, strokeWidth: 2 },
                labelStyle: { fill: '#cbd5e1', fontWeight: 500, fontSize: 10 },
                labelBgStyle: { fill: '#1e293b', fillOpacity: 0.8 },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: edgeColor,
                },
              });
            }
          });
        });
      }
    });

    // Apply search filter
    const filteredNodes = newNodes.map(node => {
      if (node.type === 'serviceNode' && searchQuery) {
        const service = node.data.service as Service;
        const isMatch = service.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                        service.id.toLowerCase().includes(searchQuery.toLowerCase());
        return {
          ...node,
          style: { ...node.style, opacity: isMatch ? 1 : 0.2 },
        };
      }
      return node;
    });

    setNodes((currentNodes) => {
      return filteredNodes.map(newNode => {
        const existingNode = currentNodes.find(n => n.id === newNode.id);
        if (existingNode) {
          return {
            ...newNode,
            position: existingNode.position,
            selected: existingNode.selected,
            dragging: existingNode.dragging,
            measured: existingNode.measured,
            width: existingNode.width,
            height: existingNode.height,
            style: {
              ...newNode.style,
              ...(existingNode.style?.width ? { width: existingNode.style.width } : {}),
              ...(existingNode.style?.height && !groupsCollapsed ? { height: existingNode.style.height } : {}),
            }
          };
        }
        return newNode;
      });
    });

    setEdges((currentEdges) => {
      return newEdges.map(newEdge => {
        const existingEdge = currentEdges.find(e => e.id === newEdge.id);
        if (existingEdge) {
          return {
            ...newEdge,
            selected: existingEdge.selected,
          };
        }
        return newEdge;
      });
    });
  }, [data, groupsCollapsed, searchQuery, setNodes, setEdges]);

  const onNodeClick = useCallback((event: MouseEvent, node: Node) => {
    if (node.type === 'serviceNode') {
      setSelectedService(node.data.service as Service);
    }
  }, []);

  if (loading && !data) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-950 text-slate-400">
        <RefreshCw className="animate-spin mr-2" /> Loading inventory...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-950 text-rose-500">
        Error loading dashboard: {error}
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-slate-950 text-slate-200 overflow-hidden relative">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          className="bg-slate-950"
          minZoom={0.1}
          maxZoom={1.5}
        >
          <Background color="#334155" gap={16} size={1} />
          <Controls className="bg-slate-900 border-slate-800 fill-slate-400" />
          <MiniMap 
            nodeColor={(n) => {
              if (n.type === 'serverGroup') return '#1e293b';
              const status = (n.data?.service as Service)?.status?.status;
              if (status === 'error') return '#f43f5e';
              if (status === 'degraded') return '#f59e0b';
              return '#10b981';
            }}
            maskColor="rgba(15, 23, 42, 0.8)"
            className="bg-slate-900 border-slate-800"
          />
          
          <Panel position="top-left" className="bg-slate-900/80 backdrop-blur-md p-4 rounded-xl border border-slate-800 shadow-2xl flex items-center gap-4">
            <div className="flex items-center gap-2 mr-4">
              <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center text-blue-400">
                <Activity size={20} />
              </div>
              <div>
                <h1 className="text-lg font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
                  KOSMOS-PANEL v2
                </h1>
                <p className="text-xs text-slate-500">
                  Last updated: {lastUpdated?.toLocaleTimeString()}
                </p>
              </div>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <input 
                type="text" 
                placeholder="Search services..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all w-64 text-slate-200 placeholder:text-slate-600"
              />
            </div>

            <div className="h-8 w-px bg-slate-800 mx-2" />

            <button 
              onClick={() => setGroupsCollapsed(!groupsCollapsed)}
              className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors flex items-center gap-2 text-sm font-medium"
              title={groupsCollapsed ? "Expand Groups" : "Collapse Groups"}
            >
              {groupsCollapsed ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
              {groupsCollapsed ? "Expand" : "Collapse"}
            </button>

            <button 
              onClick={refetch}
              className="p-2 text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors flex items-center gap-2 text-sm font-medium"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
          </Panel>
        </ReactFlow>
      </ReactFlowProvider>

      {selectedService && (
        <Sidebar 
          service={selectedService} 
          onClose={() => setSelectedService(null)} 
        />
      )}
    </div>
  );
}
