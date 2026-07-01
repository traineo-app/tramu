// api/plan-completo.js — pla plurisemanal amb metodologia, PERSISTIT (font única)
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic();
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

const ROLLING_WEEKS = 8;

const BASE_INSTRUCTIONS = `Eres el coach IA de tramu generando un PLAN PLURISEMANAL (vista de bloc, 4-16 setmanes).

La teva metodologia completa està al CERVELL DEL COACH que segueix. Segueix-la sempre.

DIFERÈNCIA AMB EL PLA SETMANAL:
- Aquí NO generes sessions individuals dia per dia.
- Generes una vista de bloc: per cada setmana → fase, hores totals, càrrega 100-700, focus en una frase, i 3-4 títols principals de sessions.
- L'objectiu és que l'atleta vegi la progressió i lògica del bloc complet.

REGLES GENERALS:
- Respostes en CASTELLÀ (la interfície està en castellà)
- Aplica la filosofia 80/20 i els principis de càrrega/recuperació del cervell
- Respecta la nomenclatura de fase segons l'objectiu
- Quan una setmana inclogui força/gimnàs, els títols de sessió han de reflectir els exercicis i patrons més ben valorats del cervell (força màxima i unilateral: split squat, deadlift/RDL, soleus, Pallof, pliometria simple) i evitar els desaconsellats per endurance (crunch, russian twist, dips/press banca en perfils no natació). Segueix les taules d'EXERCICIS CLAU
- Volum total setmanal coherent amb el volum base de l'atleta
- La CORBA DE CÀRREGA importa: ha de pujar progressivament i BAIXAR al final si hi ha cursa (taper). Mai una línia plana ni ascendent fins al final.
- Retorna JSON estricte sense markdown ni preàmbul`;

function getMondayISO(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

function periodizationSig(userData, objetivo, raceDate) {
  const sv = userData?.stravaStats;
  const fotoMark = sv
    ? "s" + Math.round(Number(sv?.last4Weeks?.weeklyAvgHours || sv?.avgWeeklyHours || 0))
    : "nofoto";
  return [
    "v3",
    objetivo,
    raceDate || "",
    Math.round(Number(userData?.volum) || 4),
    userData?.dias ?? 3,
    (userData?.sports || ["running"]).slice().sort().join(","),
    userData?.nivel || "intermedio",
    fotoMark
  ].join("|");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { userData, raceDate, raceName, email, forceRegenerate, realWeeks, currentWeekStart } = req.body;
    const objetivo = raceDate ? "carrera" : (userData?.objetivo || "forma");
    const sig = periodizationSig(userData, objetivo, raceDate);

    // realWeeks = setmanes REALS del dashboard (font de veritat del que s'ha fet/planificat).
    // El dashboard mana: el mapa ha de reflectir-les, no inventar-ne de noves per aquestes dates.
    const realWeeksArr = Array.isArray(realWeeks) ? realWeeks : [];

    // ── 1. Cache: si hi ha periodització vàlida desada, retorna-la ──
    // Nota: el cache només és vàlid si NO hi ha setmanes reals per coordinar
    // (si n'hi ha, cal reconstruir el mapa perquè reflecteixi el dashboard).
    if (email && !forceRegenerate && realWeeksArr.length === 0) {
      const { data: cachedProfile } = await supabase
        .from("profiles")
        .select("periodization")
        .eq("email", email)
        .maybeSingle();
      if (cachedProfile?.periodization && cachedProfile.periodization._sig === sig) {
        return res.status(200).json({ ...cachedProfile.periodization, _cached: true });
      }
    }

    // ── 2. Generar ──
    let weeks;
    if (objetivo === "carrera" && raceDate) {
      const diff = Math.ceil((new Date(raceDate) - new Date()) / (1000 * 60 * 60 * 24 * 7));
      weeks = Math.max(1, Math.min(diff, 24));
    } else {
      weeks = ROLLING_WEEKS;
    }

    // Format del ritme/velocitat/temps objectiu per al prompt (camelCase del dashboard)
    const ritmeObjTxt = userData?.ritmeObj
      ? `${Math.floor(userData.ritmeObj / 60)}:${String(userData.ritmeObj % 60).padStart(2, "0")}/km`
      : null;
    const velObjTxt = userData?.velObj ? `${userData.velObj} km/h` : null;
    const tempsObjTxt = userData?.tempsObj
      ? `${Math.floor(userData.tempsObj / 3600)}h${String(Math.floor((userData.tempsObj % 3600) / 60)).padStart(2, "0")}min`
      : null;

    let ritmeBlock = "";
    if (ritmeObjTxt) ritmeBlock += `\nRITMO OBJETIVO de carrera: ${ritmeObjTxt}. Las sesiones de calidad de las fases Construcción y Específico deben orientarse a este ritmo (series y tiradas a ritmo objetivo o ligeramente más rápido). Es la referencia para dosificar la intensidad.`;
    if (velObjTxt) ritmeBlock += `\nVELOCIDAD OBJETIVO de carrera: ${velObjTxt}. Orienta las sesiones de calidad a esta velocidad media.`;
    if (tempsObjTxt) ritmeBlock += `\nTIEMPO OBJETIVO total: ${tempsObjTxt}. Ten en cuenta la exigencia de este objetivo al planificar las cargas.`;

    const objectiveTask = {
      carrera: `OBJETIVO: CARRERA hacia ${raceName || "objetivo competitivo"} el ${raceDate}.
Aplica la periodización del BLOC 9 #56 de tu metodología (Off-season → Base → Build → Peak → Taper → Carrera).

ESTRUCTURA OBLIGATORIA DE LA CURVA DE CARGA (es lo MÁS importante de este plan):
- La carga y el volumen deben DIBUJAR UNA CURVA que sube progresivamente y BAJA claramente al final (taper). NUNCA una línea plana ni ascendente hasta el final.
- BASE (primeras semanas): volumen moderado y creciente, carga 250-400.
- CONSTRUCCIÓN/ESPECÍFICO (centro del bloque): PICO de volumen y carga del bloque, las semanas más altas (carga 450-650). Aquí es donde más se entrena.
- PENÚLTIMA semana (Taper): reduce a ~60-70% del pico.
- ÚLTIMA semana (la de la carrera, el weekNum más alto): volumen MUY bajo (~40% del pico), carga 150-250. Solo activaciones cortas + la propia carrera. Es de las semanas MÁS SUAVES de todo el bloque. NUNCA debe tener carga alta — sería un error grave.
- Respeta los microciclos 3+1: cada ~4 semanas una de descarga (~25-30% menos que la anterior).
- El objetivo de toda la curva es llegar al día de la carrera en PICO de forma: fresco pero entrenado.${ritmeBlock}

ADAPTA LAS FASES AL TIEMPO REAL Y AL PUNTO DE FORMA ACTUAL (clave — NO empieces siempre por Base):
- El plan tiene ${weeks} semana(s) hasta la carrera. Distribuye las fases según ESE tiempo disponible y el estado de forma del atleta (su histórico Strava y nivel indican de dónde viene).
- Si quedan POCAS semanas (≤4) Y el atleta ya tiene base (nivel intermedio/avanzado o volumen Strava decente): NO empieces por "Base 1". El atleta YA está entrenado. Entra directamente en Específico + Taper. Sería un error hacerle empezar la base a pocas semanas de competir.
- Si quedan 5-8 semanas: poca o nula Base, sobre todo Construcción + Específico + Taper.
- Si quedan 9-14 semanas: Base corta + Construcción + Específico + Taper.
- Si quedan 15+ semanas: periodización completa Base → Construcción → Específico → Taper.
- Un atleta avanzado necesita MENOS base que un principiante para el mismo tiempo. Usa el histórico para calibrar de dónde parte.

Nomenclatura de fase: usa "Base 1", "Construcción 2", "Específico", "Taper", "Carrera" (la última semana SIEMPRE "Carrera"). Si saltas la base, empieza directamente por "Construcción" o "Específico".`,

      forma: `OBJETIVO: PONERSE EN FORMA (mejora general, SIN carrera).
Como no hay pico objetivo, usa CICLO ROLLING 3+1 según BLOC 9 #57 de tu metodología (3 sem progresión + 1 descarga).
Nomenclatura OBLIGATORIA: "Ciclo 1 · Semana X/${weeks}" (NUNCA "Base 1" ni "Construcción").
Distribución según metodología: 75-85% Z2, intensidad moderada bien dosificada, fuerza 2x/sem.`,

      peso: `OBJETIVO: PERDER PESO Y GANAR ENERGÍA (SIN carrera).
Aplica TODA la metodología del BLOC 11 #73 (atleta con sobrepeso): construir capacidad ANTES que quemar calorías.
Prioriza VOLUMEN aeróbico Z2 + FUERZA 2-3x/sem + NEAT alto. Evita HIIT y picos de intensidad.
Si el perfil sugiere baja tolerancia al impacto, prioriza modalidades de bajo impacto (bici, caminar, elíptica, nado).
Nomenclatura OBLIGATORIA: "Ciclo 1 · Semana X/${weeks}". Ciclo rolling 3+1.`,

      vuelta: `OBJETIVO: VOLVER DESPUÉS DE UNA PAUSA (SIN carrera).
Aplica TODA la metodología del BLOC 11 #69 (retorno tras lesión/pausa): progresión MUY conservadora.
Primeras 2 semanas casi exclusivamente Z1-Z2. Prioridad absoluta: NO recaer, construir tolerancia tisular.
Nomenclatura OBLIGATORIA: "Ciclo 1 · Semana X/${weeks}". Ciclo rolling 3+1 con techos bajos.`
    };

    const ejemploFase = objetivo === "carrera" ? "Base 1" : `Ciclo 1 · Semana 1/${weeks}`;
    const volumBase = userData?.volum || 4;

    // ── LA FOTO DE L'ATLETA: context d'on venim (Strava de l'onboarding) ──
    const sv = userData?.stravaStats || null;
    let fotoBlock = "";
    if (sv) {
      fotoBlock += `\n\n# FOTO DEL ATLETA AL EMPEZAR (de dónde viene — histórico Strava)\n`;
      fotoBlock += `Esta es la foto real de su estado de forma. ÚSALA para decidir de qué fase partir (no le hagas empezar de cero si ya viene entrenado).\n`;
      if (sv.recentActivities6mo != null) fotoBlock += `- Actividades últimos 6 meses: ${sv.recentActivities6mo}\n`;
      if (sv.avgWeeklyHours != null) fotoBlock += `- Volumen medio histórico: ${sv.avgWeeklyHours} h/semana (${sv.avgWeeklyKm || "?"} km/sem)\n`;
      if (sv.last4Weeks?.weeklyAvgHours != null) fotoBlock += `- Últimas 4 semanas (estado actual): ${sv.last4Weeks.weeklyAvgHours} h/sem · ${sv.last4Weeks.km || "?"} km\n`;
      if (sv.running?.longestKm) fotoBlock += `- Rodaje más largo reciente: ${sv.running.longestKm} km\n`;
      if (sv.running?.best5K_pace) fotoBlock += `- Mejor 5K: ${sv.running.best5K_pace}\n`;
      if (sv.running?.best10K_pace) fotoBlock += `- Mejor 10K: ${sv.running.best10K_pace}\n`;
      if (sv.cycling?.longestKm) fotoBlock += `- Ruta bici más larga: ${sv.cycling.longestKm} km\n`;
      fotoBlock += `INTERPRETACIÓN: si este volumen/nivel indica que ya tiene una base sólida, ARRANCA el plan en una fase avanzada (Construcción/Específico) acorde al tiempo que queda. No repitas base que ya tiene hecha.`;
    } else {
      fotoBlock = `\n\n# SIN HISTÓRICO STRAVA\nNo hay foto de Strava. Usa el nivel declarado (${userData?.nivel || "intermedio"}) y el volumen base para estimar de qué fase partir según el tiempo disponible.`;
    }

    // ── COORDINACIÓ AMB EL DASHBOARD: setmanes reals ja viscudes/en curs ──
    // El dashboard mana. Aquestes setmanes s'han de reflectir al mapa TAL QUAL
    // (mateixos títols de sessió), no regenerar-les. La IA només genera les futures.
    let realWeeksBlock = "";
    if (realWeeksArr.length > 0) {
      const anchor = currentWeekStart || null;
      const lines = realWeeksArr
        .slice()
        .sort((a, b) => (a.setmana < b.setmana ? -1 : 1))
        .map((w) => {
          const isCurrent = anchor && w.setmana === anchor;
          const titles = (w.sessions || [])
            .map((s) => s.rest ? "Descanso" : (s.title || "Sesión"))
            .join(" · ");
          const doneCount = (w.sessions || []).filter((s) => !s.rest && s.completed).length;
          const trainCount = (w.sessions || []).filter((s) => !s.rest).length;
          return `- Semana del ${w.setmana}${isCurrent ? " (ACTUAL — la que ve el usuario en el dashboard)" : ""}: ${titles || "sin sesiones"} [completadas ${doneCount}/${trainCount}]`;
        })
        .join("\n");
      realWeeksBlock = `\n\n# SEMANAS REALES DEL DASHBOARD (FUENTE DE VERDAD — el dashboard manda)
Estas semanas YA existen con contenido real (el usuario las ve y las ajusta en el dashboard). REGLAS ESTRICTAS:
- Para estas fechas, refleja EXACTAMENTE estos títulos de sesión en el mapa (no inventes otros, no los reordenes).
- La semana marcada ACTUAL debe coincidir título por título con lo que hay en el dashboard.
- Si una semana no tiene sesiones completadas, refléjalo igualmente tal cual (no la maquilles).
- Genera/ajusta SOLO las semanas que NO están en esta lista, dándoles continuidad coherente (fase, carga, progresión) a partir de lo ya hecho.
${lines}`;
    }

    const userMessage = `${objectiveTask[objetivo] || objectiveTask.forma}

# DATOS DEL ATLETA

- Disciplinas: ${(userData?.sports || ["running"]).join("+")}
- Nivel: ${userData?.nivel || "intermedio"}
- Días disponibles/semana: ${userData?.dias || 3}
- Volumen base: ${volumBase} h/semana
- Edad: ${userData?.edat || "no informada"}
${userData?.fcmax ? `- FCmax: ${userData.fcmax} bpm` : ""}
${objetivo === "carrera"
        ? `- CARRERA: ${raceName} el ${raceDate} (distancia ${userData?.distancia || ""}${userData?.desnivel ? ", +" + userData.desnivel + "m D+" : ""})`
        : ""}
${fotoBlock}${realWeeksBlock}

# TAREA

Genera ${weeks} semanas. Para cada semana retorna: weekNum, phase (respeta la nomenclatura del objetivo), totalHours (coherente con ${volumBase}h base, varía según la fase — taper y descarga van MUY por debajo), load (100-700, dibujando la curva descrita), focus (una frase clara), sessions (3-4 títulos descriptivos en castellano).${realWeeksArr.length > 0 ? "\nRECUERDA: las semanas listadas en 'SEMANAS REALES DEL DASHBOARD' van con sus títulos exactos; solo generas las demás." : ""}

**FORMATO OBLIGATORIO** — Devuelve SOLO un objeto JSON válido (sin markdown, sin \`\`\`json, sin preámbulo):

{
  "totalWeeks": ${weeks},
  "objetivo": "${objetivo}",
  "weeks": [
    {"weekNum":1,"phase":"${ejemploFase}","totalHours":4.5,"load":320,"focus":"...","sessions":["...","...","..."]}
  ],
  "resumen": "Resumen general del bloc en 2 frases"
}`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: [
        { type: "text", text: BASE_INSTRUCTIONS },
        { type: "text", text: METHODOLOGY, cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: userMessage }]
    });

    let reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    reply = reply.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    let data;
    try {
      data = JSON.parse(reply);
    } catch (e1) {
      const match = reply.match(/\{[\s\S]*\}/);
      if (!match) {
        console.error("No JSON in response:", reply.substring(0, 500));
        return res.status(500).json({ error: "Sin JSON en respuesta", preview: reply.substring(0, 200) });
      }
      try { data = JSON.parse(match[0]); }
      catch (e2) {
        console.error("JSON inválido tras regex:", e2.message);
        return res.status(500).json({ error: "JSON inválido del modelo" });
      }
    }

    if (!data.weeks || !Array.isArray(data.weeks)) {
      console.error("Sin weeks:", JSON.stringify(data).substring(0, 300));
      return res.status(500).json({ error: "Respuesta sin estructura weeks" });
    }

    // ── 3. Adjuntar metadades i persistir ──
    // _anchorMonday: si ja existia un mapa, conservem l'àncora original perquè
    // el càlcul de "setmana actual" no es descol·loqui en reajustar.
    let anchorMonday = getMondayISO(new Date());
    if (email) {
      const { data: prev } = await supabase
        .from("profiles")
        .select("periodization")
        .eq("email", email)
        .maybeSingle();
      if (prev?.periodization?._anchorMonday) anchorMonday = prev.periodization._anchorMonday;
    }

    const result = {
      totalWeeks: data.totalWeeks || weeks,
      objetivo: data.objetivo || objetivo,
      weeks: data.weeks,
      resumen: data.resumen || data.resum || "",
      _sig: sig,
      _anchorMonday: anchorMonday,
      _generatedAt: new Date().toISOString()
    };

    if (email) {
      const { error: saveErr } = await supabase
        .from("profiles")
        .update({ periodization: result })
        .eq("email", email);
      if (saveErr) console.error("No s'ha pogut desar la periodització:", saveErr.message);
    }

    return res.status(200).json({ ...result, usage: response.usage });

  } catch (error) {
    console.error("Plan completo error:", error);
    return res.status(500).json({ error: error.message || "Error en plan-completo" });
  }
}

export const config = { maxDuration: 60 };
