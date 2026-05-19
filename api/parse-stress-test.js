import Anthropic from "@anthropic-ai/sdk";

export const config = {
  api: {
    bodyParser: { sizeLimit: '15mb' }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { pdfBase64 } = req.body;
    if (!pdfBase64) return res.status(400).json({ error: 'No PDF provided' });

    const base64Data = pdfBase64.includes(',') ? pdfBase64.split(',')[1] : pdfBase64;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Data
            }
          },
          {
            type: 'text',
            text: `Analiza esta prueba de esfuerzo. Extrae los datos clave y devuelve SOLO un objeto JSON válido con esta estructura exacta (usa null si un dato no aparece, no inventes):

{
  "edat": número o null,
  "pes": número kg o null,
  "alcada": número cm o null,
  "fcmax": número bpm o null,
  "fcrep": número bpm o null,
  "vo2max": número ml/kg/min o null,
  "umbral_aerobic": número bpm o null,
  "umbral_anaerobic": número bpm o null,
  "ritme_5k": número segundos/km o null,
  "ritme_10k": número segundos/km o null,
  "ritme_z2": número segundos/km o null,
  "ftp": número watts o null,
  "zones_fc": {"z1":[min,max],"z2":[min,max],"z3":[min,max],"z4":[min,max],"z5":[min,max]} o null,
  "tipus_test": "running" | "ciclisme" | "combinat" | "altre",
  "observacions": "resumen breve en español de 1-2 frases destacando lo más relevante"
}

REGLAS ESTRICTAS:
- Devuelve SOLO el objeto JSON, sin markdown ni explicaciones.
- Los ritmos en segundos por km (ej: 5:30/km = 330 segundos).
- Los umbrales como frecuencia cardíaca en bpm.
- Si el PDF NO es una prueba de esfuerzo, devuelve {"error": "no_es_prova_esforc"}.
- Si una zona FC no se detecta pero tienes FCmax, estímala con los %: Z1 50-60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 90-100%.`
          }
        ]
      }]
    });

    let responseText = '';
    for (const block of message.content) {
      if (block.type === 'text') responseText += block.text;
    }
    responseText = responseText.trim();
    responseText = responseText.replace(/^```json\s*/i, '').replace(/```$/, '').trim();

    const data = JSON.parse(responseText);

    if (data.error === 'no_es_prova_esforc') {
      return res.status(400).json({ error: 'El PDF no parece ser una prueba de esfuerzo' });
    }

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('Parse stress test error:', error);
    return res.status(500).json({ error: error.message || 'Error procesando PDF' });
  }
}
