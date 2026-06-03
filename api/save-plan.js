import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
function getMondayISO(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

// Afegeix camp a l'objecte NOMÉS si el valor és significatiu (no undefined/null/'').
// Així desar un canvi de sessió sense reenviar l'Strava no esborra la foto ja guardada.
function setIf(obj, key, val) {
  if (val === undefined || val === null || val === '') return;
  obj[key] = val;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, userData, sessions, resum, weekStartDate } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerit' });
  try {
    // 1. Buscar o crear profile per email
    const { data: existing, error: selErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (selErr) throw selErr;
    let profileId;

    // Camps base (sempre presents)
    // IMPORTANT: columnes date/int han de rebre null, mai string buit
    const profileFields = {
      sports:        Array.isArray(userData?.sports) ? userData.sports : (userData?.sports ? [userData.sports] : ['running']),
      dias:          parseInt(userData?.dias) || 3,
      descanso:      userData?.descanso || 'Ninguno',
      nivel:         userData?.nivel    || 'intermedio',
      fcmax:         parseInt(userData?.fcmax)   || 185,
      volum:         parseFloat(userData?.volum) || 4,
      objetivo:      userData?.objetivo  || '',
      carrera:       userData?.carrera   || '',
      distancia:     userData?.distancia || '',
      desnivel:      parseInt(userData?.desnivel) || 0,
      carrera_fecha: userData?.fecha || null
    };

    // ── LA FOTO DE L'ATLETA: només s'escriu si ve (setIf), per no esborrar-la ──
    // Dades personals
    setIf(profileFields, 'edat',   userData?.edat != null ? parseInt(userData.edat) : null);
    setIf(profileFields, 'alcada', userData?.alcada != null ? parseInt(userData.alcada) : null);
    setIf(profileFields, 'pes',    userData?.pes != null ? parseFloat(userData.pes) : null);
    setIf(profileFields, 'fcrep',  userData?.fcrep != null ? parseInt(userData.fcrep) : null);
    setIf(profileFields, 'genere', userData?.genere);
    // Rendiment / ritmes
    setIf(profileFields, 'pacez2',   userData?.pacez2 != null ? parseInt(userData.pacez2) : null);
    setIf(profileFields, 'ftp',      userData?.ftp != null ? parseInt(userData.ftp) : null);
    setIf(profileFields, 'race5k',   userData?.race5k != null ? parseInt(userData.race5k) : null);
    setIf(profileFields, 'race10k',  userData?.race10k != null ? parseInt(userData.race10k) : null);
    // Objectius de cursa
    setIf(profileFields, 'ritme_obj', userData?.ritmeObj != null ? parseInt(userData.ritmeObj) : null);
    setIf(profileFields, 'vel_obj',   userData?.velObj != null ? parseFloat(userData.velObj) : null);
    setIf(profileFields, 'temps_obj', userData?.tempsObj != null ? parseInt(userData.tempsObj) : null);
    // Gimnàs
    setIf(profileFields, 'musculos',     Array.isArray(userData?.musculos) && userData.musculos.length ? userData.musculos : null);
    setIf(profileFields, 'obj_gym',      userData?.objGym || userData?.obj_gym);
    setIf(profileFields, 'equipamiento', userData?.equipamiento);
    setIf(profileFields, 'gym_ubi',      userData?.gymUbi || userData?.gym_ubi);
    setIf(profileFields, 'gym_mat',      Array.isArray(userData?.gymMat) && userData.gymMat.length ? userData.gymMat : (Array.isArray(userData?.gym_mat) && userData.gym_mat.length ? userData.gym_mat : null));
    // LA FOTO sencera (jsonb) — el context d'on venim
    setIf(profileFields, 'strava_stats',      userData?.stravaStats);
    setIf(profileFields, 'stress_test_data',  userData?.stressTestData);

    if (existing) {
      const { error: updErr } = await supabase
        .from('profiles')
        .update(profileFields)
        .eq('id', existing.id);
      if (updErr) throw updErr;
      profileId = existing.id;
    } else {
      const { data: created, error: insErr } = await supabase
        .from('profiles')
        .insert({ email, ...profileFields })
        .select('id')
        .single();
      if (insErr) throw insErr;
      profileId = created.id;
    }

    // 2. Upsert plan per (profile_id, setmana)
    const setmana = weekStartDate || getMondayISO(new Date());
    const planData = {
      profile_id: profileId,
      setmana,
      sessions: sessions || [],
      resum: resum || ''
    };
    const { data: planResult, error: planErr } = await supabase
      .from('plans')
      .upsert(planData, { onConflict: 'profile_id,setmana' })
      .select()
      .single();
    if (planErr) throw planErr;
    return res.status(200).json({ ok: true, profileId, plan: planResult });
  } catch (e) {
    console.error('save-plan error:', e);
    return res.status(500).json({ error: e.message });
  }
}
