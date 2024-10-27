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
        console.log(response.data.items);
        return response.data;

    })
    .catch(error => {
        console.error(error);
        return error;
    });
}

const urlHandles = {

}

var mazar = {
    nombre: "Mazar-Paute",
    cotaMin: 2115,
    cotaMax: 2153,
    energiaMax: 170,
    prefix: "maz",
    turbinas_id: 30503,
    caudal_id: 30538,
    cota_id: 30031
};

var molino = {
    nombre: "Molino",
    cotaMin: 2115,
    cotaMax: 2153,
    energiaMax: 1100,
    prefix: "mol",
    turbinas_id: 44822,
    caudal_id: 24811,
    cota_id: 24019
};

var sopladora = {
    nombre: "Sopladora",
    cotaMin: 1312,
    cotaMax: 1318,
    energiaMax: 487,
    prefix: "sop",
    turbinas_id: 90503,
    caudal_id: 90537,
    cota_id: 90919
};

var minas_san_francisco = {
    nombre: "Minas San Francisco",
    cotaMin: 783,
    cotaMax: 792,
    energiaMax: 270,
    prefix: "msf",
    turbinas_id: 650503,
    caudal_id: 650538,
    cota_id: 650919
};

var hidroelectricas = [mazar, sopladora, molino, minas_san_francisco];

var celec_sur = {
    nombre: "CELEC EP SUR",
    prefix: "csr",
    caudal_id: 24812 
}

getInfo(mazar.caudal_id);

//get those values
console.log(hidroID.mazarEnergia);
console.log(hidroID["mazarEnergia"]);
var fecha = new Date();
console.log(new Date(fecha.getTime() - 5 * 60 * 60 * 1000)); //works to do GMT-5

for(var central of hidroelectricas){
    console.log("Hidroeléctrica "+ central.nombre);
    for(var dato in central){
        console.log(dato,":", central[dato]);
    }
    console.log("\n");
}
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


this was taken around 23h34

https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues?mrid=24812&fechaInicio=2024-10-26T06:00:00.000Z&fechaFin=2024-10-27T05:00:00.000Z&fecha=26/10/2024%2001:00:00


when requesting information, oldest timestamps are last, that means that 00h00 is items[items.length], and 24h00 is items[0]
*/
