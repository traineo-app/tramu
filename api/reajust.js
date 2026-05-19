export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { planActual, canvi, userData } = req.body;

  const fc = userData?.fcmax || 185;
  const z2min = Math.round(fc * 0.60);
  const z2max = Math.round(fc * 0.70);

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

  const systemPrompt = `Eres un coach experto. Reajustas planes de entrenamiento.

REGLA CRÍTICA NÚMERO 1 — INVIOLABLE:
El usuario ha hecho un cambio explícito y consciente en su plan. Tu trabajo NO es revertir su cambio, sino ADAPTAR el resto de la semana alrededor de él.
- Los días marcados con "canviat":true SON LEY. NO los cambies, NO los muevas, NO los modifiques bajo ningún concepto.
- Los días marcados con "completed":true ya están hechos. NO los toques.
- Si el cambio del usuario rompe alguna regla teórica (ej. dos días duros seguidos), TÚ adaptas el resto de días para minimizar el daño, NO deshaces el cambio.

REGLAS SECUNDARIAS (aplicar solo a días NO modificados):
- Evita dos días alta intensidad seguidos si puedes reorganizar OTROS días
- 80% Z2, 20% calidad
- Si reduces tiempo un día, redistribuye a otros (no a los días con "canviat":true)
- Si marcas descanso, redistribuye la carga (no a los días con "canviat":true)

OUTPUT:
- Responde SIEMPRE en castellano
- Sé conciso en "why" (máx 1 frase corta)
- Mantén "canviat":true en los días que el usuario modificó
- Marca "canviat":true solo en días que TÚ has reorganizado como reacción al cambio del usuario`;

  const userMessage = `Plan actual (con cambios del atleta ya aplicados):
${JSON.stringify(planSimple)}

Cambio que ha hecho el atleta: ${canvi}

IMPORTANTE: Este cambio YA ESTÁ aplicado en el plan que te paso. Tu trabajo es preservarlo y adaptar el resto.

Datos: FC max ${fc}, Z2 ${z2min}-${z2max}, ${userData?.dias || 3} días, ${(userData?.sports || ['running']).join('+')}, nivel ${userData?.nivel || 'intermedio'}

Devuelve el plan adaptado. PRESERVA los días con "canviat":true. Responde SOLO con JSON válido:
{
  "setmana": [
    {"dia":"Lu","rest":false,"icon":"🏃","title":"...","sub":"45 min · Z2","why":"...","tags":["Running","Z2"],"duracio_min":45,"canviat":false}
  ],
  "missatge": "Frase corta sobre el reajuste (máx 12 palabras)",
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
        max_tokens: 1500,
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
