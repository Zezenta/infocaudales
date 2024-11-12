const { TwitterApi } = require('twitter-api-v2');

class TwitterService {
    /**
     * @private
     * @type {TwitterApi}
     */
    _client;

    /**
     * @public
     * @constructor
     */
    constructor() {
        this._client = new TwitterApi({
            appKey: process.env.API_KEY,
            appSecret: process.env.API_KEY_SECRET,
            accessToken: process.env.ACCESS_TOKEN,
            accessSecret: process.env.ACCESS_SECRET, 
        });
        this._rwClient = this._client.readWrite;
    }

    /**
     * @public
     * @param {string} message
     * @param {Buffer} imageBuffer
     * @returns {Promise<void>}
     */
    async postTweet(message, imageBuffer) {
        try {
            if(!Buffer.isBuffer(imageBuffer)){
                console.error("Buffer given not buffer");
            }

            const mediaId = await this._rwClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });

            const tweet = await this._rwClient.v2.tweet({
                text: message,
                media: {
                    media_ids: [mediaId],
                },
            });

            console.log('[TwitterService] Posting tweet:', message);
            console.log('[TwitterService] Posted tweet:', tweet.data);
        } catch (error) {
            console.error('[TwitterService] Error posting image tweet', error);
            throw error;
        }
    }
        /**
     * @public
     * @param {string} message
     */
    async postText(message) {
        try {
            console.log('[TwitterService] Posting tweet:', message);
            const tweet = await this._client.v2.tweet(message);
            console.log('[TwitterService] Posted tweet:', tweet.data);
        } catch (error) {
            console.error('[TwitterService] Error posting text tweet', error);
            throw error;
        }
    }
}

module.exports = TwitterService