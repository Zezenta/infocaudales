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
function getInfo(id){
    axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
        params: {
            mrid: id,
            fechaInicio: '2024-10-26T06:00:00.000Z',
            fechaFin: '2024-10-27T05:00:00.000Z',
            fecha: '26/10/2024 01:00:00'
        }
    })
    .then(response => {
        console.log(response.data);
        return response.data;

    })
    .catch(error => {
        console.error(error);
        return error;
    });
}

const urlHandles = {

}

//map names with ids
const hidroID = {
    mazarEnergia: null, //MWh
    mazarTurbinas: 30503, //int
    molinoEnergia: null,
    molinoTurbinas: 44822,
    sopladoraEnergia: null,
    sopladoraTurbinas: 90503,
    msfranciscoEnergia: null,
    msfranciscoTurbinas: 650503,
    celecSurEnergia: null, //MWh
    mazarCaudal: 30538, //ms3
    mazarCota: 30031, //msnm
    amaluzaCaudal: 24811,
    amaluzaCota: 24019,
    sopladoraCaudal: 90537,
    sopladoraCota: 90919,
    msfranciscoCaudal: 650538,
    msfranciscoCota: 650919,
    pauteCaudal: 24812 //msnm
};

//get those values
console.log(hidroID.mazarEnergia);
console.log(hidroID["mazarEnergia"]);
var fecha = new Date();
console.log(new Date(fecha.getTime() - 5 * 60 * 60 * 1000)); //works to do GMT-5
/*
note that
mazEnerDia
molEnerDia
sopEnerDia
msfEnerDia
csrEnerDia
dont use ids, instead, they use their own url handles and dont use the pointValues param

i guess i'll have to alter Date and Time so it is synced with GMT-5 (ecuadorian time), because Verpex's servers are in london


all this was taken around 15h37

DAILY Energy handles:
PREFIX: first three letters of the hydroelectric name
https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom{PREFIX}/{PREFIX}EnerDia?fecha={DD/MM/AA}%2000:00:00

literally anything else:
ID: the ones declared before
FECHA: DD/MM/AA
https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues?mrid={ID}&fechaInicio={FECHA}T06:00:00.000Z&fechaFin={FECHA DD+1}T05:00:00.000Z&fecha=26/10/2024%2001:00:00
*/
