export interface PhotoItem {
  id: string;
  url: string;
  author?: string; // Kept optional, hidden from UI
  caption?: string; // Kept optional, hidden from UI
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
}
