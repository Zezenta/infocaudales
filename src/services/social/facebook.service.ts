import axios from 'axios';
import { facebookLogger } from '../../utils/logger.js';
import { MediaStorageService } from './media-storage.service.js';

export interface FacebookConfig {
  accessToken?: string;
  pageId?: string;
  graphApiVersion?: string;
  mediaStorage?: MediaStorageService;
}

export interface FacebookPostResult {
  id: string;
  postId?: string;
  permalink?: string;
}

export interface PostVideoOptions {
  title?: string;
  description?: string;
}

export class FacebookService {
  private accessToken: string;
  private pageId: string;
  private apiVersion: string;
  private baseUrl: string;
  private mediaStorage: MediaStorageService;

  constructor(config?: FacebookConfig) {
    this.accessToken = config?.accessToken || process.env.FB_PAGE_ACCESS_TOKEN || '';
    this.pageId = config?.pageId || process.env.FB_PAGE_ID || '';
    this.apiVersion = config?.graphApiVersion || 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.mediaStorage = config?.mediaStorage || new MediaStorageService();

    if (!this.accessToken) {
      facebookLogger.warn('[FacebookService] Missing FB_PAGE_ACCESS_TOKEN in environment.');
    }
    if (!this.pageId) {
      facebookLogger.warn('[FacebookService] Missing FB_PAGE_ID in environment.');
    }
  }

  /**
   * Helper to format and throw descriptive Graph API errors
   */
  private handleError(action: string, error: any): never {
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      const errData = error.response.data.error;
      const msg = `[FacebookService] Graph API error during ${action}: ${errData.message} (code: ${errData.code}, subcode: ${errData.error_subcode || 'none'}, type: ${errData.type})`;
      facebookLogger.error(msg);
      throw new Error(msg);
    }
    const msg = `[FacebookService] Error during ${action}: ${error?.message || error}`;
    facebookLogger.error(msg);
    throw new Error(msg);
  }

  /**
   * Post a single photo to the Facebook Page feed
   */
  async postPhoto(photo: Buffer | string, message?: string): Promise<FacebookPostResult> {
    try {
      const imageUrl = await this.mediaStorage.uploadImage(photo, 'fb_photo');
      facebookLogger.info(`[FacebookService] Publishing photo to Facebook page ${this.pageId}...`);

      const params: Record<string, any> = {
        url: imageUrl,
        access_token: this.accessToken,
      };
      if (message) {
        params.message = message;
      }

      const res = await axios.post(`${this.baseUrl}/${this.pageId}/photos`, null, { params });
      const photoId = res.data?.id;
      const postId = res.data?.post_id || photoId;

      facebookLogger.info(`[FacebookService] Photo posted successfully (photoId: ${photoId}, postId: ${postId})`);

      return {
        id: photoId,
        postId,
        permalink: `https://www.facebook.com/${postId}`,
      };
    } catch (err) {
      this.handleError('posting single photo', err);
    }
  }

  /**
   * Post multiple photos to the Facebook Page in a single post (Photo Album / Grid).
   * Perfect for daily reports or multi-plant telemetry roundups.
   */
  async postPhotos(photos: Array<Buffer | string>, message?: string): Promise<FacebookPostResult> {
    if (!photos || photos.length === 0) {
      throw new Error('[FacebookService] At least one photo is required for postPhotos.');
    }

    if (photos.length === 1) {
      return this.postPhoto(photos[0], message);
    }

    try {
      facebookLogger.info(`[FacebookService] Preparing multi-photo post with ${photos.length} photos...`);

      // 1. Upload each photo as unpublished (published=false) to get media_fbid
      const mediaFbids: string[] = [];
      for (let i = 0; i < photos.length; i++) {
        const imageUrl = await this.mediaStorage.uploadImage(photos[i], `fb_multi_${i + 1}`);
        facebookLogger.info(`[FacebookService] Uploading unpublished photo ${i + 1}/${photos.length}...`);

        const res = await axios.post(`${this.baseUrl}/${this.pageId}/photos`, null, {
          params: {
            url: imageUrl,
            published: false,
            access_token: this.accessToken,
          },
        });

        const photoId = res.data?.id;
        if (!photoId) {
          throw new Error(`Failed to upload photo ${i + 1}`);
        }
        mediaFbids.push(photoId);
      }

      // 2. Publish post on page feed with all attached media
      facebookLogger.info(`[FacebookService] Creating feed post with ${mediaFbids.length} attached photos...`);
      const feedParams: Record<string, any> = {
        access_token: this.accessToken,
        attached_media: mediaFbids.map((id) => ({ media_fbid: id })),
      };
      if (message) {
        feedParams.message = message;
      }

      const postRes = await axios.post(`${this.baseUrl}/${this.pageId}/feed`, feedParams);
      const postId = postRes.data?.id;

      facebookLogger.info(`[FacebookService] Multi-photo post published successfully (postId: ${postId})`);

      return {
        id: postId,
        postId,
        permalink: `https://www.facebook.com/${postId}`,
      };
    } catch (err) {
      this.handleError('posting multi-photo post', err);
    }
  }

  /**
   * Post a video to the Facebook Page.
   * Perfect for satellite animations, radar loops, and video forecasts.
   */
  async postVideo(video: Buffer | string, options?: PostVideoOptions): Promise<FacebookPostResult> {
    try {
      const videoUrl = await this.mediaStorage.uploadVideo(video, 'fb_video');
      facebookLogger.info(`[FacebookService] Publishing video to Facebook page ${this.pageId}...`);

      const params: Record<string, any> = {
        file_url: videoUrl,
        access_token: this.accessToken,
      };

      if (options?.title) {
        params.title = options.title;
      }
      if (options?.description) {
        params.description = options.description;
      }

      const res = await axios.post(`${this.baseUrl}/${this.pageId}/videos`, null, { params });
      const videoId = res.data?.id;

      facebookLogger.info(`[FacebookService] Video upload initiated (videoId: ${videoId})`);

      // Attempt to retrieve permalink URL
      let permalink = `https://www.facebook.com/${videoId}`;
      try {
        const detailsRes = await axios.get(`${this.baseUrl}/${videoId}`, {
          params: {
            fields: 'id,permalink_url',
            access_token: this.accessToken,
          },
        });
        if (detailsRes.data?.permalink_url) {
          permalink = `https://www.facebook.com${detailsRes.data.permalink_url}`;
        }
      } catch (e) {
        // Fallback to standard URL
      }

      return {
        id: videoId,
        postId: videoId,
        permalink,
      };
    } catch (err) {
      this.handleError('posting video', err);
    }
  }

  /**
   * Post a plain text message to the Facebook Page feed
   */
  async postMessage(message: string): Promise<FacebookPostResult> {
    try {
      facebookLogger.info(`[FacebookService] Posting text update to page ${this.pageId}...`);
      const res = await axios.post(`${this.baseUrl}/${this.pageId}/feed`, null, {
        params: {
          message,
          access_token: this.accessToken,
        },
      });

      const postId = res.data?.id;
      facebookLogger.info(`[FacebookService] Message posted successfully (postId: ${postId})`);

      return {
        id: postId,
        postId,
        permalink: `https://www.facebook.com/${postId}`,
      };
    } catch (err) {
      this.handleError('posting text update', err);
    }
  }
}
