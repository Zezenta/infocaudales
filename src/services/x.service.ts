import { Client, OAuth1, type OAuth1Config, type ClientConfig } from '@xdevplatform/xdk';
import { xLogger } from '../utils/logger.js';

export class XService {
  private client: Client;

  constructor() {
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
   * Upload media and post a post (tweet) with text and optional media buffer
   */
  async postTweet(message: string, imageBuffer?: Buffer): Promise<any> {
    try {
      let mediaIds: string[] | undefined = undefined;

      if (imageBuffer) {
        if (!Buffer.isBuffer(imageBuffer)) {
          throw new Error('Given image is not a valid Buffer');
        }

        // Upload media via XDK MediaClient
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

        if (mediaId) {
          mediaIds = [String(mediaId)];
        } else {
          xLogger.warn(`Media upload call succeeded, but no media ID could be resolved in the response. Raw response: ${JSON.stringify(uploadRes)}`);
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
