import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Read from env or localStorage
export function getSupabaseConfig(): { url: string; anonKey: string; isConfigured: boolean } {
  let url = import.meta.env.PUBLIC_SUPABASE_URL || '';
  let anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';

  if (typeof window !== 'undefined') {
    const savedUrl = localStorage.getItem('senati_supabase_url');
    const savedKey = localStorage.getItem('senati_supabase_anon_key');
    if (savedUrl) url = savedUrl;
    if (savedKey) anonKey = savedKey;
  }

  const isConfigured = Boolean(
    url && 
    anonKey && 
    !url.includes('xyzcompany') && 
    url.startsWith('https://')
  );

  return { url, anonKey, isConfigured };
}

let cachedClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const { url, anonKey, isConfigured } = getSupabaseConfig();
  if (!isConfigured) return null;
  if (!cachedClient) {
    cachedClient = createClient(url, anonKey);
  }
  return cachedClient;
}

export const isSupabaseConfigured = () => getSupabaseConfig().isConfigured;
