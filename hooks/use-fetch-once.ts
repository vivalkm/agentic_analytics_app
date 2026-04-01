'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Fetch a URL once on mount, with abort-on-unmount and a refetch function.
 * Strict-mode safe (deduplicates via ref).
 */
export function useFetchOnce<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const fetched = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return fetch(url, { signal: controller.signal })
      .then((res) => res.json())
      .then((json: T) => {
        setData(json);
        return json;
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        return null;
      })
      .finally(() => setLoading(false));
  }, [url]);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetchData();
    return () => { abortRef.current?.abort(); };
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}
