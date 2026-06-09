// api/session-detail.mjs — detall executable d'una sessio, generat amb la metodologia del soci
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic({ maxRetries: 2 });
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

function describeMaterial(gym_ubi, gym_mat, equipamiento) {
  if (gym_ubi === 'gimnasio' || equipamiento === 'gym_completo') {
    return 'Gimnasio completo: barras, mancuernas, máquinas, poleas, banco. Cualquier ejercicio.';
  }
  const mats = Array.isArray(gym_mat) ? gym_mat : (typeof gym_mat === 'string' && gym_mat ? gym_mat.split(',') : []);
  if (mats.length === 0 || mats.includes('nada') || equipamiento === 'cuerpo') {
    return 'SOLO peso corporal. PROHIBIDO pesas, barras o máquinas. Ejercicios de calistenia (flexiones, fondos, sentadillas, zancadas, planchas, puentes, dominadas si hay barra).';
  }
  const matNames = {
    mancuernas: 'mancuernas', kettlebell: 'kettlebell', gomas: 'gomas elásticas',
    barra_dominadas: 'barra de dominadas', banco: 'banco y barra'
  };
  const list = mats.map(m => matNames[m] || m).join(', ');
  return `EN CASA. Material: ${list}. SOLO ejercicios con este material. NADA de máquinas ni poleas. Si falta material para un grupo, usa peso corporal.`;
}

const BASE_INSTRUCTIONS = `Eres el coach IA de traineo. Tu metodologia completa esta en el CERVELL DEL COACH que sigue. Siguela siempre.

El coach ya ha planificado una sesion (titulo, duracion, intencion). Tu NO la cambias: la DESARROLLAS en su ejecucion detallada paso a paso.

REGLAS:
- CARDIO: genera bloques (calentamiento, bloque principal, vuelta a la calma). La suma de minutos es la duracion de la sesion.
- GIMNASIO/FUERZA/CALISTENIA: genera 5-7 ejercicios coherentes con el grupo muscular Y EL MATERIAL DISPONIBLE. Es OBLIGATORIO respetar el material: si solo hay peso corporal, NO prescribas ejercicios con pesas o máquinas. Si solo hay mancuernas, NO uses barras ni poleas. Adapta cada ejercicio al material exacto del atleta. Los nombres de los ejercicios SIEMPRE en castellano (ej: "Sentadilla búlgara", no "Bulgarian split squat"). Para cada ejercicio incluye un campo "howto" con 1-2 frases en castellano explicando claramente cómo se ejecuta, para alguien que no conoce el ejercicio.
- En gimnasio/fuerza/calistenia, prioriza los ejercicios mejor valorados de las tablas EXERCICIS CLAU del cervell (split squat bulgaro, trap bar deadlift, RDL/hip hinge, soleus calf raise bent-knee, step-up, Pallof press, dead bug, plancha lateral, Copenhagen plank) y evita los peor valorados (crunch, russian twist, plancha abdominal como principal, dips y press banca en perfiles endurance salvo natacion/hibridos).
- Respeta la intencion del titulo: si es Z2, el bloque principal es Z2; si es series, estructura series reales con repeticiones y recuperacion.
- Numeros concretos SIEMPRE: minutos, repeticiones, distancias, porcentajes de FTP o RM, descansos, zona FC.
- Aplica la metodologia del cervell para decidir estructura, intensidades, recuperaciones y tecnica.
- Castellano. OUTPUT: SOLO JSON valido, sin markdown ni texto antes o despues.`;

function detailSig(session, userData) {
  return [
    "v3",
    session?.title || "", session?.duracio_min ?? 45,
    (session?.tags || []).join(","), userData?.fcmax ?? 185,
    userData?.nivel || "intermedio", userData?.pacez2 || "", userData?.ftp || "",
    userData?.gymUbi || "", (Array.isArray(userData?.gymMat) ? userData.gymMat.join(",") : userData?.gymMat || "")
  ].join("|");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { email, setmana, day, session, userData, forceRegenerate } = req.body;
    if (!session || !session.title) return res.status(400).json({ error: "Falta la sessio" });

    const sig = detailSig(session, userData);
    const fc = userData?.fcmax || 185;

    let planRow = null, sessionIdx = -1;
    if (email && setmana && day) {
      const { data: profile } = await supabase
        .from("profiles").select("id").eq("email", email).maybeSingle();
      if (profile) {
        const { data: plan } = await supabase
          .from("plans").select("*")
          .eq("profile_id", profile.id).eq("setmana", setmana).maybeSingle();
        if (plan && Array.isArray(plan.sessions)) {
          planRow = plan;
          sessionIdx = plan.sessions.findIndex(s => s.day === day);
          const stored = sessionIdx >= 0 ? plan.sessions[sessionIdx].detail : null;
          if (stored && stored._sig === sig && !forceRegenerate) {
            return res.status(200).json({ ...stored, _cached: true });
          }
        }
      }
    }

    const z = p => Math.round(fc * p);
    const hasMaterial = userData?.gymUbi || userData?.equipamiento || (userData?.gymMat && userData.gymMat.length);
    const userMessage = `# SESION PLANIFICADA POR EL COACH

- Titulo: ${session.title}
- Duracion: ${session.duracio_min || 45} min
- Resumen: ${session.sub || "-"}
- Por que: ${session.why || "-"}
- Etiquetas: ${(session.tags || []).join(", ") || "-"}

# CONTEXTO DEL ATLETA

- FCmax: ${fc} bpm
- Zonas FC: Z1 ${z(0.5)}-${z(0.6)} | Z2 ${z(0.6)}-${z(0.7)} | Z3 ${z(0.7)}-${z(0.8)} | Z4 ${z(0.8)}-${z(0.9)} | Z5 ${z(0.9)}-${fc}
- Nivel: ${userData?.nivel || "intermedio"}
- Objetivo: ${userData?.objetivo || "forma"}
${userData?.pacez2 ? `- Ritmo Z2 running: ${Math.floor(userData.pacez2 / 60)}:${String(userData.pacez2 % 60).padStart(2, "0")}/km` : ""}
${userData?.ftp ? `- FTP: ${userData.ftp} W` : ""}
${userData?.musculos && userData.musculos.length ? `- Grupos musculares prioritarios: ${userData.musculos.join(", ")}` : ""}
${hasMaterial ? `- MATERIAL DISPONIBLE (OBLIGATORIO respetar): ${describeMaterial(userData.gymUbi, userData.gymMat, userData.equipamiento)}` : ""}

# TAREA

Desarrolla esta sesion en su ejecucion detallada, aplicando tu metodologia.

FORMATO OBLIGATORIO. Devuelve SOLO este JSON (sin markdown):

{
  "kind": "cardio o gym",
  "summary": "una frase de que es y como afrontarla",
  "why_long": "2-4 frases: el proposito real de esta sesion y como encaja en la fase actual del plan del atleta",
  "objectives": ["objetivo concreto y comprobable 1", "objetivo 2", "objetivo 3"],
  "blocks": [
    {"label":"Calentamiento","detail":"que hacer, concreto","minutes":12,"zone":"z1","series":null,"rpe":"2-3","cue":"consejo tecnico breve","feel":"que debes notar en este bloque"},
    {"label":"6 x 800 m","detail":"ritmo y recuperacion concretos","minutes":22,"zone":"z4","series":{"reps":6,"distance_m":800,"time_s":null,"rest_s":90},"rpe":"8","cue":"manten la zancada relajada","feel":"respiracion fuerte pero controlada"}
  ],
 "exercises": [
    {"name":"Sentadilla trasera","howto":"De pie con la barra sobre los trapecios, baja flexionando rodillas y cadera hasta que los muslos queden paralelos al suelo, manteniendo la espalda recta; sube empujando con los talones","prescription":"4 x 6","load":"75-80% RM","rest_s":150,"muscle":"Cuádriceps y glúteos","cue":"controla la bajada 3 segundos"}
  ],
  "alternatives": {
    "short": "version de unos 30 min: que recortar exactamente manteniendo lo esencial",
    "easy": "version suave: como bajar la intensidad si el atleta llega cansado, sin saltarse la sesion"
  },
  "tip": "consejo del coach, 1-2 frases, alineado con la metodologia"
}

REGLAS DEL FORMATO:
- Si es cardio: rellena "blocks" (3-5 bloques) con sus campos "rpe", "cue" y "feel"; deja "exercises" como [].
- Si es gimnasio/fuerza/calistenia: rellena "exercises" (5-7) RESPETANDO EL MATERIAL DISPONIBLE; deja "blocks" como [].
- "kind" debe ser exactamente la palabra cardio o la palabra gym.
- "zone" es uno de: z1, z2, z3, z4, z5. "rpe" es un numero o rango del 1 al 10 (esfuerzo percibido).
- "series" solo cuando el bloque son repeticiones; si no, null.
- "why_long" y "objectives" SIEMPRE, sea cardio o gym.
- "alternatives" SIEMPRE: una version corta y una facil, concretas y accionables.
- La suma de "minutes" de los bloques debe aproximarse a ${session.duracio_min || 45}.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
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
      const m = reply.match(/\{[\s\S]*\}/);
      if (!m) {
        return res.status(500).json({
          error: "El modelo no devolvio JSON",
          stop_reason: response.stop_reason,
          preview: reply.slice(0, 300)
        });
      }
      try {
        data = JSON.parse(m[0]);
      } catch (e2) {
        return res.status(500).json({
          error: response.stop_reason === "max_tokens"
            ? "Respuesta cortada por limite de tokens (max_tokens)"
            : "JSON invalido del modelo: " + e2.message,
          stop_reason: response.stop_reason,
          preview: reply.slice(-300)
        });
      }
    }

    const result = {
      kind: data.kind === "gym" ? "gym" : "cardio",
      summary: data.summary || "",
      why_long: data.why_long || "",
      objectives: Array.isArray(data.objectives) ? data.objectives : [],
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      exercises: Array.isArray(data.exercises) ? data.exercises : [],
      alternatives: (data.alternatives && typeof data.alternatives === "object") ? data.alternatives : {},
      tip: data.tip || "",
      _sig: sig,
      _generatedAt: new Date().toISOString()
    };

    if (planRow && sessionIdx >= 0) {
      const { data: freshPlan } = await supabase
        .from("plans").select("sessions").eq("id", planRow.id).maybeSingle();
      if (freshPlan && Array.isArray(freshPlan.sessions)) {
        const updated = freshPlan.sessions.slice();
        const freshIdx = updated.findIndex(s => s.day === day);
        if (freshIdx >= 0) {
          updated[freshIdx] = { ...updated[freshIdx], detail: result };
          const { error: upErr } = await supabase
            .from("plans").update({ sessions: updated }).eq("id", planRow.id);
          if (upErr) console.error("No s'ha pogut desar el detall:", upErr.message);
        }
      }
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error("session-detail error:", error);
    const st = error && error.status;
    const overloaded = st === 529 || st === 429 ||
      (error && error.error && error.error.error && error.error.error.type === "overloaded_error");
    if (overloaded) {
      return res.status(503).json({
        error: "El servidor de IA esta saturado ahora mismo. Espera unos segundos y pulsa Reintentar.",
        retryable: true
      });
    }
    return res.status(500).json({ error: error.message || "Error en session-detail" });
  }
}

export const config = { maxDuration: 60 };
