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
    }

    /**
     * @public
     * @param {string} message
     */
    async postTweet(message) {
        try {
            console.log('[TwitterService] Posting tweet:', message);
            const tweet = await this._client.v2.tweet(message);
            console.log('[TwitterService] Posted tweet:', tweet.data);
        } catch (error) {
            console.error('[TwitterService] Error posting tweet', error);
            throw error;
        }
    }
}

module.exports = TwitterService