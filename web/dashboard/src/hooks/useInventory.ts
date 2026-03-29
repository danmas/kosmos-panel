// =============================================================================
// Inventory Hook
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { Inventory } from '../types';

interface UseInventoryResult {
  inventory: Inventory | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInventory(): UseInventoryResult {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  
  const fetchInventory = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory');
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data: Inventory = await res.json();
      setInventory(data);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      console.error('Failed to fetch inventory:', message);
    } finally {
      setLoading(false);
    }
  }, []);
  
  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);
  
  return {
    inventory,
    loading,
    error,
    refresh: fetchInventory,
  };
}
