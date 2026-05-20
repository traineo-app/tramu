import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

function buildUserData(profile) {
  return {
    sports: profile.sports || [],
    dias: profile.dias,
    descanso: profile.descanso,
    nivel: profile.nivel,
    fcmax: profile.fcmax,
    volum: profile.volum,
    objetivo: profile.objetivo,
    carrera: profile.carrera,
    distancia: profile.distancia,
    desnivel: profile.desnivel,
    fecha: profile.carrera_fecha
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email requerit' });

  try {
    const { data: profile, error: pErr } = await supabase
      .from('profiles').select('*').eq('email', email).maybeSingle();
    if (pErr) throw pErr;
    if (!profile) return res.status(200).json({ profile: null, plan: null, weeks: [] });

    const { data: weeks, error: wErr } = await supabase
      .from('plans')
      .select('*')
      .eq('profile_id', profile.id)
      .order('setmana', { ascending: false });
    if (wErr) throw wErr;

    const latest = weeks && weeks.length > 0 ? weeks[0] : null;

    return res.status(200).json({
      profile: profile,
      plan: {  // retrocompat amb index.html
        userData: buildUserData(profile),
        sessions: latest?.sessions || null,
        resum: latest?.resum || '',
        setmana: latest?.setmana || null
      },
      weeks: weeks || []  // nou: totes les setmanes per al dashboard
    });
  } catch (e) {
    console.error('get-plan error:', e);
    return res.status(500).json({ error: e.message });
  }
}
