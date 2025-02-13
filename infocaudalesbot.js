//test 🌊🌊🔋🔋💧💧 á é í ó ú
const axios = require('axios');
const TwitterService = require('./src/services/twitter.service');
const CronJob = require('cron').CronJob;
require('dotenv').config();
const { registerFont, createCanvas } = require('canvas');
const fs = require('fs');
registerFont('./src/fonts/DejaVuSansMono.ttf', { family: 'DejaVu Sans Mono' });
registerFont('./src/fonts/DejaVuSansMono-Bold.ttf', { family: 'DejaVu Sans Mono', weight: 'bold' });
const { mazar, molino, sopladora, minasSanFrancisco, cocaCodoSinclair } = require("./src/data/hidroelectricas.json");
const hidroelectricas = [mazar, molino, sopladora, cocaCodoSinclair];
const twitterService = new TwitterService();


var colors = ["Green", "Red", "Blue"]; //for generation, turbines, and water level
var cGreen = "#0ba408";

const job = new CronJob('15 7-22/6 * * *', () => { //hour to hour updates
    console.log('Tik');
    trigger();
    updateCocaCodoSinclair();
}, null, true, 'America/Guayaquil');
job.start();

const dailyJob = new CronJob('0 8 * * *', async () => { //daily report with complex charts
    console.log('Tik');
    await dailyReport();
    await CCSdailyReport();
}, null, true, 'America/Guayaquil');
dailyJob.start();


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
                output.push(_3h.data.items[2].valueedit);
            }
        }
        return output;

    } catch (error) {
        console.error('Error fetching data:', error);
        return error;
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
        return error;
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
        output.push(_3h.data.items[2].valueedit);
    }
}

async function postearInfo(hidroelectrica){

    var cotas = await getInfoById(hidroelectrica.cota_id, "cota"); //[actual, lunes, lunesdate]
    var caudales = await getInfoById(hidroelectrica.caudal_id, "caudal"); //[actual, -3h]
    var turbinasActivas = await getInfoById(hidroelectrica.turbinas_id); //turbinasactivas
    var produccion = await getEnergy(hidroelectrica.prefix); //[actual, -3h, lunes, lunesdate]

    if(cotas[0] === null || caudales[0] === null || turbinasActivas[0] === null || produccion[0] === null){ //if one of the values is not yet added (if one of the values is null)
        //try again 10 minutes later
        setTimeout(() => {
            postearInfo(hidroelectrica);
        }, 10 * 60 * 1000); //10 minutes in miliseconds

        return; //out
    }else{
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

        var message = "Hidroeléctrica #" + hidroelectrica.nombre.split(' ').join('') + indicadorPaute + "\n\n" + 
        "💧Cota: " + cotas[0].toFixed(2) + " msnm\n" +
        //signo_cota + Math.abs(cotas[0]-cotas[1]).toFixed(2) + " m desde el lunes " + cotas[2] + "\n" +
        "A " + (cotas[0]-hidroelectrica.cotaMin).toFixed(2) + " m de la cota mínima\n\n" +
        "🌊Caudal: " + caudales[0].toFixed(2) + " m³/s\n" +
        signo_caudal + Math.abs(delta_caudal).toFixed(2) + "% desde hace 3h\n\n" +
        "🔋Generación: " + produccion[0].toFixed(2) + " MWh\n" +
        "Al " + trabajoEnergia.toFixed(2) + "% de capacidad máxima\n" +
        //signo_ener_3h + Math.abs(delta_ener_3h).toFixed(2) + "% desde hace 3h\n" +
        //signo_ener_lunes + Math.abs(delta_ener_lunes).toFixed(2) + "% desde el lunes " + produccion[3] + "\n" +
        "Turbinas Activas: " + turbinasActivas + "/" + hidroelectrica.turbinasMax;
        
        
        //IMAGE GENERATION
        const canvas = createCanvas(1000, 1000);
        const ctx = canvas.getContext('2d');
        var textFont = "DejaVu Sans Mono";

        function formatDateTime() {
            var fecha = new Date(); //UTC date, 5 hours ahead from localtime
            fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
            var year = fecha.getUTCFullYear().toString(); //gets year
            var month = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
            var day = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
            
            var hours = fecha.getUTCHours().toString().padStart(2, '0'); //this for knowing which item from the response get, works in localtime
            var minutes = fecha.getUTCMinutes().toString().padStart(2, '0');;
        
            const formattedDate = `${day}/${month}/${year}`;
            const formattedTime = `${hours}:${minutes}`;
        
            return { date: formattedDate, time: formattedTime };
        }
        const { date: formattedDate, time: formattedTime } = formatDateTime();


        ctx.fillStyle = "#f0d9c2";
        ctx.fillRect(0, 0, 1000, 1000);
        
        //right offset
        const offsetX = 100;
        
        //draw hydroelectric
        ctx.beginPath();
        ctx.moveTo(0, 925);
        ctx.lineTo(offsetX + 50, 890);
        ctx.quadraticCurveTo(offsetX + 100, 870, offsetX + 120, 800);
        ctx.lineTo(offsetX + 200, 400);
        ctx.quadraticCurveTo(offsetX + 210, 350, offsetX + 275, 350);
        ctx.lineTo(offsetX + 275, 300);
        ctx.lineTo(offsetX + 300, 300);
        ctx.lineTo(offsetX + 300, 230);
        ctx.lineTo(offsetX + 360, 230);
        ctx.lineTo(offsetX + 360, 275);
        ctx.lineTo(offsetX + 400, 275);
        ctx.lineTo(offsetX + 400, 1000);
        ctx.lineTo( 0, 1000);
        ctx.closePath();
        
        ctx.fillStyle = "#5f5c63"; //hydroelectric fill
        ctx.fill();
        
        ctx.strokeStyle = "black"; //line style
        ctx.lineWidth = 2;
        ctx.stroke();
        
        //lateral lines
        ctx.beginPath();
        ctx.moveTo(offsetX + 275, 350);
        ctx.lineTo(offsetX + 175, 1000);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(offsetX + 360, 275);
        ctx.lineTo(offsetX + 360, 1000);
        ctx.stroke();
        
        var nivel_agua = interpolation(cotas[0].toFixed(2), hidroelectrica.cotaMin, hidroelectrica.cotaMax, 760, 300);
        
        //draw water level
        ctx.beginPath();
        ctx.moveTo(offsetX + 400, 1000);
        ctx.lineTo(1000, 1000);
        ctx.lineTo(1000, nivel_agua);
        ctx.lineTo(offsetX + 400, nivel_agua);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = "#0793de"; //water tone
        ctx.fill();
        

        //watermark
        ctx.font = 'bold 32px ' + textFont;
        ctx.fillStyle = 'black';
        ctx.fillText("@Hidro_Info_Bot", 705, 30);
        //title and date
        ctx.font = 'bold 60px ' + textFont;
        ctx.fillStyle = 'black';
        ctx.fillText(hidroelectrica.nombre, 20, 70);
        ctx.font = 'bold 50px ' + textFont;
        ctx.fillText(`${formattedDate} ${formattedTime}`, 20, 125);
        
        
        //minimum cota RED line and text
        ctx.font = 'bold 30px ' + textFont;
        ctx.fillStyle = "red";
        ctx.fillText("Cota mínima: " + hidroelectrica.cotaMin + " msnm", 510, 790);
        ctx.beginPath();
        ctx.moveTo(500, 760);
        ctx.lineTo(1000, 760);
        ctx.strokeStyle = "red";
        ctx.lineWidth = 5;
        ctx.stroke();
        
        //current cota text
        ctx.font = 'bold 30px ' + textFont;
        ctx.fillStyle = "#0793de";
        ctx.fillText("Cota actual: " + cotas[0].toFixed(2) + " msnm", 510, nivel_agua - 10);

        //maximum cota
        ctx.font = 'bold 30px ' + textFont;
        ctx.fillStyle = 'gray';
        ctx.fillText("-Cota máxima: " + hidroelectrica.cotaMax + " msnm", 500, 305);
        
        //caudal text
        ctx.font = 'bold 40px ' + textFont;
        ctx.fillStyle = "black";
        ctx.fillText("Caudal: " + caudales[0].toFixed(2) + "m³/s", 575, 200);
        var caudaloutput = getCaudalCategory(caudales[0].toFixed(2), hidroelectrica.maxCaudal);
        ctx.fillStyle = caudaloutput[1];
        ctx.fillText(caudaloutput[0], 775, 235);
        
        //battery
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "black";
        ctx.moveTo(11, 310);
        ctx.lineTo(11, 345);
        ctx.lineTo(170, 345);
        ctx.lineTo(170, 335);
        ctx.lineTo(175, 335);
        ctx.lineTo(175, 320);
        ctx.lineTo(170, 320);
        ctx.lineTo(170, 310);
        ctx.closePath();
        ctx.stroke();
        
        var energiaPixelsFill = interpolation(produccion[0].toFixed(2), 0, hidroelectrica.energiaMax, 0, 150);
        var energiaoutput = getEnergyCategory(energiaPixelsFill); //color
        
        //battery content
        ctx.fillStyle = energiaoutput[1];
        ctx.fillRect(16, 315, energiaPixelsFill, 25);
        
        //generation
        ctx.font = 'bold 40px ' + textFont;
        ctx.fillStyle = "black";
        ctx.fillText("Generación:", 10, 250);
        ctx.fillText(produccion[0].toFixed(2) + " MW", 10, 300);
        
        ctx.fillStyle = energiaoutput[1];
        ctx.fillText(energiaoutput[0], 185, 340);
        
        ctx.closePath();
        ctx.stroke();
        //save the image
        const imageBuffer = canvas.toBuffer('image/png');
        //fs.writeFileSync("./postear.png", imageBuffer);

        //post the tweet
        try{
            await twitterService.postTweet(message, imageBuffer);
        }catch(error){
            console.error("Error with TwitterService");
            return error;
        }
    }
}

async function trigger() {
    for(i = 0; i < 3; i++){
        postearInfo(hidroelectricas[i]);
    }
}

//DAILY REPORTS
async function getDailyInfo(){
    var fecha = new Date(); //UTC Date
    fecha.setHours(fecha.getHours() - 5); //reduce it to gmt-5


    //reduce a day
    fecha.setDate(fecha.getDate() - 1);

    var anio = fecha.getUTCFullYear().toString(); //gets year
    var mes = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
    var dia = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
    
    //params
    var p_fechaInicio = anio + "-" + mes + "-" + dia + "T06:00:00.000Z";
    var p_fechaFin = new Date(p_fechaInicio);
    p_fechaFin.setHours(p_fechaFin.getUTCHours() + 23);
    var p_fecha = dia + "/" + mes + "/" + anio + " 01:00:00";
    var energia_fecha = dia + "/" + mes + "/" + anio + " 00:00:00";

    var output = [[[], [], [], []], [[], [], [], []], [[], [], [], []], [[], [], [], []], [[], [], [], []]]; //will be in the order of [hydroelectric][info][hour]

    //get data en masse
    try {
        for(i = 0; i < 4; i++){ //for each hydroelectric
            var cPrefix = hidroelectricas[i].prefix;
            var generationInfo = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardom' + cPrefix + '/' + cPrefix + 'EnerDia', { //generation is unique so gets its own block of code
                params: {
                    fecha: energia_fecha
                }
            });

    
            var turbinesInfo = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
                params: {
                    mrid: hidroelectricas[i].turbinas_id,
                    fechaInicio: p_fechaInicio,
                    fechaFin: p_fechaFin,
                    fecha: p_fecha
                }
            });
    
            var water_levelInfo = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
                params: {
                    mrid: hidroelectricas[i].cota_id,
                    fechaInicio: p_fechaInicio,
                    fechaFin: p_fechaFin,
                    fecha: p_fecha
                }
            });

            var water_caudalInfo = await axios.get('https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues', {
                params: {
                    mrid: hidroelectricas[i].caudal_id,
                    fechaInicio: p_fechaInicio,
                    fechaFin: p_fechaFin,
                    fecha: p_fecha
                }
            });
    
            for(z = 0; z <= 23; z++){ //parse every bit of information in 
                output[i][0].push(generationInfo.data.items[23 - z].valueedit);
                output[i][1].push(turbinesInfo.data.items[23 - z].valueedit);
                output[i][2].push(water_levelInfo.data.items[23 - z].valueedit);
                output[i][3].push(water_caudalInfo.data.items[23 - z].valueedit);
            }
        }
        
        return output; //[i][0] for energy, [i][1] for turbines, [i][2] waterLevel

    } catch (error) {
        console.error('Error fetching daily data:', error);
        return error;
    }
}


async function dailyReport(){
    const masterInfo = await getDailyInfo();
    var width = 2200;
    var height = 2500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    var textFont = "DejaVu Sans Mono"; //cross compatible font


    //pretty obvious
    function formatDateTime() {
        var fecha = new Date(); //UTC date, 5 hours ahead from localtime
        fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
        fecha.setDate(fecha.getDate() - 1);
        const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const diaSemana = diasSemana[fecha.getUTCDay()];

        const year = fecha.getFullYear();
        const diaMes = fecha.getUTCDate().toString().padStart(2, '0');
        const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const mes = meses[fecha.getUTCMonth()];

        return [diaSemana, diaMes, mes, year];
    }
    const dateInfo = formatDateTime();

    ctx.fillStyle = "#f0d9c2"; //background color
    ctx.fillRect(0, 0, 2200, 2500); //background filler
    //watermark text
    ctx.font = 'bold 46px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.textAlign = "end";
    ctx.fillText("@Hidro_Info_Bot", 2190, 40);
    //title text
    ctx.font = 'bold 102px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.textAlign = "start";
    ctx.fillText("Reporte Diario Complejo Paute", 20, 120); //title
    ctx.font = 'bold 96px ' + textFont;
    ctx.fillText(`${dateInfo[0]}, ${dateInfo[1]} de ${dateInfo[2]} del ${dateInfo[3]}`, 20, 235); //date and stuff

    //PARAMETERS
    //main box
    var anchor = [25, 350];
    //infoblocks
    var initialYcoords = anchor[1];
    var infoBlock_height = 500;
    var infoBlockSpacing = 70;
    //infoblocks content
    var contentHeight = 450;
    var infoBlock_margin = (infoBlock_height - contentHeight) / 2;
    var infoBlock_width = width - infoBlock_margin * 2;
    var graphSpacing = 10;
    var labels = ["Generación", "Turbinas", "Cota"];
    var totalDailyGeneration = 0;
    //infoblocks PARAMETERS
    var graphLineWidth = 5; //Y axis ticks line width
    var graphLineLength = 20; //Y axis ticks line length
    var estTextWidth = 180; //hydroelectric name title width
    var bigSpace = 710; //space allocated to generation chart + battery
    var normalSpace = 565; //space that the other 2 graph take
    var lastSpacing = 100; //space between water level graph and turbines graph

    var individualEnergy = []; //for later tweet message

    //GRAY LABELS FOR GENERACIÓN, TURBINAS, AND COTA
    //x axis values (TIME) (in array because they are not that ordered, they are actually kind of chaotic)
    var xvalues = [anchor[0] + estTextWidth, anchor[0] + estTextWidth + bigSpace + (graphSpacing / 2), anchor[0] + estTextWidth + bigSpace + normalSpace + (graphSpacing / 2 * 3) + lastSpacing];
    text(xvalues[0] + bigSpace / 2 - 50, anchor[1] - 20, labels[0], " 70px " + textFont, "center", "gray");
    text(xvalues[1] + normalSpace / 2, anchor[1] - 20, labels[1], " 70px " + textFont, "center", "gray");
    text(xvalues[2] + normalSpace / 2, anchor[1] - 20, labels[2], " 70px " + textFont, "center", "gray");


    //generate infoBlocks
    for(i = 0; i < 3; i++){

        //each infoblock
        ctx.beginPath();
        ctx.strokeStyle = "black";
        ctx.lineWidth = 5;
        ctx.rect(anchor[0], initialYcoords, infoBlock_width, infoBlock_height + infoBlockSpacing); //add +infoBlockSpacing to the end
        ctx.stroke();
        rotatedText(anchor[0] + infoBlock_margin + 55, initialYcoords + infoBlock_height / 2, hidroelectricas[i].nombre, "bold 80px " + textFont); //hydroelectric title
        
        //SMALL BOXES FOR GRAPH LABELING, ALSO INCLUDES INDIVIDUAL BATTERY
        //GENERATION GRAPH
        testRect(anchor[0] + estTextWidth, initialYcoords + infoBlock_margin, 565, contentHeight, "Black", graphLineWidth); //graph box

        var startingPoint = [anchor[0] + estTextWidth, initialYcoords + infoBlock_margin + contentHeight]; //will adjust the X position to where the left line is (to place the ticks in the Y axis)

        //for the line ticks in the Y axis
        var genPointer = 0;
        for(y = 0; y < contentHeight; y = y + (contentHeight / 5)){ //add a bunch of pixels (that correspond to a fifth of the total graph height)
            test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //adds line ticks

            rotatedText(startingPoint[0] - graphLineLength / 2 - 20, startingPoint[1] - 6 - y + 5, Math.round(hidroelectricas[i].energiaMax / 5 * genPointer), "bold 30px " + textFont, true); //adds ticks labeling

            genPointer++; //increase pointer to label in next iteration
        }

        text(startingPoint[0] - graphLineLength / 2 - 30, initialYcoords + 40, "MWh", "bold 30px " + textFont); //MWh indicator atop of Y axis

        //individual BATTERY DRAWING
        test(estTextWidth + bigSpace - 110, initialYcoords + 22.5 + 30, estTextWidth + bigSpace - 110, initialYcoords + contentHeight + infoBlock_margin + 2.5);
        test(estTextWidth + bigSpace - 110, initialYcoords + contentHeight + infoBlock_margin, estTextWidth + bigSpace - 10, initialYcoords + contentHeight + infoBlock_margin);
        test(estTextWidth + bigSpace - 10, initialYcoords + 22.5 + 30, estTextWidth + bigSpace - 10, initialYcoords + contentHeight + infoBlock_margin + 2.5);
        test(estTextWidth + bigSpace - 112.5, initialYcoords + 22.5 + 30, estTextWidth + bigSpace - 85, initialYcoords + 22.5 + 30);
        test(estTextWidth + bigSpace - 7.5, initialYcoords + 22.5 + 30, estTextWidth + bigSpace - 35, initialYcoords + 22.5 + 30);
        test(estTextWidth + bigSpace - 35, initialYcoords + 25 + 30, estTextWidth + bigSpace - 35, initialYcoords + 30);
        test(estTextWidth + bigSpace - 85, initialYcoords + 25 + 30, estTextWidth + bigSpace - 85, initialYcoords + 30);
        test(estTextWidth + bigSpace - 87.5, initialYcoords + 30, estTextWidth + bigSpace - 32.5, initialYcoords + 30);


        var energySum = 0; //individual energy sum
        var maxDailyEnergy = hidroelectricas[i].energiaMax * 24; //individual max daily energy
        
        for (let h = 0; h < masterInfo[i][0].length; h++) {
            energySum += masterInfo[i][0][h]; //for individual battery drawing
        }
        individualEnergy[i] = energySum; //for later tweet message
        totalDailyGeneration += energySum; //for big battery drawing
        //individual battery fill
        testRect(estTextWidth + bigSpace - 105, initialYcoords + contentHeight + 20, 90, interpolation(energySum, 0, maxDailyEnergy, 0, -412.5), cGreen, 5, cGreen); //battery fill (0, -412.5)
        //END GENERATION GRAPH



        //TURBINE GARPH
        testRect(anchor[0] + estTextWidth + bigSpace + (graphSpacing / 2), initialYcoords + infoBlock_margin, normalSpace, contentHeight, "Black", graphLineWidth); //graph box
        startingPoint[0] += bigSpace + (graphSpacing / 2); //upgrade the line ticks to the new X position
        var turbinePointer = 0; //tick labeling pointer
        //same thing than with other graphs, but adds 1 more unit to the turbine maximum for aesthetics
        for(y = 0; y < contentHeight - infoBlock_margin; y = y + (contentHeight / (hidroelectricas[i].turbinasMax + 1))){
            test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //ticks

            text(startingPoint[0] - graphLineLength / 2 - 3, startingPoint[1] - y, turbinePointer, "bold 20px " + textFont, "end"); //labeling

            turbinePointer++;
        }
        //END TURBINE GRAPH



        //WATER LEVEL GRAPH
        testRect(anchor[0] + estTextWidth + bigSpace + normalSpace + (graphSpacing / 2 * 3) + lastSpacing, initialYcoords + infoBlock_margin, normalSpace, contentHeight, "Black", graphLineWidth); //graph box
        startingPoint[0] = startingPoint[0] - (graphSpacing / 2) + (graphSpacing / 2 * 3) + normalSpace + lastSpacing; //upgrade the line ticks to the new X position
        var wlPointer = 0;
        //ticks as with other graphs
        for(y = 0; y < contentHeight; y = y + (contentHeight / 5)){
            test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //draws ticks lines
            rotatedText(startingPoint[0] - graphLineLength / 2 - 20, startingPoint[1] - 6 - y + 5, Math.round((hidroelectricas[i].cotaMax - hidroelectricas[i].cotaMin) / 5 * wlPointer + hidroelectricas[i].cotaMin), "bold 30px " + textFont, true); //writes ticks labels, changed to stay in the interval between minimum and maximum water leels
            wlPointer++;
        }
        text(startingPoint[0] - graphLineLength / 2 - 35, initialYcoords + 40, "msnm", "bold 30px " + textFont);
        //END WATER LEVEL GRAPH
        


        //loop each graph inside an infoBlock
        for(k = 0; k < 3; k++){
            ctx.beginPath();
            ctx.strokeStyle = colors[k];
            ctx.lineWidth = 4; //optimal lineWidth


            //for each bit of information, draw another line
            if(k == 1){ //for turbines
                ctx.moveTo(xvalues[k], interpolation(masterInfo[i][1][0], 0, hidroelectricas[i].turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information

                for (j = 1; j <= 24; j++) {
                    //previous coords
                    //previous Y uses last data value to mark where it should increase or decrease from
                    //it wont define it to nothing if we reached the end (so the next continuation line isnt drawn)
                    const prevY = interpolation(masterInfo[i][1][j - 1], 0, hidroelectricas[i].turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin);

                    //current coords
                    const currentX = xvalues[k] + (j - 1) * 24.5; //this works differently as the other ones, because the value jumps one space
                    //current Y uses current data value
                    const currentY = interpolation(masterInfo[i][1][j], 0, hidroelectricas[i].turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin);

                    //if its past the last one (23rd last one bc it started on 0), just dont draw anything
                    ctx.lineTo(currentX, prevY);
                    ctx.lineTo(currentX, currentY);


                    //we still have to use currentX value to write x axis
                    //x axis
                    if(j % 6 === 0) {
                        rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true);
                    }
                }

            }else if(k == 2){ //if its a water graph
                ctx.moveTo(xvalues[k], interpolation(masterInfo[i][2][0], hidroelectricas[i].cotaMin, hidroelectricas[i].cotaMax, initialYcoords + infoBlock_margin + contentHeight, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information
                for(j = 1; j <= 24; j++){

                    if(j < 24){
                        ctx.lineTo(xvalues[k] + j * 24.5, interpolation(masterInfo[i][2][j], hidroelectricas[i].cotaMin, hidroelectricas[i].cotaMax, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin));
                    }
                    if(j % 6 == 0){
                        rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true)    
                    }

                } 
            }else{ //for generation
                ctx.moveTo(xvalues[k], interpolation(masterInfo[i][0][0], 0, (hidroelectricas[i].energiaMax + hidroelectricas[i].energiaMax * 0.04), initialYcoords + infoBlock_margin + contentHeight, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information
                for(j = 1; j <= 24; j++){
                    
                    if(j < 24){
                        ctx.lineTo(xvalues[k] + j * 24.5, interpolation(masterInfo[i][0][j], 0, (hidroelectricas[i].energiaMax + hidroelectricas[i].energiaMax * 0.04), initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin));
                    }
                    if(j % 6 == 0){
                        rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true)    
                    }
                    
                }
            }

            ctx.stroke();
        }

        //Y COORDS FOR NEXT INFOBLOCK
        initialYcoords += infoBlock_height + infoBlockSpacing;
        
    }

    //BIG BATTERY DRAWING
    var totalMaxDailyGeneration = hidroelectricas[0].energiaMax * 24 + hidroelectricas[1].energiaMax * 24 + hidroelectricas[2].energiaMax * 24;
    var batterySpacing = 12.5;
    var batteryAnchor = infoBlock_height * 3 + infoBlockSpacing * 3 + batterySpacing + anchor[1] + 115;
    ctx.strokeStyle = "black";
    var batteryLength = 80; //length in respect to the end
    var batteryHeight = 300;
    var batteryLineWidth = 10;
    var lineCorrectionFactor = 5;

    //BATTERY TEXT
    text(anchor[0], batteryAnchor - 15, "Producción: " + totalDailyGeneration.toFixed(2) + " MWh (" + interpolation(totalDailyGeneration + 34, 0, totalMaxDailyGeneration, 0, 100).toFixed(2) + "% del máximo)", "bold 80px " + textFont, "start")

    anchor[0] += 10;
    testRect(anchor[0] + 5, batteryAnchor + batterySpacing + 5, interpolation(totalDailyGeneration, 0, totalMaxDailyGeneration, 0, 2065), batteryHeight - 22.5, cGreen, 5, cGreen); //BATTERY FILL
    test(anchor[0], batteryAnchor + batterySpacing, anchor[0], batteryAnchor + batteryHeight, "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength + lineCorrectionFactor, batteryAnchor + batterySpacing, anchor[0] - lineCorrectionFactor, batteryAnchor + batterySpacing,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength + lineCorrectionFactor, batteryAnchor + batteryHeight, anchor[0] - lineCorrectionFactor, batteryAnchor + batteryHeight,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing, anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing + (batteryHeight * 0.3) + lineCorrectionFactor, "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight, anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight - (batteryHeight * 0.3) - lineCorrectionFactor,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight - (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4) + lineCorrectionFactor, batteryAnchor + batteryHeight - (batteryHeight * 0.3), "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing + (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4) + lineCorrectionFactor, batteryAnchor + batterySpacing + (batteryHeight * 0.3),  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - (batteryLength * 0.4), batteryAnchor + batterySpacing + (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4), batteryAnchor + batteryHeight - (batteryHeight * 0.3),  "black", batteryLineWidth)

    //not elegant but will refactor later
    var deltaMazar = (masterInfo[0][2][0] < masterInfo[0][2][23]) ? ", un aumento de " : ", una reducción de ";
    var deltaMolino = (masterInfo[1][2][0] < masterInfo[1][2][23]) ? ", un aumento de " : ", una reducción de ";
    var deltaSopladora = (masterInfo[2][2][0] < masterInfo[2][2][23]) ? ", un aumento de " : ", una reducción de ";


    var dailyMessage = "Reporte Diario del Complejo #Paute\n" +
    //"Durante las 24 horas del " + dateInfo[0] + ", " + dateInfo[1] + " de " + dateInfo[2] + ":\n" +
    "Durante 24 horas:\n" +
    "\n" +
    "#Mazar\n" +
    "Generó " + individualEnergy[0].toFixed(2) + " MWh, un " + interpolation(individualEnergy[0], 0, (mazar.energiaMax * 24), 0, 100).toFixed(2) + "% de su capacidad máxima\n" +
    //"Su cota pasó de " + masterInfo[0][2][0].toFixed(2) + " msnm, a " + masterInfo[0][2][23].toFixed(2) + deltaMazar + Math.abs(masterInfo[0][2][0] - masterInfo[0][2][23]).toFixed(2)  + " metros\n" +
    "\n" +
    "#Molino\n" +
    "Generó " + individualEnergy[1].toFixed(2) + " MWh, un " + interpolation(individualEnergy[1], 0, (molino.energiaMax * 24), 0, 100).toFixed(2) + "% de su capacidad máxima\n" +
    //"Su cota pasó de " + masterInfo[1][2][0].toFixed(2) + " msnm, a " + masterInfo[1][2][23].toFixed(2) + deltaMolino + Math.abs(masterInfo[1][2][0] - masterInfo[1][2][23]).toFixed(2) + " metros\n" +
    "\n" +
    "#Sopladora\n" +
    "Generó " + individualEnergy[2].toFixed(2) + " MWh, un " + interpolation(individualEnergy[2], 0, (sopladora.energiaMax * 24), 0, 100).toFixed(2) + "% de su capacidad máxima\n";// +
    //"Su cota pasó de " + masterInfo[2][2][0].toFixed(2) + " msnm, a " + masterInfo[2][2][23].toFixed(2) + deltaSopladora + Math.abs(masterInfo[2][2][0] - masterInfo[2][2][23]).toFixed(2) + " metros\n";

    const imageBuffer = canvas.toBuffer('image/png');
    //fs.writeFileSync("./test.png", imageBuffer);
    
    try{
        await twitterService.postTweet(dailyMessage, imageBuffer);
    }catch(error){
        console.error("Error with TwitterService in Daily Reporting");
        return error;
    }
    

    //FUNCTIONS
    function test(X, Y, X1, Y1, color, optionalLineWidth){
        ctx.beginPath();
        ctx.lineWidth = (optionalLineWidth) ? optionalLineWidth : 5;
        ctx.strokeStyle = color;
        ctx.moveTo(X, Y);
        ctx.lineTo(X1, Y1);
        ctx.stroke();
    }
    
    function testRect(X, Y, X1, Y1, color, optionalLineWidth, fillColor){
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = optionalLineWidth;
        if (fillColor) {
            ctx.fillStyle = fillColor;
            ctx.fillRect(X, Y, X1, Y1);
            return;
        }
        ctx.rect(X, Y, X1, Y1);
        ctx.stroke();
    }
    
    function text(X, Y, text, textValue, alignment, optionalColor){
        ctx.font = textValue;
        ctx.fillStyle = (optionalColor) ? optionalColor : "black";
        ctx.textAlign = (alignment) ? alignment : "center";
    
        ctx.fillText(text, X, Y);
    }
    
    
    function rotatedText(X, Y, text, textValue, inclination){ //inclination is optional
        ctx.font = textValue;
        ctx.fillStyle = 'black';
        ctx.textAlign = "center";
    
        ctx.save(); //save initial state
        ctx.translate(X, Y); //move coord system to input params
        ctx.rotate(inclination ? -Math.PI / 4 : -Math.PI / 2); //rotate context to the left(equivalent to -90 degrees o -Math.PI/2 radians)
        ctx.fillText(text, 0, 0); //write text in new orientation
        ctx.restore(); //restore text to not mess it up in any other text writing
    }
}

//very important function to draw graphs
function interpolation(value, minimumvalue, maximumValue, minimumPixel, maximumPixel) {
    return ((value - minimumvalue) * (maximumPixel - minimumPixel)) / (maximumValue - minimumvalue) + minimumPixel;
}

function getCaudalCategory(value, maxCaudal) {
    if (value == 0) return ["Nulo", "#373b34"];
  
    const segment = maxCaudal / 5;//divide max in 5 equal segments
  
    if (value > 0 && value <= segment) return ["Muy Bajo", "Red"];
    if (value > segment && value <= segment * 2) return ["Bajo", "#bf6626"];
    if (value > segment * 2 && value <= segment * 3) return ["Medio", "Orange"];
    if (value > segment * 3 && value <= segment * 4) return ["Alto", "#519928"];
    if (value > segment * 4) return ["Muy Alto", "Green"];
  
    return ["Muy Alto", "Green"]; //just in case
}

function getEnergyCategory(value) {
    if(value <= 0) {
        return ["Nula", "#2b2727"];
    }else if (value > 0 && value < 50) {
        return ["Baja", "Red"];
    }else if (value >= 50 && value < 100) {
        return ["Media", "Orange"];
    }else if (value >= 100) {
        return ["Alta", "Green"];
    }else{
        console.error("Out of range getCategory function");
    }
}


async function updateCocaCodoSinclair(){ //normal 3hour report
    var width = 1000;
    var height = 600;
    const canvas = createCanvas(width, height); // Ajuste de altura del canvas
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = "#f0d9c2";
    ctx.fillRect(0, 0, 1000, 600);
    
    //pretty obvious
    function formatDateTime() {
        var fecha = new Date(); //UTC date, 5 hours ahead from localtime
        fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
        var year = fecha.getUTCFullYear().toString(); //gets year
        var month = (fecha.getUTCMonth()+1).toString().padStart(2, '0'); //gets month
        var day = (fecha.getUTCDate()).toString().padStart(2, '0'); //gets day of the month
        
        var hours = fecha.getUTCHours().toString().padStart(2, '0'); //this for knowing which item from the response get, works in localtime
        var minutes = fecha.getUTCMinutes().toString().padStart(2, '0');;
    
        const formattedDate = `${day}/${month}/${year}`;
        const formattedTime = `${hours}:${minutes}`;
    
        return { date: formattedDate, time: formattedTime };
    }
    
    const { date: formattedDate, time: formattedTime } = formatDateTime();
    
    //get hydroelectric info upfront
    var caudales = await getInfoById(cocaCodoSinclair.caudal_id, "caudal");
    var currentCaudal = caudales[0]; 
    
    var textFont = "DejaVu Sans Mono";
    ctx.font = 'bold 32px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.fillText("@Hidro_Info_Bot", 705, 30);
    
    ctx.font = 'bold 60px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.fillText("Coca Codo Sinclair", 20, 70);
    ctx.font = 'bold 50px ' + textFont;
    ctx.fillText(`${formattedDate} ${formattedTime}`, 20, 125);

    //hydroelectric
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 5;

    ctx.moveTo(600, 600);
    ctx.lineTo(600, 200);
    ctx.lineTo(625, 200);
    ctx.lineTo(625, 175);
    ctx.lineTo(400, 175);
    ctx.lineTo(400, 200);
    ctx.lineTo(425, 200);
    ctx.arcTo(425, 240, 180, 400, 20);
    ctx.arcTo(180, 400, 0, 400, 30);
    ctx.lineTo(0, 400);
    ctx.lineTo(0, 600);
    ctx.closePath();
    
    ctx.fillStyle = "#5f5c63"; //hydroelectric fill
    ctx.fill();
    
    ctx.moveTo(400, 200);
    ctx.lineTo(625, 200); //upper line
    
    ctx.stroke();
    

    //water
    ctx.lineWidth = 2;
    var caudalLevel;
    if(currentCaudal < 400){ //500 because of CCS specifics
        caudalLevel = interpolation(currentCaudal, 0, 400, 585, 250); // 250 max - 585 min
    }else{
        caudalLevel = interpolation(currentCaudal, 0, cocaCodoSinclair.maxCaudal, 585, 250); // 250 max - 585 min
    }
    ctx.fillStyle = "black";
    ctx.beginPath();
    ctx.moveTo(602.5, 600);
    ctx.lineTo(1000, 600);
    
    var wavePronuntiation = 20;
    var waveRadius = 30;
    ctx.lineTo(1000, caudalLevel + wavePronuntiation / 3);
    
    for(i = 1; i < 8; i++){
        var waveY = (i % 2 == 0) ? caudalLevel + wavePronuntiation : caudalLevel - wavePronuntiation;
        var nextWaveY = (i % 2 == 0) ? caudalLevel - wavePronuntiation : caudalLevel + wavePronuntiation;
        
        ctx.arcTo(1000 - i * 50, waveY, 1000 - (i + 1) * 50, nextWaveY, waveRadius);
    }
    ctx.arcTo(602.5, caudalLevel + wavePronuntiation, 600, caudalLevel - wavePronuntiation, 13)
    
    ctx.lineTo(602.5, caudalLevel);
    ctx.closePath();
    ctx.fillStyle = "#0793de"; //water tone
    ctx.fill();
    ctx.stroke();


    var caudalTextInfo = getCaudalCategory(currentCaudal, 300); //caudal value and color //300 because of CCS specifics
    var textXanchor = 700; //image text pos
    ctx.fillStyle = "black";
    ctx.font = 'bold 50px ' + textFont;
    ctx.fillText("Caudal: ", textXanchor, caudalLevel - 20 - 140);
    ctx.fillText(currentCaudal + " m³/s", textXanchor, caudalLevel - 20 - 80);
    ctx.fillStyle = caudalTextInfo[1];
    ctx.fillText(caudalTextInfo[0], textXanchor, caudalLevel - 20 - 20); //MEDIO, BAJO, ALTO, ETC
    
    ctx.fillStyle = "black";
    var delta_caudal = caudales[1] === 0 ? (currentCaudal > 0 ? 100 : 0) : ((currentCaudal - caudales[1]) / caudales[1]) * 100;
    var signo_caudal = (currentCaudal >= caudales[1]) ? "+" : "-";
    
    //delta info on image
    ctx.font = 'bold 40px ' + textFont;
    ctx.fillText("El caudal cambió", 20, 480);
    ctx.fillText(signo_caudal + Math.abs(delta_caudal).toFixed(2) + "% desde hace 3h", 20, 520);
    
    //tweet message
    var message = "Hidroeléctrica Coca Codo Sinclair\n" + 
    "#" + cocaCodoSinclair.nombre.split(' ').join('') + " #CCS\n" +
    "\n" +
    "🌊Caudal: " + currentCaudal.toFixed(2) + " m³/s\n" +
    signo_caudal + Math.abs(delta_caudal).toFixed(2) + "% desde hace 3h\n" +
    "\n"; /* +
    "🔋Generación: " + currentEnergy.toFixed(2) + " MWh\n" +
    "Al " + trabajoEnergia.toFixed(2) + "% de capacidad máxima\n" +
    "Turbinas Activas: " + currentTurbines + "/" + cocaCodoSinclair.turbinasMax;
    */
    
    //save the image
    const imageBuffer = canvas.toBuffer('image/png');
    //fs.writeFileSync("./ccs.png", imageBuffer);
    
    //post the tweet
    try{
        await twitterService.postTweet(message, imageBuffer);
    }catch(error){
        console.error("Error with TwitterService when posting Coca Codo Sinclair");
        return error;
    }
    
}

async function CCSdailyReport(){
    var width = 2050;
    var height = 2500;
    const canvas = createCanvas(width, height); // Ajuste de altura del canvas
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = "#f0d9c2";
    ctx.fillRect(0, 0, 1000, 600);
    
    //pretty obvious
    function formatDateTime() {
        var fecha = new Date(); //UTC date, 5 hours ahead from localtime
        fecha.setHours(fecha.getHours() - 5); //modify UTC date to be the same as GMT-5
        fecha.setDate(fecha.getDate() - 1);
        const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const diaSemana = diasSemana[fecha.getUTCDay()];

        const year = fecha.getFullYear();

        const diaMes = fecha.getUTCDate().toString().padStart(2, '0');

        const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        const mes = meses[fecha.getUTCMonth()];

        return [diaSemana, diaMes, mes, year];
    }
    const dateInfo = formatDateTime();

    //get CCS info upfront
    var masterInfo = await getDailyInfo();
    var dayInfo = masterInfo[3];

    var energySum = 0;
    var minProd = 100000;
    var maxProd = 0;
    var caudalPromedio = 0;
    var minCaudal = 100000;
    var maxCaudal = 0;

    for (let h = 0; h < 24; h++) {
        energySum += dayInfo[0][h]; //for individual battery drawing
        caudalPromedio += dayInfo[3][h];
        if(dayInfo[0][h] < minProd){
            minProd = dayInfo[0][h];
        }
        if(dayInfo[0][h] > maxProd){
            maxProd = dayInfo[0][h];
        }
        if(dayInfo[3][h] < minCaudal){
            minCaudal = dayInfo[3][h];
        }
        if(dayInfo[3][h] > maxCaudal){
            maxCaudal = dayInfo[3][h];
        }
    }
    caudalPromedio /= 24;

    var message = "Reporte Diario Coca Codo Sinclair\n" + 
    "#CocaCodoSinclair #CCS\n" +
    "\n" +
    "Durante 24 horas:\n" +
    "Generó " + energySum.toFixed(2) + "MWh, un " + interpolation(energySum, 0, (cocaCodoSinclair.energiaMax * 24), 0, 100).toFixed(2) + "% de su capacidad máxima\n" +
    "\n" +
    "Mantuvo un caudal promedio de " + caudalPromedio.toFixed(2) + " m³/s, con " + minCaudal.toFixed(2) + " m³/s en su punto más bajo y " + maxCaudal.toFixed(2) + " m³/s en su punto más alto";


    ctx.fillStyle = "#f0d9c2"; //background color
    ctx.fillRect(0, 0, 2200, 2500); //background filler
    
    var textFont = "DejaVu Sans Mono"; //cross compatible font

    ctx.font = 'bold 46px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.textAlign = "end";
    ctx.fillText("@Hidro_Info_Bot", 2040, 40); //watermark

    ctx.font = 'bold 102px ' + textFont;
    ctx.fillStyle = 'black';
    ctx.textAlign = "start";
    ctx.fillText("Reporte Diario Coca Codo Sinclair", 15, 150); //title
    ctx.font = 'bold 96px ' + textFont;
    ctx.fillText(`${dateInfo[0]}, ${dateInfo[1]} de ${dateInfo[2]} del ${dateInfo[3]}`, 20, 265); //date and stuff, further changing required


    //IMPORTANT PARAMETERS
    //main box
    var anchor = [25, 380];

    //infoblocks
    var initialYcoords = anchor[1];
    var infoBlock_height = 500;
    var infoBlockSpacing = 70;

    //infoblocks content
    var contentHeight = 450;
    var infoBlock_margin = (infoBlock_height - contentHeight) / 2;
    var infoBlock_width = width - infoBlock_margin * 2;
    var graphSpacing = 10;

    var dailyGeneration = 0;
    var totalMaxDailyGeneration = cocaCodoSinclair.energiaMax * 24;

    //each infoblock (only one in this case)
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 5;
    ctx.rect(anchor[0], initialYcoords, infoBlock_width, infoBlock_height + infoBlockSpacing); //add +infoBlockSpacing to the end to you know what
    ctx.stroke();

    //parameters for further changing
    var graphLineWidth = 5; //Y axis ticks line width
    var graphLineLength = 20; //Y axis ticks line length
    var estTextWidth = 90; //hydroelectric name title width
    var bigSpace = 650; //space allocated to generation chart + battery
    var normalSpace = 565; //space that the other 2 graph take
    var lastSpacing = 100; //space between water level graph and turbines graph

    //x axis values (TIME) (in array because they are not that ordered, they are actually kind of chaotic)
    var xvalues = [anchor[0] + estTextWidth, anchor[0] + estTextWidth + bigSpace + (graphSpacing / 2), anchor[0] + estTextWidth + bigSpace + normalSpace + (graphSpacing / 2 * 3) + lastSpacing];
    //LABELING
    text(xvalues[0] + bigSpace / 2 - 50, anchor[1] - 20, "Generación", " 70px " + textFont, "center", "gray");
    text(xvalues[1] + normalSpace / 2, anchor[1] - 20, "Turbinas", " 70px " + textFont, "center", "gray");
    text(xvalues[2] + normalSpace / 2, anchor[1] - 20, "Caudal", " 70px " + textFont, "center", "gray");
    
    //small boxes for graphs LABELING AND TICKS
    //GENERATION GRAPH
    testRect(anchor[0] + estTextWidth, initialYcoords + infoBlock_margin, 565, contentHeight, "Black", graphLineWidth); //graph box
    
    var startingPoint = [anchor[0] + estTextWidth, initialYcoords + infoBlock_margin + contentHeight]; //will adjust the X position to where the left line is (to place the ticks in the Y axis)

    //for the line ticks in the Y axis
    var genPointer = 0;
    for(y = 0; y < contentHeight; y = y + (contentHeight / 5)){ //add a bunch of pixels (that correspond to a fifth of the total graph height)
        test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //adds line ticks

        rotatedText(startingPoint[0] - graphLineLength / 2 - 20, startingPoint[1] - 6 - y + 5, Math.round(cocaCodoSinclair.energiaMax / 5 * genPointer), "bold 30px " + textFont, true); //adds ticks labeling

        genPointer++; //increase pointer to label in next iteration
    }
    text(startingPoint[0] - graphLineLength / 2 - 30, initialYcoords + 40, "MWh", "bold 30px " + textFont); //MWh indicator atop of Y axis

    dailyGeneration += energySum; //for big battery drawing
    //testRect(estTextWidth + bigSpace - 105, initialYcoords + contentHeight + 20, 90, interpolation(energySum, 0, maxDailyEnergy, 0, -412.5), cGreen, 5, cGreen); //battery fill (0, -412.5)
    //END GENERATION GRAPH


    //TURBINE GARPH
    testRect(anchor[0] + estTextWidth + bigSpace + (graphSpacing / 2), initialYcoords + infoBlock_margin, normalSpace, contentHeight, "Black", graphLineWidth); //graph box

    startingPoint[0] += bigSpace + (graphSpacing / 2); //upgrade the line ticks to the new position
    var turbinePointer = 0; //tick labeling pointer

    //same thing than with other graphs, but adds 1 more unit to the turbine maximum for aesthetics
    for(y = 0; y < contentHeight - infoBlock_margin; y = y + (contentHeight / (cocaCodoSinclair.turbinasMax + 1))){
        test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //ticks

        text(startingPoint[0] - graphLineLength / 2 - 3, startingPoint[1] - y, turbinePointer, "bold 20px " + textFont, "end"); //labeling

        turbinePointer++;
    }
    //END TURBINE GRAPH


    //CAUDAL GRAPH
    testRect(anchor[0] + estTextWidth + bigSpace + normalSpace + (graphSpacing / 2 * 3) + lastSpacing, initialYcoords + infoBlock_margin, normalSpace, contentHeight, "Black", graphLineWidth); //graph box

    startingPoint[0] = startingPoint[0] - (graphSpacing / 2) + (graphSpacing / 2 * 3) + normalSpace + lastSpacing; //adjust X pos for ticks

    var wlPointer = 0;
    var chartCaudalMax = (maxCaudal < 500) ? 500 : 1000; //500 is the limit for visualization, if it goes above, then it is 1000
    //ticks
    for(y = 0; y < contentHeight; y = y + (contentHeight / 5)){
        test(startingPoint[0] - graphLineLength / 2, startingPoint[1] - 6 - y, startingPoint[0] + graphLineLength / 2, startingPoint[1] - 6 - y, "black", 4); //draws ticks lines

        rotatedText(startingPoint[0] - graphLineLength / 2 - 20, startingPoint[1] - 6 - y + 5, Math.round((chartCaudalMax) / 5 * wlPointer), "bold 30px " + textFont, true); //writes ticks labels, changed to stay in the interval between minimum and maximum water levels
        wlPointer++;
    }
    text(startingPoint[0] - graphLineLength / 2 - 35, initialYcoords + 40, "m3/s", "bold 30px " + textFont);
    //CAUDAL LEVEL END GRAPH


    //ACTUAL CHARTS
    //loop each graph inside an infoBlock AND GENERATE ACTUAL CHARTS
    for(k = 0; k < 3; k++){
        ctx.beginPath();
        ctx.strokeStyle = colors[k];
        ctx.lineWidth = 4; //optimal lineWidth


        //for each bit of information, draw another line
        if(k == 1){ //for turbines
            ctx.moveTo(xvalues[k], interpolation(dayInfo[1][0], 0, cocaCodoSinclair.turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information

            for (j = 1; j <= 24; j++) {
                //previous coords
                //previous Y uses last data value to mark where it should increase or decrease from
                //it wont define it to nothing if we reached the end (so the next continuation line isnt drawn)
                const prevY = interpolation(dayInfo[1][j - 1], 0, cocaCodoSinclair.turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin);

                //current coords
                const currentX = xvalues[k] + (j - 1) * 24.5; //this works differently as the other ones, because the value jumps one space
                //current Y uses current data value
                const currentY = interpolation(dayInfo[1][j], 0, cocaCodoSinclair.turbinasMax + 1, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin);

                //if its past the last one (23rd last one bc it started on 0), just dont draw anything
                ctx.lineTo(currentX, prevY);
                ctx.lineTo(currentX, currentY);


                //we still have to use currentX value to write x axis
                //x axis
                if(j % 6 === 0) {
                    rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true);
                }
            }



        }else if(k == 2){ //if its a water graph (caudal in this case)
            ctx.moveTo(xvalues[k], interpolation(dayInfo[3][0], 0, chartCaudalMax, initialYcoords + infoBlock_margin + contentHeight, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information
            for(j = 1; j <= 24; j++){

                if(j < 24){
                    ctx.lineTo(xvalues[k] + j * 24.5, interpolation(dayInfo[3][j], 0, chartCaudalMax, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin));
                }
                if(j % 6 == 0){
                    rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true)    
                }

            } 
        }else{ //for generation
            ctx.moveTo(xvalues[k], interpolation(dayInfo[0][0], 0, cocaCodoSinclair.energiaMax, initialYcoords + infoBlock_margin + contentHeight, initialYcoords + infoBlock_margin)); //starts in the first bit of data in the retrieved information
            for(j = 1; j <= 24; j++){
                
                if(j < 24){
                    ctx.lineTo(xvalues[k] + j * 24.5, interpolation(dayInfo[0][j], 0, cocaCodoSinclair.energiaMax, initialYcoords + infoBlock_margin + contentHeight - 5, initialYcoords + infoBlock_margin));
                }
                if(j % 6 == 0){
                    rotatedText(xvalues[k] + (j - 1) * 24.5 - 25, initialYcoords + infoBlock_margin + contentHeight + 50, j.toString().padStart(2, "0") + ":00", "bold 30px " + textFont, true)    
                }
                
            }
        }

        ctx.stroke();
    }

    //BIG BATTERY DRAWING
    var batterySpacing = 12.5;
    var batteryAnchor = infoBlock_height + infoBlockSpacing + batterySpacing + anchor[1] + 95;
    ctx.strokeStyle = "black";
    var batteryLength = 80; //length in respect to the end
    var batteryHeight = 300;
    var batteryLineWidth = 10;
    var lineCorrectionFactor = 5;

    //BATTERY TEXT
    text(anchor[0], batteryAnchor - 15, "Producción total: " + dailyGeneration.toFixed(2) + " MWh", "bold 80px " + textFont, "start");
    text(anchor[0], batteryAnchor + 75, "(" + interpolation(dailyGeneration, 0, totalMaxDailyGeneration, 0, 100).toFixed(2) + "% del máximo)", "bold 80px " + textFont, "start")

    anchor[0] += 10;
    batteryAnchor += 90;
    //BATTERY DRAWING
    testRect(anchor[0] + 5, batteryAnchor + batterySpacing + 5, interpolation(dailyGeneration, 0, totalMaxDailyGeneration, 0, 2065), batteryHeight - 22.5, cGreen, 5, cGreen);
    test(anchor[0], batteryAnchor + batterySpacing, anchor[0], batteryAnchor + batteryHeight, "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength + lineCorrectionFactor, batteryAnchor + batterySpacing, anchor[0] - lineCorrectionFactor, batteryAnchor + batterySpacing,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength + lineCorrectionFactor, batteryAnchor + batteryHeight, anchor[0] - lineCorrectionFactor, batteryAnchor + batteryHeight,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing, anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing + (batteryHeight * 0.3) + lineCorrectionFactor, "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight, anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight - (batteryHeight * 0.3) - lineCorrectionFactor,  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batteryHeight - (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4) + lineCorrectionFactor, batteryAnchor + batteryHeight - (batteryHeight * 0.3), "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - batteryLength, batteryAnchor + batterySpacing + (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4) + lineCorrectionFactor, batteryAnchor + batterySpacing + (batteryHeight * 0.3),  "black", batteryLineWidth);
    test(anchor[0] + infoBlock_width - (batteryLength * 0.4), batteryAnchor + batterySpacing + (batteryHeight * 0.3), anchor[0] + infoBlock_width - (batteryLength * 0.4), batteryAnchor + batteryHeight - (batteryHeight * 0.3),  "black", batteryLineWidth)



    //COQUITA CODITO SINCLAIRSITO DRAWING
    ctx.beginPath();
    ctx.strokeStyle = "black";
    ctx.lineWidth = 10;

    //hydroelectric
    ctx.moveTo(1200, 2500); // 600 * 2, 1000 * 2.5
    ctx.lineTo(1200, 1700); // 600 * 2, 600 * 2.5 1700
    ctx.lineTo(1250, 1700); // 625 * 2, 600 * 2.5 1700
    ctx.lineTo(1250, 1637.5); // 625 * 2, 575 * 2.5
    ctx.lineTo(800, 1637.5); // 400 * 2, 575 * 2.5
    ctx.lineTo(800, 1700); // 400 * 2, 600 * 2.5 1700
    ctx.lineTo(850, 1700); // 425 * 2, 600 * 2.5 1700
    ctx.arcTo(850, 1800, 360, 2000, 50); // 425 * 2, 640 * 2.5, 180 * 2, 800 * 2.5, 20 * 2.5
    ctx.arcTo(500, 2000, 0, 2000, 75); // 180 * 2, 800 * 2.5, 0, 800 * 2.5, 30 * 2.5
    ctx.lineTo(0, 2000); // 0, 800 * 2.5
    ctx.lineTo(0, 2500); // 0, 1000 * 2.5
    ctx.closePath();

    ctx.fillStyle = "#5f5c63"; //hydroelectric fill
    ctx.fill();

    ctx.moveTo(800, 1700); // 1700
    ctx.lineTo(1250, 1700); // 1700

    ctx.stroke();

    //water
    ctx.lineWidth = 6;
    var caudalLevel = interpolation(caudalPromedio, 0, chartCaudalMax, 2450, 1512.5); // 1512.5 max - 2450 min
    ctx.fillStyle = "black";
    ctx.font = 'bold 70px ' + textFont;
    ctx.fillText("Caudal promedio: ", 1300, caudalLevel - 20 - 160);
    ctx.fillText(caudalPromedio.toFixed(2) + " m³/s", 1300, caudalLevel - 20 - 80);
    ctx.beginPath();

    ctx.moveTo(1200, 2500);
    ctx.lineTo(2050, 2500);

    var wavePronuntiation = 50;
    var waveRadius = 75;
    ctx.lineTo(2050, caudalLevel + wavePronuntiation / 3);

    for (i = 1; i < 8; i++) {
        var waveY = (i % 2 == 0) ? caudalLevel + wavePronuntiation : caudalLevel - wavePronuntiation;
        var nextWaveY = (i % 2 == 0) ? caudalLevel - wavePronuntiation : caudalLevel + wavePronuntiation;
        ctx.arcTo(2050 - i * 105, waveY, 2050 - (i + 1) * 105, nextWaveY, waveRadius);
    }
    ctx.arcTo(1200, caudalLevel + wavePronuntiation, 1200, caudalLevel - wavePronuntiation, 32.5);

    ctx.lineTo(1200, caudalLevel); //caudalLevel
    ctx.closePath();
    ctx.fillStyle = "#0793de"; //water tone
    ctx.fill();

    
    ctx.stroke();
    
    const imageBuffer = canvas.toBuffer('image/png');
    //fs.writeFileSync("./dailyCCS.png", imageBuffer);
    //post the tweet
    try{
        await twitterService.postTweet(message, imageBuffer);
    }catch(error){
        console.error("Error with TwitterService when posting Coca Codo Sinclair");
        return error;
    }


    //FUNCTIONS
    function test(X, Y, X1, Y1, color, optionalLineWidth){
        ctx.beginPath();
        ctx.lineWidth = (optionalLineWidth) ? optionalLineWidth : 5;
        ctx.strokeStyle = color;
        ctx.moveTo(X, Y);
        ctx.lineTo(X1, Y1);
        ctx.stroke();
    }
    
    function testRect(X, Y, X1, Y1, color, optionalLineWidth, fillColor){
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = optionalLineWidth;
        if (fillColor) {
            ctx.fillStyle = fillColor;
            ctx.fillRect(X, Y, X1, Y1);
            return;
        }
        ctx.rect(X, Y, X1, Y1);
        ctx.stroke();
    }
    
    function text(X, Y, text, textValue, alignment, optionalColor){
        ctx.font = textValue;
        ctx.fillStyle = (optionalColor) ? optionalColor : "black";
        ctx.textAlign = (alignment) ? alignment : "center";
    
        ctx.fillText(text, X, Y);
    }
    
    
    function rotatedText(X, Y, text, textValue, inclination){ //inclination is optional
        ctx.font = textValue;
        ctx.fillStyle = 'black';
        ctx.textAlign = "center";
    
        ctx.save(); //save initial state
        ctx.translate(X, Y); //move coord system to input params
        ctx.rotate(inclination ? -Math.PI / 4 : -Math.PI / 2); //rotate context to the left(equivalent to -90 degrees o -Math.PI/2 radians)
        ctx.fillText(text, 0, 0); //write text in new orientation
        ctx.restore(); //restore text to not mess it up in any other text writing
    }
}


//CLOCK JOBS
const testito = new Date().toLocaleString("es-EC", { timeZone: "America/Guayaquil" }); //status on

try{
    twitterService.postText("Status on " + testito + " test: 💧íóú");
}catch(error){
    console.error("Error with TwitterService when posting status on");
    return error;
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


COCA CODO SINCLAIR:
ENERGY OUTPUT:
https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomccs/ccsEnerDia?fecha=08/12/2024%2000:00:00
TURBINES:
https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues?mrid=100503&fechaInicio=2024-12-08T06:00:00.000Z&fechaFin=2024-12-09T05:00:00.000Z&fecha=08/12/2024%2001:00:00
CAUDAL:
https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues?mrid=100037&fechaInicio=2024-12-08T06:00:00.000Z&fechaFin=2024-12-09T05:00:00.000Z&fecha=08/12/2024%2001:00:00
COTA:

https://generacioncsr.celec.gob.ec:8443/ords/csr/sardomcsr/pointValues?mrid=100540&fechaInicio=2024-12-08T06:00:00.000Z&fechaFin=2024-12-09T05:00:00.000Z&fecha=08/12/2024%2001:00:00
*/
