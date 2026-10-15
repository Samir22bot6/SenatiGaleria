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

// ── Supabase DB helpers ────────────────────────────────────────────────

/**
 * Toggle like on a media item in the database.
 * Uses upsert into `likes` table and updates the count on `media_uploads`.
 */
export async function toggleLikeInDB(mediaId: string, userId: string): Promise<{ liked: boolean; newCount: number } | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    // Check if already liked
    const { data: existing } = await sb
      .from('likes')
      .select('id')
      .eq('media_id', mediaId)
      .eq('user_identifier', userId)
      .maybeSingle();

    if (existing) {
      // Unlike
      await sb.from('likes').delete().eq('id', existing.id);
      // Decrement count
      await sb.rpc('decrement_likes', { row_id: mediaId });
    } else {
      // Like
      await sb.from('likes').insert({ media_id: mediaId, user_identifier: userId });
      // Increment count
      await sb.rpc('increment_likes', { row_id: mediaId });
    }

    // Fetch updated count
    const { data: media } = await sb
      .from('media_uploads')
      .select('like_count')
      .eq('id', mediaId)
      .single();

    return { liked: !existing, newCount: media?.like_count ?? 0 };
  } catch (err) {
    console.warn('Supabase like toggle error:', err);
    return null;
  }
}

/**
 * Upload media file to Supabase Storage and insert record into media_uploads
 */
export async function uploadMediaToSupabase(
  file: File,
  userId: string,
  mediaType: 'image' | 'video' = 'image',
  durationSeconds?: number
): Promise<{ publicUrl: string; dbId: string } | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const ext = file.name.split('.').pop() || (mediaType === 'video' ? 'mp4' : 'jpg');
    const filePath = `event/${Date.now()}_${Math.random().toString(36).slice(2,7)}.${ext}`;

    // Upload to Storage
    const { data: storageData, error: storageError } = await sb.storage
      .from('event-media')
      .upload(filePath, file, {
        cacheControl: '3600',
        contentType: file.type,
        upsert: false,
      });

    if (storageError) throw storageError;

    // Get public URL
    const { data: urlData } = sb.storage
      .from('event-media')
      .getPublicUrl(filePath);

    const publicUrl = urlData?.publicUrl || '';

    // Insert DB record
    const { data: dbRecord, error: dbError } = await sb
      .from('media_uploads')
      .insert({
        storage_path: filePath,
        public_url: publicUrl,
        media_type: mediaType,
        duration_seconds: durationSeconds,
        uploaded_by: userId,
        is_approved: true, // auto-approve for now
        like_count: 0,
      })
      .select('id')
      .single();

    if (dbError) throw dbError;

    return { publicUrl, dbId: dbRecord.id };
  } catch (err) {
    console.warn('Supabase upload error:', err);
    return null;
  }
}

/**
 * Fetch all approved media from Supabase
 */
export async function fetchMediaFromSupabase(): Promise<any[] | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from('media_uploads')
      .select('*')
      .eq('is_approved', true)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return data;
  } catch (err) {
    console.warn('Supabase fetch media error:', err);
    return null;
  }
}

/**
 * Delete a media item from Supabase Database and Storage
 */
export async function deleteMediaFromSupabase(mediaId: string, storagePath?: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    // 1. If storage path is provided or can be found, delete file from bucket
    if (storagePath) {
      await sb.storage.from('event-media').remove([storagePath]);
    } else {
      // Look up storage path first if possible
      const { data: record } = await sb
        .from('media_uploads')
        .select('storage_path')
        .eq('id', mediaId)
        .maybeSingle();

      if (record?.storage_path) {
        await sb.storage.from('event-media').remove([record.storage_path]);
      }
    }

    // 2. Delete row from media_uploads
    const { error } = await sb
      .from('media_uploads')
      .delete()
      .eq('id', mediaId);

    if (error) {
      // Fallback: If DELETE rule is restricted, soft delete by setting is_approved = false
      console.warn('Hard delete failed, performing soft delete (is_approved=false):', error.message);
      await sb
        .from('media_uploads')
        .update({ is_approved: false })
        .eq('id', mediaId);
    }

    return true;
  } catch (err) {
    console.warn('Supabase deleteMedia error:', err);
    return false;
  }
}

