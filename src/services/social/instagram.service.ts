import axios, { AxiosError } from 'axios';
import { instagramLogger } from '../../utils/logger.js';
import { MediaStorageService } from './media-storage.service.js';

export interface InstagramConfig {
  accessToken?: string;
  igUserId?: string;
  graphApiVersion?: string;
  mediaStorage?: MediaStorageService;
}

export interface InstagramPostResult {
  mediaId: string;
  permalink?: string;
  mediaType?: string;
}

export interface PostReelOptions {
  caption?: string;
  shareToFeed?: boolean;
  coverUrl?: string;
}

export class InstagramService {
  private accessToken: string;
  private igUserId: string;
  private apiVersion: string;
  private baseUrl: string;
  private mediaStorage: MediaStorageService;

  constructor(config?: InstagramConfig) {
    this.accessToken = config?.accessToken || process.env.FB_PAGE_ACCESS_TOKEN || '';
    this.igUserId = config?.igUserId || process.env.IG_USER_ID || '';
    this.apiVersion = config?.graphApiVersion || 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.mediaStorage = config?.mediaStorage || new MediaStorageService();

    if (!this.accessToken) {
      instagramLogger.warn('[InstagramService] Missing FB_PAGE_ACCESS_TOKEN in environment.');
    }
    if (!this.igUserId) {
      instagramLogger.warn('[InstagramService] Missing IG_USER_ID in environment.');
    }
  }

  /**
   * Helper to format and throw descriptive Graph API errors
   */
  private handleError(action: string, error: any): never {
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      const errData = error.response.data.error;
      const msg = `[InstagramService] Graph API error during ${action}: ${errData.message} (code: ${errData.code}, subcode: ${errData.error_subcode || 'none'}, type: ${errData.type})`;
      instagramLogger.error(msg);
      throw new Error(msg);
    }
    const msg = `[InstagramService] Error during ${action}: ${error?.message || error}`;
    instagramLogger.error(msg);
    throw new Error(msg);
  }

  /**
   * Polls an Instagram media container until status_code === 'FINISHED'.
   */
  private async waitForContainer(containerId: string, maxAttempts = 30, delayMs = 3000): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.get(`${this.baseUrl}/${containerId}`, {
          params: {
            fields: 'status_code,status',
            access_token: this.accessToken,
          },
        });

        const statusCode = res.data?.status_code;
        instagramLogger.info(
          `[InstagramService] Container ${containerId} status: ${statusCode || 'UNKNOWN'} (attempt ${attempt}/${maxAttempts})`
        );

        if (statusCode === 'FINISHED') {
          return;
        }

        if (statusCode === 'ERROR') {
          throw new Error(
            `Media container processing failed with ERROR: ${res.data?.status || 'Unknown processing error'}`
          );
        }

        if (statusCode === 'EXPIRED') {
          throw new Error('Media container EXPIRED before publishing.');
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } catch (err: any) {
        if (err.message && err.message.includes('Media container')) throw err;
        this.handleError(`polling container ${containerId}`, err);
      }
    }

    throw new Error(
      `[InstagramService] Timeout: Media container ${containerId} did not finish within ${
        (maxAttempts * delayMs) / 1000
      }s.`
    );
  }

  /**
   * Publishes a finished container to Instagram feed / reels.
   */
  private async publishContainer(containerId: string): Promise<string> {
    instagramLogger.info(`[InstagramService] Publishing container ${containerId} to Instagram...`);
    try {
      const res = await axios.post(
        `${this.baseUrl}/${this.igUserId}/media_publish`,
        null,
        {
          params: {
            creation_id: containerId,
            access_token: this.accessToken,
          },
        }
      );

      const mediaId = res.data?.id;
      if (!mediaId) {
        throw new Error('No media ID returned by media_publish');
      }
      instagramLogger.info(`[InstagramService] Successfully published media: ${mediaId}`);
      return mediaId;
    } catch (err) {
      this.handleError(`publishing container ${containerId}`, err);
    }
  }

  /**
   * Fetches public permalink and details for a published media item.
   */
  private async getMediaDetails(mediaId: string): Promise<{ permalink?: string; mediaType?: string }> {
    try {
      const res = await axios.get(`${this.baseUrl}/${mediaId}`, {
        params: {
          fields: 'id,permalink,media_type,timestamp',
          access_token: this.accessToken,
        },
      });
      return {
        permalink: res.data?.permalink,
        mediaType: res.data?.media_type,
      };
    } catch (err) {
      instagramLogger.warn(`[InstagramService] Could not retrieve permalink for ${mediaId}: ${err}`);
      return {};
    }
  }

  /**
   * Post a single photo to Instagram feed
   */
  async postPhoto(photo: Buffer | string, caption?: string): Promise<InstagramPostResult> {
    try {
      const imageUrl = await this.mediaStorage.uploadImage(photo, 'ig_photo');
      instagramLogger.info(`[InstagramService] Creating single photo container: ${imageUrl}...`);

      const params: Record<string, any> = {
        image_url: imageUrl,
        access_token: this.accessToken,
      };
      if (caption) {
        params.caption = caption;
      }

      const createRes = await axios.post(`${this.baseUrl}/${this.igUserId}/media`, null, { params });
      const containerId = createRes.data?.id;
      if (!containerId) {
        throw new Error('Failed to create single photo container (no ID returned)');
      }

      await this.waitForContainer(containerId);
      const mediaId = await this.publishContainer(containerId);
      const details = await this.getMediaDetails(mediaId);

      return {
        mediaId,
        permalink: details.permalink,
        mediaType: details.mediaType || 'IMAGE',
      };
    } catch (err) {
      this.handleError('posting single photo', err);
    }
  }

  /**
   * Post a multi-image Carousel to Instagram (2 to 10 images).
   * Perfect for multi-card reports (cover + individual hydro plants).
   */
  async postCarousel(items: Array<Buffer | string>, caption?: string): Promise<InstagramPostResult> {
    if (!items || items.length < 2) {
      throw new Error('[InstagramService] An Instagram Carousel requires at least 2 items.');
    }
    if (items.length > 10) {
      throw new Error('[InstagramService] An Instagram Carousel allows a maximum of 10 items.');
    }

    try {
      instagramLogger.info(`[InstagramService] Preparing carousel with ${items.length} items...`);

      // 1. Upload all items to storage and get public URLs
      const imageUrls: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const url = await this.mediaStorage.uploadImage(items[i], `ig_carousel_${i + 1}`);
        imageUrls.push(url);
      }

      // 2. Create child containers for each carousel item
      const childContainerIds: string[] = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        instagramLogger.info(`[InstagramService] Creating child item ${i + 1}/${imageUrls.length}...`);

        const res = await axios.post(`${this.baseUrl}/${this.igUserId}/media`, null, {
          params: {
            image_url: url,
            is_carousel_item: true,
            access_token: this.accessToken,
          },
        });

        const childId = res.data?.id;
        if (!childId) {
          throw new Error(`Failed to create child container for item ${i + 1}`);
        }
        childContainerIds.push(childId);
      }

      // 3. Wait for all child containers to be finished
      for (const childId of childContainerIds) {
        await this.waitForContainer(childId, 15, 2000);
      }

      // 4. Create the parent Carousel container
      instagramLogger.info(`[InstagramService] Creating parent carousel container with ${childContainerIds.length} children...`);
      const carouselParams: Record<string, any> = {
        media_type: 'CAROUSEL',
        children: childContainerIds.join(','),
        access_token: this.accessToken,
      };
      if (caption) {
        carouselParams.caption = caption;
      }

      const carouselRes = await axios.post(`${this.baseUrl}/${this.igUserId}/media`, null, {
        params: carouselParams,
      });

      const carouselContainerId = carouselRes.data?.id;
      if (!carouselContainerId) {
        throw new Error('Failed to create parent carousel container');
      }

      // 5. Wait for carousel container and publish
      await this.waitForContainer(carouselContainerId, 20, 2000);
      const mediaId = await this.publishContainer(carouselContainerId);
      const details = await this.getMediaDetails(mediaId);

      return {
        mediaId,
        permalink: details.permalink,
        mediaType: details.mediaType || 'CAROUSEL_ALBUM',
      };
    } catch (err) {
      this.handleError('posting carousel', err);
    }
  }

  /**
   * Post a Reel (video) to Instagram.
   * Perfect for satellite animations and weather radar loops.
   */
  async postReel(video: Buffer | string, options?: PostReelOptions): Promise<InstagramPostResult> {
    try {
      const videoUrl = await this.mediaStorage.uploadVideo(video, 'ig_reel');
      instagramLogger.info(`[InstagramService] Creating Reel container from ${videoUrl}...`);

      const reelParams: Record<string, any> = {
        media_type: 'REELS',
        video_url: videoUrl,
        share_to_feed: options?.shareToFeed !== false,
        access_token: this.accessToken,
      };

      if (options?.caption) {
        reelParams.caption = options.caption;
      }
      if (options?.coverUrl) {
        reelParams.cover_url = options.coverUrl;
      }

      const res = await axios.post(`${this.baseUrl}/${this.igUserId}/media`, null, {
        params: reelParams,
      });

      const reelContainerId = res.data?.id;
      if (!reelContainerId) {
        throw new Error('Failed to create Reel container (no ID returned)');
      }

      // Video encoding on Meta takes some time; allow up to 40 checks (120s)
      instagramLogger.info(`[InstagramService] Waiting for Reel video encoding: ${reelContainerId}...`);
      await this.waitForContainer(reelContainerId, 40, 3000);

      const mediaId = await this.publishContainer(reelContainerId);
      const details = await this.getMediaDetails(mediaId);

      return {
        mediaId,
        permalink: details.permalink,
        mediaType: details.mediaType || 'VIDEO',
      };
    } catch (err) {
      this.handleError('posting reel', err);
    }
  }
}
