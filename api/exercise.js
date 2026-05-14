export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name } = req.query;

  try {
    const response = await fetch(
      `https://wger.de/api/v2/exercise/search/?term=${encodeURIComponent(name||'squat')}&language=english&format=json`,
      { headers: { 'Accept': 'application/json' } }
    );
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
