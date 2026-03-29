// =============================================================================
// KOSMOS Flow Dashboard Types
// =============================================================================

// Server types from /api/servers
export interface Server {
  id: string;
  name: string;
  env: 'prod' | 'test' | 'dev';
  color: 'green' | 'yellow' | 'red' | 'gray';
  ssh: SSHConfig;
  services: Service[];
}

export interface SSHConfig {
  host: string;
  port: number;
  user: string;
}

export interface Service {
  id: string;
  name: string;
  type: ServiceType;
  ok: boolean;
  detail: string;
  url?: string;
  description?: string;
  hasLogs?: boolean;
}

export type ServiceType = 
  | 'http' 
  | 'httpJson' 
  | 'tcp' 
  | 'tls' 
  | 'systemd' 
  | 'sshCommand' 
  | 'dockerContainer';

// Inventory types from /api/inventory
export interface Inventory {
  credentials: Credential[];
  servers: InventoryServer[];
  poll: PollConfig;
  dashboard?: DashboardConfig;
}

export interface Credential {
  id: string;
  type: string;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  useAgent?: string;
}

export interface InventoryServer {
  id: string;
  name: string;
  env: string;
  ssh: SSHConfig & { credentialId?: string };
  services: InventoryService[];
  position?: { x: number; y: number };
  collapsed?: boolean;
}

export interface InventoryService extends Omit<Service, 'ok' | 'detail'> {
  dependencies?: Dependency[];
  healthEndpoint?: string;
  statusEndpoint?: string;
  dependenciesEndpoint?: string;
  // Service-specific fields
  expectStatus?: number;
  rules?: object[];
  host?: string;
  port?: number;
  minDaysLeft?: number;
  service?: string;
  command?: string;
  okPattern?: string;
  container?: string;
  timeoutMs?: number;
}

export interface Dependency {
  targetServiceId: string;
  type: DependencyType;
  required: boolean;
}

export type DependencyType = 'rest' | 'ws' | 'db' | 'cache' | 'queue' | 'storage';

export interface PollConfig {
  intervalSec: number;
  concurrency: number;
}

export interface DashboardConfig {
  layout?: 'auto' | 'manual';
  showEdgeLabels?: boolean;
  groupSpacing?: number;
  nodeSpacing?: number;
  theme?: 'dark' | 'light';
}

// API Response types
export interface ServersResponse {
  ts: number;
  servers: Server[];
}

// React Flow node data types
export interface ServerGroupNodeData {
  server: Server;
  onServerAction?: (serverId: string) => void;
}

export interface ServiceNodeData {
  service: Service;
  serverId: string;
  onServiceClick?: (serverId: string, serviceId: string) => void;
}

export interface DependencyEdgeData {
  type: DependencyType;
  required: boolean;
  targetStatus?: boolean;
}

// Panel state
export interface SelectedService {
  serverId: string;
  serviceId: string;
  service: Service;
  server: Server;
  dependencies?: Dependency[];
}

// Filter state
export interface FilterState {
  search: string;
  status: 'all' | 'ok' | 'fail';
  env: 'all' | 'prod' | 'test' | 'dev';
}
