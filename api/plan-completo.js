// api/plan-completo.js — pla plurisemanal amb metodologia del soci
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic();

const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

const BASE_INSTRUCTIONS = `Eres el coach IA de traineo generando un PLAN PLURISEMANAL (vista de bloc, 4-16 setmanes).

La teva metodologia completa està al CERVELL DEL COACH que segueix. Segueix-la sempre.

DIFERÈNCIA AMB EL PLA SETMANAL:
- Aquí NO generes sessions individuals dia per dia.
- Generes una vista de bloc: per cada setmana → fase, hores totals, càrrega 100-700, focus en una frase, i 3-4 títols principals de sessions.
- L'objectiu és que l'atleta vegi la progressió i lògica del bloc complet.

REGLES GENERALS:
- Respostes en CASTELLÀ (la interfície està en castellà)
- Aplica la filosofia 80/20 i els principis de càrrega/recuperació del cervell
- Respecta la nomenclatura de fase segons l'objectiu
- Volum total setmanal coherent amb el volum base de l'atleta
- Retorna JSON estricte sense markdown ni preàmbul`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { userData, raceDate, raceName, totalWeeks } = req.body;
    const objetivo = raceDate ? "carrera" : (userData?.objetivo || "forma");

    let weeks;
    if (objetivo === "carrera" && raceDate) {
      const diff = Math.ceil((new Date(raceDate) - new Date()) / (1000 * 60 * 60 * 24 * 7));
      weeks = Math.max(4, Math.min(diff, 16));
    } else {
      weeks = totalWeeks || 4;
    }

    // Task framing per objectiu — DELEGA a la metodologia, no la duplica
    const objectiveTask = {
      carrera: `OBJETIVO: CARRERA hacia ${raceName || "objetivo competitivo"} el ${raceDate}.
Aplica la periodización descrita en BLOC 9 #56 de tu metodología (Off-season → Base → Build → Peak → Taper → Carrera).
Nomenclatura de fase: usa "Base 1", "Construcción 2", "Específico", "Taper", "Carrera".
Calcula fase según las semanas hasta la prueba (las pautas internas del cervell ya las describen).`,

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

# TAREA

Genera ${weeks} semanas. Para cada semana retorna: weekNum, phase (respeta la nomenclatura del objetivo), totalHours (coherente con ${volumBase}h base, varía según la fase), load (100-700), focus (una frase clara), sessions (3-4 títulos descriptivos en castellano).

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
        console.error("JSON inválido tras regex:", e2.message, "Texto:", reply.substring(0, 500));
        return res.status(500).json({ error: "JSON inválido del modelo" });
      }
    }

    if (!data.weeks || !Array.isArray(data.weeks)) {
      console.error("Sin weeks:", JSON.stringify(data).substring(0, 300));
      return res.status(500).json({ error: "Respuesta sin estructura weeks" });
    }

    return res.status(200).json({
      ...data,
      usage: response.usage
    });

  } catch (error) {
    console.error("Plan completo error:", error);
    return res.status(500).json({ error: error.message || "Error en plan-completo" });
  }
}

// IMPORTANT: timeout per processar 42K tokens metodologia + generar fins a 16 setmanes
export const config = {
  maxDuration: 60
};
