import Papa from 'papaparse';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

const SPORT_MAP = {
  'Run':'running','Trail Run':'trail','Ride':'ciclismo',
  'Mountain Bike Ride':'ciclismo','Gravel Ride':'ciclismo',
  'Virtual Ride':'ciclismo','E-Bike Ride':'ciclismo',
  'Swim':'natacion','Open Water Swim':'natacion',
  'Weight Training':'gimnasio','Workout':'gimnasio','Yoga':'gimnasio',
  'Hike':'trail','Walk':'walking'
};

function num(v){
  if(v===null||v===undefined||v==='') return null;
  const n=parseFloat(String(v).replace(',','.'));
  return isNaN(n)?null:n;
}

function paceFmt(sec){
  if(!sec||sec<=0) return null;
  const m=Math.floor(sec/60),s=Math.round(sec%60);
  return m+':'+String(s).padStart(2,'0');
}

// Strava CSV: distància en METRES, dividir per 1000 per km
function toKm(v) {
  const n = num(v);
  if (n === null) return null;
  // Auto-detect: si valor > 100 és metres; si < 100 ja és km
  // Strava col 6 = km (9.02), col 17 = metres (9027.9)
  // Papa.parse pot retornar qualsevol de les dues
  return n > 100 ? Math.round(n / 1000 * 100) / 100 : Math.round(n * 100) / 100;
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  try {
    const {csvText,fileName}=req.body;
    if(!csvText) return res.status(400).json({error:'No CSV text provided'});

    const parsed=Papa.parse(csvText,{header:true,skipEmptyLines:true});
    const activities=parsed.data;
    if(activities.length===0) return res.status(400).json({error:'CSV vacío'});

    const sample=activities[0];
    const cols=Object.keys(sample);
    const findCol=(...cands)=>cols.find(c=>cands.some(x=>c.toLowerCase().includes(x.toLowerCase())));

    const colDate   =findCol('Activity Date','fecha de la actividad');
    const colType   =findCol('Activity Type','tipo de actividad');
    const colDist   =findCol('Distance');
    const colMovTime=findCol('Moving Time');
    const colTime   =findCol('Elapsed Time');
    const colElev   =findCol('Elevation Gain');
    const colHRavg  =findCol('Average Heart Rate','frecuencia cardíaca media','frecuencia cardiaca media');
    const colHRmax  =findCol('Max Heart Rate','frecuencia cardíaca máxima','frecuencia cardiaca maxima');

    if(!colDate||!colType||!colDist){
      return res.status(400).json({error:'Formato CSV no reconocido',cols_detected:cols.slice(0,20)});
    }

    const sixMonthsAgo=new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth()-6);

    const recent6mo=[];
    for(const a of activities){
      if(!a[colDate]) continue;
      const date=new Date(a[colDate]);
      if(isNaN(date)||date<sixMonthsAgo) continue;
      recent6mo.push({...a,_date:date});
    }

    // Volum
    const totalKm6mo=recent6mo.reduce((s,a)=>s+(toKm(a[colDist])||0),0);
    const totalSec6mo=recent6mo.reduce((s,a)=>s+(num(a[colMovTime])||num(a[colTime])||0),0);
    const avgWeeklyKm=Math.round(totalKm6mo/26*10)/10;
    const avgWeeklyHours=Math.round(totalSec6mo/3600/26*10)/10;

    // Distribució per esport
    const sportCounts={},sportVolume={};
    recent6mo.forEach(a=>{
      const m=SPORT_MAP[a[colType]]||'otros';
      sportCounts[m]=(sportCounts[m]||0)+1;
      sportVolume[m]=(sportVolume[m]||0)+(toKm(a[colDist])||0);
    });

    // Running
    const runs6mo=recent6mo.filter(a=>/Run/i.test(a[colType]||''));
    const rides6mo=recent6mo.filter(a=>/Ride/i.test(a[colType]||''));

    // Best 5K / 10K
    let longestRun=0,bestPace5K=null,bestPace10K=null;
    for(const r of runs6mo){
      const km=toKm(r[colDist]);
      const sec=num(r[colMovTime])||num(r[colTime]);
      if(!km||!sec||km<=0) continue;
      if(km>longestRun) longestRun=km;
      const pace=sec/km;
      if(km>=4.8&&km<=5.5&&(!bestPace5K||pace<bestPace5K)) bestPace5K=pace;
      if(km>=9.5&&km<=11.0&&(!bestPace10K||pace<bestPace10K)) bestPace10K=pace;
    }

    // ── ANÀLISI DE FREQÜÈNCIA CARDÍACA ─────────────────────────────────────
    let maxHRever_run=0,maxHRever_bike=0;
    const hrRuns=[];

    for(const r of runs6mo){
      const avgHR=colHRavg?num(r[colHRavg]):null;
      const maxHR=colHRmax?num(r[colHRmax]):null;
      const km=toKm(r[colDist]);
      const sec=num(r[colMovTime])||num(r[colTime]);
      const elev=num(r[colElev])||0;
      // FCmax real: agafa només runs >20min per evitar escalfaments
      if(maxHR&&sec&&sec>1200&&maxHR>maxHRever_run) maxHRever_run=maxHR;
      if(avgHR&&km&&km>1&&sec&&sec>0){
        hrRuns.push({avgHR,maxHR,km,sec,pacePerKm:sec/km,elev});
      }
    }
    for(const r of rides6mo){
      const maxHR=colHRmax?num(r[colHRmax]):null;
      const sec=num(r[colMovTime])||num(r[colTime]);
      if(maxHR&&sec&&sec>1800&&maxHR>maxHRever_bike) maxHRever_bike=maxHR;
    }

    const maxHRever=Math.max(maxHRever_run,maxHRever_bike)||null;

    // ── Estimació FCmax real ─────────────────────────────────────────────────
    // L'usuari rarament arriba al màxim absolut en entrenaments normals.
    // Si la FC mitja d'entrenament és >73% de la màxima observada, la FCmax real
    // és probablement superior. Divisor 0.74 = assumeix que la mitja d'entrenaments
    // és ~74% del FCmax real (zona Z2-Z3 frontera).
    let fcmaxEstimate=null;
    if(maxHRever_run){
      const avgHRall=hrRuns.length>0
        ?hrRuns.reduce((s,r)=>s+r.avgHR,0)/hrRuns.length
        :null;
      if(avgHRall){
        const avgPct=avgHRall/maxHRever_run;
        if(avgPct>0.73){
          fcmaxEstimate=Math.round(avgHRall/0.74); // ← 0.74 (era 0.78)
        } else {
          fcmaxEstimate=maxHRever_run;
        }
      }
    }

    // ── Z2 real des de HR ────────────────────────────────────────────────────
    // Usa fcmaxEstimate si disponible, sinó maxHRever_run.
    // z2Hi = 74% FCmax (era 72%) — rang més ample per capturar runs fàcils reals.
    const fcmaxForZones=fcmaxEstimate||maxHRever_run;
    let z2PaceSec=null,z2AvgHR=null,z2RunsCount=0;
    let z4PaceSec=null,z4RunsCount=0;

    if(fcmaxForZones&&hrRuns.length>0){
      const z2Lo=fcmaxForZones*0.60;
      const z2Hi=fcmaxForZones*0.74; // ← 0.74 (era 0.72)
      const z2Runs=hrRuns.filter(r=>r.avgHR>=z2Lo&&r.avgHR<=z2Hi&&r.km>=4);
      if(z2Runs.length>=1){ // ← >= 1 (era >= 2)
        z2PaceSec=Math.round(z2Runs.reduce((s,r)=>s+r.pacePerKm,0)/z2Runs.length);
        z2AvgHR=Math.round(z2Runs.reduce((s,r)=>s+r.avgHR,0)/z2Runs.length);
        z2RunsCount=z2Runs.length;
      }

      const z4Lo=fcmaxForZones*0.85;
      const z4Runs=hrRuns.filter(r=>r.avgHR>=z4Lo&&r.km>=1);
      if(z4Runs.length>=2){
        z4PaceSec=Math.round(z4Runs.reduce((s,r)=>s+r.pacePerKm,0)/z4Runs.length);
        z4RunsCount=z4Runs.length;
      }
    }

    // Last 4 weeks
    const last4wCutoff=new Date(); last4wCutoff.setDate(last4wCutoff.getDate()-28);
    const last4w=recent6mo.filter(a=>a._date>=last4wCutoff);
    const last4wHours=last4w.reduce((s,a)=>s+(num(a[colMovTime])||0),0)/3600;

    let longestRide=0;
    for(const r of rides6mo){
      const km=toKm(r[colDist]);
      if(km&&km>longestRide) longestRide=km;
    }

    const best5K=bestPace5K?Math.round(bestPace5K):null;
    const best10K=bestPace10K?Math.round(bestPace10K):null;

    return res.status(200).json({
      success:true,
      data:{
        fileName:fileName||'strava.zip',
        totalActivities:activities.length,
        recentActivities6mo:recent6mo.length,
        avgWeeklyKm,
        avgWeeklyHours,
        last4Weeks:{
          km:Math.round(last4w.reduce((s,a)=>s+(toKm(a[colDist])||0),0)*10)/10,
          hours:Math.round(last4wHours*10)/10,
          weeklyAvgHours:Math.round(last4wHours/4*10)/10
        },
        sportCounts,
        sportVolume,
        running:{
          totalActivities:runs6mo.length,
          longestKm:Math.round(longestRun*10)/10,
          best5K_sec:best5K,
          best10K_sec:best10K,
          best5K_pace:paceFmt(best5K),
          best10K_pace:paceFmt(best10K)
        },
        cycling:{
          totalActivities:rides6mo.length,
          longestKm:Math.round(longestRide*10)/10
        },
        heartRate:{
          maxEverRun:maxHRever_run||null,
          maxEverBike:maxHRever_bike||null,
          maxEver:maxHRever,
          fcmaxEstimate:fcmaxEstimate,
          fcmaxNote:fcmaxEstimate&&fcmaxEstimate>(maxHRever_run||0)
            ?'FCmax estimada superior a la observada (entrenos no han llegado al máximo absoluto)'
            :'FCmax basada en HR máxima registrada',
          runsWithHR:hrRuns.length,
          avgTrainingHR:hrRuns.length?Math.round(hrRuns.reduce((s,r)=>s+r.avgHR,0)/hrRuns.length):null,
          z2:{
            paceFromHR_sec:z2PaceSec,
            paceFromHR:paceFmt(z2PaceSec),
            avgHR:z2AvgHR,
            runsCount:z2RunsCount
          },
          z4:{
            paceFromHR_sec:z4PaceSec,
            paceFromHR:paceFmt(z4PaceSec),
            runsCount:z4RunsCount
          }
        }
      }
    });
  } catch(error){
    console.error('Parse Strava error:',error);
    return res.status(500).json({error:error.message||'Error procesando CSV'});
  }
}
