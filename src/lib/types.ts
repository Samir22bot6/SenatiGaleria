export type MediaType = 'image' | 'video';

export interface PhotoItem {
  id: string;
  url: string;
  mediaType?: MediaType; // 'image' or 'video'
  durationSeconds?: number; // Maximum 8.0 seconds
  thumbnailUrl?: string; // Optional poster for videos
  author?: string;
  caption?: string;
  timestamp: number;
  likes: number;
  avatar?: string;
  isApproved: boolean;
  source?: 'camera' | 'upload';
}

export interface UserSession {
  name: string;
  email?: string;
  phone?: string;
  dataConsent: boolean;
  isLoggedIn: boolean;
  avatar?: string;
}

export interface EventConfig {
  eventName: string;
  slideshowIntervalSeconds: number;
  qrDestinationUrl: string;
  maxVideoDurationSeconds: number;
}
