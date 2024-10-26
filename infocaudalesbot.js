const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
require('dotenv').config();

const client = new TwitterApi({
    appKey: process.env.API_KEY,
    appSecret: process.env.API_KEY_SECRET,
    accessToken: process.env.ACCESS_TOKEN,
    accessSecret: process.env.ACCESS_SECRET,
});

//twitter auth
async function postTweet() {
    try {
        const tweet = await client.v2.tweet('test\nhi');
        console.log('Tweet posted:', tweet);
    } catch (error) {
        console.error('Error posting tweet:', error, error.data);
    }
}

//get information
/*axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
    params: {
      mrid: '30538',
      fechaInicio: '2024-10-26T06:00:00.000Z',
      fechaFin: '2024-10-27T05:00:00.000Z',
      fecha: '26/10/2024 01:00:00'
    }
  })
  .then(response => {
    console.log(response.data);
  })
  .catch(error => {
    console.error(error);
  });
*/

//map names with ids
const nameIdMap = {
    mazar: 23432,
    sopladora: 12345,
    nalgas: 67890
};

//get those values
console.log(nameIdMap.mazar);
console.log(nameIdMap["mazar"]);