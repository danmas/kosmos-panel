import { useState, useEffect, useCallback } from 'react';
import { AggregatedData } from '../types';

export function useServicesPolling(initialIntervalSec: number = 7) {
  const [data, setData] = useState<AggregatedData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [intervalSec, setIntervalSec] = useState<number>(initialIntervalSec);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/servers');
      if (!res.ok) throw new Error('Failed to fetch servers data');
      const json: AggregatedData = await res.json();
      setData(json);
      setLastUpdated(new Date());
      setError(null);
      if (json.poll?.intervalSec) {
        setIntervalSec(json.poll.intervalSec);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const intervalId = setInterval(fetchData, intervalSec * 1000);
    return () => clearInterval(intervalId);
  }, [fetchData, intervalSec]);

  return { data, loading, error, refetch: fetchData, lastUpdated };
}
