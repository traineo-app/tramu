import Anthropic from "@anthropic-ai/sdk";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      // Bàsics
      sports, dias, descanso, nivel, fcmax, volum,
      objetivo, carrera, distancia, desnivel,
      // Personals
      edat, alcada, pes, fcrep, genere,
      // Calibrats (valors reals de PDF/Strava/manual)
      pacez2, race5k, race10k, ftp,
      // Gym específics
      musculos, obj_gym, equipamiento,
      // Carrera
      fecha,
      // Dades crues de Strava i PDF (si s'han passat)
      stravaStats, stressTestData
    } = req.body;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ─── Construir context de l'atleta ───────────────────────────────────────

    const sportsList = Array.isArray(sports) ? sports : (sports || 'running').split(',');
    const hasCardio = sportsList.some(s => ['running', 'ciclismo', 'trail', 'natacion', 'triatlon'].includes(s));
    const isGymOnly = sportsList.length > 0 && sportsList.every(s => ['gimnasio', 'calistenia'].includes(s));
    const isTri = sportsList.includes('triatlon');
    const isDua = sportsList.includes('duatlon');

    // Calcular FCmax i zones
    const fcMax = parseInt(fcmax) || 185;
    const fcrep_val = parseInt(fcrep) || null;
    const z1 = [Math.round(fcMax * 0.50), Math.round(fcMax * 0.60)];
    const z2 = [Math.round(fcMax * 0.60), Math.round(fcMax * 0.70)];
    const z3 = [Math.round(fcMax * 0.70), Math.round(fcMax * 0.80)];
    const z4 = [Math.round(fcMax * 0.80), Math.round(fcMax * 0.90)];
    const z5 = [Math.round(fcMax * 0.90), fcMax];

    // Ritmes de running (sec/km → format MM:SS)
    function fmtPace(sec) {
      if (!sec) return null;
      const m = Math.floor(sec / 60), s = Math.round(sec % 60);
      return m + ':' + String(s).padStart(2, '0') + '/km';
    }

    // Nivell de rendiment estimat (s'usa per calibrar la dificultat)
    const nivelMap = { principiante: 1, inicio: 1, intermedio: 2, avanzado: 3, élite: 4 };
    const nivelVal = nivelMap[(nivel || 'intermedio').toLowerCase()] || 2;

    // Inferir nivel des de Strava si no s'ha especificat
    let nivelLabel = nivel || 'Intermedio';
    if (stravaStats?.avgWeeklyHours) {
      const h = stravaStats.avgWeeklyHours;
      if (h >= 10 && nivelVal < 3) nivelLabel = 'Avanzado (inferido de Strava)';
      else if (h >= 5 && nivelVal < 2) nivelLabel = 'Intermedio (inferido de Strava)';
    }

    // Volum real (Strava guanya sobre manual)
    const volumReal = stravaStats?.last4Weeks?.weeklyAvgHours || parseFloat(volum) || 4;

    // ─── Construir bloc de dades de rendiment ────────────────────────────────

    let rendimentBlock = '';

    if (!isGymOnly) {
      rendimentBlock += `\nDADES DE RENDIMENT:\n`;

      // FCmax i zones
      rendimentBlock += `- FCmax: ${fcMax} bpm`;
      if (stressTestData?.fcmax) rendimentBlock += ` (mesurat en prova d'esforç)`;
      else if (stravaStats?.heartRate?.fcmaxEstimate) rendimentBlock += ` (estimat des de Strava, màx registrat ${stravaStats.heartRate.maxEver} bpm)`;
      else rendimentBlock += ` (estimat)`;
      rendimentBlock += '\n';

      if (fcrep_val) rendimentBlock += `- FC repòs: ${fcrep_val} bpm\n`;

      rendimentBlock += `- Zones FC: Z1 ${z1[0]}-${z1[1]} | Z2 ${z2[0]}-${z2[1]} | Z3 ${z3[0]}-${z3[1]} | Z4 ${z4[0]}-${z4[1]} | Z5 ${z5[0]}-${fcMax}\n`;

      if (stressTestData?.umbral_aerobic) rendimentBlock += `- Llindar aeròbic (VT1): ${stressTestData.umbral_aerobic} bpm\n`;
      if (stressTestData?.umbral_anaerobic) rendimentBlock += `- Llindar anaeròbic (VT2): ${stressTestData.umbral_anaerobic} bpm\n`;
      if (stressTestData?.vo2max) rendimentBlock += `- VO2max: ${stressTestData.vo2max} ml/kg/min\n`;

      if (sportsList.includes('running') || sportsList.includes('trail') || isTri || isDua) {
        rendimentBlock += `\nRITMES DE RUNNING:\n`;
        if (pacez2) rendimentBlock += `- Ritme Z2 (base aeròbica): ${fmtPace(parseInt(pacez2))}`;
        if (stressTestData?.ritme_z2) rendimentBlock += ` ← prova d'esforç`;
        else if (stravaStats?.heartRate?.z2?.paceFromHR_sec) rendimentBlock += ` ← Strava HR real (${stravaStats.heartRate.z2.runsCount} rodatges a ${stravaStats.heartRate.z2.avgHR} bpm)`;
        if (pacez2) rendimentBlock += '\n';

        if (race5k) {
          const pace5k = Math.round(parseInt(race5k) / 5);
          rendimentBlock += `- Millor 5K: ${fmtPace(pace5k)}`;
          if (stravaStats?.running?.best5K_pace) rendimentBlock += ` (Strava: ${stravaStats.running.best5K_pace})`;
          rendimentBlock += '\n';
        }
        if (race10k) {
          const pace10k = Math.round(parseInt(race10k) / 10);
          rendimentBlock += `- Millor 10K: ${fmtPace(pace10k)}`;
          if (stravaStats?.running?.best10K_pace) rendimentBlock += ` (Strava: ${stravaStats.running.best10K_pace})`;
          rendimentBlock += '\n';
        }
        if (stressTestData?.ritme_z2 && stressTestData?.ritme_5k) {
          const diff = stressTestData.ritme_5k - stressTestData.ritme_z2;
          rendimentBlock += `- Diferència Z2 vs 5K: ${Math.round(diff)}s/km (referència de progressió)\n`;
        }
        if (sportsList.includes('trail') && desnivel > 0) {
          rendimentBlock += `- Desnivell objectiu cursa: +${desnivel}m D+\n`;
        }
      }

      if ((sportsList.includes('ciclismo') || isTri || isDua) && ftp) {
        rendimentBlock += `\nCICLISME:\n- FTP: ${ftp}W`;
        if (stressTestData?.ftp) rendimentBlock += ` (prova d'esforç)`;
        rendimentBlock += '\n';
      }

      if (sportsList.includes('natacion') || isTri) {
        rendimentBlock += `\nNATACIÓ:\n- Inclou sessions tècniques i de resistència aeròbica\n`;
      }
    }

    // ─── Bloc de Strava ──────────────────────────────────────────────────────

    let stravaBlock = '';
    if (stravaStats) {
      stravaBlock = `\nHISTÒRIC STRAVA (últims 6 mesos):\n`;
      stravaBlock += `- Activitats: ${stravaStats.recentActivities6mo}\n`;
      stravaBlock += `- Volum mig: ${stravaStats.avgWeeklyKm} km/setmana · ${stravaStats.avgWeeklyHours}h/setmana\n`;
      stravaBlock += `- Últimes 4 setmanes: ${stravaStats.last4Weeks?.weeklyAvgHours || '?'}h/setmana\n`;
      if (stravaStats.running?.longestKm) stravaBlock += `- Rodatge més llarg: ${stravaStats.running.longestKm} km\n`;
      if (stravaStats.cycling?.longestKm) stravaBlock += `- Ruta bici més llarga: ${stravaStats.cycling.longestKm} km\n`;
      if (stravaStats.heartRate?.avgTrainingHR) stravaBlock += `- FC mitja als entrenos: ${stravaStats.heartRate.avgTrainingHR} bpm\n`;
      stravaBlock += `IMPORTANT: ajusta el volum de la setmana al nivell real (${volumReal}h/sem), NO et límites a l'estimació genèrica.\n`;
    }

    // ─── Bloc de gym ─────────────────────────────────────────────────────────

    let gymBlock = '';
    if (isGymOnly || musculos?.length > 0) {
      gymBlock = `\nESPECIFICACIONS DE GIMNÀS:\n`;
      if (musculos?.length > 0) {
        const musMap = {
          tren_superior: 'tren superior (pit, espatlles, tríceps)',
          tren_inferior: 'tren inferior (quads, isquiotibials, bessons)',
          core: 'core i abdomen',
          espalda: 'espatlla i bíceps',
          gluteos: 'glútis',
          equilibrado: 'cos equilibrat (tots els grups)'
        };
        gymBlock += `- Grups prioritaris: ${musculos.map(m => musMap[m] || m).join(', ')}\n`;
      }
      if (obj_gym) {
        const objMap = { fuerza: 'força i potència', hipertrofia: 'hipertròfia', tono: 'tonificació i definició', funcional: 'funcional i mobilitat' };
        gymBlock += `- Objectiu: ${objMap[obj_gym] || obj_gym}\n`;
      }
      if (equipamiento) {
        const equipMap = { gym_completo: 'gimnàs complet (tots els aparells)', mancuernas: 'mancuernes i peses a casa', cuerpo: 'només pes corporal / calistenia' };
        gymBlock += `- Material: ${equipMap[equipamiento] || equipamiento}\n`;
      }
    }

    // ─── Bloc personal ────────────────────────────────────────────────────────

    let personalBlock = '';
    if (edat || alcada || pes) {
      personalBlock = `\nDADES PERSONALS:\n`;
      if (edat) {
        personalBlock += `- Edat: ${edat} anys`;
        if (genere) personalBlock += ` · ${genere === 'mujer' ? 'dona' : genere === 'hombre' ? 'home' : ''}`;
        personalBlock += '\n';
      }
      if (alcada && pes) {
        const bmi = Math.round(pes / ((alcada / 100) ** 2) * 10) / 10;
        personalBlock += `- Altura: ${alcada} cm · Pes: ${pes} kg · IMC: ${bmi}\n`;
      }
      if (objetivo === 'peso') personalBlock += `- Objectiu de pèrdua de pes: prioritzar Z2 i activitats de llarga durada\n`;
    }

    // ─── Bloc cursa ──────────────────────────────────────────────────────────

    let carreraBlock = '';
    if (objetivo === 'carrera' && carrera) {
      carreraBlock = `\nOBJECTIU CURSA:\n`;
      carreraBlock += `- Cursa: ${carrera}\n`;
      if (distancia) carreraBlock += `- Distància: ${distancia}\n`;
      if (desnivel > 0) carreraBlock += `- Desnivell: +${desnivel}m D+\n`;
      if (fecha) {
        const diff = Math.ceil((new Date(fecha) - new Date()) / (1000 * 60 * 60 * 24));
        carreraBlock += `- Data: ${fecha} (${diff} dies)\n`;
        if (diff < 30) carreraBlock += `- ATENCIÓ: menys de 30 dies. Setmana de taper/manteniment, no augmentis la càrrega.\n`;
        else if (diff < 60) carreraBlock += `- Fase específica: prioritzar intensitat específica de cursa.\n`;
        else if (diff < 120) carreraBlock += `- Fase de construcció: augmentar volum progressivament.\n`;
        else carreraBlock += `- Fase base: construir la base aeròbica, no hi ha pressa.\n`;
      }
    }

    // ─── Construir el prompt final ────────────────────────────────────────────

    const isMultisport = isTri || isDua || sportsList.length > 2;

    const systemPrompt = `Ets un coach d'entrenament esportiu professional amb 20 anys d'experiència. 
Generes plans setmanals MOLT personalitzats, concrets i basats en dades reals de l'atleta.
Respons SEMPRE en castellà, en format JSON estricte sense markdown.

PRINCIPIS DEL PLA:
1. Respecta SEMPRE el nombre de dies disponibles (${dias} dies d'entrenament).
2. El dia de descans fix és ${descanso} — SEMPRE descans en aquest dia.
3. El volum ha de ser ${volumReal}h/setmana ±20% (RESPECTA EL VOLUM REAL, no inventes).
4. Progressió gradual: no augmentis més del 10% de volum respecte al nivell actual.
5. La intensitat ha de distribuir-se: ~80% Z1-Z2 (aeròbic base), ~20% Z3-Z5 (qualitat).
6. ${isGymOnly ? 'Pla de força/calistenia: sessions estructurades per grups musculars, escalfament i tornada a la calma.' : 'Cada sessió de running/bici/natació ha d\'incloure zona FC objectiu.'}
${isTri ? '7. Triatleta: reparteix les 3 disciplines (natació/bici/running) de forma equilibrada. Inclou almenys 1 brick per setmana si el nivell és intermedi o avançat.' : ''}
${isDua ? '7. Duatló: combina running i bici equilibradament.' : ''}
${objetivo === 'peso' ? '7. Objectiu de pèrdua de pes: sessions llargues Z2 que cremen greix, no sessions curtes d\'alta intensitat.' : ''}

OBLIGATORI al JSON de resposta:
- "setmana": array de 7 sessions (una per dia Lu-Di), en ordre Lu→Di
- Cada sessió amb: day, icon, title, sub, why, tags, duracio_min, rest
- "resum": frase d'1-2 línies explicant la lògica del pla
- Si la sessió és descans: rest:true, icon:"💤", title:"Descanso", duracio_min:0
- Tags han d'incloure la zona FC si és cardio (ex: ["Running","Z2"]) o el grup muscular si és gym (ex: ["Gimnasio","Piernas"])
- "duracio_min" ha de ser realista per al volum de ${volumReal}h/setmana

ICONES per activitat:
🏃 running/trail · 🚴 ciclisme · 🏊 natació · 🏋️ gimnàs · 🤸 calistenia/core · 💤 descans · 🥇 brick triatleta`;

    const userPrompt = `Genera la setmana d'entrenament per a aquest atleta:

ESPORTS: ${sportsList.join(', ')}
NIVELL: ${nivelLabel}
DIES DISPONIBLES: ${dias} (descans fix: ${descanso})
VOLUM OBJECTIU: ${volumReal}h/setmana
OBJECTIU: ${objetivo}
${personalBlock}${rendimentBlock}${stravaBlock}${gymBlock}${carreraBlock}
Genera el JSON ara. IMPORTANT: el total de duracio_min de les sessions d'entrenament ha de sumar aproximadament ${Math.round(volumReal * 60)} minuts (${volumReal}h).`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [
        { role: "user", content: userPrompt }
      ],
      system: systemPrompt
    });

    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') responseText += block.text;
    }

    // Netejar markdown si ve
    responseText = responseText.trim()
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    const data = JSON.parse(responseText);

    // Validació bàsica
    if (!data.setmana || !Array.isArray(data.setmana)) {
      throw new Error('Resposta sense setmana vàlida');
    }

    // Garantir que tenim exactament 7 dies amb els camps necessaris
    const dayNames = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
    const validated = dayNames.map((day, i) => {
      const session = data.setmana[i] || { rest: true };
      return {
        day,
        icon: session.icon || (session.rest ? '💤' : '🏃'),
        title: session.title || session.titulo || (session.rest ? 'Descanso' : 'Sesión'),
        sub: session.sub || session.description || '',
        why: session.why || session.razon || '',
        tags: session.tags || session.etiquetas || [],
        duracio_min: session.duracio_min || session.duracion || (session.rest ? 0 : 45),
        rest: session.rest || false
      };
    });

    return res.status(200).json({
      setmana: validated,
      resum: data.resum || data.resumen || ''
    });

  } catch (error) {
    console.error('Coach error:', error);
    return res.status(500).json({
      error: error.message || 'Error generant el pla',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
