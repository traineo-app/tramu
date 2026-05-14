export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // Busca el perfil per email
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    const profiles = await profileRes.json();

    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const profile = profiles[0];

    // Busca l'últim pla d'aquesta setmana
    const today = new Date().toISOString().split('T')[0];
    const weekStart = getMonday(today);

    const planRes = await fetch(
      `${supabaseUrl}/rest/v1/plans?profile_id=eq.${profile.id}&setmana=gte.${weekStart}&order=creat_el.desc&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      }
    );

    const plans = await planRes.json();

    return res.status(200).json({
      profile,
      plan: plans && plans.length > 0 ? plans[0] : null
    });

  } catch (error) {
    console.error('Get plan error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function getMonday(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}
