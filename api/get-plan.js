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
    // 1. Buscar profile per email
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!profile) return res.status(200).json({ plan: null });

    // 2. Últim pla per setmana DESC
    const { data: plans, error: plErr } = await supabase
      .from('plans')
      .select('*')
      .eq('profile_id', profile.id)
      .order('setmana', { ascending: false })
      .limit(1);
    if (plErr) throw plErr;

    if (!plans || plans.length === 0) {
      return res.status(200).json({
        plan: { userData: buildUserData(profile), sessions: null, resum: '' }
      });
    }

    const plan = plans[0];
    return res.status(200).json({
      plan: {
        userData: buildUserData(profile),
        sessions: plan.sessions,
        resum: plan.resum,
        setmana: plan.setmana
      }
    });
  } catch (e) {
    console.error('get-plan error:', e);
    return res.status(500).json({ error: e.message });
  }
}
