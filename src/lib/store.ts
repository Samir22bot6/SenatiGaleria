import type { PhotoItem, UserSession } from './types';
import { getSupabase } from './supabase';

const PHOTOS_STORAGE_KEY = 'senati_event_gallery_photos_v2';
const USER_STORAGE_KEY = 'senati_event_user_session_v2';
const LIKES_STORAGE_KEY = 'senati_event_liked_photos_v2';

// Clean institutional photos for SENATI events without names or personal messages
export const INITIAL_PHOTOS: PhotoItem[] = [
  {
    id: 'senati-demo-1',
    url: 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?auto=format&fit=crop&w=1400&q=80',
    timestamp: Date.now() - 1000 * 60 * 18,
    likes: 34,
    isApproved: true,
    source: 'upload'
  },
  {
    id: 'senati-demo-2',
    url: 'https://images.unsplash.com/photo-1531482615713-2afd69097998?auto=format&fit=crop&w=1400&q=80',
    timestamp: Date.now() - 1000 * 60 * 35,
    likes: 48,
    isApproved: true,
    source: 'camera'
  },
  {
    id: 'senati-demo-3',
    url: 'https://images.unsplash.com/photo-1581092335397-9583fe92d232?auto=format&fit=crop&w=1400&q=80',
    timestamp: Date.now() - 1000 * 60 * 62,
    likes: 27,
    isApproved: true,
    source: 'upload'
  },
  {
    id: 'senati-demo-4',
    url: 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1400&q=80',
    timestamp: Date.now() - 1000 * 60 * 110,
    likes: 56,
    isApproved: true,
    source: 'camera'
  },
  {
    id: 'senati-demo-5',
    url: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=1400&q=80',
    timestamp: Date.now() - 1000 * 60 * 150,
    likes: 41,
    isApproved: true,
    source: 'upload'
  }
];

class EventGalleryStore {
  private channel: BroadcastChannel | null = null;
  private supabaseRealtimeChannel: any = null;
  private listeners: Set<(event: { type: string; data?: any }) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('senati_event_live_channel_v2');
        this.channel.onmessage = (msg) => {
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

      // Connect to Supabase Realtime broadcast across the internet if configured
      this.initSupabaseRealtime();
    }
  }

  private initSupabaseRealtime() {
    try {
      const supabase = getSupabase();
      if (!supabase) return;

      this.supabaseRealtimeChannel = supabase.channel('senati_global_event_room');

      this.supabaseRealtimeChannel
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
    if (typeof window === 'undefined') return INITIAL_PHOTOS;

    const raw = localStorage.getItem(PHOTOS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(INITIAL_PHOTOS));
      return INITIAL_PHOTOS;
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : INITIAL_PHOTOS;
    } catch {
      return INITIAL_PHOTOS;
    }
  }

  // Upload photo without names or messages
  public addPhoto(photoInput: { url: string; source?: 'camera' | 'upload' }): PhotoItem {
    const photos = this.getPhotos();
    const newPhoto: PhotoItem = {
      url: photoInput.url,
      source: photoInput.source || 'upload',
      id: 'photo-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
      timestamp: Date.now(),
      likes: 0,
      isApproved: true,
    };

    const updated = [newPhoto, ...photos];
    if (typeof window !== 'undefined') {
      localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(updated));
      const eventPayload = { type: 'PHOTO_ADDED', data: newPhoto };
      
      // Local broadcast
      this.channel?.postMessage(eventPayload);
      
      // Global Supabase Realtime broadcast across internet devices
      if (this.supabaseRealtimeChannel) {
        this.supabaseRealtimeChannel.send({
          type: 'broadcast',
          event: 'PHOTO_ADDED',
          data: newPhoto
        });
      }

      this.notifyListeners(eventPayload);
    }

    return newPhoto;
  }

  public toggleLike(photoId: string): number {
    if (typeof window === 'undefined') return 0;

    const photos = this.getPhotos();
    const likedRaw = localStorage.getItem(LIKES_STORAGE_KEY);
    const likedSet = new Set<string>(likedRaw ? JSON.parse(likedRaw) : []);

    const target = photos.find((p) => p.id === photoId);
    if (!target) return 0;

    let newCount = target.likes;
    if (likedSet.has(photoId)) {
      likedSet.delete(photoId);
      newCount = Math.max(0, target.likes - 1);
    } else {
      likedSet.add(photoId);
      newCount = target.likes + 1;
    }

    target.likes = newCount;
    localStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(Array.from(likedSet)));
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(photos));

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

  public resetToDefaults(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(PHOTOS_STORAGE_KEY, JSON.stringify(INITIAL_PHOTOS));
    const payload = { type: 'PHOTOS_UPDATED' };
    this.channel?.postMessage(payload);
    this.notifyListeners(payload);
  }
}

export const galleryStore = new EventGalleryStore();
