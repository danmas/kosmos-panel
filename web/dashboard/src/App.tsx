// =============================================================================
// KOSMOS Flow Dashboard - Main Application
// =============================================================================

import { useState, useCallback, useMemo, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Node,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useServersPolling, useInventory } from './hooks';
import { buildGraph } from './utils/graphBuilder';
import {
  ServerGroupNode,
  ServiceNode,
  DependencyEdge,
  ServiceDetailsPanel,
  ControlPanel,
} from './components';
import type { FilterState, SelectedService, Service, Dependency } from './types';

import './App.css';

// Register custom node types
const nodeTypes = {
  serverGroup: ServerGroupNode,
  service: ServiceNode,
};

// Register custom edge types
const edgeTypes = {
  dependency: DependencyEdge,
};

function FlowDashboard() {
  const reactFlowInstance = useReactFlow();
  
  // Data fetching
  const { servers, lastUpdate, loading, error, refresh } = useServersPolling({ intervalMs: 5000 });
  const { inventory } = useInventory();
  
  // Local state
  const [filters, setFilters] = useState<FilterState>({
    search: '',
    status: 'all',
    env: 'all',
  });
  const [selectedService, setSelectedService] = useState<SelectedService | null>(null);
  
  // Build graph from data
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const result = buildGraph(servers, inventory, filters);
    console.log('buildGraph result:', { servers: servers.length, nodes: result.nodes.length, edges: result.edges.length });
    return result;
  }, [servers, inventory, filters]);
  
  // React Flow state
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  
  // Update nodes/edges when data changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);
  
  // Handle node click
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'service') {
      const data = node.data as { service: Service; serverId: string };
      const server = servers.find(s => s.id === data.serverId);
      
      if (server) {
        // Find dependencies from inventory
        const invServer = inventory?.servers.find(s => s.id === data.serverId);
        const invService = invServer?.services.find(s => s.id === data.service.id);
        const dependencies: Dependency[] = invService?.dependencies || [];
        
        setSelectedService({
          serverId: data.serverId,
          serviceId: data.service.id,
          service: data.service,
          server,
          dependencies,
        });
      }
    }
  }, [servers, inventory]);
  
  // Handle fit view
  const handleFitView = useCallback(() => {
    reactFlowInstance.fitView({ padding: 0.2 });
  }, [reactFlowInstance]);
  
  // Close details panel
  const handleClosePanel = useCallback(() => {
    setSelectedService(null);
  }, []);
  
  // Loading state
  if (loading && servers.length === 0) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Загрузка данных...</p>
      </div>
    );
  }
  
  // Error state
  if (error && servers.length === 0) {
    return (
      <div className="error-screen">
        <h2>Ошибка загрузки</h2>
        <p>{error}</p>
        <button onClick={refresh}>Повторить</button>
      </div>
    );
  }
  
  return (
    <div className="flow-dashboard">
      {/* Control Panel */}
      <ControlPanel
        filters={filters}
        onFiltersChange={setFilters}
        lastUpdate={lastUpdate}
        onRefresh={refresh}
        onFitView={handleFitView}
      />
      
      {/* React Flow Canvas */}
      <div className="flow-container">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
          defaultEdgeOptions={{
            type: 'dependency',
          }}
        >
          <Background color="#334155" gap={20} />
          <Controls 
            showInteractive={false}
            style={{ bottom: 20, left: 20 }}
          />
          <MiniMap
            style={{
              backgroundColor: '#1e293b',
              bottom: 20,
              right: selectedService ? 380 : 20,
            }}
            nodeColor={(node) => {
              if (node.type === 'serverGroup') {
                return '#334155';
              }
              const data = node.data as { service?: Service };
              return data?.service?.ok ? '#22c55e' : '#ef4444';
            }}
            maskColor="rgba(15, 23, 42, 0.8)"
          />
        </ReactFlow>
      </div>
      
      {/* Service Details Panel */}
      <ServiceDetailsPanel
        selected={selectedService}
        onClose={handleClosePanel}
      />
    </div>
  );
}

// Wrap with ReactFlowProvider
export default function App() {
  return (
    <ReactFlowProvider>
      <FlowDashboard />
    </ReactFlowProvider>
  );
}
