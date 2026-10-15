import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://stwsoqoirxhzpaidelch.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN0d3NvcW9pcnhoenBhaWRlbGNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMzU2OTQsImV4cCI6MjEwNzYxMTY5NH0.DubNwlTVDFKinM0rmG1Q-Y7mr6xnsTdEQJzdcFumJtU';

// Read from env, localStorage, or fallback
export function getSupabaseConfig(): { url: string; anonKey: string; isConfigured: boolean } {
  let url = import.meta.env.PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  let anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

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

// ── Supabase DB helpers ────────────────────────────────────────────────

/**
 * Update like count directly in media_uploads
 */
export async function updateLikeCountInDB(mediaId: string, delta: number): Promise<number | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data: record } = await sb
      .from('media_uploads')
      .select('like_count')
      .eq('id', mediaId)
      .maybeSingle();

    if (record) {
      const newCount = Math.max(0, (record.like_count || 0) + delta);
      await sb
        .from('media_uploads')
        .update({ like_count: newCount })
        .eq('id', mediaId);
      return newCount;
    }
  } catch (err) {
    console.warn('Supabase updateLikeCountInDB error:', err);
  }
  return null;
}

/**
 * Upload media file (File or Blob) to Supabase Storage ('event-media')
 * and insert a record into 'media_uploads' table.
 */
export async function uploadMediaToSupabase(
  file: File | Blob,
  userId: string,
  mediaType: 'image' | 'video' = 'image',
  durationSeconds?: number
): Promise<{ publicUrl: string; dbId: string } | null> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase no está configurado');

  const ext = (file instanceof File && file.name.includes('.'))
    ? file.name.split('.').pop()
    : (mediaType === 'video' ? 'webm' : 'jpg');
  const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = `uploads/${fileName}`;

  // 1. Subir al Storage bucket 'event-media'
  const { data: storageData, error: storageError } = await sb.storage
    .from('event-media')
    .upload(filePath, file, {
      cacheControl: '3600',
      contentType: file.type || (mediaType === 'video' ? 'video/webm' : 'image/jpeg'),
      upsert: false,
    });

  if (storageError) {
    console.error('Error al subir a Supabase Storage (event-media):', storageError);
    throw new Error(`Storage: ${storageError.message}`);
  }

  // 2. Obtener URL pública
  const { data: urlData } = sb.storage
    .from('event-media')
    .getPublicUrl(filePath);

  const publicUrl = urlData?.publicUrl || '';
  if (!publicUrl) {
    throw new Error('No se pudo obtener la URL pública de la imagen en Supabase');
  }

  // 3. Insertar fila en 'media_uploads'
  const insertPayload: Record<string, any> = {
    url: publicUrl,
    media_type: mediaType,
    user_id: userId,
    approved: true,
    like_count: 0
  };

  if (typeof durationSeconds === 'number') {
    insertPayload.duration_seconds = durationSeconds;
  }

  const { data: dbRecord, error: dbError } = await sb
    .from('media_uploads')
    .insert(insertPayload)
    .select('id')
    .single();

  if (dbError) {
    console.error('Error al insertar en tabla media_uploads:', dbError);
    throw new Error(`DB: ${dbError.message}`);
  }

  return { publicUrl, dbId: dbRecord.id };
}

/**
 * Fetch all approved media from Supabase 'media_uploads'
 */
export async function fetchMediaFromSupabase(): Promise<any[] | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from('media_uploads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150);

    if (error) throw error;
    // Filtrar solo las aprobadas (o que no estén desaprobadas)
    return data ? data.filter(row => row.approved !== false) : [];
  } catch (err) {
    console.warn('Supabase fetch media error:', err);
    return null;
  }
}

/**
 * Delete a media item from Supabase Database and Storage
 */
export async function deleteMediaFromSupabase(mediaId: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    // 1. Obtener registro para borrar archivo de Storage
    const { data: record } = await sb
      .from('media_uploads')
      .select('url')
      .eq('id', mediaId)
      .maybeSingle();

    if (record?.url && record.url.includes('/event-media/')) {
      const parts = record.url.split('/event-media/');
      if (parts[1]) {
        await sb.storage.from('event-media').remove([parts[1]]);
      }
    }

    // 2. Borrar fila en media_uploads (o marcar approved = false)
    const { error } = await sb
      .from('media_uploads')
      .delete()
      .eq('id', mediaId);

    if (error) {
      console.warn('Hard delete falló, ejecutando baja lógica (approved=false):', error.message);
      await sb
        .from('media_uploads')
        .update({ approved: false })
        .eq('id', mediaId);
    }

    return true;
  } catch (err) {
    console.warn('Supabase deleteMedia error:', err);
    return false;
  }
}
