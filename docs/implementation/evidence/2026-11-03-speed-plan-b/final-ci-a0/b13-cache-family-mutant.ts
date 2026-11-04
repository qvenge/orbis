import { QueryClient } from '@tanstack/react-query';

export function undeclaredFamily(client: QueryClient) {
  const { setQueryData: put } = client;
  put(['b13-unregistered-family'], 'proof');
}
