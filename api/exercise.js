export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const map = {
    'sentadilla': 'squat',
    'dominadas': 'pull up',
    'flexiones': 'push up',
    'plancha': 'plank',
    'hip thrust': 'hip thrust',
    'romanian deadlift': 'romanian deadlift',
    'press de banca': 'bench press',
    'press militar': 'overhead press',
    'remo con mancuerna': 'dumbbell row',
    'curl de bíceps': 'bicep curl',
    'dips': 'dips',
    'sentadilla búlgara': 'bulgarian split squat',
    'step-up': 'step up',
    'elevación de talones': 'calf raise',
    'bird dog': 'bird dog',
    'dead bug': 'dead bug',
    'plancha frontal': 'plank',
    'zancadas': 'lunge'
  };

  const query = map[name.toLowerCase()] || name.toLowerCase();

  try {
    const response = await fetch(
      `https://wger.de/api/v2/exercise/search/?term=${encodeURIComponent(query)}&language=english&format=json`,
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await response.json();

    if (data.suggestions && data.suggestions.length > 0) {
      const ex = data.suggestions[0];
      const exId = ex.data?.id;

      if (exId) {
        // Busca imatges de l'exercici
        const imgRes = await fetch(
          `https://wger.de/api/v2/exerciseimage/?exercise_base=${exId}&format=json`,
          { headers: { 'Accept': 'application/json' } }
        );
        const imgData = await imgRes.json();
        const img = imgData.results && imgData.results.length > 0
          ? imgData.results[0].image
          : null;

        return res.status(200).json({
          gif: img,
          name: ex.value,
          muscle: name,
          equipment: ''
        });
      }
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
