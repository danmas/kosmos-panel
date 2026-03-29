// =============================================================================
// Servers Polling Hook
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { Server, ServersResponse } from '../types';

interface UseServersPollingOptions {
  intervalMs?: number;
  enabled?: boolean;
}

interface UseServersPollingResult {
  servers: Server[];
  lastUpdate: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useServersPolling(
  options: UseServersPollingOptions = {}
): UseServersPollingResult {
  const { intervalMs = 5000, enabled = true } = options;
  
  const [servers, setServers] = useState<Server[]>([]);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  
  const fetchServers = useCallback(async () => {
    try {
      const res = await fetch('/api/servers');
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data: ServersResponse = await res.json();
      
      setServers(data.servers || []);
      setLastUpdate(data.ts || Date.now());
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      console.error('Failed to fetch servers:', message);
    } finally {
      setLoading(false);
    }
  }, []);
  
  // Initial fetch
  useEffect(() => {
    if (enabled) {
      fetchServers();
    }
  }, [enabled, fetchServers]);
  
  // Polling interval
  useEffect(() => {
    if (!enabled) return;
    
    const interval = setInterval(fetchServers, intervalMs);
    
    return () => clearInterval(interval);
  }, [enabled, intervalMs, fetchServers]);
  
  return {
    servers,
    lastUpdate,
    loading,
    error,
    refresh: fetchServers,
  };
}
