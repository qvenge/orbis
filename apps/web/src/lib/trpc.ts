import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient as createVanillaClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@orbis/server/src/router.ts';
import { supabase } from './supabase.ts';

export const trpc = createTRPCReact<AppRouter>();

const sharedLink = httpBatchLink({
  url: '/trpc',
  async headers() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? { authorization: `Bearer ${token}` } : {};
  },
});

export function createTRPCClient() {
  return trpc.createClient({
    links: [sharedLink],
  });
}

// Vanilla client for use outside React (Zustand stores, etc.)
export const trpcClient = createVanillaClient<AppRouter>({
  links: [sharedLink],
});
