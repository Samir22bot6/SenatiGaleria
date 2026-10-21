import type { PhotoItem, UserSession, MediaType } from './types';
import { getSupabase, fetchMediaFromSupabase, updateLikeCountInDB, deleteMediaFromSupabase } from './supabase';

const PHOTOS_STORAGE_KEY = 'senati_event_gallery_photos_v5';
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
      // Limpiar versiones anteriores que tenían fotos cacheadas o eliminadas
      try {
        localStorage.removeItem('senati_event_gallery_photos_v3');
        localStorage.removeItem('senati_event_gallery_photos_v4');
      } catch {}

      try {
        this.channel = new BroadcastChannel('senati_event_live_channel_v5');
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

      // Sondeo periódico cada 8 segundos como respaldo de conexión
      setInterval(() => {
        this.syncWithSupabase();
      }, 8000);
    }
  }

  /**
   * Sincroniza la galería local con la tabla 'media_uploads' de Supabase.
   * La base de datos es la fuente oficial: si una foto fue eliminada en Supabase,
   * se elimina inmediatamente del almacenamiento local y de la interfaz.
   */
  public async syncWithSupabase() {
    if (typeof window === 'undefined' || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const remoteData = await fetchMediaFromSupabase();
      if (remoteData && Array.isArray(remoteData)) {
        const remotePhotos: PhotoItem[] = remoteData.map((row: any) => {
          const isVid = (row.media_type as MediaType) === 'video';
          let thumb = row.thumbnail_url;
          if (isVid && !thumb && row.url && row.url.includes('cloudinary.com')) {
            thumb = row.url.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
          }
          return {
            id: String(row.id),
            url: row.url,
            mediaType: (row.media_type as MediaType) || 'image',
            durationSeconds: row.duration_seconds ? Number(row.duration_seconds) : undefined,
            thumbnailUrl: thumb,
            timestamp: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
            likes: Number(row.like_count || 0),
            isApproved: row.approved !== false,
            source: 'upload',
            author: row.user_id || undefined,
            uploaderDeviceId: row.device_id || undefined
          };
        });

        // La base de datos remota es la fuente definitiva de la verdad
        localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(remotePhotos));
        this.notifyListeners({ type: 'PHOTOS_UPDATED' });
      }
    } catch (e) {
      console.warn('Error sincronizando fotos con Supabase:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Purga una foto fantasma (por ejemplo, eliminada del Storage bucket directamente que devuelve error 404)
   */
  public removeGhostPhoto(photoId: string) {
    const current = this.getPhotos();
    const updated = current.filter(p => p.id !== photoId);
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(updated));
    this.notifyListeners({ type: 'PHOTOS_UPDATED' });
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
        .on('broadcast', { event: 'TRANSMISSION_STATUS_CHANGED' }, (payload: any) => {
          if (payload && payload.data) {
            const isLive = payload.data.isLive !== false;
            localStorage.setItem('senati_event_live', isLive ? 'true' : 'false');
            this.notifyListeners({ type: 'TRANSMISSION_STATUS_CHANGED', data: { isLive } });
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
    author?: string;
    uploaderDeviceId?: string;
  }): PhotoItem {
    let thumb = mediaInput.thumbnailUrl;
    if (mediaInput.mediaType === 'video' && !thumb && mediaInput.url && mediaInput.url.includes('cloudinary.com')) {
      thumb = mediaInput.url.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
    }

    const newMedia: PhotoItem = {
      id: mediaInput.id || ('media-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7)),
      url: mediaInput.url,
      mediaType: mediaInput.mediaType || 'image',
      durationSeconds: mediaInput.durationSeconds,
      thumbnailUrl: thumb,
      source: mediaInput.source || 'upload',
      author: mediaInput.author || this.getCurrentUserId(),
      uploaderDeviceId: mediaInput.uploaderDeviceId || this.getDeviceId(),
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

  public getDeviceId(): string {
    if (typeof window === 'undefined') return '';
    let id = localStorage.getItem('senati_user_device_id');
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
      localStorage.setItem('senati_user_device_id', id);
    }
    return id;
  }

  public getCurrentUserId(): string {
    const session = this.getSession();
    if (session) {
      return session.email || session.phone || session.name || 'Asistente SENATI';
    }
    return '';
  }

  /**
   * Comprueba si el usuario actual es el propietario/autor de la foto o video
   */
  public isUserPhotoOwner(photo: PhotoItem): boolean {
    if (typeof window === 'undefined' || !photo) return false;
    const currentUserId = this.getCurrentUserId();
    const currentDeviceId = this.getDeviceId();

    // 1. Coincidencia por ID de dispositivo (máxima fiabilidad en móvil)
    if (photo.uploaderDeviceId && currentDeviceId && photo.uploaderDeviceId === currentDeviceId) {
      return true;
    }

    // 2. Coincidencia por usuario registrado (email, teléfono o nombre)
    if (photo.author && currentUserId) {
      if (photo.author.toLowerCase() === currentUserId.toLowerCase()) {
        return true;
      }
      const session = this.getSession();
      if (session) {
        if (session.email && photo.author.toLowerCase() === session.email.toLowerCase()) return true;
        if (session.phone && photo.author === session.phone) return true;
        if (session.name && photo.author.toLowerCase() === session.name.toLowerCase()) return true;
      }
    }

    return false;
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

  // ── Control de Transmisión del Evento (Modo Admin) ──
  public isTransmissionActive(): boolean {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('senati_event_live') !== 'false';
  }

  public async setTransmissionActive(isLive: boolean): Promise<void> {
    if (typeof window === 'undefined') return;

    localStorage.setItem('senati_event_live', isLive ? 'true' : 'false');
    const payload = { type: 'TRANSMISSION_STATUS_CHANGED', data: { isLive } };

    this.channel?.postMessage(payload);

    if (this.supabaseRealtimeChannel) {
      this.supabaseRealtimeChannel.send({
        type: 'broadcast',
        event: 'TRANSMISSION_STATUS_CHANGED',
        data: { isLive }
      });
    }

    const sb = getSupabase();
    if (sb) {
      try {
        await sb.from('eventos').update({ activo: isLive }).neq('activo', isLive);
      } catch {}
    }

    this.notifyListeners(payload);
  }
}

export const galleryStore = new EventGalleryStore();
