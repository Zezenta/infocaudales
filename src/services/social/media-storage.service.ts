import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { metaLogger } from '../../utils/logger.js';

export interface StorageConfig {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName?: string;
  publicBaseUrl?: string;
}

export class MediaStorageService {
  private s3Client: S3Client | null = null;
  private bucket: string;
  private publicBaseUrl: string;

  constructor(config?: StorageConfig) {
    const endpoint = config?.endpoint || process.env.R2_ENDPOINT;
    const accessKeyId = config?.accessKeyId || process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = config?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
    this.bucket = config?.bucketName || process.env.R2_BUCKET_NAME || 'hidro-info-bot-media';
    this.publicBaseUrl = (config?.publicBaseUrl || process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

    if (endpoint && accessKeyId && secretAccessKey) {
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }
  }

  /**
   * Check if storage client is configured
   */
  isConfigured(): boolean {
    return this.s3Client !== null && Boolean(this.bucket) && Boolean(this.publicBaseUrl);
  }

  /**
   * Upload an arbitrary buffer to R2 storage
   */
  async uploadBuffer(buffer: Buffer, key: string, contentType: string): Promise<string> {
    if (!this.s3Client) {
      throw new Error('[MediaStorageService] Cloudflare R2 is not configured. Check R2_* env variables.');
    }

    const cleanKey = key.replace(/^\/+/, '');

    metaLogger.info(`[MediaStorageService] Uploading ${buffer.length} bytes to R2: ${cleanKey} (${contentType})...`);

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const publicUrl = `${this.publicBaseUrl}/${cleanKey}`;
    metaLogger.info(`[MediaStorageService] Upload successful: ${publicUrl}`);
    return publicUrl;
  }

  /**
   * Upload an image buffer or file path and return public URL.
   * If input is already an HTTP(S) URL, it returns it directly.
   */
  async uploadImage(imageInput: Buffer | string, prefix: string = 'img'): Promise<string> {
    if (typeof imageInput === 'string' && (imageInput.startsWith('http://') || imageInput.startsWith('https://'))) {
      return imageInput;
    }

    let buffer: Buffer;
    let ext = 'png';
    let contentType = 'image/png';

    if (Buffer.isBuffer(imageInput)) {
      buffer = imageInput;
    } else {
      if (!fs.existsSync(imageInput)) {
        throw new Error(`[MediaStorageService] Local image file not found: ${imageInput}`);
      }
      buffer = fs.readFileSync(imageInput);
      const fileExt = path.extname(imageInput).toLowerCase().replace('.', '');
      if (fileExt === 'jpg' || fileExt === 'jpeg') {
        ext = 'jpg';
        contentType = 'image/jpeg';
      } else if (fileExt === 'webp') {
        ext = 'webp';
        contentType = 'image/webp';
      }
    }

    const uniqueId = crypto.randomBytes(6).toString('hex');
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const key = `images/${prefix}_${timestamp}_${uniqueId}.${ext}`;

    return this.uploadBuffer(buffer, key, contentType);
  }

  /**
   * Upload a video buffer or file path to R2 and return public URL.
   * If input is already an HTTP(S) URL, it returns it directly.
   */
  async uploadVideo(videoInput: Buffer | string, prefix: string = 'video'): Promise<string> {
    if (typeof videoInput === 'string' && (videoInput.startsWith('http://') || videoInput.startsWith('https://'))) {
      return videoInput;
    }

    let buffer: Buffer;
    if (Buffer.isBuffer(videoInput)) {
      buffer = videoInput;
    } else {
      if (!fs.existsSync(videoInput)) {
        throw new Error(`[MediaStorageService] Local video file not found: ${videoInput}`);
      }
      buffer = fs.readFileSync(videoInput);
    }

    const uniqueId = crypto.randomBytes(6).toString('hex');
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const key = `videos/${prefix}_${timestamp}_${uniqueId}.mp4`;

    return this.uploadBuffer(buffer, key, 'video/mp4');
  }
}
