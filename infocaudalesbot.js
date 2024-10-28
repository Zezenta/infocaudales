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
async function getInfoById(id, type){ //type could be "cota", "caudal", "turbinas"

    var fecha = new Date(); //UTC date, 5 hours ahead from localtime
    fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
    var anio = fecha.getUTCFullYear().toString(); //gets year
    var mes = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
    var dia = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
    
    var hora = fecha.getUTCHours(); //this for knowing which item from the response get, works in localtime
    
    //params
    var p_fechaInicio = anio + "-" + mes + "-" + dia + "T06:00:00.000Z";
    var p_fechaFin = new Date(p_fechaInicio);
    p_fechaFin.setHours(p_fechaFin.getUTCHours() + 23);
    console.log(p_fechaFin);
    var p_fecha = dia + "/" + mes + "/" + anio + " 01:00:00";

    var output = [];

    try {
        const actual = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
            params: {
                mrid: id,
                fechaInicio: p_fechaInicio,
                fechaFin: p_fechaFin,
                fecha: p_fecha
            }
        });
        output.push(actual.data.items[24 - hora].valueedit);

        if(type == "cota"){ //return output[actual, lunes]
            var fechaLunes = new Date(fecha);
            fechaLunes.setUTCDate(fecha.getUTCDate() - (fecha.getUTCDay() || 7) + 1);
            fechaLunes.setUTCHours(6, 0, 0, 0); // 6 am UTC, so fechaInicio
            var c_fechaFin = new Date(fechaLunes);
            c_fechaFin.setUTCHours(c_fechaFin.getUTCHours() + 23);

            var c_anio = fechaLunes.getUTCFullYear().toString(); //gets year
            var c_mes = (fechaLunes.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
            var c_dia = (fechaLunes.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
            var c_fecha = c_dia + "/" + c_mes + "/" + c_anio + " 01:00:00";

            const lunes = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
                params: {
                    mrid: id,
                    fechaInicio: fechaLunes,
                    fechaFin: c_fechaFin,
                    fecha: c_fecha
                }
            });
            output.push(lunes.data.items[23].valueedit);
        }
        else if(type == "caudal"){ //return output[actual, -3h]

        }
        return output;
        //console.log(24 - hora, response.data.items[24 - hora].valueedit);
        //return response.data.items[24 - hora].valueedit; // Devolvemos el valor deseado

    } catch (error) {
        console.error('Error fetching data:', error);
        return error; // Puedes retornar el error o manejarlo de otra forma
    }


}

var mazar = {
    nombre: "Mazar",
    cotaMin: 2115,
    cotaMax: 2153,
    energiaMax: 170,
    prefix: "maz",
    turbinas_id: 30503,
    caudal_id: 30538,
    cota_id: 30031,
    paute: true
};

var molino = {
    nombre: "Molino",
    cotaMin: 2115,
    cotaMax: 2153,
    energiaMax: 1100,
    prefix: "mol",
    turbinas_id: 44822,
    caudal_id: 24811,
    cota_id: 24019,
    paute: true
};

var sopladora = {
    nombre: "Sopladora",
    cotaMin: 1312,
    cotaMax: 1318,
    energiaMax: 487,
    prefix: "sop",
    turbinas_id: 90503,
    caudal_id: 90537,
    cota_id: 90919,
    paute: true
};

var minas_san_francisco = {
    nombre: "MinasSanFrancisco",
    cotaMin: 783,
    cotaMax: 792,
    energiaMax: 270,
    prefix: "msf",
    turbinas_id: 650503,
    caudal_id: 650538,
    cota_id: 650919,
    paute: false
};

var celec_sur = {
    nombre: "CELEC EP SUR",
    prefix: "csr",
    caudal_id: 24812 
}

var hidroelectricas = [mazar, sopladora, molino, minas_san_francisco];

(async() => {
    var nalga = await getInfoById(mazar.caudal_id);
    console.log( nalga[0]);
})();

for(var central of hidroelectricas){
    console.log("Hidroeléctrica "+ central.nombre);
    for(var dato in central){
        console.log(dato+":", central[dato]);
    }
    console.log("\n");
}

async function postearInfo(){



}



/*
note that
mazEnerDia
molEnerDia
sopEnerDia
msfEnerDia
csrEnerDia
dont use ids, instead, they use their own url handles and dont use the pointValues param

i guess i'll have to alter Date and Time so it is synced with GMT-5 (ecuadorian time), because Verpex's servers are in london (or in this case US east)


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

every single request has:
fechaInicio: year-month-dayT06:00:00.000Z
fechaFin year-month-{day+1}-T05:00:00.000Z
fecha: day/month/year%2001:00:00
but this starts from 01h00 to 24h00, i dont want that but they only support that

the response value according to actual time
*/
