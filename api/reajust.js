export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { planActual, canvi, userData } = req.body;

  const fc = userData?.fcmax || 185;
  const z2min = Math.round(fc * 0.60);
  const z2max = Math.round(fc * 0.70);

  const systemPrompt = `Ets un coach esportiu expert en running, ciclisme, triatló i força.
La teva feina és reajustar plans d'entrenament de manera intel·ligent quan l'atleta fa canvis.

Regles irrenunciables:
- Mai força de cames el dia anterior a un rodatge llarg
- Mai dos dies d'alta intensitat seguits  
- 80% del volum en Z2, 20% en qualitat
- Si es redueix temps un dia, redistribueix els minuts als dies amb menys càrrega
- Si es marca un dia com a descans, la càrrega va al dia amb menys volum de la setmana
- Explica sempre en una frase curta per què has fet cada canvi important
- Respon SEMPRE en castellà`;

  const userMessage = `Pla actual de la setmana:
${JSON.stringify(planActual, null, 2)}

Canvi que ha fet l'atleta:
${canvi}

Dades de l'atleta:
- FC màxima: ${fc} bpm
- Z2: ${z2min}-${z2max} bpm  
- Dies disponibles: ${userData?.dias || 3}
- Disciplines: ${(userData?.sports || ['running']).join(', ')}
- Nivell: ${userData?.nivel || 'intermedi'}

Reajusta el pla sencer tenint en compte el canvi. Redistribueix la càrrega de manera intel·ligent.

Respon ÚNICAMENT amb JSON vàlid sense cap text addicional:
{
  "setmana": [
    {
      "dia": "Lu",
      "rest": false,
      "icon": "🏃",
      "title": "Rodaje Z2",
      "sub": "45 min · 132-148 bpm",
      "why": "Sin cambios",
      "tags": ["Running", "Z2"],
      "duracio_min": 45,
      "canviat": false
    }
  ],
  "missatge": "Frase curta explicant el reajust principal",
  "resum": "Resum del coach del pla reajustat"
}

Important: posa "canviat": true als dies que has modificat perquè l'usuari els vegi ressaltats.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
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
