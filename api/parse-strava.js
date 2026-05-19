import formidable from 'formidable';
import fs from 'fs';
import JSZip from 'jszip';
import Papa from 'papaparse';

export const config = {
  api: { bodyParser: false }
};

const SPORT_MAP = {
  'Run': 'running', 'Trail Run': 'trail', 'Ride': 'ciclismo',
  'Mountain Bike Ride': 'ciclismo', 'Gravel Ride': 'ciclismo',
  'Virtual Ride': 'ciclismo', 'Swim': 'natacion',
  'Weight Training': 'gimnasio', 'Workout': 'gimnasio', 'Yoga': 'gimnasio',
  'Hike': 'trail', 'Walk': 'walking'
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const form = formidable({ maxFileSize: 200 * 1024 * 1024 });
    const [fields, files] = await form.parse(req);
    const file = files.file?.[0];
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const zipBuffer = fs.readFileSync(file.filepath);
    const zip = await JSZip.loadAsync(zipBuffer);

    // Busca activities.csv en cualquier carpeta
    let activitiesFile = null;
    zip.forEach((path, f) => {
      if (path.endsWith('activities.csv') && !f.dir) activitiesFile = f;
    });

    if (!activitiesFile) {
      return res.status(400).json({ error: 'No se encontró activities.csv en el ZIP' });
    }

    const csvText = await activitiesFile.async('string');
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    const activities = parsed.data;

    if (activities.length === 0) {
      return res.status(400).json({ error: 'CSV vacío' });
    }

    // Detectar las columnas reales (Strava cambia nombres según idioma/versión)
    const sample = activities[0];
    const cols = Object.keys(sample);
    const findCol = (...candidates) => cols.find(c => candidates.some(cand => c.toLowerCase().includes(cand.toLowerCase())));

    const colDate = findCol('Activity Date', 'fecha de la actividad', 'Data');
    const colType = findCol('Activity Type', 'tipo de actividad', 'Tipus');
    const colDist = findCol('Distance', 'distancia', 'distància');
    const colTime = findCol('Elapsed Time', 'tiempo transcurrido', 'temps transcorregut');
    const colMovTime = findCol('Moving Time', 'tiempo en movimiento', 'temps en moviment');
    const colElev = findCol('Elevation Gain', 'desnivel', 'desnivell');

    if (!colDate || !colType || !colDist) {
      return res.status(400).json({
        error: 'No se reconoce el formato del CSV de Strava',
        cols_detected: cols.slice(0, 20)
      });
    }

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    let totalActivities = activities.length;
    let recent6mo = [];
    let recent2mo = [];

    for (const a of activities) {
      const dateStr = a[colDate];
      if (!dateStr) continue;
      const date = new Date(dateStr);
      if (isNaN(date)) continue;
      if (date >= sixMonthsAgo) recent6mo.push({ ...a, _date: date });
      if (date >= twoMonthsAgo) recent2mo.push({ ...a, _date: date });
    }

    // Volum setmanal (mitja últims 6 mesos = ~26 setmanes)
    const totalDistance6mo = recent6mo.reduce((s, a) => s + (num(a[colDist]) || 0), 0);
    const totalTime6mo = recent6mo.reduce((s, a) => s + (num(a[colTime]) || 0), 0);
    const avgWeeklyKm = Math.round(totalDistance6mo / 26 * 10) / 10;
    const avgWeeklyHours = Math.round(totalTime6mo / 3600 / 26 * 10) / 10;

    // Distribució per esport (últims 6 mesos)
    const sportCounts = {};
    const sportVolume = {};
    recent6mo.forEach(a => {
      const rawType = a[colType] || 'Other';
      const mapped = SPORT_MAP[rawType] || 'otros';
      sportCounts[mapped] = (sportCounts[mapped] || 0) + 1;
      sportVolume[mapped] = (sportVolume[mapped] || 0) + (num(a[colDist]) || 0);
    });

    // Millors marques running (a partir de la distància i temps)
    const runs6mo = recent6mo.filter(a => /Run/i.test(a[colType]) || /Trail Run/i.test(a[colType]));
    let best5K = null, best10K = null, longestRun = 0;
    let bestPace5K = null, bestPace10K = null;

    for (const r of runs6mo) {
      const km = num(r[colDist]);
      const sec = num(r[colMovTime]) || num(r[colTime]);
      if (!km || !sec) continue;
      if (km > longestRun) longestRun = km;
      const pacePerKm = sec / km; // sec/km
      if (km >= 4.8 && km <= 5.5) {
        if (!bestPace5K || pacePerKm < bestPace5K) bestPace5K = pacePerKm;
      }
      if (km >= 9.5 && km <= 11) {
        if (!bestPace10K || pacePerKm < bestPace10K) bestPace10K = pacePerKm;
      }
    }
    best5K = bestPace5K ? Math.round(bestPace5K) : null;
    best10K = bestPace10K ? Math.round(bestPace10K) : null;

    // Cicling longest + estimació FTP (rough)
    const rides6mo = recent6mo.filter(a => /Ride/i.test(a[colType]));
    let longestRide = 0;
    for (const r of rides6mo) {
      const km = num(r[colDist]);
      if (km && km > longestRide) longestRide = km;
    }

    // Volum últim mes (per detectar si està entrenant ara mateix)
    const last4weeks = recent6mo.filter(a => {
      const d = new Date(a._date);
      return (Date.now() - d.getTime()) < 28 * 24 * 60 * 60 * 1000;
    });
    const last4wKm = last4weeks.reduce((s, a) => s + (num(a[colDist]) || 0), 0);
    const last4wHours = last4weeks.reduce((s, a) => s + (num(a[colTime]) || 0), 0) / 3600;

    return res.status(200).json({
      success: true,
      data: {
        totalActivities,
        recentActivities6mo: recent6mo.length,
        recentActivities2mo: recent2mo.length,
        avgWeeklyKm,
        avgWeeklyHours,
        last4Weeks: {
          km: Math.round(last4wKm * 10) / 10,
          hours: Math.round(last4wHours * 10) / 10,
          weeklyAvgHours: Math.round(last4wHours / 4 * 10) / 10
        },
        sportCounts,
        sportVolume,
        running: {
          totalActivities: runs6mo.length,
          longestKm: Math.round(longestRun * 10) / 10,
          best5K_sec: best5K,
          best10K_sec: best10K,
          best5K_pace: best5K ? `${Math.floor(best5K/60)}:${String(best5K%60).padStart(2,'0')}` : null,
          best10K_pace: best10K ? `${Math.floor(best10K/60)}:${String(best10K%60).padStart(2,'0')}` : null
        },
        cycling: {
          totalActivities: rides6mo.length,
          longestKm: Math.round(longestRide * 10) / 10
        }
      }
    });
  } catch (error) {
    console.error('Parse Strava error:', error);
    return res.status(500).json({ error: error.message || 'Error procesando ZIP' });
  }
}
