// api/coach.js — tramu coach IA
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic();

const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

function describeMaterial(gym_ubi, gym_mat, equipamiento) {
  if (gym_ubi === 'gimnasio' || equipamiento === 'gym_completo') {
    return 'Gimnasio completo: acceso a barras, mancuernas, máquinas, poleas, banco. Usa cualquier ejercicio.';
  }
  const mats = Array.isArray(gym_mat) ? gym_mat : (typeof gym_mat === 'string' && gym_mat ? gym_mat.split(',') : []);
  if (mats.length === 0 || mats.includes('nada') || equipamiento === 'cuerpo') {
    return 'SOLO peso corporal (calistenia). PROHIBIDO usar pesas, barras o máquinas. Usa: flexiones, fondos, sentadillas, zancadas, planchas, puentes de glúteo, dominadas solo si hay barra.';
  }
  const matNames = {
    mancuernas: 'mancuernas', kettlebell: 'kettlebell', gomas: 'gomas elásticas',
    barra_dominadas: 'barra de dominadas', banco: 'banco y barra'
  };
  const list = mats.map(m => matNames[m] || m).join(', ');
  return `Entrena EN CASA. Material disponible: ${list}. SOLO usa ejercicios que se puedan hacer con ESTE material exacto. NO uses máquinas, poleas ni nada que no esté en la lista. Si falta material para un grupo muscular, sustituye por peso corporal.`;
}

const BASE_INSTRUCTIONS = `Eres el coach IA de tramu, una app d'entrenament esportiu per a runners, ciclistes, triatletes, swimmers, atletes de força i gent que vol estar en forma.

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
- Si hi ha cursa propera, ajusta la fase (base/construcció/específic/taper) i RESPECTA LA FASE indicada al context
- Si hi ha sessions de força, respecta SEMPRE el material disponible de l'atleta
- En sessions de força/gimnàs/calistènia, prioritza els exercicis més ben valorats de les taules EXERCICIS CLAU del cervell (split squat, trap bar deadlift, RDL, soleus bent-knee, step-up, Pallof press, dead bug, planxa lateral, Copenhagen plank) i evita els pitjor valorats (crunch, russian twist, planxa abdominal com a principal, dips i press banca en perfils endurance excepte natació/híbrids)
- Retorna JSON estricte sense markdown segons el format demanat al missatge`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
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

async function handleChat(req, res) {
  const { messages, userContext } = req.body;

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

async function handlePlanGeneration(req, res) {
  const {
    sports, dias, descanso, nivel, fcmax, volum,
    objetivo, carrera, distancia, desnivel, fecha,
    edat, alcada, pes, fcrep, genere,
    pacez2, race5k, race10k, ftp,
    musculos, obj_gym, equipamiento, gym_ubi, gym_mat, gym_purpose,
    stravaStats, stressTestData,
    previousWeek, weekNumber, cycleInfo,
    plannedTitles, plannedFocus
  } = req.body;

  const sportsList = Array.isArray(sports) ? sports : (sports || 'running').split(',');
  const hasCardio = sportsList.some(s => ['running','ciclismo','trail','natacion','triatlon'].includes(s));
  const isGymOnly = sportsList.length > 0 && sportsList.every(s => ['gimnasio','calistenia'].includes(s));
  const hasGym = sportsList.includes('gimnasio') || sportsList.includes('calistenia');
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

  let ctx = `# DADES DE L'ATLETA\n\n`;
  ctx += `**Esports:** ${sportsList.join(', ')}\n`;
  ctx += `**Nivell:** ${nivel || 'intermedio'}\n`;
  ctx += `**Dies disponibles:** ${dias} (descans fix: ${descanso})\n`;
  ctx += `**Volum objectiu:** ${volumReal}h/setmana${stravaStats?.last4Weeks?.weeklyAvgHours ? ' (real de Strava 4 sem)' : ''}\n`;
  ctx += `**Objectiu:** ${objetivo}\n`;

  if (edat || alcada || pes) {
    ctx += `\n## PERSONAL\n`;
    if (edat) ctx += `- Edat: ${edat} anys${genere ? ' · ' + (genere === 'mujer' ? 'dona' : genere === 'hombre' ? 'home' : '') : ''}\n`;
    if (alcada && pes) {
      const bmi = Math.round(pes / Math.pow(alcada/100, 2) * 10) / 10;
      ctx += `- Altura: ${alcada} cm · Pes: ${pes} kg · IMC: ${bmi}\n`;
    }
    if (objetivo === 'peso') ctx += `- OBJECTIU PÈRDUA DE PES: prioritzar Z2 i activitats llargues\n`;
  }

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
      // Ritme objectiu de cursa
      if (req.body.ritme_obj) {
        const ro = parseInt(req.body.ritme_obj);
        ctx += `- RITME OBJECTIU de cursa: ${fmtPace(ro)} — orienta les sessions de qualitat cap a aquest ritme\n`;
      }
      if (sportsList.includes('trail')) {
        ctx += `\n### TRAIL — DESNIVELL OBLIGATORI\n`;
        if (desnivel > 0) {
          ctx += `- Desnivell objectiu de la cursa: +${desnivel}m D+. Les sessions de trail han de construir cap a aquest desnivell de forma progressiva segons la fase.\n`;
        }
        ctx += `- CADA sessió de trail HA DE portar "desnivel_m" amb un valor REAL i > 0 (mai 0). Una tirada de trail de 60-90 min sol tenir entre 300 i 1000 m de D+ segons la fase i el perfil de la cursa. Posa metres concrets i coherents, mai zero.\n`;
      }
    }

    if ((sportsList.includes('ciclismo') || isTri || isDua) && ftp) {
      ctx += `\n### CICLISME\n- FTP: ${ftp}W`;
      if (stressTestData?.ftp) ctx += ` (prova d'esforç)`;
      ctx += '\n';
    }
    if (req.body.vel_obj && (sportsList.includes('ciclismo'))) {
      ctx += `- VELOCITAT OBJECTIU de cursa: ${req.body.vel_obj} km/h mitjana\n`;
    }

    if (sportsList.includes('natacion') || isTri) {
      ctx += `\n### NATACIÓ\n- Inclou sessions tècniques i de resistència aeròbica\n`;
    }
  }

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

  if (isGymOnly || hasGym || (musculos && musculos.length > 0)) {
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
    if (gym_purpose === 'cursa') {
      ctx += `- PROPOSIT DE LA FORÇA: al servei de la cursa. Aplica força per endurance del cervell: força màxima i unilateral, baixes repeticions, RIR 2-3, lluny de les sessions clau de running. NO hipertròfia.\n`;
    } else if (gym_purpose === 'aparte') {
      ctx += `- PROPOSIT DE LA FORÇA: objectiu independent de la cursa (estètic/general). Pots orientar les sessions de gimnàs al seu objectiu (${obj_gym || 'general'}) sense subordinar-les del tot al running, però protegint sempre les sessions clau de cursa (no lower body destructiu el dia abans).\n`;
    }
    ctx += `- Material: ${describeMaterial(gym_ubi, gym_mat, equipamiento)}\n`;
  }

  if (previousWeek && previousWeek.sessions) {
    ctx += `\n## SETMANA ANTERIOR — Adapta la nova en funció d'això\n`;
    ctx += `**Fase de la setmana anterior:** ${previousWeek.phase || 'desconeguda'}\n\n`;
    ctx += `**Resultat per dia:**\n`;

    previousWeek.sessions.forEach(s => {
      if (s.rest) {
        ctx += `- ${s.day}: Descans\n`;
      } else if (s.completed && s.completion) {
        const c = s.completion;
        const statusMap = { completed: 'COMPLETADA', partial: 'PARCIAL', skipped: 'NO FETA' };
        const rpeMap = { easy: 'fàcil', good: 'bé', hard: 'dura', very_hard: 'al límit' };
        let line = `- ${s.day}: [${s.title} · ${s.duracio_min}min` ;
        if (s.custom) {
          if (s.custom.km) line += ` · ${s.custom.km}km`;
          if (s.custom.elev) line += ` · +${s.custom.elev}m`;
        }
        line += `] → ${statusMap[c.status] || c.status.toUpperCase()}`;
        if (c.status === 'partial' && c.actualDuration) line += ` (${c.actualDuration}min reals de ${c.plannedDuration})`;
        line += ` · RPE: ${rpeMap[c.rpe] || c.rpe}`;
        if (c.note) line += ` · Nota: "${c.note}"`;
        ctx += line + '\n';
      } else if (s.skipped) {
        ctx += `- ${s.day}: [${s.title}] → NO FETA (sense confirmar / saltada)\n`;
      } else {
        ctx += `- ${s.day}: [${s.title}] → SENSE DADES\n`;
      }
    });

    ctx += `\n**INSTRUCCIÓ D'ADAPTACIÓ:**\n`;
    ctx += `- Si l'atleta ha completat tot bé amb RPE moderat → segueix progressió natural (puja càrrega ~5%).\n`;
    ctx += `- Si hi ha RPE "al límit" repetit (≥2 sessions) → suavitza Z4/Z5 aquesta setmana.\n`;
    ctx += `- Si ha saltat o fet parcial una sessió clau (tirada llarga, qualitat) → NO la dobles, analitza per què (fatiga? logística?) i adapta.\n`;
    ctx += `- Si ha completat poc (<60% sessions) → reduceix volum 15-20% i prioritza adherència sobre estímul.\n`;
    ctx += `- Si RPE "fàcil" generalitzat → pots pujar lleugerament intensitat o volum.\n`;
    ctx += `- NO recuperar sessions perdudes: una sessió saltada no es compensa, segueix endavant.\n`;
  }

  if (Array.isArray(plannedTitles) && plannedTitles.length) {
    ctx += `\n## GUÍA DEL PLAN GENERAL (plan completo) — el mapa manda\n`;
    ctx += `El plan completo ya ha definido qué sesiones toca esta semana. DEBES generar sesiones que se correspondan con estos títulos (mismo tipo y enfoque), para que dashboard y plan completo sean coherentes:\n`;
    plannedTitles.forEach(t => { ctx += `- ${t}\n`; });
    if (plannedFocus) ctx += `**Enfoque de la semana:** ${plannedFocus}\n`;
    ctx += `Puedes concretar días, duración y detalle, pero NO cambies el tipo de sesión ni añadas/quites sesiones clave respecto a esta guía.\n`;
  }

  if (weekNumber) {
    ctx += `\n## POSICIÓ AL BLOC\n- Setmana número ${weekNumber} del pla.\n`;
  }
  if (cycleInfo) {
    ctx += `- Cicle ${cycleInfo.cycleNumber}, setmana ${cycleInfo.cycleWeek}/4 del cicle (rolling).\n`;
    if (cycleInfo.cycleWeek === 4) ctx += `- Aquesta és setmana de DESCÀRREGA: -25/30% volum, mantén freqüència i una mica d'intensitat.\n`;
  }

  if (objetivo === 'carrera' && carrera) {
    ctx += `\n## OBJECTIU CURSA\n`;
    ctx += `- Cursa: ${carrera}\n`;
    if (distancia) ctx += `- Distància: ${distancia}\n`;
    if (desnivel > 0) ctx += `- Desnivell: +${desnivel}m D+\n`;
    if (req.body.temps_obj) {
      const t = parseInt(req.body.temps_obj);
      const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = t%60;
      ctx += `- Temps objectiu: ${h>0?h+'h ':''}${m}min ${s>0?s+'s':''}\n`;
    }
    if (fecha) {
      const diff = Math.ceil((new Date(fecha) - new Date()) / (1000*60*60*24));
      ctx += `- Data: ${fecha} (${diff} dies)\n`;
      if (diff < 0) {
        ctx += `- **LA CARRERA YA HA PASADO** (hace ${Math.abs(diff)} días). Genera una SEMANA DE RECUPERACIÓN post-competición: solo Z1-Z2 muy suave, volumen muy bajo (~40% del habitual), sin series ni intensidad. El cuerpo necesita recuperarse del esfuerzo de la carrera. No programes sesiones duras.\n`;
      } else if (diff <= 3) {
        ctx += `- **SEMANA DE LA CARRERA — TAPER FINAL**: reduce el volumen al 40-50% del habitual. Solo activaciones cortas de calidad (15-20 min con unos pocos cambios de ritmo). Descanso total o muy suave los 2 días previos a la carrera. PROHIBIDO sesiones largas, tiradas o series duras. El objetivo es llegar FRESCO, no entrenado.\n`;
      } else if (diff <= 10) {
        ctx += `- **FASE TAPER**: reduce el volumen progresivamente (60-70% del habitual). Mantén algo de intensidad específica de carrera pero acorta mucho las sesiones. Empieza a descargar fatiga para llegar fresco.\n`;
      } else if (diff < 35) {
        ctx += `- **FASE ESPECÍFICO**: prioriza intensidad específica de carrera, simula los ritmos objetivo en las sesiones de calidad. Volumen todavía alto pero empezando a pulir. Las tiradas/series deben parecerse a la exigencia de la prueba.\n`;
      } else if (diff < 70) {
        ctx += `- **FASE CONSTRUCCIÓN**: aumenta volumen progresivamente e introduce calidad (series, ritmo). Es la fase de mayor carga del bloque.\n`;
      } else {
        ctx += `- **FASE BASE**: construye base aeróbica (mayoría Z2), volumen moderado y creciente. Todavía sin demasiada intensidad.\n`;
      }
    }
  }

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
      "desnivel_m": 0,
      "rest": false,
      "_nota_trail": "si la sesion es trail, desnivel_m DEBE ser > 0 (metros reales de subida)"
    }
  ],
  "resum": "Frase d'1-2 línies explicant la lògica del pla",
  "missatge": "Si hi ha setmana anterior: frase breu (màx 16 paraules) explicant com aquesta setmana s'adapta al que es va fer i quina és la seva intenció. Ex: 'Semana de más carga: la anterior la completaste entera, toca progresar'"
}
\`\`\`

**RESTRICCIONS ESTRICTES:**
- Els 7 dies en ordre Lu, Ma, Mi, Ju, Vi, Sá, Do
- El/els dia(es) "${descanso}" → rest:true, icon:"💤", title:"Descanso", duracio_min:0
- Total duracio_min de sessions d'entrenament ≈ ${Math.round(volumReal * 60)} minuts (volum objectiu), AJUSTAT segons la fase indicada al context (taper i recuperació van molt per sota)
- Tags amb zona FC ["Z2"] si running/bici, o grup muscular ["Piernas"] si gym
- En sessions de TRAIL, inclou SEMPRE "desnivel_m" amb els metres de desnivell positiu reals de la sessió. Planifica el desnivell segons la teva metodologia de trail; si la metodologia no ho concreta, aplica criteris generals d'entrenament de trail. Si hi ha cursa amb desnivell objectiu, fes progressar el D+ de les sessions al llarg del bloc cap a aquest objectiu (poc desnivell a fase base, acostant-se al D+ de cursa a fase específica, amb sessions clau que simulin l'exigència real). El D+ ha de ser coherent amb la durada, la fase i el terreny de la prova. Una sessió de trail SENSE desnivell no té sentit
- Icones: 🏃 running/trail · 🚴 ciclisme · 🏊 natació · 🏋️ gimnàs · 🤸 calistenia/core · 💤 descans · 🥇 brick triatleta
- "why" en castellà, frase curta i motivadora
- "title" en castellà, descriptiu i concret
- RESPECTA LA FASE indicada al context: si és taper o recuperació, el volum i la intensitat han de baixar de veritat`;

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
      desnivel_m: s.desnivel_m || s.desnivel || 0,
      rest: s.rest || false
    };
  });

  return res.status(200).json({
    setmana: validated,
    resum: data.resum || data.resumen || '',
    missatge: data.missatge || '',
    phase: data.phase || data.fase || null,
    usage: response.usage
  });
}
