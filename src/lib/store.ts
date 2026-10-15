import type { PhotoItem, UserSession, MediaType } from './types';
import { getSupabase, fetchMediaFromSupabase, updateLikeCountInDB, deleteMediaFromSupabase } from './supabase';

const PHOTOS_STORAGE_KEY = 'senati_event_gallery_photos_v4';
const USER_STORAGE_KEY = 'senati_event_user_session_v3';
const LIKES_STORAGE_KEY = 'senati_event_liked_photos_v3';

// Array vacío inicial: sin fotos de referencia
export const INITIAL_PHOTOS: PhotoItem[] = [];

class EventGalleryStore {
  private channel: BroadcastChannel | null = null;
  private supabaseRealtimeChannel: any = null;
  private listeners: Set<(event: { type: string; data?: any }) => void> = new Set();
  private isSyncing = false;

  constructor() {
    if (typeof window !== 'undefined') {
      // Limpiar versiones anteriores que tenían fotos de demostración
      try {
        localStorage.removeItem('senati_event_gallery_photos_v3');
      } catch {}

      try {
        this.channel = new BroadcastChannel('senati_event_live_channel_v4');
        this.channel.onmessage = (msg) => {
          if (msg.data?.type === 'PHOTO_DELETED' && msg.data?.data?.photoId) {
            const current = this.getPhotos();
            const filtered = current.filter((p) => p.id !== msg.data.data.photoId);
            localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(filtered));
          } else if (msg.data?.type === 'PHOTO_ADDED' && msg.data?.data) {
            const current = this.getPhotos();
            if (!current.some(p => p.id === msg.data.data.id)) {
              localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify([msg.data.data, ...current]));
            }
          }
          this.notifyListeners(msg.data);
        };
      } catch (err) {
        console.warn('BroadcastChannel not supported');
      }

      window.addEventListener('storage', (e) => {
        if (e.key === PHOTOS_STORAGE_KEY) {
          this.notifyListeners({ type: 'PHOTOS_UPDATED' });
        }
      });

      this.initSupabaseRealtime();
      this.syncWithSupabase();

      // Sondeo periódico cada 10 segundos como respaldo de conexión
      setInterval(() => {
        this.syncWithSupabase();
      }, 10000);
    }
  }

  /**
   * Sincroniza la galería local con la tabla 'media_uploads' de Supabase
   */
  public async syncWithSupabase() {
    if (typeof window === 'undefined' || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const remoteData = await fetchMediaFromSupabase();
      if (remoteData && Array.isArray(remoteData)) {
        const remotePhotos: PhotoItem[] = remoteData.map((row: any) => ({
          id: String(row.id),
          url: row.url,
          mediaType: (row.media_type as MediaType) || 'image',
          durationSeconds: row.duration_seconds ? Number(row.duration_seconds) : undefined,
          timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
          likes: Number(row.like_count || 0),
          isApproved: row.approved !== false,
          source: 'upload'
        }));

        // Combinar fotos remotas con las fotos locales
        const currentLocal = this.getPhotos();
        const mergedMap = new Map<string, PhotoItem>();

        // 1. Fotos de la base de datos
        remotePhotos.forEach(p => mergedMap.set(p.id, p));

        // 2. Fotos locales que aún no estén en remote (o subidas temporalmente)
        currentLocal.forEach(p => {
          if (!mergedMap.has(p.id) && !p.id.startsWith('senati-demo')) {
            mergedMap.set(p.id, p);
          }
        });

        const merged = Array.from(mergedMap.values()).sort((a, b) => b.timestamp - a.timestamp);
        localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(merged));
        this.notifyListeners({ type: 'PHOTOS_UPDATED' });
      }
    } catch (e) {
      console.warn('Error sincronizando fotos con Supabase:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  private initSupabaseRealtime() {
    try {
      const supabase = getSupabase();
      if (!supabase) return;

      this.supabaseRealtimeChannel = supabase.channel('senati_global_event_room');

      // Escuchar cambios en la tabla 'media_uploads' en PostgreSQL
      this.supabaseRealtimeChannel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'media_uploads' },
          (payload: any) => {
            console.log('Supabase postgres_changes recibido:', payload.eventType);
            this.syncWithSupabase();
          }
        )
        .on('broadcast', { event: 'PHOTO_ADDED' }, (payload: any) => {
          if (payload && payload.data) {
            const current = this.getPhotos();
            if (!current.some((p) => p.id === payload.data.id)) {
              const updated = [payload.data, ...current];
              localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(updated));
              this.notifyListeners({ type: 'PHOTO_ADDED', data: payload.data });
            }
          }
        })
        .on('broadcast', { event: 'PHOTO_LIKED' }, (payload: any) => {
          if (payload && payload.data) {
            const current = this.getPhotos();
            const target = current.find((p) => p.id === payload.data.photoId);
            if (target) {
              target.likes = payload.data.likes;
              localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(current));
              this.notifyListeners({ type: 'PHOTO_LIKED', data: payload.data });
            }
          }
        })
        .on('broadcast', { event: 'PHOTO_DELETED' }, (payload: any) => {
          if (payload && payload.data && payload.data.photoId) {
            const current = this.getPhotos();
            const filtered = current.filter((p) => p.id !== payload.data.photoId);
            localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(filtered));
            this.notifyListeners({ type: 'PHOTO_DELETED', data: payload.data });
          }
        })
        .subscribe();
    } catch (err) {
      console.warn('Supabase realtime init error', err);
    }
  }

  private notifyListeners(event: { type: string; data?: any }) {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (e) {
        console.error('Error in listener', e);
      }
    });
  }

  public subscribe(callback: (event: { type: string; data?: any }) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  public getPhotos(): PhotoItem[] {
    if (typeof window === 'undefined') return [];

    const raw = localStorage.getItem(PHOTOS_STORAGE_KEY);
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Eliminar cualquier foto de demostración previa
        const clean = parsed.filter(p => !p.id.startsWith('senati-demo'));
        if (clean.length !== parsed.length) {
          localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(clean));
        }
        return clean;
      }
      return [];
    } catch {
      return [];
    }
  }

  // Subir foto o video
  public addPhoto(mediaInput: { 
    id?: string;
    url: string; 
    mediaType?: MediaType; 
    durationSeconds?: number;
    thumbnailUrl?: string;
    source?: 'camera' | 'upload';
  }): PhotoItem {
    const photos = this.getPhotos();
    const newMedia: PhotoItem = {
      id: mediaInput.id || ('media-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7)),
      url: mediaInput.url,
      mediaType: mediaInput.mediaType || 'image',
      durationSeconds: mediaInput.durationSeconds,
      thumbnailUrl: mediaInput.thumbnailUrl,
      source: mediaInput.source || 'upload',
      timestamp: Date.now(),
      likes: 0,
      isApproved: true,
    };

    const updated = [newMedia, ...photos];
    if (typeof window !== 'undefined') {
      localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(updated));
      const eventPayload = { type: 'PHOTO_ADDED', data: newMedia };
      
      this.channel?.postMessage(eventPayload);
      
      if (this.supabaseRealtimeChannel && !newMedia.url.startsWith('data:')) {
        // Enviar por broadcast solo si es URL pública de storage (para no exceder límite de tamaño de websocket)
        this.supabaseRealtimeChannel.send({
          type: 'broadcast',
          event: 'PHOTO_ADDED',
          data: newMedia
        });
      }

      this.notifyListeners(eventPayload);
    }

    return newMedia;
  }

  public toggleLike(photoId: string): number {
    if (typeof window === 'undefined') return 0;

    const photos = this.getPhotos();
    const likedRaw = localStorage.getItem(LIKES_STORAGE_KEY);
    const likedSet = new Set<string>(likedRaw ? JSON.parse(likedRaw) : []);

    const target = photos.find((p) => p.id === photoId);
    if (!target) return 0;

    let delta = 1;
    let newCount = target.likes;
    if (likedSet.has(photoId)) {
      likedSet.delete(photoId);
      newCount = Math.max(0, target.likes - 1);
      delta = -1;
    } else {
      likedSet.add(photoId);
      newCount = target.likes + 1;
      delta = 1;
    }

    target.likes = newCount;
    localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(Array.from(likedSet)));
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(photos));

    // Sincronizar like con la base de datos Supabase
    updateLikeCountInDB(photoId, delta);

    const payload = { type: 'PHOTO_LIKED', data: { photoId, likes: newCount } };
    this.channel?.postMessage(payload);

    if (this.supabaseRealtimeChannel) {
      this.supabaseRealtimeChannel.send({
        type: 'broadcast',
        event: 'PHOTO_LIKED',
        data: { photoId, likes: newCount }
      });
    }

    this.notifyListeners(payload);
    return newCount;
  }

  public isPhotoLiked(photoId: string): boolean {
    if (typeof window === 'undefined') return false;
    const likedRaw = localStorage.getItem(LIKES_STORAGE_KEY);
    const likedSet = new Set<string>(likedRaw ? JSON.parse(likedRaw) : []);
    return likedSet.has(photoId);
  }

  public getSession(): UserSession | null {
    if (typeof window === 'undefined') return null;
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  public setSession(session: UserSession): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(session));
    const payload = { type: 'SESSION_CHANGED', data: session };
    this.channel?.postMessage(payload);
    this.notifyListeners(payload);
  }

  public clearSession(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(USER_STORAGE_KEY);
    const payload = { type: 'SESSION_CHANGED', data: null };
    this.channel?.postMessage(payload);
    this.notifyListeners(payload);
  }

  public deletePhoto(photoId: string): boolean {
    if (typeof window === 'undefined') return false;

    const photos = this.getPhotos();
    const target = photos.find((p) => p.id === photoId);
    if (!target) return false;

    const updated = photos.filter((p) => p.id !== photoId);
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(updated));

    const payload = { type: 'PHOTO_DELETED', data: { photoId } };
    this.channel?.postMessage(payload);

    if (this.supabaseRealtimeChannel) {
      this.supabaseRealtimeChannel.send({
        type: 'broadcast',
        event: 'PHOTO_DELETED',
        data: { photoId }
      });
    }

    // Borrar de Supabase (Database y Storage)
    deleteMediaFromSupabase(photoId);

    this.notifyListeners(payload);
    return true;
  }

  public resetToDefaults(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(PHOTOS_STORAGE_KEY);
    this.syncWithSupabase();
  }
}

export const galleryStore = new EventGalleryStore();
