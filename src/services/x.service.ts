import fs from 'fs';
import { Client, OAuth1, type OAuth1Config, type ClientConfig } from '@xdevplatform/xdk';
import { xLogger } from '../utils/logger.js';

export interface PostMediaOptions {
  imageBuffer?: Buffer;
  videoBuffer?: Buffer;
  videoPath?: string;
}

export class XService {
  private client: Client;

  constructor(customClient?: Client) {
    if (customClient) {
      this.client = customClient;
      return;
    }

    const apiKey = process.env.API_KEY || process.env.X_API_KEY || '';
    const apiSecret = process.env.API_KEY_SECRET || process.env.X_API_KEY_SECRET || '';
    const accessToken = process.env.ACCESS_TOKEN || process.env.X_ACCESS_TOKEN || '';
    const accessTokenSecret = process.env.ACCESS_SECRET || process.env.X_ACCESS_TOKEN_SECRET || '';

    const oauth1Config: OAuth1Config = {
      apiKey,
      apiSecret,
      accessToken,
      accessTokenSecret,
      callback: process.env.OAUTH_CALLBACK || 'oob'
    };

    const oauth1 = new OAuth1(oauth1Config);
    const config: ClientConfig = {
      oauth1: oauth1
    };

    this.client = new Client(config);
  }

  /**
   * Upload image media to X and return mediaId.
   */
  async uploadImage(imageBuffer: Buffer): Promise<string> {
    if (!Buffer.isBuffer(imageBuffer)) {
      throw new Error('Given image is not a valid Buffer');
    }

    const uploadRes = await this.client.media.upload({
      body: {
        media: imageBuffer.toString('base64'),
        mediaCategory: 'tweet_image',
        mediaType: 'image/png'
      } as any
    });

    const mediaId = uploadRes?.data?.id 
      || uploadRes?.data?.media_id_string 
      || (uploadRes as any)?.id 
      || (uploadRes as any)?.media_id_string 
      || (uploadRes as any)?.media_id;

    if (!mediaId) {
      throw new Error(`Media upload call succeeded, but no media ID could be resolved. Raw response: ${JSON.stringify(uploadRes)}`);
    }

    return String(mediaId);
  }

  /**
   * Upload video to X using chunked media upload (INIT -> APPEND -> FINALIZE -> STATUS).
   * Accepts a video Buffer or file path string.
   */
  async uploadVideo(
    videoInput: Buffer | string,
    options: { chunkSize?: number; mediaCategory?: string; pollTimeoutSeconds?: number } = {}
  ): Promise<string> {
    let videoBuffer: Buffer;
    if (typeof videoInput === 'string') {
      if (!fs.existsSync(videoInput)) {
        throw new Error(`Video file not found at path: ${videoInput}`);
      }
      videoBuffer = fs.readFileSync(videoInput);
    } else if (Buffer.isBuffer(videoInput)) {
      videoBuffer = videoInput;
    } else {
      throw new Error('Given video input must be a Buffer or file path string');
    }

    if (videoBuffer.length === 0) {
      throw new Error('Video buffer is empty');
    }

    const totalBytes = videoBuffer.length;
    const mediaCategory = (options.mediaCategory || 'tweet_video') as any;
    const chunkSize = options.chunkSize || 2 * 1024 * 1024; // 2 MB chunks

    xLogger.info(`[XService] Initializing chunked video upload: ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB)...`);

    // 1. INIT
    const initRes = await this.client.media.initializeUpload({
      body: {
        totalBytes,
        mediaType: 'video/mp4',
        mediaCategory
      } as any,
      totalBytes,
      mediaType: 'video/mp4',
      mediaCategory
    } as any);

    const initAny = initRes as any;
    const mediaId = initAny?.data?.id 
      || initAny?.data?.media_id_string 
      || initAny?.id 
      || initAny?.media_id_string 
      || initAny?.media_id;

    if (!mediaId) {
      throw new Error(`Failed to initialize video upload: No media ID returned. Response: ${JSON.stringify(initRes)}`);
    }

    xLogger.info(`[XService] Video upload session initialized (mediaId: ${mediaId}). Appending chunks...`);

    // 2. APPEND
    let segmentIndex = 0;
    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
      const chunk = videoBuffer.subarray(offset, Math.min(offset + chunkSize, totalBytes));
      xLogger.info(`[XService] Appending chunk ${segmentIndex} (${chunk.length} bytes)...`);

      await this.client.media.appendUpload(String(mediaId), {
        body: {
          media: chunk.toString('base64'),
          segmentIndex
        } as any,
        media: chunk.toString('base64'),
        segmentIndex
      } as any);
      segmentIndex++;
    }

    xLogger.info(`[XService] Appended ${segmentIndex} chunk(s). Finalizing video upload...`);

    // 3. FINALIZE
    const finalizeRes = await this.client.media.finalizeUpload(String(mediaId));
    let processingInfo = finalizeRes?.data?.processing_info 
      || (finalizeRes?.data as any)?.processingInfo 
      || (finalizeRes as any)?.processing_info;

    // 4. STATUS polling (wait until X finishes encoding the video)
    const maxWaitSeconds = options.pollTimeoutSeconds || 120;
    let waitedSeconds = 0;

    while (processingInfo && (processingInfo.state === 'pending' || processingInfo.state === 'in_progress')) {
      const checkAfter = Math.max(1, processingInfo.check_after_secs || processingInfo.checkAfterSecs || 2);
      xLogger.info(
        `[XService] Video processing in state "${processingInfo.state}". Waiting ${checkAfter}s (progress: ${processingInfo.progress_percent || 0}%)...`
      );

      await new Promise(resolve => setTimeout(resolve, checkAfter * 1000));
      waitedSeconds += checkAfter;

      if (waitedSeconds > maxWaitSeconds) {
        throw new Error(`Timed out waiting for X video processing after ${waitedSeconds} seconds`);
      }

      const statusRes = await this.client.media.getUploadStatus(String(mediaId), { command: 'STATUS' });
      processingInfo = statusRes?.data?.processing_info 
        || (statusRes?.data as any)?.processingInfo 
        || (statusRes as any)?.processing_info;

      if (processingInfo && processingInfo.state === 'failed') {
        const errorMsg = processingInfo.error?.message || JSON.stringify(processingInfo.error || 'Video processing failed on X servers');
        throw new Error(`X video processing failed: ${errorMsg}`);
      }
    }

    xLogger.info(`[XService] Video successfully uploaded and processed by X (mediaId: ${mediaId})`);
    return String(mediaId);
  }

  /**
   * Post a tweet containing text and an MP4 video (from buffer or file path).
   */
  async postVideo(message: string, videoInput: Buffer | string): Promise<any> {
    try {
      const mediaId = await this.uploadVideo(videoInput);

      const postPayload: any = {
        text: message,
        media: {
          media_ids: [mediaId]
        }
      };

      xLogger.info(`[XService] Posting tweet with video (mediaId: ${mediaId}): "${message.slice(0, 80)}..."`);
      const response = await this.client.posts.create(postPayload);
      xLogger.info(`[XService] Video tweet posted successfully: ${JSON.stringify(response)}`);
      return response;
    } catch (error: any) {
      if (error?.status === 403 || error?.message?.includes('not allowed to post a video')) {
        xLogger.error(`[XService] 403 Forbidden: Account is not allowed to post this video: ${error?.message || error}`);
      } else {
        xLogger.error(`[XService] Error posting video tweet to X: ${error?.message || error}`);
      }
      throw error;
    }
  }

  /**
   * Upload media (image or video) and post a post (tweet) with text.
   * Fully backward-compatible with postTweet(message, imageBuffer).
   * Automatically detects if the buffer is an MP4 video or accepts PostMediaOptions.
   */
  async postTweet(message: string, media?: Buffer | PostMediaOptions): Promise<any> {
    try {
      let mediaIds: string[] | undefined = undefined;

      if (media) {
        if (!Buffer.isBuffer(media) && typeof media === 'object') {
          if (media.videoBuffer || media.videoPath) {
            const vidId = await this.uploadVideo((media.videoBuffer || media.videoPath)!);
            mediaIds = [vidId];
          } else if (media.imageBuffer) {
            const imgId = await this.uploadImage(media.imageBuffer);
            mediaIds = [imgId];
          }
        } else if (Buffer.isBuffer(media)) {
          // Detect MP4: offset 4 to 8 is 'ftyp'
          const isMp4 = media.length > 8 && media.subarray(4, 8).toString('ascii') === 'ftyp';
          if (isMp4) {
            const vidId = await this.uploadVideo(media);
            mediaIds = [vidId];
          } else {
            const imgId = await this.uploadImage(media);
            mediaIds = [imgId];
          }
        }
      }

      const postPayload: any = {
        text: message
      };

      if (mediaIds && mediaIds.length > 0) {
        postPayload.media = {
          media_ids: mediaIds
        };
      }

      xLogger.info(`Posting post: ${message}`);
      const response = await this.client.posts.create(postPayload);
      xLogger.info(`Posted response: ${JSON.stringify(response)}`);
      return response;
    } catch (error) {
      xLogger.error(`Error posting to X: ${error}`);
      throw error;
    }
  }

  /**
   * Post a text-only message to X
   */
  async postText(message: string): Promise<any> {
    return this.postTweet(message);
  }
}

