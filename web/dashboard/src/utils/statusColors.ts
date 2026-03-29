// =============================================================================
// Status Colors Utility
// =============================================================================

import type { DependencyType } from '../types';

// Server status colors
export const serverColors = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  gray: '#6b7280',
} as const;

// Service status colors
export const statusColors = {
  ok: '#22c55e',
  fail: '#ef4444',
  unknown: '#6b7280',
} as const;

// Environment badge colors
export const envColors = {
  prod: { bg: '#dc2626', text: '#fff' },
  test: { bg: '#2563eb', text: '#fff' },
  dev: { bg: '#7c3aed', text: '#fff' },
} as const;

// Dependency edge colors by type
export const dependencyColors: Record<DependencyType, string> = {
  rest: '#3b82f6',    // blue
  ws: '#8b5cf6',      // purple
  db: '#10b981',      // green
  cache: '#f59e0b',   // orange
  queue: '#ef4444',   // red
  storage: '#6b7280', // gray
};

// Dependency edge styles
export const dependencyStyles: Record<DependencyType, {
  strokeWidth: number;
  strokeDasharray?: string;
  animated?: boolean;
}> = {
  rest: { strokeWidth: 2 },
  ws: { strokeWidth: 2, strokeDasharray: '5,5', animated: true },
  db: { strokeWidth: 3 },
  cache: { strokeWidth: 1 },
  queue: { strokeWidth: 2, strokeDasharray: '10,5' },
  storage: { strokeWidth: 2, strokeDasharray: '5,2,2,2' },
};

// Get status icon
export function getStatusIcon(ok: boolean): string {
  return ok ? '🟢' : '🔴';
}

// Get status text
export function getStatusText(ok: boolean): string {
  return ok ? 'Работает' : 'Не работает';
}

// Service type icons
export const serviceTypeIcons: Record<string, string> = {
  http: '🌐',
  httpJson: '📋',
  tcp: '🔌',
  tls: '🔒',
  systemd: '⚙️',
  sshCommand: '💻',
  dockerContainer: '🐳',
};

// Theme CSS variables
export const darkTheme = {
  '--bg-primary': '#0f172a',
  '--bg-secondary': '#1e293b',
  '--bg-card': '#334155',
  '--bg-hover': '#475569',
  '--text-primary': '#f1f5f9',
  '--text-secondary': '#94a3b8',
  '--text-muted': '#64748b',
  '--border-color': '#475569',
  '--accent-green': '#22c55e',
  '--accent-red': '#ef4444',
  '--accent-yellow': '#eab308',
  '--accent-blue': '#3b82f6',
  '--accent-purple': '#8b5cf6',
};
