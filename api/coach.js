// api/coach.js — traineo coach IA
// 
// Fusió de:
// - Prompt caching del cervell del coach (metodologia ~42K tokens, cost al 10%)
// - Rich context de l'atleta (Strava, PDF, calibració)
// - Suport per dos modes: pla setmanal (camps) i chat (messages)

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic();

// Llegit un sol cop al cold start, cacheat per Anthropic al 90% en re-crides.
const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

const BASE_INSTRUCTIONS = `Eres el coach IA de traineo, una app d'entrenament esportiu per a runners, ciclistes, triatletes, swimmers, atletes de força i gent que vol estar en forma.

La teva metodologia, filosofia i criteris tècnics estan al CERVELL DEL COACH que segueix. Segueix-lo sempre.

REGLES GENERALS:
- Respostes en CASTELLÀ (la interfície de l'app està en castellà)
- Números concrets sempre que puguis (minuts, km, ritmes, %FCmax, bpm, sèries, reps)
- Cap consell genèric — adapta tot al perfil i dades reals de l'atleta
- Si una pregunta cau fora del que cobreix la metodologia, digues honestament que necessitaries més context, no t'inventis res

QUAN GENERIS UN PLA SETMANAL (mode JSON):
- Aplica TOTA la metodologia del cervell
- Personalitza al màxim amb les dades reals (Strava HR, prueba esfuerzo, calibració)
- Respecta dies disponibles i dia de descans fix
- Respecta el VOLUM REAL (ve de Strava últimes 4 setmanes si està disponible)
- Distribució 80/20: ~80% Z1-Z2 (aeròbic base), ~20% Z3-Z5 (qualitat)
- Si hi ha cursa propera, ajusta la fase (base/construcció/específic/taper)
- Retorna JSON estricte sense markdown segons el format demanat al missatge`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Detectar mode: chat lliure (té "messages") o generació de pla (té camps individuals)
    if (req.body.messages && Array.isArray(req.body.messages)) {
      return await handleChat(req, res);
    } else {
      return await handlePlanGeneration(req, res);
    }
  } catch (error) {
    console.error('Coach error:', error);
    return res.status(500).json({ error: error.message || 'Error en el coach' });
  }
}

// ─── MODE CHAT: per futures converses lliures amb el coach ─────────────────
async function handleChat(req, res) {
  const { messages, userContext } = req.body;

  // Si arriba context de l'usuari, l'injectem com a primer missatge
  let finalMessages = messages;
  if (userContext) {
    finalMessages = [
      { role: 'user', content: 'Context de l\'atleta (referència permanent):\n\n' + JSON.stringify(userContext, null, 2) },
      { role: 'assistant', content: 'Entès. Treballaré tenint en compte aquest context de l\'atleta.' },
      ...messages
    ];
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: [
      { type: "text", text: BASE_INSTRUCTIONS },
      { type: "text", text: METHODOLOGY, cache_control: { type: "ephemeral" } }
    ],
    messages: finalMessages
  });

  const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");

  return res.status(200).json({ reply, usage: response.usage });
}

// ─── MODE PLA SETMANAL: genera setmana[7] + resum ──────────────────────────
async function handlePlanGeneration(req, res) {
  const {
    sports, dias, descanso, nivel, fcmax, volum,
    objetivo, carrera, distancia, desnivel, fecha,
    edat, alcada, pes, fcrep, genere,
    pacez2, race5k, race10k, ftp,
    musculos, obj_gym, equipamiento,
    stravaStats, stressTestData
  } = req.body;

  const sportsList = Array.isArray(sports) ? sports : (sports || 'running').split(',');
  const hasCardio = sportsList.some(s => ['running','ciclismo','trail','natacion','triatlon'].includes(s));
  const isGymOnly = sportsList.length > 0 && sportsList.every(s => ['gimnasio','calistenia'].includes(s));
  const isTri = sportsList.includes('triatlon');
  const isDua = sportsList.includes('duatlon');

  const fcMax = parseInt(fcmax) || 185;
  const z1 = [Math.round(fcMax*0.50), Math.round(fcMax*0.60)];
  const z2 = [Math.round(fcMax*0.60), Math.round(fcMax*0.70)];
  const z3 = [Math.round(fcMax*0.70), Math.round(fcMax*0.80)];
  const z4 = [Math.round(fcMax*0.80), Math.round(fcMax*0.90)];
  const z5 = [Math.round(fcMax*0.90), fcMax];

  const fmtPace = (sec) => {
    if (!sec) return null;
    const m = Math.floor(sec/60), s = Math.round(sec%60);
    return m + ':' + String(s).padStart(2,'0') + '/km';
  };

  const volumReal = stravaStats?.last4Weeks?.weeklyAvgHours || parseFloat(volum) || 4;

  // ─── Construir el bloc de context ───────────────────────────────────────
  let ctx = `# DADES DE L'ATLETA\n\n`;
  ctx += `**Esports:** ${sportsList.join(', ')}\n`;
  ctx += `**Nivell:** ${nivel || 'intermedio'}\n`;
  ctx += `**Dies disponibles:** ${dias} (descans fix: ${descanso})\n`;
  ctx += `**Volum objectiu:** ${volumReal}h/setmana${stravaStats?.last4Weeks?.weeklyAvgHours ? ' (real de Strava 4 sem)' : ''}\n`;
  ctx += `**Objectiu:** ${objetivo}\n`;

  // Personals
  if (edat || alcada || pes) {
    ctx += `\n## PERSONAL\n`;
    if (edat) ctx += `- Edat: ${edat} anys${genere ? ' · ' + (genere === 'mujer' ? 'dona' : genere === 'hombre' ? 'home' : '') : ''}\n`;
    if (alcada && pes) {
      const bmi = Math.round(pes / Math.pow(alcada/100, 2) * 10) / 10;
      ctx += `- Altura: ${alcada} cm · Pes: ${pes} kg · IMC: ${bmi}\n`;
    }
    if (objetivo === 'peso') ctx += `- OBJECTIU PÈRDUA DE PES: prioritzar Z2 i activitats llargues\n`;
  }

  // Cardio: FCmax, zones, ritmes
  if (!isGymOnly) {
    ctx += `\n## RENDIMENT\n`;
    ctx += `- FCmax: ${fcMax} bpm`;
    if (stressTestData?.fcmax) ctx += ` (mesurat en prova d'esforç)`;
    else if (stravaStats?.heartRate?.fcmaxEstimate) ctx += ` (estimat de Strava — màx registrat ${stravaStats.heartRate.maxEver} bpm)`;
    ctx += '\n';

    if (fcrep) ctx += `- FC repòs: ${fcrep} bpm\n`;
    ctx += `- Zones FC: Z1 ${z1[0]}-${z1[1]} | Z2 ${z2[0]}-${z2[1]} | Z3 ${z3[0]}-${z3[1]} | Z4 ${z4[0]}-${z4[1]} | Z5 ${z5[0]}-${fcMax}\n`;

    if (stressTestData?.umbral_aerobic) ctx += `- VT1 (llindar aeròbic): ${stressTestData.umbral_aerobic} bpm\n`;
    if (stressTestData?.umbral_anaerobic) ctx += `- VT2 (llindar anaeròbic): ${stressTestData.umbral_anaerobic} bpm\n`;
    if (stressTestData?.vo2max) ctx += `- VO2max: ${stressTestData.vo2max} ml/kg/min\n`;

    // Running paces
    if (sportsList.includes('running') || sportsList.includes('trail') || isTri || isDua) {
      ctx += `\n### RUNNING\n`;
      if (pacez2) {
        ctx += `- Ritme Z2 (aeròbic base): ${fmtPace(parseInt(pacez2))}`;
        if (stressTestData?.ritme_z2) ctx += ` (de prova d'esforç)`;
        else if (stravaStats?.heartRate?.z2?.paceFromHR_sec) ctx += ` (real de Strava: ${stravaStats.heartRate.z2.runsCount} rodatges a ${stravaStats.heartRate.z2.avgHR} bpm)`;
        ctx += '\n';
      }
      if (race5k) {
        const p5k = Math.round(parseInt(race5k)/5);
        ctx += `- Millor 5K: ${fmtPace(p5k)}`;
        if (stravaStats?.running?.best5K_pace) ctx += ` (Strava: ${stravaStats.running.best5K_pace})`;
        ctx += '\n';
      }
      if (race10k) {
        const p10k = Math.round(parseInt(race10k)/10);
        ctx += `- Millor 10K: ${fmtPace(p10k)}`;
        if (stravaStats?.running?.best10K_pace) ctx += ` (Strava: ${stravaStats.running.best10K_pace})`;
        ctx += '\n';
      }
      if (sportsList.includes('trail') && desnivel > 0) {
        ctx += `- Desnivell objectiu cursa: +${desnivel}m D+\n`;
      }
    }

    // Bici / FTP
    if ((sportsList.includes('ciclismo') || isTri || isDua) && ftp) {
      ctx += `\n### CICLISME\n- FTP: ${ftp}W`;
      if (stressTestData?.ftp) ctx += ` (prova d'esforç)`;
      ctx += '\n';
    }

    if (sportsList.includes('natacion') || isTri) {
      ctx += `\n### NATACIÓ\n- Inclou sessions tècniques i de resistència aeròbica\n`;
    }
  }

  // Historial Strava
  if (stravaStats) {
    ctx += `\n## HISTÒRIC STRAVA (últims 6 mesos)\n`;
    ctx += `- Activitats: ${stravaStats.recentActivities6mo}\n`;
    ctx += `- Volum mig: ${stravaStats.avgWeeklyKm} km/setmana · ${stravaStats.avgWeeklyHours}h/setmana\n`;
    ctx += `- Últimes 4 setmanes: ${stravaStats.last4Weeks?.weeklyAvgHours || '?'}h/setmana · ${stravaStats.last4Weeks?.km || '?'}km\n`;
    if (stravaStats.running?.longestKm) ctx += `- Rodatge més llarg: ${stravaStats.running.longestKm} km\n`;
    if (stravaStats.cycling?.longestKm) ctx += `- Ruta bici més llarga: ${stravaStats.cycling.longestKm} km\n`;
    if (stravaStats.heartRate?.avgTrainingHR) ctx += `- FC mitja als entrenos: ${stravaStats.heartRate.avgTrainingHR} bpm\n`;
    ctx += `\n**IMPORTANT:** ajusta el volum de la setmana al volum REAL (${volumReal}h/sem), no a l'estimació genèrica del nivell.\n`;
  }

  // Gym
  if (isGymOnly || (musculos && musculos.length > 0)) {
    ctx += `\n## GIMNÀS\n`;
    if (musculos && musculos.length > 0) {
      const musMap = {
        tren_superior: 'tren superior (pit, espatlles, tríceps)',
        tren_inferior: 'tren inferior (quads, isquiotibials, bessons)',
        core: 'core i abdomen',
        espalda: 'esquena i bíceps',
        gluteos: 'glútis',
        equilibrado: 'cos equilibrat (tots els grups)'
      };
      ctx += `- Grups prioritaris: ${musculos.map(m => musMap[m] || m).join(', ')}\n`;
    }
    if (obj_gym) {
      const objMap = { fuerza:'força i potència', hipertrofia:'hipertròfia', tono:'tonificació i definició', funcional:'funcional i mobilitat' };
      ctx += `- Objectiu: ${objMap[obj_gym] || obj_gym}\n`;
    }
    if (equipamiento) {
      const equipMap = { gym_completo:'gimnàs complet', mancuernas:'mancuernes i peses a casa', cuerpo:'només pes corporal / calistenia' };
      ctx += `- Material: ${equipMap[equipamiento] || equipamiento}\n`;
    }
  }

  // Cursa
  if (objetivo === 'carrera' && carrera) {
    ctx += `\n## OBJECTIU CURSA\n`;
    ctx += `- Cursa: ${carrera}\n`;
    if (distancia) ctx += `- Distància: ${distancia}\n`;
    if (desnivel > 0) ctx += `- Desnivell: +${desnivel}m D+\n`;
    if (fecha) {
      const diff = Math.ceil((new Date(fecha) - new Date()) / (1000*60*60*24));
      ctx += `- Data: ${fecha} (${diff} dies)\n`;
      if (diff < 30) ctx += `- **FASE: TAPER** — manteniment, no augmentis càrrega\n`;
      else if (diff < 60) ctx += `- **FASE: ESPECÍFIC** — prioritzar intensitat específica de cursa\n`;
      else if (diff < 120) ctx += `- **FASE: CONSTRUCCIÓ** — augmentar volum progressivament\n`;
      else ctx += `- **FASE: BASE** — construir base aeròbica\n`;
    }
  }

  // ─── Missatge final amb el format JSON requerit ─────────────────────────
  const userMessage = ctx + `\n\n---\n\nGENERA EL PLA SETMANAL aplicant tota la teva metodologia.

**FORMAT DE RESPOSTA OBLIGATORI** — Retorna NOMÉS un objecte JSON vàlid (sense markdown, sense \`\`\`json, sense explicacions prèvies). Estructura exacta:

\`\`\`
{
  "setmana": [
    {
      "day": "Lu",
      "icon": "🏃",
      "title": "Rodaje Z2",
      "sub": "45 min · base aeróbica",
      "why": "Construyes la base aeróbica de la semana",
      "tags": ["Running", "Z2"],
      "duracio_min": 45,
      "rest": false
    },
    ... 7 elements en total, ordre Lu → Do
  ],
  "resum": "Frase d'1-2 línies explicant la lògica del pla"
}
\`\`\`

**RESTRICCIONS ESTRICTES:**
- Els 7 dies en ordre Lu, Ma, Mi, Ju, Vi, Sá, Do
- El dia "${descanso}" → rest:true, icon:"💤", title:"Descanso", duracio_min:0
- Total duracio_min de sessions d'entrenament ≈ ${Math.round(volumReal * 60)} minuts (volum objectiu)
- Tags amb zona FC ["Z2"] si running/bici, o grup muscular ["Piernas"] si gym
- Icones: 🏃 running/trail · 🚴 ciclisme · 🏊 natació · 🏋️ gimnàs · 🤸 calistenia/core · 💤 descans · 🥇 brick triatleta
- "why" en castellà, frase curta i motivadora
- "title" en castellà, descriptiu i concret`;

  // ─── Crida a Claude amb prompt caching ─────────────────────────────────
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: [
      { type: "text", text: BASE_INSTRUCTIONS },
      { type: "text", text: METHODOLOGY, cache_control: { type: "ephemeral" } }
    ],
    messages: [{ role: "user", content: userMessage }]
  });

  let reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  reply = reply.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  let data;
  try {
    data = JSON.parse(reply);
  } catch (e) {
    console.error('Failed to parse coach reply:', reply.substring(0, 500));
    throw new Error('Resposta del coach amb format incorrecte');
  }

  if (!data.setmana || !Array.isArray(data.setmana)) {
    throw new Error('Resposta sense setmana vàlida');
  }

  // Normalitzar a 7 dies garantits en ordre Lu→Do
  const dayNames = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
  const validated = dayNames.map((day, i) => {
    let s = data.setmana.find(x => x.day === day) || data.setmana[i] || { rest: true };
    return {
      day,
      icon: s.icon || (s.rest ? '💤' : '🏃'),
      title: s.title || s.titulo || (s.rest ? 'Descanso' : 'Sesión'),
      sub: s.sub || s.description || s.descripcion || '',
      why: s.why || s.razon || s.porque || '',
      tags: s.tags || s.etiquetas || [],
      duracio_min: s.duracio_min || s.duracion || s.duration || (s.rest ? 0 : 45),
      rest: s.rest || false
    };
  });

  return res.status(200).json({
    setmana: validated,
    resum: data.resum || data.resumen || '',
    usage: response.usage  // monitora cache_creation_input_tokens / cache_read_input_tokens
  });
}
