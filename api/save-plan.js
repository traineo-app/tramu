import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    email,
    userData,
    currentWeek,    // {weekStartDate, weekNumber, phase, sessions, resum, cycleInfo}
    nextWeek,       // mateixa estructura, o null si encara no s'ha generat
    pastWeeks,      // array d'objectes setmana arxivada (opcional, default mantenir el què hi havia)
    // retrocompat: si el frontend antic envia sessions/resum sense currentWeek
    sessions,
    resum
  } = req.body;

  if (!email) return res.status(400).json({ error: 'Email requerit' });

  // Backwards compat: si arriba sessions sense currentWeek, construïm currentWeek d'ell
  const effectiveCurrentWeek = currentWeek || (sessions ? {
    weekStartDate: getMondayISO(new Date()),
    weekNumber: 1,
    phase: 'Setmana 1',
    sessions: sessions,
    resum: resum || ''
  } : null);

  const upsertData = {
    email,
    user_data: userData,
    updated_at: new Date().toISOString()
  };
  if (effectiveCurrentWeek) {
    upsertData.current_week = effectiveCurrentWeek;
    upsertData.week_start_date = effectiveCurrentWeek.weekStartDate;
    // També mantenim el camp 'sessions' antic per retrocompat
    upsertData.sessions = effectiveCurrentWeek.sessions;
    upsertData.resum = effectiveCurrentWeek.resum;
  }
  if (nextWeek !== undefined) upsertData.next_week = nextWeek;
  if (pastWeeks !== undefined) upsertData.past_weeks = pastWeeks;

  try {
    const { data, error } = await supabase
      .from('plans')
      .upsert(upsertData, { onConflict: 'email' })
      .select();
    if (error) throw error;
    return res.status(200).json({ ok: true, plan: data?.[0] || null });
  } catch (e) {
    console.error('save-plan error:', e);
    return res.status(500).json({ error: e.message });
  }
}

function getMondayISO(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;  // Diumenge → -6, sinó 1-day
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}
