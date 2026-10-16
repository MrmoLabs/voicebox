import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export function useModelRuntime() {
  return useQuery({
    queryKey: ['modelRuntime'],
    queryFn: () => apiClient.getModelRuntime(),
    refetchInterval: 1000,
  });
}
