/**
 * src/sync/supabaseClient.js — single Supabase client, or null if unconfigured.
 * Requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (see .env / Vercel env).
 * The app runs fully without these (local-only); sync just stays off.
 */
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = (url && key)
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  : null

export const syncEnabled = () => !!supabase
