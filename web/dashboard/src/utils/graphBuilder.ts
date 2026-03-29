// =============================================================================
// Graph Builder Utility
// =============================================================================
// Transforms API data into React Flow nodes and edges

import type { Node, Edge } from 'reactflow';
import type {
  Server,
  Inventory,
  ServerGroupNodeData,
  ServiceNodeData,
  DependencyEdgeData,
  Dependency,
  FilterState,
} from '../types';
import { dependencyColors, dependencyStyles } from './statusColors';

// Constants for layout
const GROUP_WIDTH = 320;
const GROUP_PADDING = 20;
const SERVICE_HEIGHT = 60;
const SERVICE_SPACING = 10;
const GROUP_HEADER_HEIGHT = 50;
const GROUP_SPACING_X = 400;
const GROUP_SPACING_Y = 50;
const GROUPS_PER_ROW = 3;

/**
 * Build React Flow graph from servers and inventory data
 */
export function buildGraph(
  servers: Server[],
  inventory: Inventory | null,
  filters?: FilterState
): { nodes: Node[], edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  
  // Filter servers by env
  let filteredServers = servers;
  if (filters?.env && filters.env !== 'all') {
    filteredServers = servers.filter(s => s.env === filters.env);
  }
  
  // Create nodes for each server
  filteredServers.forEach((server, serverIndex) => {
    // Calculate grid position
    const col = serverIndex % GROUPS_PER_ROW;
    const row = Math.floor(serverIndex / GROUPS_PER_ROW);
    
    // Check if server has saved position in inventory
    const inventoryServer = inventory?.servers.find(s => s.id === server.id);
    const savedPosition = inventoryServer?.position;
    
    // Filter services
    let services = server.services;
    if (filters?.status && filters.status !== 'all') {
      services = services.filter(s => 
        filters.status === 'ok' ? s.ok : !s.ok
      );
    }
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      const serverMatch = server.name.toLowerCase().includes(searchLower);
      if (!serverMatch) {
        services = services.filter(s => 
          s.name.toLowerCase().includes(searchLower) ||
          s.id.toLowerCase().includes(searchLower)
        );
      }
    }
    
    // Skip server if no services match
    if (services.length === 0 && filters?.search) {
      const serverMatch = server.name.toLowerCase().includes(filters.search.toLowerCase());
      if (!serverMatch) return;
    }
    
    // Calculate group height based on services
    const groupHeight = GROUP_HEADER_HEIGHT + 
      services.length * (SERVICE_HEIGHT + SERVICE_SPACING) + 
      GROUP_PADDING;
    
    // Create group node for server
    const groupId = `server-${server.id}`;
    nodes.push({
      id: groupId,
      type: 'serverGroup',
      position: savedPosition || {
        x: col * GROUP_SPACING_X,
        y: row * (400 + GROUP_SPACING_Y),
      },
      style: {
        width: GROUP_WIDTH,
        height: groupHeight,
      },
      data: {
        server,
      } as ServerGroupNodeData,
    });
    
    // Create child nodes for services
    services.forEach((service, serviceIndex) => {
      const nodeId = `${server.id}::${service.id}`;
      nodes.push({
        id: nodeId,
        type: 'service',
        position: {
          x: GROUP_PADDING,
          y: GROUP_HEADER_HEIGHT + serviceIndex * (SERVICE_HEIGHT + SERVICE_SPACING),
        },
        parentId: groupId,
        extent: 'parent',
        draggable: false,
        data: {
          service,
          serverId: server.id,
        } as ServiceNodeData,
      });
    });
  });
  
  // Create edges from dependencies
  if (inventory) {
    const nodeIdMap = buildNodeIdMap(servers);
    
    inventory.servers.forEach(invServer => {
      invServer.services.forEach(invService => {
        const dependencies = invService.dependencies || [];
        const sourceNodeId = `${invServer.id}::${invService.id}`;
        
        // Check if source node exists
        if (!nodes.find(n => n.id === sourceNodeId)) return;
        
        dependencies.forEach(dep => {
          const targetNodeId = findTargetNodeId(nodeIdMap, dep.targetServiceId);
          
          // Check if target node exists
          if (!targetNodeId || !nodes.find(n => n.id === targetNodeId)) return;
          
          // Get target service status
          const targetService = findServiceById(servers, dep.targetServiceId);
          
          edges.push(createDependencyEdge(
            sourceNodeId,
            targetNodeId,
            dep,
            targetService?.ok
          ));
        });
      });
    });
  }
  
  return { nodes, edges };
}

/**
 * Build a map of serviceId -> nodeId for quick lookup
 */
function buildNodeIdMap(servers: Server[]): Map<string, string> {
  const map = new Map<string, string>();
  
  servers.forEach(server => {
    server.services.forEach(service => {
      // Map both with and without server prefix
      map.set(service.id, `${server.id}::${service.id}`);
      map.set(`${server.id}::${service.id}`, `${server.id}::${service.id}`);
    });
  });
  
  return map;
}

/**
 * Find target node ID by service ID
 */
function findTargetNodeId(
  nodeIdMap: Map<string, string>,
  targetServiceId: string
): string | null {
  // Try exact match first
  if (nodeIdMap.has(targetServiceId)) {
    return nodeIdMap.get(targetServiceId)!;
  }
  
  // Try finding by service ID only (without server prefix)
  for (const [key, value] of nodeIdMap.entries()) {
    if (key.endsWith(`::${targetServiceId}`) || key === targetServiceId) {
      return value;
    }
  }
  
  return null;
}

/**
 * Find service by ID across all servers
 */
function findServiceById(servers: Server[], serviceId: string) {
  for (const server of servers) {
    const service = server.services.find(s => s.id === serviceId);
    if (service) return service;
  }
  return null;
}

/**
 * Create a dependency edge
 */
function createDependencyEdge(
  sourceId: string,
  targetId: string,
  dependency: Dependency,
  targetStatus?: boolean
): Edge {
  const color = dependencyColors[dependency.type];
  const style = dependencyStyles[dependency.type];
  
  // Adjust color if target is down and dependency is required
  let strokeColor = color;
  if (targetStatus === false && dependency.required) {
    strokeColor = '#ef4444'; // red
  } else if (targetStatus === false && !dependency.required) {
    strokeColor = '#f59e0b'; // orange/warning
  }
  
  return {
    id: `${sourceId}->${targetId}`,
    source: sourceId,
    target: targetId,
    type: 'dependency',
    animated: style.animated || false,
    style: {
      stroke: strokeColor,
      strokeWidth: style.strokeWidth,
      strokeDasharray: style.strokeDasharray,
    },
    data: {
      type: dependency.type,
      required: dependency.required,
      targetStatus,
    } as DependencyEdgeData,
    label: dependency.type.toUpperCase(),
    labelStyle: {
      fill: strokeColor,
      fontWeight: 600,
      fontSize: 10,
    },
    labelBgStyle: {
      fill: '#1e293b',
      fillOpacity: 0.9,
    },
    labelBgPadding: [4, 2] as [number, number],
  };
}

/**
 * Calculate optimal layout for groups
 */
export function calculateAutoLayout(
  servers: Server[],
  containerWidth: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  
  const groupsPerRow = Math.max(1, Math.floor(containerWidth / GROUP_SPACING_X));
  
  servers.forEach((server, index) => {
    const col = index % groupsPerRow;
    const row = Math.floor(index / groupsPerRow);
    
    positions.set(server.id, {
      x: col * GROUP_SPACING_X,
      y: row * (400 + GROUP_SPACING_Y),
    });
  });
  
  return positions;
}
