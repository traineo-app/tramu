// api/swap-exercise.mjs — genera 3-4 alternativas para un ejercicio de gimnasio/fuerza
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic({ maxRetries: 2 });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

let METHODOLOGY = "";
try {
  METHODOLOGY = fs.readFileSync(path.join(process.cwd(), "coach-methodology.md"), "utf8");
} catch (e) {
  METHODOLOGY = "";
}

function describeMaterial(gym_ubi, gym_mat, equipamiento) {
  if (gym_ubi === 'gimnasio' || equipamiento === 'gym_completo') {
    return 'Gimnasio completo: barras, mancuernas, máquinas, poleas, banco. Cualquier ejercicio.';
  }
  const mats = Array.isArray(gym_mat) ? gym_mat : (typeof gym_mat === 'string' && gym_mat ? gym_mat.split(',') : []);
  if (mats.length === 0 || mats.includes('nada') || equipamiento === 'cuerpo') {
    return 'SOLO peso corporal. PROHIBIDO pesas, barras o máquinas. Ejercicios de calistenia.';
  }
  const matNames = {
    mancuernas: 'mancuernas', kettlebell: 'kettlebell', gomas: 'gomas elásticas',
    barra_dominadas: 'barra de dominadas', banco: 'banco y barra'
  };
  const list = mats.map(m => matNames[m] || m).join(', ');
  return `EN CASA. Material: ${list}. SOLO ejercicios con este material. NADA de máquinas ni poleas.`;
}

const BASE_INSTRUCTIONS = `Eres el coach IA de tramu. Tu metodologia esta en el CERVELL DEL COACH que sigue.

El atleta quiere CAMBIAR un ejercicio concreto de su sesion de fuerza porque no le gusta, no puede hacerlo o le falta material. Tu tarea: proponer 3-4 alternativas que trabajen EL MISMO grupo muscular con un estimulo equivalente, respetando ESTRICTAMENTE el material disponible.

REGLAS:
- Mismo grupo muscular y patron de movimiento equivalente al ejercicio original.
- PRIORIZA SIEMPRE los ejercicios mejor valorados de las tablas de EXERCICIS CLAU del cervell del coach (split squat bulgaro, trap bar deadlift, RDL / hip hinge, soleus calf raise bent-knee, step-up, Pallof press, dead bug, plancha lateral, Copenhagen plank, etc.). EVITA los peor valorados por el cervell (crunch, russian twist, plancha abdominal como ejercicio principal, dips y press banca en perfiles endurance salvo natacion/hibridos, foam roller sobre IT band). Respeta las notas de cada tabla (p. ej. lunges/walking lunge tienen coste excentrico alto: alejarlos de sesiones clave de running).
- Respeta el material disponible: si solo hay peso corporal, NADA de pesas o maquinas; si solo hay mancuernas, NADA de barras ni poleas.
- Nombres SIEMPRE en castellano (ej: "Sentadilla bulgara", no "Bulgarian split squat").
- NO repitas el ejercicio original ni propongas variantes triviales (mismo ejercicio con otro nombre).
- Mantén una prescripcion coherente (series x reps, descanso) similar al original.
- Para cada alternativa, "howto" con 1-2 frases claras de como se ejecuta.
- Castellano. OUTPUT: SOLO JSON valido, sin markdown.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { exercise, userData, session } = req.body;
    if (!exercise || !exercise.name) return res.status(400).json({ error: "Falta el ejercicio a cambiar" });

    const hasMaterial = userData?.gymUbi || userData?.equipamiento || (userData?.gymMat && userData.gymMat.length);
    const material = hasMaterial
      ? describeMaterial(userData.gymUbi, userData.gymMat, userData.equipamiento)
      : 'Gimnasio completo (asume material estándar).';

    const userMessage = `# EJERCICIO A SUSTITUIR

- Nombre: ${exercise.name}
- Grupo muscular: ${exercise.muscle || "-"}
- Prescripcion actual: ${exercise.prescription || "-"}${exercise.load ? " · " + exercise.load : ""}
- Descanso: ${exercise.rest_s ? exercise.rest_s + "s" : "-"}
${session?.title ? `- Sesion: ${session.title}` : ""}

# CONTEXTO DEL ATLETA

- Nivel: ${userData?.nivel || "intermedio"}
- Objetivo: ${userData?.objetivo || "forma"}
${userData?.musculos && userData.musculos.length ? `- Grupos prioritarios: ${userData.musculos.join(", ")}` : ""}
- MATERIAL DISPONIBLE (OBLIGATORIO respetar): ${material}

# TAREA

Propon 3-4 alternativas al ejercicio. Devuelve SOLO este JSON (sin markdown):

{
  "alternatives": [
    {"name":"Nombre en castellano","howto":"1-2 frases de como se ejecuta","prescription":"4 x 8","load":"peso o intensidad sugerida","rest_s":120,"muscle":"${exercise.muscle || "Grupo"}","cue":"consejo tecnico breve"}
  ]
}

Devuelve entre 3 y 4 alternativas. Cada una con todos los campos.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      system: [
        { type: "text", text: BASE_INSTRUCTIONS },
        ...(METHODOLOGY ? [{ type: "text", text: METHODOLOGY, cache_control: { type: "ephemeral" } }] : [])
      ],
      messages: [{ role: "user", content: userMessage }]
    });

    let reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    reply = reply.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();

    let data;
    try {
      data = JSON.parse(reply);
    } catch (e1) {
      const m = reply.match(/\{[\s\S]*\}/);
      if (!m) {
        return res.status(500).json({ error: "El modelo no devolvio JSON", stop_reason: response.stop_reason, preview: reply.slice(0, 300) });
      }
      try { data = JSON.parse(m[0]); }
      catch (e2) {
        return res.status(500).json({ error: "JSON invalido del modelo: " + e2.message, stop_reason: response.stop_reason, preview: reply.slice(-300) });
      }
    }

    let alts = Array.isArray(data.alternatives) ? data.alternatives : [];
    // sanejar i limitar a 4
    alts = alts.filter(a => a && a.name).slice(0, 4).map(a => ({
      name: String(a.name),
      howto: a.howto || "",
      prescription: a.prescription || exercise.prescription || "",
      load: a.load || "",
      rest_s: a.rest_s || exercise.rest_s || null,
      muscle: a.muscle || exercise.muscle || "",
      cue: a.cue || ""
    }));

    if (alts.length === 0) {
      return res.status(500).json({ error: "El coach no devolvio alternativas válidas" });
    }

    return res.status(200).json({ alternatives: alts });

  } catch (error) {
    console.error("swap-exercise error:", error);
    const st = error && error.status;
    const overloaded = st === 529 || st === 429 ||
      (error && error.error && error.error.error && error.error.error.type === "overloaded_error");
    if (overloaded) {
      return res.status(503).json({ error: "El servidor de IA está saturado. Espera unos segundos y reintenta.", retryable: true });
    }
    return res.status(500).json({ error: error.message || "Error en swap-exercise" });
  }
}

export const config = { maxDuration: 60 };
