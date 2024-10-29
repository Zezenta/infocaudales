const axios = require('axios');
const { TwitterApi } = require('twitter-api-v2');
const CronJob = require('cron').CronJob;
require('dotenv').config();

const client = new TwitterApi({
    appKey: process.env.API_KEY,
    appSecret: process.env.API_KEY_SECRET,
    accessToken: process.env.ACCESS_TOKEN,
    accessSecret: process.env.ACCESS_SECRET,
});

//twitter auth and posting
async function postTweet(message) {
    try {
        const tweet = await client.v2.tweet(message);
        console.log('Tweet posted:', tweet);
        var fechatweet = new Date();
        fechatweet.setHours(fechatweet.getHours()-5);
        console.log(fechatweet);
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

        if(type == "cota"){ //return output[actual, lunes, lunesDate]
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
            output.push(fechaLunes.getUTCDate());
        }
        else if(type == "caudal"){ //return output[actual, -3h]
            if(hora >= 4){
                output.push(actual.data.items[24-hora+3].valueedit);
            }else if(hora <= 3){
                var fechaAyer = new Date(fecha); //clone fecha
                fechaAyer.setUTCDate(fechaAyer.getUTCDate() - 1); //yesterday
                fechaAyer.setUTCHours(6, 0, 0, 0); //6 am UTC, so fechaInicio

                //obtain year, month and day
                var anioAyer = fechaAyer.getUTCFullYear().toString();
                var mesAyer = (fechaAyer.getUTCMonth()+1).toString().padStart(2, '0');
                var diaAyer = fechaAyer.getUTCDate().toString().padStart(2, '0');
                var h_fechaFin = new Date(fechaAyer);
                h_fechaFin.setHours(h_fechaFin.getUTCHours() + 23);
                var h_fecha = diaAyer + "/" + mesAyer + "/" + anioAyer + " 01:00:00";

                const _3h = await axios.get("https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues", {
                    params: {
                        mrid: id,
                        fechaInicio: fechaAyer,
                        fechaFin: h_fechaFin,
                        fecha: h_fecha
                    }
                });
                //console.log("got it from yesterday");
                output.push(_3h.data.items[2].valueedit);
            }
        }
        return output;

    } catch (error) {
        console.error('Error fetching data:', error);
        return error; // Puedes retornar el error o manejarlo de otra forma
    }
}

async function getEnergy(prefix){ //return actual, _3h, lunes
    var fecha = new Date(); //UTC date, 5 hours ahead from localtime
    fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
    var anio = fecha.getUTCFullYear().toString(); //gets year
    var mes = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
    var dia = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
    var p_fecha = dia + "/" + mes + "/" + anio + " 00:00:00";
    var hora = fecha.getUTCHours();

    var output = [];

    try {
        const actual = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom' + prefix + '/' + prefix + 'EnerDia', {
            params: {
                fecha: p_fecha
            }
        });
        output.push(actual.data.items[24-hora].valueedit);

        if(hora >= 4){
            output.push(actual.data.items[24-hora+3].valueedit);
        }else if(hora <= 3){
            var fechaAyer = new Date(fecha); //clone fecha
            fechaAyer.setUTCDate(fechaAyer.getUTCDate() - 1); //yesterday
            var anioAyer = fechaAyer.getUTCFullYear().toString();
            var mesAyer = (fechaAyer.getUTCMonth()+1).toString().padStart(2, '0');
            var diaAyer = fechaAyer.getUTCDate().toString().padStart(2, '0');
            var ayer = diaAyer + "/" + mesAyer + "/" + anioAyer + " 00:00:00";
            const valorAyer = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom' + prefix + '/' + prefix + 'EnerDia', {
                params: {
                    fecha: ayer
                }
            });
            output.push(valorAyer.data.items[2].valueedit);
        }

        var fechaLunes = new Date(fecha);
        fechaLunes.setUTCDate(fecha.getUTCDate() - (fecha.getUTCDay() || 7) + 1);
        fechaLunes.setUTCHours(0, 0, 0, 0);
        var anioLunes = fechaLunes.getUTCFullYear().toString();
        var mesLunes = (fechaLunes.getUTCMonth()+1).toString().padStart(2, '0');
        var diaLunes = fechaLunes.getUTCDate().toString().padStart(2, '0');
        var lunes = diaLunes + "/" + mesLunes + "/" + anioLunes + " 00:00:00";

        const valorLunes = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom' + prefix + '/' + prefix + 'EnerDia', {
            params: {
                fecha: lunes
            }
        });
        output.push(valorLunes.data.items[23].valueedit);
        output.push(fechaLunes.getUTCDate());

        return output;

    } catch (error) {
        console.error('Error fetching data:', error);
        return error; // Puedes retornar el error o manejarlo de otra forma
    }
}

async function celecSur(){ //still work to do, MW left but wont do it for now
    var fecha = new Date(); //UTC date, 5 hours ahead from localtime
    fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
    var anio = fecha.getUTCFullYear().toString(); //gets year
    var mes = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
    var dia = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month

    var p_fechaInicio = anio + "-" + mes + "-" + dia + "T06:00:00.000Z";
    var p_fechaFin = new Date(p_fechaInicio);
    p_fechaFin.setHours(p_fechaFin.getUTCHours() + 23);
    var p_fecha = dia + "/" + mes + "/" + anio + " 01:00:00";
    var hora = fecha.getUTCHours();

    var output = [];


    const caudal_actual = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom' + prefix + '/' + prefix + 'EnerDia', {
        params: {
            mrid: id,
            fechaInicio: p_fechaInicio,
            fechaFin: p_fechaFin,
            fecha: p_fecha
        }
    });
    output.push(caudal_actual.data.items[24 - hora].valueedit);

    if(hora >= 4){
        output.push(caudal_actual.data.items[24-hora+3].valueedit);
    }else if(hora <= 3){
        var fechaAyer = new Date(fecha); //clone fecha
        fechaAyer.setUTCDate(fechaAyer.getUTCDate() - 1); //yesterday
        fechaAyer.setUTCHours(6, 0, 0, 0); //6 am UTC, so fechaInicio

        //obtain year, month and day
        var anioAyer = fechaAyer.getUTCFullYear().toString();
        var mesAyer = (fechaAyer.getUTCMonth()+1).toString().padStart(2, '0');
        var diaAyer = fechaAyer.getUTCDate().toString().padStart(2, '0');
        var h_fechaFin = new Date(fechaAyer);
        h_fechaFin.setHours(h_fechaFin.getUTCHours() + 23);
        var h_fecha = diaAyer + "/" + mesAyer + "/" + anioAyer + " 01:00:00";

        const _3h = await axios.get("https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues", {
            params: {
                mrid: id,
                fechaInicio: fechaAyer,
                fechaFin: h_fechaFin,
                fecha: h_fecha
            }
        });
        //console.log("got it from yesterday");
        output.push(_3h.data.items[2].valueedit);
    }
}


var mazar = {
    nombre: "Mazar",
    cotaMin: 2098,
    cotaMax: 2153,
    energiaMax: 170,
    turbinasMax: 2,
    prefix: "maz",
    turbinas_id: 30503,
    caudal_id: 30538,
    cota_id: 30031,
    paute: true
};

var molino = {
    nombre: "Molino",
    cotaMin: 1975,
    cotaMax: 1991,
    energiaMax: 1100,
    turbinasMax: 10,
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
    turbinasMax: 3,
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
    turbinasMax: 3,
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


async function postearInfo(hidroelectrica){

    var cotas = await getInfoById(hidroelectrica.cota_id, "cota"); //[actual, lunes, lunesdate]
    var caudales = await getInfoById(hidroelectrica.caudal_id, "caudal"); //[actual, -3h]
    var turbinasActivas = await getInfoById(hidroelectrica.turbinas_id); //turbinasactivas
    var produccion = await getEnergy(hidroelectrica.prefix); //[actual, -3h, lunes, lunesdate]

    var indicadorPaute = (hidroelectrica.paute) ? " #Paute" : "";
    //cotas and caudales
    var signo_cota = (cotas[0] >= cotas[1]) ? "+" : "-";
    var delta_caudal = caudales[1] === 0 ? (caudales[0] > 0 ? 100 : 0) : ((caudales[0] - caudales[1]) / caudales[1]) * 100;
    var signo_caudal = (caudales[0] >= caudales[1]) ? "+" : "-";

    //energy
    var signo_ener_3h = (produccion[0] >= produccion[1]) ? "+" : "-";
    var delta_ener_3h = produccion[1] === 0 ? (produccion[0] > 0 ? 100 : 0) : ((produccion[0] - produccion[1]) / produccion[1]) * 100;
    var signo_ener_lunes = (produccion[0] >= produccion[2]) ? "+" : "-";
    var delta_ener_lunes = produccion[2] === 0 ? (produccion[0] > 0 ? 100 : 0) : ((produccion[0] - produccion[2]) / produccion[2]) * 100;
    var trabajoEnergia = (produccion[0] / hidroelectrica.energiaMax) * 100;

    var message = "Hidroeléctrica #" + hidroelectrica.nombre + indicadorPaute + "\n\n" + 
    "💧Cota: " + cotas[0].toFixed(2) + " msnm\n" +
    signo_cota + Math.abs(cotas[0]-cotas[1]).toFixed(2) + " m desde el lunes " + cotas[2] + "\n" +
    "A " + (cotas[0]-hidroelectrica.cotaMin).toFixed(2) + " m de la cota mínima\n\n" +
    "🌊Caudal: " + caudales[0].toFixed(2) + " m3/s\n" +
    signo_caudal + Math.abs(delta_caudal).toFixed(2) + "% desde hace 3h\n\n" +
    "🔋Generación: " + produccion[0].toFixed(2) + " MW/h\n" +
    "Al " + trabajoEnergia.toFixed(2) + "% de capacidad máxima\n" +
    signo_ener_3h + Math.abs(delta_ener_3h).toFixed(2) + "% desde hace 3h\n" +
    signo_ener_lunes + Math.abs(delta_ener_lunes).toFixed(2) + "% desde el lunes " + produccion[3] + "\n" +
    "Turbinas Activas: " + turbinasActivas + "/" + hidroelectrica.turbinasMax;
    
    console.log(message + "\n\n\n")

    //post the tweet
    postTweet(message);
}

async function trigger(){
    for(var hidroelectrica of hidroelectricas){
        postearInfo(hidroelectrica);
    }
}

const job = new CronJob('15 1-22/3 * * *', () => {
    trigger();
    console.log('Tik');
}, null, true, 'America/Guayaquil');
job.start();



//postTweet("Test\nHellowrold\n\n\nHi");
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
