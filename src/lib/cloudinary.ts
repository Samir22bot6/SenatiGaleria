/**
 * Cloudinary Storage Integration
 * Permite subir fotos y videos directamente a Cloudinary mediante Unsigned Upload Presets
 * sin exponer API Keys secretas en el cliente.
 */

export interface CloudinaryConfig {
  cloudName: string;
  uploadPreset: string;
  folder: string;
  isConfigured: boolean;
}

// Configuración por defecto o variables de entorno
const DEFAULT_CLOUD_NAME = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME || '';
const DEFAULT_UPLOAD_PRESET = import.meta.env.PUBLIC_CLOUDINARY_UPLOAD_PRESET || '';
const DEFAULT_FOLDER = import.meta.env.PUBLIC_CLOUDINARY_FOLDER || 'senati_galeria';

export function getCloudinaryConfig(): CloudinaryConfig {
  let cloudName = DEFAULT_CLOUD_NAME;
  let uploadPreset = DEFAULT_UPLOAD_PRESET;
  let folder = DEFAULT_FOLDER;

  if (typeof window !== 'undefined') {
    const savedCloudName = localStorage.getItem('senati_cloudinary_cloud_name');
    const savedPreset = localStorage.getItem('senati_cloudinary_upload_preset');
    const savedFolder = localStorage.getItem('senati_cloudinary_folder');

    if (savedCloudName) cloudName = savedCloudName;
    if (savedPreset) uploadPreset = savedPreset;
    if (savedFolder) folder = savedFolder;
  }

  const isConfigured = Boolean(cloudName && uploadPreset);

  return { cloudName, uploadPreset, folder, isConfigured };
}

export function isCloudinaryConfigured(): boolean {
  return getCloudinaryConfig().isConfigured;
}

export function saveCloudinaryConfig(cloudName: string, uploadPreset: string, folder: string = 'senati_galeria') {
  if (typeof window !== 'undefined') {
    localStorage.setItem('senati_cloudinary_cloud_name', cloudName.trim());
    localStorage.setItem('senati_cloudinary_upload_preset', uploadPreset.trim());
    localStorage.setItem('senati_cloudinary_folder', folder.trim());
  }
}

export interface CloudinaryUploadResult {
  publicUrl: string;
  publicId: string;
  format?: string;
  bytes?: number;
  duration?: number;
  resourceType: 'image' | 'video';
}

/**
 * Sube una imagen o video directamente a Cloudinary vía REST API
 */
export async function uploadMediaToCloudinary(
  file: File | Blob,
  mediaType: 'image' | 'video' = 'image'
): Promise<CloudinaryUploadResult> {
  const config = getCloudinaryConfig();

  if (!config.isConfigured) {
    throw new Error('Cloudinary no está configurado. Por favor define PUBLIC_CLOUDINARY_CLOUD_NAME y PUBLIC_CLOUDINARY_UPLOAD_PRESET en tu archivo .env');
  }

  const resourceType = mediaType === 'video' ? 'video' : 'image';
  const url = `https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/upload`;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', config.uploadPreset);
  if (config.folder) {
    formData.append('folder', config.folder);
  }

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = `Error HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      }
    } catch {}
    throw new Error(`Cloudinary Error: ${errorDetail}`);
  }

  const data = await response.json();

  if (!data.secure_url) {
    throw new Error('Cloudinary no devolvió una secure_url válida.');
  }

  return {
    publicUrl: data.secure_url,
    publicId: data.public_id,
    format: data.format,
    bytes: data.bytes,
    duration: data.duration,
    resourceType: mediaType
  };
}
