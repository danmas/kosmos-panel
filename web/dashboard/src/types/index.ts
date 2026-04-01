export type ServiceStatus = 'healthy' | 'degraded' | 'error';

export interface Dependency {
  targetServiceId: string;
  type: string;
  required: boolean;
}

export interface DependencyStatus extends Dependency {
  status: ServiceStatus;
}

export interface ServiceMetrics {
  [key: string]: string | number;
}

export interface ServiceStatusDetail {
  status: ServiceStatus;
  detail: string;
  metrics?: ServiceMetrics;
}

export interface Service {
  id: string;
  type: string;
  name: string;
  description: string;
  url?: string;
  ok?: boolean;
  detail?: string;
  healthEndpoint?: string;
  statusEndpoint?: string;
  dependencies: Dependency[];
  status?: ServiceStatusDetail;
  dependencyStatuses?: DependencyStatus[];
}

export interface Server {
  id: string;
  name: string;
  env: 'prod' | 'test' | string;
  color?: string;
  ssh?: { host: string; port: number };
  services: Service[];
}

export interface Inventory {
  servers: Server[];
  poll: { intervalSec: number; concurrency: number };
}

export interface AggregatedData {
  servers: Server[];
  poll: { intervalSec: number; concurrency: number };
}
