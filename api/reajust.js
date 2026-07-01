// api/reajust.js — readaptació dins de la setmana amb metodologia del soci
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const anthropic = new Anthropic();

const METHODOLOGY = fs.readFileSync(
  path.join(process.cwd(), "coach-methodology.md"),
  "utf8"
);

const BASE_INSTRUCTIONS = `Eres el coach IA de tramu. Tu metodología completa está en el CERVELL DEL COACH que sigue — síguela siempre.

Tu trabajo aquí: el atleta ha hecho un cambio en su semana. Debes REOPTIMIZAR toda la semana para que sea coherente con la metodología, redistribuyendo carga E intensidad.

REGLA #1 — LO QUE EL ATLETA HA TOCADO A MANO ES SAGRADO:
Días con "userLocked":true o "completed":true:
- Devuelve dia, title, duracio_min, custom, tags, rest EXACTAMENTE iguales al input
- NO los muevas de día, NO cambies su contenido, NO los conviertas en descanso
- Solo puedes ajustar "why" para explicar cómo encaja el resto alrededor
- Estos días son decisiones del atleta: intocables

IMPORTANTE — "canviat":true SIN "userLocked" son ajustes TUYOS de una vez anterior:
- Esos SÍ los puedes volver a tocar/redistribuir libremente si la metodología lo pide
- No los trates como inmutables; solo lo son los "userLocked" o "completed"

REGLA #2 — REDISTRIBUCIÓN DE VOLUMEN cuando hay déficit/superávit:
- delta_load > 0 → FALTAN unidades de carga → añade minutos en 1-3 días no modificados
- delta_load < 0 → SOBRAN unidades de carga → reduce minutos en 1-3 días no modificados
- Prefiere ajustar días de la misma disciplina
- Los días que ajustes: marca "canviat":true y en "why" pon "Compensa el cambio del [día]"

REGLA #3 — DISTRIBUCIÓN DE INTENSIDAD (SIEMPRE aplica, incluso sin déficit/superávit):
- Si hay una sesión DURA o LARGA (trail con desnivel >500m, sesión >90min, zona Z4/Z5 repetida):
  → Los 1-2 días ANTERIORES deben ser Z1/Z2 o descanso (no series, no intensidad alta)
  → El día POSTERIOR debe ser Z1, recuperación activa o descanso
- Nunca dos sesiones de alta intensidad (Z4/Z5 o series) en días consecutivos
- DURACIÓN MÍNIMA: Running/Trail mín. 25 min · Ciclismo mín. 35 min · Gimnasio mín. 30 min · Natación mín. 20 min. Si al redistribuir queda por debajo del mínimo, conviértela en DESCANSO (rest:true).
- Puedes CAMBIAR EL TIPO de sesión de los días no modificados si la metodología lo requiere
  → Si cambias el tipo, actualiza title, sub, tags, icon y why coherentemente
- Nunca fuerza pesada lower body el día anterior a: intervalos, tirada larga o competición.

REGLA #4 — COHERENCIA GENERAL:
- Aplica la lógica de carga/recuperación del CERVELL DEL COACH
- Reparte los días de entrenamiento; no los agrupes todos seguidos
- El día de descanso programado del atleta (si hay uno) es respetable pero puedes moverlo si la semana lo requiere

OUTPUT en castellano, JSON válido sin markdown.`;

const DIA_NAMES = ['Lu','Ma','Mi','Ju','Vi','Sá','Do'];

function sessionLoad(d) {
  if (d.rest) return 0;
  if (d.completed && d.completion && d.completion.status === 'skipped') return 0;
  if (d.skipped) return 0;
  const min = d.duracio_min || 45;
  const tags = d.tags || [];
  const z = (tags.find(t => t && t.startsWith('Z')) || '').toLowerCase().substring(0, 2);
  const zWeight = { z1: 0.8, z2: 1.0, z3: 1.5, z4: 2.2, z5: 3.0 }[z] || 1.0;
  const elevBonus = d.custom?.elev ? Math.min(d.custom.elev / 500 * 0.4, 1.6) : 0;
  const longBonus = min > 90 ? Math.max(0, 1.3 - zWeight) : 0;
  return Math.round(min * (zWeight + elevBonus + longBonus));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { planActual, canvi, userData } = req.body;

    const fc = userData?.fcmax || 185;
    const z2min = Math.round(fc * 0.60);
    const z2max = Math.round(fc * 0.70);

    // ── Dia actual i dies passats ─────────────────────────────────────────────
    const todayDow = (new Date().getDay() + 6) % 7; // 0=Lu … 6=Do
    const todayDayName = DIA_NAMES[todayDow];
    const pastDayNames = planActual
      .filter(d => { const idx = DIA_NAMES.indexOf(d.day); return idx >= 0 && idx < todayDow; })
      .map(d => d.day);

    // ── Càrrega: només dies a partir d'avui (passats no recuperables) ─────────
    const targetLoadFull = Math.round((userData?.volum || 4) * 60 * 1.0);
    const remainingRatio = Math.max(1, 7 - todayDow) / 7;
    const targetLoad = Math.round(targetLoadFull * remainingRatio);

    const currentLoad = planActual
      .filter(d => { const idx = DIA_NAMES.indexOf(d.day); return idx >= todayDow; })
      .reduce((sum, d) => sum + sessionLoad(d), 0);

    const deltaLoad = targetLoad - currentLoad;
    const needsRedistribution = Math.abs(deltaLoad) >= 20;

    // ── Sessions clau ─────────────────────────────────────────────────────────
    const keySessions = planActual
      .filter(d => !d.rest && (
        (d.custom?.elev || 0) > 500 ||
        (d.duracio_min || 0) > 90 ||
        (d.tags || []).some(t => t === 'Z4' || t === 'Z5')
      ))
      .map(d => `${d.day}: "${d.title}" ${d.duracio_min}min${d.custom?.elev ? ` +${d.custom.elev}m D+` : ''}${d.custom?.km ? ` ${d.custom.km}km` : ''} [carga:${sessionLoad(d)}]`);

    const planSimple = planActual.map(d => ({
      dia: d.day,
      title: d.title,
      rest: d.rest || false,
      min: d.duracio_min || 45,
      tags: d.tags || [],
      userLocked: d.userLocked || false,
      canviat: d.canviat || false,
      custom: d.custom || null,
      completed: d.completed || false,
      load: sessionLoad(d)
    }));

    const userMessage = `Plan actual (cambio del atleta YA aplicado):
${JSON.stringify(planSimple)}

Cambio del atleta: ${canvi}

HOY ES: ${todayDayName}
${pastDayNames.length > 0 ? `DÍAS PASADOS (inmutables, su carga NO se recupera): ${pastDayNames.join(', ')}
→ NO añadas sesiones en días pasados. NO intentes compensar su carga en días futuros.` : ''}

ANÁLISIS DE CARGA (solo días desde hoy):
- Carga objetivo restante de la semana: ${targetLoad} unidades
- Carga actual desde hoy: ${currentLoad} unidades
- Delta: ${deltaLoad > 0 ? '+' : ''}${deltaLoad} unidades
${needsRedistribution
  ? `⚠ REDISTRIBUCIÓN NECESARIA: ${deltaLoad > 0 ? `Añade carga en días libres restantes` : `Reduce carga en días no modificados`}`
  : `✓ Carga equilibrada. Revisa distribución de intensidad si hace falta.`
}

${keySessions.length > 0 ? `SESIONES CLAVE (requieren proteger días adyacentes):
${keySessions.join('\n')}
→ Aplica REGLA #3: días previos y posterior deben ser fáciles.` : ''}

Datos atleta: FC max ${fc}, Z2 ${z2min}-${z2max}, ${userData?.dias || 3} días/sem, ${(userData?.sports || ['running']).join('+')}, nivel ${userData?.nivel || 'intermedio'}

Instrucción: Optimiza los días restantes de la semana. Puedes cambiar tipo de sesión (title, tags, sub, icon) en días NO modificados si la metodología lo exige.
Devuelve SOLO JSON válido:
{
  "setmana": [
    {"dia":"Lu","rest":false,"icon":"🏃","title":"...","sub":"...","why":"...","tags":[...],"duracio_min":45,"canviat":false,"custom":null}
  ],
  "missatge": "Qué se ha ajustado y por qué, claro y breve (máx 16 palabras). Ej: 'Suavizado el miércoles porque el jueves llevas tirada larga'",
  "resum": "Resumen breve de la semana"
}`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 2500,
      system: [
        { type: "text", text: BASE_INSTRUCTIONS },
        { type: "text", text: METHODOLOGY, cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: 'user', content: userMessage }]
    });

    let reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    reply = reply.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

    const result = JSON.parse(reply);
    return res.status(200).json(result);

  } catch (error) {
    console.error('Reajust error:', error);
    return res.status(500).json({ error: error.message });
  }
}

export const config = { maxDuration: 60 };
