export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { planActual, canvi, userData } = req.body;

  const fc = userData?.fcmax || 185;
  const z2min = Math.round(fc * 0.60);
  const z2max = Math.round(fc * 0.70);

  // CÀLCUL EXPLÍCIT del delta de càrrega
  const targetMinutes = (userData?.volum || 4) * 60;
  const currentMinutes = planActual.reduce((sum, d) => sum + (d.rest ? 0 : (d.duracio_min || 0)), 0);
  const delta = targetMinutes - currentMinutes;
  const needsRedistribution = Math.abs(delta) >= 15;

  const planSimple = planActual.map(d => ({
    dia: d.day,
    title: d.title,
    rest: d.rest || false,
    min: d.duracio_min || 45,
    tags: d.tags || [],
    canviat: d.canviat || false,
    custom: d.custom || null,
    completed: d.completed || false
  }));

  const systemPrompt = `Eres un coach experto en periodización. Tu trabajo principal cuando el atleta hace un cambio es REDISTRIBUIR la diferencia de carga al resto de la semana.

REGLA #1 — DÍAS DEL ATLETA SON INMUTABLES:
Días con "canviat":true:
- Devuelve title, duracio_min (=min recibido), custom, tags EXACTAMENTE iguales
- Solo puedes ajustar "why" para explicar por qué encaja
- NO los toques bajo ningún concepto

Días con "completed":true: igual de inmutables.

REGLA #2 — REDISTRIBUCIÓN OBLIGATORIA cuando hay déficit/superávit:
Si te paso un "delta" distinto de cero:
- delta > 0 → FALTAN minutos → AÑADE minutos repartidos en 1-3 días NO modificados ni completados
- delta < 0 → SOBRAN minutos → REDUCE minutos en 1-3 días NO modificados ni completados
- Prefiere ajustar días de la misma disciplina (running con running, bici con bici)
- Evita cargar más un día si el siguiente es duro
- Los días que TÚ ajustes: marca "canviat":true Y en "why" pon "Compensa el cambio del [día del atleta]"

REGLA #3 — COHERENCIA:
- 80% Z2, 20% calidad
- Nunca dos días alta intensidad seguidos si puedes reorganizar
- Nunca toques días con "completed":true ni con "canviat":true

OUTPUT castellano, JSON válido.`;

  const userMessage = `Plan actual (con cambio del atleta YA aplicado):
${JSON.stringify(planSimple)}

Cambio del atleta: ${canvi}

CÁLCULO DE CARGA:
- Volumen objetivo semanal: ${targetMinutes} min (${userData?.volum || 4} horas)
- Volumen actual (después del cambio): ${currentMinutes} min
- Delta: ${delta > 0 ? '+' : ''}${delta} min
${needsRedistribution ? `\n⚠ REDISTRIBUCIÓN OBLIGATORIA: ${delta > 0 ? `Añade ${Math.abs(delta)} min` : `Reduce ${Math.abs(delta)} min`} repartidos en días NO modificados.` : '\n✓ Volumen dentro del rango, sin redistribución necesaria.'}

REGLA INVIOLABLE: Días con "canviat":true mantienen EXACTAMENTE: mismo title, mismo min → duracio_min, mismo custom, mismos tags. NO afines.

Datos atleta: FC max ${fc}, Z2 ${z2min}-${z2max}, ${userData?.dias || 3} días/sem, ${(userData?.sports || ['running']).join('+')}, nivel ${userData?.nivel || 'intermedio'}

Devuelve SOLO JSON válido:
{
  "setmana": [
    {"dia":"Lu","rest":false,"icon":"🏃","title":"...","sub":"...","why":"...","tags":[...],"duracio_min":45,"canviat":false,"custom":null}
  ],
  "missatge": "Frase corta sobre la redistribución (máx 14 palabras)",
  "resum": "Resumen breve"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    return res.status(200).json(result);

  } catch (error) {
    console.error('Reajust error:', error);
    return res.status(500).json({ error: error.message });
  }
}
